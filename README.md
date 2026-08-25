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

## Privacy

Authorship Tracker runs entirely inside your vault:

- **No network requests.** The plugin never contacts a server. This is enforced in CI,
  not just asserted — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and the node
  `http`/`https` modules are lint errors in this codebase.
- **No telemetry or analytics.** Nothing about your usage is collected or transmitted.
- **No third-party code.** `package.json` has no runtime dependencies at all, and the
  published `main.js` contains exactly one external reference: `require("obsidian")`.

What it *does* write, all of it inside your vault and readable in a text editor:

- YAML frontmatter on the notes you edit (`created_by`, `content_origin`,
  `last_modified_by`, `edit_count`)
- a daily JSONL log in the folder you configure, containing note paths, your author
  name, timestamps, and short summaries that include `## ` heading text from the notes
  you edited

That last point is worth stating plainly: **the log describes your notes**, so it travels
wherever your vault travels. If you sync your vault, the logs sync too. Put the log
folder in an ignored path, or set retention, if that matters to you.

Two things outside this plugin's control: Obsidian itself checks for plugin updates, and
the links in this README are documentation, not runtime behaviour.

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
| Log retention | `0` (keep all) | Delete logs older than N whole calendar days (`1` keeps today and yesterday) |
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

Only the first two `|` separate fields, so a pattern may contain alternations of its
own — `Meetings=importer:notes|ai-derived|(Notes|Summary)-.*\.md$` works as written.

#### Pattern limits

The match runs on the UI thread while Obsidian is handling a vault event, so a regex
that backtracks catastrophically can freeze the app. `(a+)+$` against a thirty-character
filename takes about twelve seconds — this is not bounded by how short filenames are.

Patterns are therefore checked before use: anything over 200 characters is refused, and
each pattern is run against short adversarial inputs and timed. One that is measurably
slow on a 24-character probe is rejected, because that is what a hang on a real filename
looks like early. A rejected pattern is reported in settings and again on load, and its
mapping simply never matches — it is **not** downgraded to matching every file in the
folder.

This is a practical check, not a guarantee. It has no false positives on ordinary
patterns and catches the known catastrophic shapes, but it cannot promise to catch every
possible one; a pattern that slips through and proves slow in use is disabled for the
rest of the session the first time it is measured. Keep patterns simple — anchored
prefixes like `^Transcript-` are the intended use, and nested quantified groups such as
`(\w+)+` are worth avoiding regardless.

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
- **Filename patterns are screened, not sandboxed** — see [Pattern limits](#pattern-limits).
  A pattern that survives screening and later proves slow is disabled after its first
  slow match, not before it.
- **Log pruning runs at load** — retention is applied when the plugin starts, so a
  vault left open for days will not prune until Obsidian is restarted.
- **Disabling the plugin cancels pending work** — an edit still inside its debounce
  window, or an auto-import file still inside its settle delay, is dropped rather than
  written, and a stamp already in flight is abandoned before it writes. The one thing
  a disabled plugin may still do is finish rewriting a file it had already opened,
  leaving its contents unchanged.

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

### Releasing

```bash
npm version <x.y.z>   # runs version-bump.mjs, stages manifest.json + versions.json
git push && git push --tags
```

Pushing the tag runs `.github/workflows/release.yml`, which refuses to publish unless:

- the tag equals `manifest.json`'s version **exactly**, with no `v` prefix — Obsidian's
  plugin updater requires this, and `.npmrc` clears npm's default `v` so `npm version`
  produces the right tag
- `package.json`'s version matches too
- `versions.json` maps that version to the manifest's `minAppVersion`
- `npm run verify` passes (lint, both typechecks, the full suite)

Steps are fail-fast, so any failure means no GitHub Release is created.

Edit `manifest.json`'s version by hand and the `versions.json` check will catch it — use
`npm version` so `version-bump.mjs` keeps the two in step.

### Pre-release smoke tests

The automated suite covers plugin logic against a mocked Obsidian API; these are the
checks that need a real vault. Run them against a scratch vault with the built `main.js`
installed.

| Scenario | Steps | Expected |
|---|---|---|
| Clean vault | Enable the plugin in an empty vault | Loads with no errors; no files created until the first tracked edit |
| Normal edits | Type in a note, wait out the debounce | `created_by`, `content_origin`, `last_modified_by`, `edit_count` appear; one log line with a section-level summary. Edit again → `edit_count` increments |
| No-op edit | Type, undo back to the original, wait | No new log line, `edit_count` unchanged |
| Ignored paths | Edit a note under `Templates/`, and one named in *Ignored files* | No frontmatter change, no log line, while a normal note edited in the same session **is** stamped |
| External writers | Modify a note outside Obsidian (editor, CLI, sync) | No frontmatter change and no log line — the plugin only reacts to typing in the editor |
| Focus changes | Edit a note, then immediately switch tabs before the debounce fires | The **edited** note is stamped, not the one now in focus. Repeat with a split pane |
| Auto-import | Drop a file into a mapped folder | After ~3s it carries the mapped `created_by`/`content_origin` and a `"created"` log line. A non-matching filename in the same folder is untouched |
| Bad pattern | Paste `(a+)+$` as a filename pattern and click away | A notice names the pattern and the reason; Obsidian does not freeze; that mapping stops matching but others still work |
| Logging | Check the log folder | `<path>/YYYY-MM-DD.jsonl`, one JSON object per line, appended not overwritten |
| Retention | Set retention to 1 and **restart Obsidian** | Today's and yesterday's logs survive; older ones are deleted. Non-log files in that folder are untouched |
| Disable / re-enable | Type, then disable the plugin mid-debounce | The pending edit is dropped rather than written. Re-enable → tracking resumes with no duplicate stamps |
| Mobile | Install on iOS or Android | Plugin loads (`isDesktopOnly: false`, no Node or Electron APIs used), edits stamp, logs write |

## License

[MIT](LICENSE)
