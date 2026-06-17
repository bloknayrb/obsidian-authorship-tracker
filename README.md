# Authorship Tracker

Know whether a note in your vault was written by **you**, by an **AI assistant**, or
by **automation**. Authorship Tracker stamps lightweight provenance metadata onto your
notes and keeps a daily, human-readable log of who changed what.

It is built for vaults where more than one "author" touches your notes — you typing in
Obsidian, an AI assistant editing files through a CLI, or a script importing emails and
transcripts — and you want to keep those contributions straight.

## Why you might want this

In a mixed-authorship vault, every note looks the same regardless of who wrote it. That
makes it hard to:

- Tell whether you are reading your own words or AI-generated text
- Decide how much to trust a note when citing it elsewhere
- Audit which automation touched which files
- Avoid citing AI output as if it were a primary source

Authorship Tracker answers "who wrote this, and how trustworthy is it?" without you
having to think about it.

## How it works

When you type in a note, the plugin stamps a few YAML frontmatter fields:

```yaml
created_by: me
last_modified_by: me
edit_count: 7
content_origin: human-authored
```

It also appends a line to a daily [JSONL](https://jsonlines.org/) log with a short,
section-level summary of what changed.

### It only reacts to *your* typing

The plugin listens to Obsidian's `editor-change` event, which fires **only when you type
in the editor**. Edits made outside Obsidian — by a CLI tool, a sync client, a script,
or an AI agent writing to the filesystem — do **not** trigger it. That single decision
avoids a whole class of false-attribution bugs, and it is what lets the plugin
coexist with external writers (see [Integrating external writers](#integrating-external-writers-optional)).

### Auto-import detection

If you have folders that receive files from an external source (an email importer, a
meeting-transcript pipeline, etc.), you can map those folders to a source name and a
trust level. Files created there are stamped automatically. This is detected via
`vault.on('create')`, wrapped in `onLayoutReady()` so the plugin does not stampede over
every existing file when it first loads.

### First-edit creator attribution

When you type in a note that has no `created_by` field yet, the plugin records you as the
creator — but only when you actually edit it, not merely because the file exists.

## The fields it writes

| Field | Meaning |
|-------|---------|
| `created_by` | Who originally created the note |
| `last_modified_by` | Who last edited it |
| `edit_count` | Number of tracked modifications |
| `content_origin` | How trustworthy the *content* is, independent of who created the file |

### Suggested `content_origin` values

These are conventions, not enforced — use whatever vocabulary fits your workflow:

| Value | Trust level | Example |
|-------|-------------|---------|
| `primary` | Highest — citable as a source | Verbatim emails, transcripts, specs |
| `human-authored` | High — your own first-person knowledge | Notes you wrote yourself |
| `ai-derived` | Medium — traceable to a primary source | Meeting notes generated from a transcript |
| `ai-generated` | Low — verify before relying on it | AI analysis, recommendations |
| `metadata` | Not citable content | Status files, dashboards |

## The daily log

Logs are written to `<edit logs path>/YYYY-MM-DD.jsonl` (timestamps are local time):

```json
{"ts":"2026-03-19T14:30:00","file":"Tasks/Review-docs.md","author":"me","action":"modified","summary":"Modified ## Acceptance Criteria (+3 lines)"}
```

The summary compares the note by its `##` headings when it has them, and falls back to a
line-count delta for flat documents.

## Commands

| Command | What it does |
|---------|--------------|
| **Stamp authorship on current note** | Manually stamp the active note now, without waiting for the debounce |
| **Open today's authorship log** | Open today's JSONL log file |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Author name | _(empty → `me`)_ | The name stamped for your edits |
| Debounce delay | `10000` ms | How long after your last keystroke before stamping |
| Cache size | `50` | How many note snapshots to keep in memory for diffs (LRU) |
| Ignored folders | Templates, Excalidraw, .obsidian | Folders excluded from tracking (matched at any depth) |
| Ignored files | _(none)_ | File names excluded from tracking |
| Edit logs path | `Authorship Logs` | Where daily JSONL logs are written |
| Log retention | `0` (keep all) | Delete logs older than N days |
| Auto-import folders | _(none)_ | Folder → source mappings (see below) |

### Auto-import folder mappings

Each mapping is one line in settings:

```
Folder=Author|ContentOrigin[|FilenamePattern]
```

For example:

```
Emails=importer:email|primary
Meetings=importer:transcript|primary|^Transcript-
Meetings=importer:notes|ai-derived|^Notes-
```

The optional third field is a regular expression matched against the file name, so a
single folder can route different file types to different sources. Files that match no
mapping are left untouched.

## Querying the data

Because everything is plain frontmatter, you can query it with
[Dataview](https://github.com/blacksmithgu/obsidian-dataview):

```dataview
TABLE last_modified_by, edit_count, content_origin
FROM ""
WHERE content_origin = "ai-generated"
SORT file.mtime DESC
LIMIT 20
```

## Integrating external writers (optional)

The plugin only captures *your* typing inside Obsidian. If you also want to track edits
made by AI assistants or scripts, have those writers stamp the **same frontmatter fields**
and append to the **same JSONL format**. Because the plugin ignores non-editor writes,
the channels do not conflict:

- **This plugin** — your edits in Obsidian (`editor-change`)
- **An AI assistant** (e.g. a Claude Code `PostToolUse` hook) — edits made via the CLI
- **Automation** (e.g. a scheduled PowerShell/Python script) — imports and bulk updates,
  writing YAML directly and appending log lines

This is just a pattern — nothing about it ships with or is required by the plugin. The
author's own setup uses Claude Code hooks plus PowerShell scripts feeding the auto-import
folders above; adapt it to whatever tools you use.

## Installation

### From the community plugins list

Once accepted: **Settings → Community plugins → Browse → "Authorship Tracker" → Install →
Enable**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](../../releases/latest).
2. Copy them into `<vault>/.obsidian/plugins/authorship-tracker/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

### From source

```bash
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/authorship-tracker/`.

## Known limitations

- **No retroactive attribution** — only edits going forward are tracked.
- **`content_origin` is set at creation** — heavily revising an AI-generated note does
  not change its origin. This is intentional: original provenance is what matters for
  citation decisions.

## Development

```bash
npm install      # install dependencies
npm run dev      # build and watch
npm run lint     # lint
npm test         # run the unit tests
npm run build    # typecheck + production build
```

The pure logic (diffing, the LRU cache, folder matching, mapping parsing, time
formatting) lives in `src/` and is unit tested with [Vitest](https://vitest.dev/).

## License

[MIT](LICENSE)
