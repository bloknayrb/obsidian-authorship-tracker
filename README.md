# Obsidian Authorship Tracker

Track who creates and modifies notes in your Obsidian vault. Designed for human/AI collaborative vaults where both humans and AI agents edit notes.

## What It Does

When you type in a note, the plugin:
- Sets `last_modified_by: bryan` (or your configured author name) in YAML frontmatter
- Increments `edit_count` to track total modifications
- Sets `created_by` on new files
- Appends a detailed entry to a daily JSONL log with a section-level diff summary

The plugin uses Obsidian's `editor-change` event, which **only fires when you type in the editor**. External file modifications (from CLI tools, scripts, cloud sync) do not trigger stamping. This is the key design feature that prevents false attribution in multi-agent environments.

## YAML Fields

```yaml
created_by: bryan
last_modified_by: bryan
edit_count: 5
```

## JSONL Log Format

Daily logs are written to `99-System/Edit-Logs/YYYY-MM-DD.jsonl`:

```json
{"ts":"2026-03-19T14:30:00","file":"TaskNotes/Review-DRPA-docs.md","author":"bryan","action":"modified","summary":"Modified ## Acceptance Criteria (+3 lines)"}
```

## Companion Tools

This plugin is one channel in a three-channel authorship tracking system:

1. **This plugin** — captures human edits in Obsidian
2. **Claude Code hooks** — captures AI agent edits via PostToolUse/Stop hooks
3. **PowerShell function** — captures overnight automation edits

All three channels write to the same YAML fields and JSONL log format.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Author name | `bryan` | Name stamped in YAML fields |
| Debounce delay | `10000` ms | Wait after last keystroke before stamping |
| Cache size | `50` | Max file snapshots for diff computation |
| Ignored folders | Templates, Excalidraw, .obsidian, ... | Folders excluded from tracking |
| Ignored files | CLAUDE.md, GEMINI.md, ... | Files excluded from tracking |
| Edit logs path | `99-System/Edit-Logs` | Where daily JSONL logs are written |

## Building

```bash
npm install
npm run build
```

## Installation

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-authorship-tracker/` directory. Enable the plugin in Obsidian Settings > Community Plugins.
