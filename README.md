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

- **No network requests.** The plugin never contacts a server. Lint rules keep it that
  way rather than leaving it to review: `fetch` (bare, and via `window`/`globalThis`/
  `self`), `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, the node
  `http`/`https` modules, and Obsidian's own `requestUrl`/`request` are all errors. That
  is a guard against accidental reintroduction, not a sandbox — it catches the ways a
  request would realistically be written, not every conceivable one.
- **No telemetry or analytics.** Nothing about your usage is collected or transmitted.
- **No third-party code.** `package.json` has no runtime dependencies at all, and the
  published `main.js` contains exactly one external reference: `require("obsidian")`.

Everything it writes stays inside your vault and is readable in a text editor:
[frontmatter](#the-fields-it-writes) on the notes you edit, and a
[daily JSONL log](#the-daily-log).

Worth stating plainly, because "no telemetry" alone would be misleading: **the log
describes your notes.** Its entries contain note paths and short summaries that include
`## ` heading text from the notes you edited. It travels wherever your vault travels — if
you sync, the logs sync. Put the log folder in an ignored path, or set retention, if that
matters to you.

One thing outside this plugin's control: Obsidian itself checks for plugin updates.

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

The plugin only captures *your* typing inside Obsidian. It does not detect or enforce ordinary or unmapped filesystem edits from AI assistants, scripts, sync clients, or other external writers. The exception is a configured auto-import folder: matching Markdown-file creation there can be stamped with the mapping’s configured source attribution.

For a cooperative record of those writes, configure compatible agents to load the repository’s [external-writer skill](skills/obsidian-authorship-tracker/SKILL.md) and follow the [agent provenance contract](docs/agent-provenance-contract.md). The protocol records a declared agent/automation identity, preserves existing note provenance by default, and appends a versioned JSONL event.

This is best-effort declared provenance, not identity verification or tamper-evident audit logging. An agent that lacks a configured writer identity, vault log path, timezone, source basis, or unambiguous target must ask rather than guessing. Agents should not write into configured auto-import folders unless you explicitly direct them to do so.

The skill is reference-first: it ships in this repository, but an agent runtime must be configured to load it. It cannot force an arbitrary LLM, script, or untrusted writer to comply.

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

Most behaviour is already covered by `npm test` against a mocked Obsidian API — edits,
debouncing, ignore rules, focus changes, auto-import, logging, retention, and unload are
all asserted there, so re-checking them by hand is busywork that makes the whole list
easy to skip.

These are the ones a mock cannot prove. Run them against a scratch vault with the built
`main.js` installed.

| Scenario | Why a mock can't cover it | Expected |
|---|---|---|
| Clean vault | Real plugin load against a real Obsidian build | Enables with no console errors; no files created until the first tracked edit |
| External writers | Requires a real write from outside Obsidian | Modify a note via another editor, the CLI, or sync → **no** frontmatter change and **no** log line |
| Bad filename pattern | The freeze is a real-UI symptom; tests assert the validator, not the app | Paste `(a+)+$` as a pattern and click away → a notice names the pattern and the reason, Obsidian stays responsive, other mappings keep working |
| Retention across a restart | Pruning runs at load, so it needs a genuine restart | Set retention to 1, restart Obsidian → today's and yesterday's logs survive, older ones are gone, non-log files untouched |
| Mobile | No mobile runtime in CI | Install on iOS or Android → plugin loads (`isDesktopOnly: false`), edits stamp, logs write |
| Vault sync | Sync behaviour is outside the plugin entirely | With sync enabled, confirm the log folder syncs as expected — or is excluded, if you configured that |

## License

[MIT](LICENSE)
