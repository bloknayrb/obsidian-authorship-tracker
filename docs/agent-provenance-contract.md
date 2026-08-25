# Agent provenance contract

## Scope and non-goals

This is a **cooperative, best-effort declared provenance** protocol for external agents and automations that write Markdown files in a vault using Authorship Tracker.

It records what a compliant writer declares about its own work. It is not identity verification, access control, a way to prevent mistaken or malicious edits, or tamper-evident audit logging. Frontmatter and JSONL logs are ordinary mutable vault files. A writer that lacks required context must abstain and ask the user rather than inventing attribution.

The Obsidian plugin captures `editor-change` events. It does not detect or enforce ordinary or unmapped filesystem edits made by agents, scripts, sync clients, or other tools. The exception is a configured auto-import folder: the plugin observes matching Markdown-file creation there and may stamp its configured source attribution.

## Prerequisites

Before an external writer records provenance, it must have:

- the vault root;
- a configured Authorship Tracker log directory and the vault owner's local timezone for daily file partitioning;
- a stable external identity matching `^[a-z][a-z0-9_-]{1,31}(?::[a-z][a-z0-9_-]{1,63})?$`.

Identifiers are case-sensitive. Use an identity such as `hermes`, `claude-code`, or `automation:meeting-importer`. Do not use a human name, the reserved `human:` prefix, or an invented identity. If any prerequisite is unavailable, do not write provenance metadata or an event.

## Note metadata

| Field | External-writer rule |
| --- | --- |
| `created_by` | Set only when creating a truly new note. Preserve it on existing notes. |
| `last_modified_by` | Set to the configured external identity after a material content change. |
| `edit_count` | Plugin-owned. External writers never modify it. |
| `content_origin` | Set on a new note; preserve on existing notes unless the user explicitly requests a correction. |

Allowed `content_origin` values are `primary`, `human-authored`, `ai-derived`, `ai-generated`, and `metadata`.

Use `ai-generated` for model-written prose without durable grounding. Use `ai-derived` only when the event contains one or more durable `source_refs`, such as vault-relative links, canonical URLs, or immutable source identifiers. Use `primary` only for imported original source material. Do not classify content as `human-authored` unless the user explicitly instructs it or provides a verified human source.

## External event schema

Each event is one JSON object on one line in the configured daily `YYYY-MM-DD.jsonl` file. The existing core fields remain compatible with plugin-generated records. External writers add the optional fields below.

| Field | Required | Rule |
| --- | --- | --- |
| `ts` | yes | RFC 3339 UTC timestamp, for example `2026-08-25T18:00:00.000Z`. |
| `file` | yes | Normalized vault-relative Markdown path using `/`; never absolute and never containing `..`. |
| `author` | yes | Same configured identity as `writer_id`. |
| `action` | yes | `created` or `modified`. |
| `summary` | yes | Short, factual description that does not copy sensitive note content. |
| `provenance_version` | external only | Number `1`. |
| `writer_kind` | external only | `agent` or `automation`. |
| `writer_id` | external only | Stable configured identity. |
| `event_id` | external only | Unique opaque ID for this intended operation. |
| `content_change` | external only | `true` for a material content change; `false` only for a user-requested provenance correction. |
| `source_refs` | conditional | Non-empty array when `content_origin` is set to `ai-derived`. |

Example new-note event:

```json
{"ts":"2026-08-25T18:00:00.000Z","file":"Research/Brief.md","author":"hermes","action":"created","summary":"Created AI-derived research brief","provenance_version":1,"writer_kind":"agent","writer_id":"hermes","event_id":"evt_01","content_change":true,"source_refs":["Sources/Interview transcript.md"]}
```

Example edit event:

```json
{"ts":"2026-08-25T18:05:00.000Z","file":"Research/Brief.md","author":"hermes","action":"modified","summary":"Added sourced decision summary","provenance_version":1,"writer_kind":"agent","writer_id":"hermes","event_id":"evt_02","content_change":true,"source_refs":["https://example.com/source"]}
```

An explicitly requested provenance correction uses `action: "modified"` and `content_change: false`.

## Decision rules

| Situation | Required behavior |
| --- | --- |
| New note created by the writer | Set `created_by`, `last_modified_by`, and an honest `content_origin`; do not set `edit_count`; append a `created` event. |
| Existing note, material content change | Preserve `created_by`, `content_origin`, and `edit_count`; set `last_modified_by`; append a `modified` event. |
| Existing note, whitespace-only/no-op formatting | Do not add metadata or an event. |
| User explicitly requests provenance correction | Make only the requested correction; append a `modified` event with `content_change: false`. |
| Model synthesis lacks durable sources | Use `ai-generated`, not `ai-derived`. |
| Existing metadata is malformed, contradictory, or has an unknown origin | Abstain and tell the user. Do not repair it without explicit authorization. |
| Destination is an auto-import folder that may map the path | Abstain unless the user explicitly directs the write. |
| Copy, rename, restore, template, or import has uncertain original authorship | Treat it as an existing note and preserve provenance; ask before reclassifying. |

A material change adds, removes, rewrites, summarizes, translates, or changes factual/prose content. It includes generated titles and substantive citation insertion. It excludes no-ops and whitespace-only formatting.

## Write, verify, and recover

1. Read the note and its existing metadata. Validate the identity, path, metadata, classification, log location, and auto-import conflict before writing.
2. Generate one `event_id` for the intended operation. Before retrying an operation, search the relevant daily log for that ID. If it exists, do not append it again.
3. Write the note content and permitted metadata.
4. Append exactly one event with that `event_id`.
5. Read back the note and the event line. Report success only when both match the intended operation.

A note file and JSONL log cannot be updated atomically. If note writing succeeds but event append or read-back fails, report **partial provenance recorded**. Do not retry automatically, do not modify `edit_count`, and do not claim that the operation has a complete audit record. On explicit user instruction, reconcile by searching for `event_id` and appending the missing event only if it is absent.

## Concurrency and correction limits

Concurrent external writers can still overwrite each other's mutable frontmatter or interleave log writes. This protocol records declared behavior; it does not serialize writers or prove who acted. Users can correct an attribution explicitly, and the correction should itself be recorded as a `content_change: false` event.
