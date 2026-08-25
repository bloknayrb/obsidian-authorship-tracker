---
name: obsidian-authorship-tracker
description: Record declared provenance for agent-written vault notes.
version: 0.1.0
author: Bryan Kolb, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [obsidian, provenance, authorship, ai, automation]
    related_skills: []
---

# Authorship Tracker external-writer skill

Use this skill when you create or materially edit Markdown notes in a vault that uses Authorship Tracker **outside the Obsidian editor**. It creates a cooperative record of declared provenance. It does not prove identity or override the plugin's own editor-change tracking.

Read [`../../docs/agent-provenance-contract.md`](../../docs/agent-provenance-contract.md) before writing. That contract is authoritative for fields, classification, event schema, failure handling, and examples.

## When to use

- You create a new vault note through a filesystem, CLI, API, or automation.
- You materially rewrite, summarize, translate, or add substantive content to an existing vault note.
- The user explicitly requests a provenance correction.

Do not use this skill for a person typing directly in Obsidian. The plugin records those editor changes itself.

## Prerequisites

Before writing, obtain all of the following:

- vault root;
- configured Authorship Tracker log path and vault-owner local timezone;
- a stable external identity from the user or environment, such as `hermes` or `automation:meeting-importer`;
- any durable source references required to classify content as `ai-derived`.

Ask the user when a prerequisite is missing. Do not guess a log path, timezone, writer identity, human author, or content origin.

## Procedure

1. Read the target note and its frontmatter. Validate that the target is a normalized vault-relative Markdown path and is not in an auto-import folder that may claim the path.
2. Decide whether this is a material change. Skip provenance for no-ops and whitespace-only formatting.
3. Classify new content honestly. Use `ai-generated` without durable sources. Use `ai-derived` only with durable source references. Preserve existing provenance by default.
4. Generate a unique `event_id`, then search the relevant daily log for it before any retry.
5. Write permitted note metadata and content. For a new note, set `created_by` and `last_modified_by` to the stable external identity. For a material edit, set only `last_modified_by`.
6. Append one extended JSONL event using the contract schema.
7. Read back the changed note and the exact JSONL line. Report whether complete provenance was recorded.

## Never

- Never use a human name or `human:` identity for an external agent or automation.
- Never invent an identity, source reference, timezone, or authorship classification. Ask the user instead.
- Do not change `created_by` on an existing note without explicit user authorization.
- Do not change `content_origin` on an existing note without explicit user authorization.
- Do not modify `edit_count`; it is plugin-owned.
- Do not write into an auto-import path with conflicting attribution unless the user explicitly directs it.
- Do not automatically retry an uncertain operation. If note metadata succeeded but log writing or read-back failed, report **partial provenance recorded**.

## Verification

A complete operation has all three outcomes:

1. The note contains only the permitted metadata change.
2. One matching event with the generated `event_id` is present in the configured daily log.
3. The agent reports the declared writer identity, content classification, source references when applicable, and any limitation or partial failure.

This skill is reference-first: compatible agent runtimes must be configured to load it. It cannot compel an arbitrary LLM, script, or untrusted writer to follow the protocol.
