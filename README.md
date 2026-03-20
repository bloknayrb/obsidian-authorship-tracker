# Obsidian Authorship Tracker

Track who creates and modifies notes in your Obsidian vault. Designed for vaults where humans, AI agents, and automation all edit files — and you need to know who did what.

## The Problem

In a collaborative vault, notes get created and modified by multiple sources: you typing in Obsidian, AI assistants editing via CLI, Power Automate importing emails, overnight scripts updating metadata. Without tracking, every note looks the same regardless of who wrote it. This makes it impossible to:

- Know if you're reading your own words or AI-generated content
- Apply appropriate trust levels when citing notes in deliverables
- Audit which automation touched which files
- Prevent circular citations (citing AI output as if it were a primary source)

## How It Works

The plugin stamps lightweight YAML frontmatter fields on every note it touches:

```yaml
created_by: bryan
last_modified_by: claude-interactive
edit_count: 7
content_origin: human-authored
```

It also writes detailed entries to a daily JSONL log with section-level diff summaries.

### Key Design Decision: `editor-change` Only

The plugin uses Obsidian's `editor-change` event, which **fires only when you type in the editor**. External file modifications — from CLI tools, scripts, cloud sync, or AI agents writing via the filesystem — do **not** trigger this event. This single decision eliminates the entire class of false-attribution bugs that would occur if the plugin listened to `vault.on('modify')`.

### Auto-Import Detection

Files arriving in designated folders (e.g., Power Automate email imports) are detected via `vault.on('create')` and stamped with the appropriate source author. This handler is wrapped in `onLayoutReady()` to prevent the initial vault-indexing stampede that would otherwise fire create events for every existing file when the plugin first loads.

### First-Edit Creator Attribution

When you type in a file that has no `created_by` field, the plugin stamps you as the creator. This means you only get credited as creator when you actually interact with the file — not when it appears in the vault.

## YAML Fields

| Field | Purpose | Set By |
|-------|---------|--------|
| `created_by` | Who originally created the file | Plugin (first edit or auto-import), Claude hooks, automation |
| `last_modified_by` | Who last edited the file | Plugin (human edits), Claude hooks (AI edits) |
| `edit_count` | Total number of modifications | All channels increment |
| `content_origin` | Trust level of the content itself | Plugin (auto-import), Claude hooks, audit scripts |

### Author Values

| Value | Source |
|-------|--------|
| `bryan` (configurable) | Human typing in Obsidian |
| `claude-interactive` | Claude Code main session |
| `claude-opus` / `claude-sonnet` / `claude-haiku` | Claude subagents |
| `power-automate:email` | Email imports |
| `power-automate:teams` | Teams message imports |
| `power-automate:teams-transcript` | Meeting transcripts (verbatim speech-to-text) |
| `power-automate:teams-meeting-note` | Teams Copilot AI meeting summaries |
| `automation:<name>` | Overnight scripts |

### Content Origin Values

Classifies the provenance of the content, separate from who created the file.

| Value | Trust Level | Example |
|-------|-------------|---------|
| `primary` | Highest — citable as source | Verbatim emails, transcripts, specs |
| `human-authored` | High — first-person knowledge | Notes you wrote yourself |
| `ai-derived` | Medium — trace to primary source | Meeting notes from transcripts, summaries |
| `ai-generated` | Low — requires verification | AI analysis, recommendations, reviews |
| `metadata` | N/A — not citable content | Task status, state files, dashboards |

## JSONL Log Format

Daily logs are written to `<editLogsPath>/YYYY-MM-DD.jsonl`:

```json
{"ts":"2026-03-19T14:30:00","file":"TaskNotes/Review-DRPA-docs.md","author":"bryan","action":"modified","summary":"Modified ## Acceptance Criteria (+3 lines)"}
{"ts":"2026-03-19T14:35:00","file":"TaskNotes/Review-DRPA-docs.md","author":"claude-interactive","action":"modified","summary":"Replaced 4 lines with 6 lines"}
```

The diff summary uses section-level comparison (by `##` headings) when headings exist, falling back to line-count stats for flat documents.

## Three-Channel Architecture

This plugin is one channel in a broader authorship tracking system. All three channels write to the same YAML fields and JSONL format:

| Channel | Captures | Mechanism |
|---------|----------|-----------|
| **This plugin** | Human edits in Obsidian | `editor-change` event (typing only) |
| **Claude Code hooks** | AI agent edits via CLI | PostToolUse → temp JSONL → Stop hook batch consolidation |
| **PowerShell scripts** | Overnight automation, auto-imports | Direct YAML insertion + JSONL append |

The channels are designed to not conflict:
- Plugin uses `editor-change` (human typing) — external writes don't trigger it
- Claude hooks use PostToolUse (CLI tool calls) — Obsidian events don't trigger them
- PowerShell scripts run on schedule — no event-driven conflicts

## Auto-Import Folder Mappings

Files created in these folders are automatically attributed to the mapped source:

| Folder | Author | Content Origin | Filename Pattern |
|--------|--------|---------------|-----------------|
| `Emails/` | `power-automate:email` | `primary` | — |
| `TeamsChats/messages/` | `power-automate:teams` | `primary` | — |
| `Transcripts/Processed Transcripts/` | `power-automate:teams-transcript` | `primary` | — |
| `Transcripts/Completed Notes/` | `power-automate:teams-meeting-note` | `ai-derived` | — |
| `Transcripts/General/` | `power-automate:teams-transcript` | `primary` | `^Transcript-` |
| `Transcripts/General/` | `power-automate:teams-meeting-note` | `ai-derived` | `^(MeetingNotes-\|Meeting Note-)` |

Files in `General/` matching neither pattern fall through all mappings and receive no stamp — they are handled by other channels. Configurable in Settings.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Author name | `bryan` | Your name for attribution |
| Debounce delay | `10000` ms | Wait after last keystroke before stamping |
| Cache size | `50` | Max file snapshots for diff computation (LRU) |
| Ignored folders | Templates, Excalidraw, .obsidian, ... | Folders excluded from tracking |
| Ignored files | CLAUDE.md, GEMINI.md, ... | Files excluded from tracking |
| Edit logs path | `99-System/Edit-Logs` | Where daily JSONL logs are written |
| Auto-import mappings | (see above) | Format: `Folder=Author\|ContentOrigin[\|FilenamePattern]` |

## Dataview Queries

```dataview
TABLE last_modified_by, edit_count, content_origin
FROM ""
WHERE last_modified_by = "bryan" AND date(updated) = date(today)
SORT file.mtime DESC
```

```dataview
LIST
FROM ""
WHERE content_origin = "ai-generated"
SORT file.mtime DESC
LIMIT 20
```

## Installation

### From Source

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-authorship-tracker/` directory.

**Note**: If your vault path contains special characters (like `&`), build in a temp directory:

```bash
cp main.ts package.json tsconfig.json esbuild.config.mjs /tmp/build/
cd /tmp/build && npm install && npm run build
cp main.js /path/to/vault/.obsidian/plugins/obsidian-authorship-tracker/
```

### Enable

Settings > Community Plugins > Enable "Authorship Tracker". Reload Obsidian (Ctrl+R) if the plugin doesn't appear.

## Known Limitations

- **No retroactive attribution**: The plugin only tracks edits going forward. Use the companion audit scripts for historical classification.
- **OneDrive sync can delay create events**: Files synced via OneDrive may trigger `vault.on('create')` with a delay, but attribution is still correct.
- **Content origin is set at creation**: Editing a note doesn't change its `content_origin`. If an AI-generated document is heavily revised by a human, the origin still reads `ai-generated`. This is by design — the original provenance matters for citation decisions.

## License

MIT
