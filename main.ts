import {
	App,
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";

import { LRUCache } from "./src/lru";
import { generateDiffSummary } from "./src/diff";
import {
	AutoImportMapping,
	getAutoImportResult,
	parseMappings,
	serializeMappings,
	patternProblems,
} from "./src/mappings";
import { describeProblem, setPoisonListener } from "./src/patterns";
import {
	AuthorshipTrackerSettings,
	NUMERIC_BOUNDS,
	SETTING_COPY,
	SettingKey,
	applyControlValue,
	readControlValue,
	validateControlValue,
} from "./src/settings-controls";
import { shouldIgnoreFile } from "./src/paths";
import { isLogExpired } from "./src/retention";
import { formatLocalTimestamp, localDateString } from "./src/time";

// ─── Constants ────────────────────────────────────────────────────────────────

// How long to wait after a file is created in an auto-import folder before
// stamping it, giving external importers / templates time to finish writing.
export const AUTO_IMPORT_STAMP_DELAY_MS = 3000;
// Fallback author used when no author name is configured.
const FALLBACK_AUTHOR = "me";
// Minimum interval between user-facing error notices, to avoid spamming.
const NOTICE_THROTTLE_MS = 60000;
// How long to wait after the last keystroke in the mappings textarea before
// validating and saving. Validation probes each pattern for catastrophic
// backtracking, which is far too costly to run per keystroke.
const MAPPINGS_VALIDATE_DELAY_MS = 600;

// @types/node augments the global timer overloads even though Obsidian runs in
// a browser window. Keep timer handles browser-scoped, and bridge that ambient
// type mismatch in one place.
type WindowTimer = number;
function clearWindowTimer(timer: WindowTimer): void {
	window.clearTimeout(timer as Parameters<typeof window.clearTimeout>[0]);
}

// ─── Settings ─────────────────────────────────────────────────────────────────


const DEFAULT_SETTINGS: Omit<AuthorshipTrackerSettings, "ignoreFolders"> = {
	authorName: "",
	debounceMs: 10000,
	maxCacheSize: 50,
	ignoreFiles: [],
	editLogsPath: "Authorship Logs",
	logRetentionDays: 0,
	autoImportFolders: [],
};

function defaultSettings(configDir: string): AuthorshipTrackerSettings {
	return {
		...DEFAULT_SETTINGS,
		ignoreFolders: ["Templates", "Excalidraw", configDir],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAutoImportMapping(value: unknown): value is AutoImportMapping {
	return (
		isRecord(value) &&
		typeof value.folder === "string" &&
		typeof value.author === "string" &&
		typeof value.contentOrigin === "string" &&
		(value.filenamePattern === undefined ||
			typeof value.filenamePattern === "string")
	);
}

// ─── JSONL Log Entry ──────────────────────────────────────────────────────────

interface LogEntry {
	ts: string;
	file: string;
	author: string;
	action: "modified" | "created";
	summary: string;
}

// The file behind an editor-change payload. MarkdownView and MarkdownFileInfo
// both carry `file`, but neither type guarantees it.
function infoFile(info: MarkdownView | MarkdownFileInfo): TFile | null {
	const file = (info as { file?: TFile | null }).file;
	return file instanceof TFile ? file : null;
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class AuthorshipTrackerPlugin extends Plugin {
	settings: AuthorshipTrackerSettings;
	private _stampInProgress: Set<string> = new Set();
	private _contentCache: LRUCache<string, string>;
	// Keyed by the TFile itself rather than a path string: Obsidian mutates
	// TFile.path in place on rename, so holding the object means a pending edit
	// follows its note instead of pointing at a path that no longer resolves.
	//
	// Note the deliberate duality: _contentCache and _stampInProgress stay keyed
	// by path, because they are about a location's content rather than a note's
	// identity. The rename handler re-keys the cache; _stampInProgress needs no
	// handler because an entry lives only for the duration of one stamp.
	private _pendingEdits: Map<TFile, WindowTimer> = new Map();
	// Auto-import settle timers, so a disabled plugin cannot stamp a file after
	// the fact.
	private _autoImportTimers: Set<WindowTimer> = new Set();
	private _lastNoticeTime = 0;
	// Set in onunload so in-flight work stops before it writes.
	private _unloaded = false;

	async onload() {
		await this.loadSettings();
		this.warnAboutUnusablePatterns();

		// A pattern can also be disabled mid-session, if it passes validation and
		// then proves slow on a real filename. That silently stops attributing
		// imports, so say it out loud.
		setPoisonListener((pattern) => {
			this.notifyError(
				`Disabled filename pattern "${pattern}" — it was too slow on a real filename`,
				new Error("pattern disabled at match time"),
			);
		});
		this._contentCache = new LRUCache<string, string>(
			this.settings.maxCacheSize,
		);

		// editor-change: fires ONLY when the user types in the editor.
		// External writes (CLI tools, automation, cloud sync) do NOT trigger it.
		this.registerEvent(
			this.app.workspace.on(
				"editor-change",
				(editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
					const file = infoFile(info);
					if (!file) return;
					if (this.shouldIgnore(file)) return;
					if (this._stampInProgress.has(file.path)) return;

					// Reset the debounce window for this note.
					const existing = this._pendingEdits.get(file);
					if (existing) clearWindowTimer(existing);

					// Capture the editor that emitted the event, together with the
					// view it came from. The view is what lets us check at fire time
					// that the editor still holds THIS note (see flushEdit).
					const timer = window.setTimeout(() => {
						this._pendingEdits.delete(file);
						void this.flushEdit(file, editor, info);
					}, this.settings.debounceMs);

					this._pendingEdits.set(file, timer);
				},
			),
		);

		// A pending edit for a deleted note has nothing left to stamp.
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile)) return;
				// Cancelling here is an optimisation, not a correctness requirement:
				// flushEdit re-checks that the file still exists. Dropping the
				// cached baseline, though, is required.
				const pending = this._pendingEdits.get(file);
				if (pending) {
					clearWindowTimer(pending);
					this._pendingEdits.delete(file);
				}
				this._contentCache.delete(file.path);
			}),
		);

		// A rename needs no re-keying — the map is keyed by the TFile object and
		// Obsidian mutates its path in place — but the diff baseline is cached by
		// path and would otherwise be orphaned.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				const cached = this._contentCache.get(oldPath);
				if (cached !== undefined) {
					this._contentCache.delete(oldPath);
					this._contentCache.set(file.path, cached);
				}
			}),
		);

		// Cache content when the user opens/focuses a note (for diff computation).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!leaf) return;
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) return;
				const file = view.file;
				if (!file || this.shouldIgnore(file)) return;

				this.app.vault
					.read(file)
					.then((content) => {
						this._contentCache.set(file.path, content);
					})
					.catch(() => {
						// Non-critical — diff will use a fallback summary.
					});
			}),
		);

		// Auto-import detection ONLY — wrapped in onLayoutReady to avoid the
		// initial vault-indexing stampede where vault.on('create') fires for
		// every existing file during plugin load.
		this.app.workspace.onLayoutReady(() => {
			// The plugin may have been disabled while the vault was still indexing.
			if (this._unloaded) return;

			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (!(file instanceof TFile)) return;
					if (file.extension !== "md") return;
					if (this.shouldIgnore(file)) return;

					// ONLY stamp if the file matches an auto-import folder.
					const result = getAutoImportResult(
						this.settings.autoImportFolders,
						file.path,
						file.name,
					);
					if (!result) return;

					const createPath = file.path;
					const timer = window.setTimeout(() => {
						this._autoImportTimers.delete(timer);
						const currentFile =
							this.app.vault.getAbstractFileByPath(createPath);
						if (currentFile instanceof TFile) {
							void this.handleCreate(currentFile);
						}
					}, AUTO_IMPORT_STAMP_DELAY_MS);
					this._autoImportTimers.add(timer);
				}),
			);

			// Prune old logs once, after the vault is ready (no-op unless the
			// user has enabled retention).
			void this.pruneLogs();
		});

		this.addCommand({
			id: "stamp-current-note",
			name: "Stamp authorship on current note",
			editorCallback: (editor: Editor, ctx) => {
				const file = ctx.file;
				if (file instanceof TFile) {
					void this.handleEdit(file, editor.getValue());
				}
			},
		});

		this.addCommand({
			id: "open-todays-log",
			name: "Open today's authorship log",
			callback: async () => {
				const dir = normalizePath(this.settings.editLogsPath);
				const logPath = normalizePath(
					`${dir}/${localDateString(new Date())}.jsonl`,
				);
				const file = this.app.vault.getAbstractFileByPath(logPath);
				if (file instanceof TFile) {
					await this.app.workspace.getLeaf(false).openFile(file);
				} else {
					new Notice("No authorship log for today yet.");
				}
			},
		});

		this.addSettingTab(new AuthorshipTrackerSettingTab(this.app, this));
	}

	onunload() {
		this._unloaded = true;

		// A disabled plugin must not touch the vault. Both kinds of pending work
		// are cancelled rather than flushed: onunload is synchronous and
		// un-awaited, so anything started here would land after teardown, and a
		// write arriving from a plugin the user has just switched off is worse
		// than losing an edit that was still inside its debounce window.
		for (const timer of this._pendingEdits.values()) {
			clearWindowTimer(timer);
		}
		this._pendingEdits.clear();

		for (const timer of this._autoImportTimers) {
			clearWindowTimer(timer);
		}
		this._autoImportTimers.clear();
	}

	// A stored filename pattern never passes back through the settings tab, so a
	// pattern that cannot be used would otherwise fail silently — auto-imported
	// notes would just stop being attributed, with no indication why. In a
	// provenance plugin that is the worst possible failure mode, so say it out
	// loud once at load.
	private warnAboutUnusablePatterns(): void {
		const issues = patternProblems(this.settings.autoImportFolders);
		if (issues.length === 0) return;

		const detail = issues
			.map((i) => `"${i.pattern}" (${describeProblem(i.problem)})`)
			.join("; ");
		console.error(
			`[authorship-tracker] Ignoring unusable filename pattern(s): ${detail}`,
		);
		new Notice(
			`Authorship Tracker: ignoring unusable filename pattern(s): ${detail}. Auto-import for those folders is disabled until they are fixed.`,
		);
	}

	// Exposed so the settings tab's debounced save can check it too.
	get isDisabled(): boolean {
		return this._unloaded;
	}

	private authorName(): string {
		return this.settings.authorName.trim() || FALLBACK_AUTHOR;
	}

	private shouldIgnore(file: TFile): boolean {
		return shouldIgnoreFile(
			file.path,
			file.name,
			this.settings.ignoreFiles,
			this.settings.ignoreFolders,
		);
	}

	// Resolve the content for a debounced edit and stamp it.
	//
	// The captured editor is validated, never trusted: an Obsidian leaf can be
	// re-pointed at a different note (clicking a link in the same tab), and the
	// Editor object survives that. Reading it blindly would stamp THIS note's
	// frontmatter using the OTHER note's text, and poison the diff baseline with
	// it. So we only call getValue() when the view still holds this file.
	//
	// Note what is NOT here: no scan of the workspace for a leaf showing the file.
	// The emitting editor is already in hand, and a scan would miss canvas and
	// popover editors, and deferred leaves, which never appear as markdown leaves.
	private async flushEdit(
		file: TFile,
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
	): Promise<void> {
		// The note may have been deleted, or the settings changed, during the
		// debounce window.
		// Identity, not just "a TFile lives at this path" — another note moved into
		// the path would satisfy the weaker check.
		if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
		if (this.shouldIgnore(file)) return;

		let content: string | null = null;
		if (infoFile(info) === file) {
			try {
				content = editor.getValue();
			} catch {
				content = null;
			}
		}

		if (content === null) {
			try {
				// vault.read, not cachedRead: the cached copy can predate the edit
				// we are trying to record.
				content = await this.app.vault.read(file);
			} catch (err) {
				this.notifyError("Failed to read edited note", err);
				return;
			}
		}

		// A no-op editor-change — an undo back to the original, or the plugin's own
		// frontmatter write echoing back — should not inflate edit_count or add a
		// log line. This lives here rather than in handleEdit deliberately: the
		// stamp-current-note command also calls handleEdit, and an explicit user
		// action must always stamp, even when the content is unchanged.
		if (content === (this._contentCache.get(file.path) ?? "")) return;

		await this.handleEdit(file, content);
	}

	private async handleEdit(file: TFile, currentContent: string) {
		// Capture the key: a rename mid-stamp mutates TFile.path in place, and
		// releasing under the new path would strand the old one — permanently
		// blocking any note that later occupies it.
		const stampKey = file.path;
		if (this._stampInProgress.has(stampKey)) return;
		this._stampInProgress.add(stampKey);

		const cachedContent = this._contentCache.get(file.path) ?? "";
		const author = this.authorName();

		const summary = cachedContent
			? generateDiffSummary(cachedContent, currentContent)
			: "Initial edit (no cached baseline)";

		// Update cache with post-edit snapshot
		this._contentCache.set(file.path, currentContent);

		try {
			await this.app.fileManager.processFrontMatter(file, (rawFrontmatter) => {
				const frontmatter: unknown = rawFrontmatter;
				if (!isRecord(frontmatter)) return;
				// Last point at which an in-flight stamp can still be abandoned:
				// processFrontMatter reads the file before invoking this, so the
				// plugin may have been disabled in between. Returning without
				// mutating leaves the frontmatter untouched.
				if (this._unloaded) return;

				// Only claim creation if no creator is recorded yet AND the file
				// is not owned by an auto-import mapping (whose create handler
				// sets the authoritative origin). Never overwrite an existing
				// content_origin.
				if (!frontmatter["created_by"]) {
					const auto = getAutoImportResult(
						this.settings.autoImportFolders,
						file.path,
						file.name,
					);
					if (!auto) {
						frontmatter["created_by"] = author;
						if (!frontmatter["content_origin"]) {
							frontmatter["content_origin"] = "human-authored";
						}
					}
				}
				frontmatter["last_modified_by"] = author;
				frontmatter["edit_count"] =
					typeof frontmatter["edit_count"] === "number"
						? frontmatter["edit_count"] + 1
						: 1;
			});

			await this.appendLog({
				ts: formatLocalTimestamp(new Date()),
				file: file.path,
				author,
				action: "modified",
				summary,
			});
		} catch (err) {
			this.notifyError("Failed to stamp edit", err);
		} finally {
			this._stampInProgress.delete(stampKey);
		}
	}

	private async handleCreate(file: TFile) {
		const stampKey = file.path;
		if (this._stampInProgress.has(stampKey)) return;
		this._stampInProgress.add(stampKey);

		// Determine author + content origin from the auto-import mapping.
		const result = getAutoImportResult(
			this.settings.autoImportFolders,
			file.path,
			file.name,
		);
		const author = result?.author ?? this.authorName();
		const contentOrigin = result?.contentOrigin ?? "human-authored";
		const summary = result
			? `Auto-imported from ${author}`
			: "File created by user";

		try {
			let alreadyHasField = false;

			await this.app.fileManager.processFrontMatter(file, (rawFrontmatter) => {
				const frontmatter: unknown = rawFrontmatter;
				if (!isRecord(frontmatter)) return;
				if (frontmatter["created_by"]) {
					alreadyHasField = true;
					return;
				}
				frontmatter["created_by"] = author;
				if (!frontmatter["content_origin"]) {
					frontmatter["content_origin"] = contentOrigin;
				}
			});

			if (!alreadyHasField) {
				const content = await this.app.vault.read(file);
				this._contentCache.set(file.path, content);

				await this.appendLog({
					ts: formatLocalTimestamp(new Date()),
					file: file.path,
					author,
					action: "created",
					summary,
				});
			}
		} catch (err) {
			this.notifyError("Failed to stamp creation", err);
		} finally {
			this._stampInProgress.delete(stampKey);
		}
	}

	private async appendLog(entry: LogEntry): Promise<void> {
		// Reached after awaited frontmatter writes; the plugin may be gone by now.
		if (this._unloaded) return;

		const dir = normalizePath(this.settings.editLogsPath);
		const logPath = normalizePath(
			`${dir}/${localDateString(new Date())}.jsonl`,
		);
		const line = JSON.stringify(entry) + "\n";

		try {
			const folder = this.app.vault.getAbstractFileByPath(dir);
			if (!folder) {
				try {
					await this.app.vault.createFolder(dir);
				} catch {
					// May already exist due to a concurrent create — ignore.
				}
			}

			const existingFile = this.app.vault.getAbstractFileByPath(logPath);
			if (existingFile instanceof TFile) {
				// Atomic read-modify-write avoids interleaved-append races.
				await this.app.vault.process(existingFile, (data) => data + line);
			} else {
				try {
					await this.app.vault.create(logPath, line);
				} catch {
					// Lost the create race — append to the now-existing file.
					const f = this.app.vault.getAbstractFileByPath(logPath);
					if (f instanceof TFile) {
						await this.app.vault.process(f, (data) => data + line);
					}
				}
			}
		} catch (err) {
			this.notifyError("Failed to write authorship log", err);
		}
	}

	private async pruneLogs(now: Date = new Date()): Promise<void> {
		const days = this.settings.logRetentionDays;
		if (!days || days <= 0) return;

		const dir = normalizePath(this.settings.editLogsPath);
		const folder = this.app.vault.getAbstractFileByPath(dir);
		if (!(folder instanceof TFolder)) return;

		// Iterate a snapshot: vault.delete() splices folder.children, and walking
		// the live array while deleting from it skips every other match — with four
		// expired logs, two of them survived every prune.
		for (const child of folder.children.slice()) {
			// pruneLogs is launched un-awaited from onLayoutReady, so it can still
			// be deleting when the user disables the plugin.
			if (this._unloaded) return;
			if (!(child instanceof TFile)) continue;
			if (!isLogExpired(child.name, now, days)) continue;
			try {
				await this.app.fileManager.trashFile(child);
			} catch (err) {
				this.notifyError("Failed to prune old log", err);
			}
		}
	}

	private notifyError(message: string, err: unknown): void {
		console.error(`[authorship-tracker] ${message}:`, err);
		const now = Date.now();
		if (now - this._lastNoticeTime > NOTICE_THROTTLE_MS) {
			this._lastNoticeTime = now;
			new Notice(`Authorship Tracker: ${message}.`);
		}
	}

	async loadSettings() {
		const stored: unknown = await this.loadData();
		const data = isRecord(stored) ? stored : {};
		const defaults = defaultSettings(this.app.vault.configDir);
		this.settings = {
			authorName:
				typeof data.authorName === "string"
					? data.authorName
					: defaults.authorName,
			debounceMs:
				typeof data.debounceMs === "number"
					? data.debounceMs
					: defaults.debounceMs,
			maxCacheSize:
				typeof data.maxCacheSize === "number"
					? data.maxCacheSize
					: defaults.maxCacheSize,
			ignoreFolders: isStringArray(data.ignoreFolders)
				? data.ignoreFolders
				: defaults.ignoreFolders,
			ignoreFiles: isStringArray(data.ignoreFiles)
				? data.ignoreFiles
				: defaults.ignoreFiles,
			editLogsPath:
				typeof data.editLogsPath === "string"
					? data.editLogsPath
					: defaults.editLogsPath,
			logRetentionDays:
				typeof data.logRetentionDays === "number"
					? data.logRetentionDays
					: defaults.logRetentionDays,
			autoImportFolders: Array.isArray(data.autoImportFolders)
				? data.autoImportFolders.filter(isAutoImportMapping)
				: defaults.autoImportFolders,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this._contentCache?.resize(this.settings.maxCacheSize);
	}
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

// Report unusable filename patterns in a set of mappings, if any.
//
// The mappings are already stored by the time this runs. An unusable pattern is
// kept verbatim rather than stripped: getAutoImportResult treats it as a
// non-match, so the mapping never fires, whereas stripping it would leave a bare
// Folder=Author|Origin rule matching every file in that folder.
function warnAboutMappingPatterns(mappings: AutoImportMapping[]): void {
	const issues = patternProblems(mappings);
	if (issues.length === 0) return;
	const detail = issues
		.map((i) => `"${i.pattern}" (${describeProblem(i.problem)})`)
		.join("; ");
	new Notice(
		`Authorship Tracker: unusable filename pattern(s): ${detail}. Those mappings will not match anything until fixed.`,
	);
}

// Adapter for the control `validate` hook, which expects a message or nothing.
function validateMessage(key: SettingKey, value: unknown): string | void {
	const message = validateControlValue(key, value);
	if (message) return message;
}

class AuthorshipTrackerSettingTab extends PluginSettingTab {
	plugin: AuthorshipTrackerPlugin;
	private _mappingsDebounce: WindowTimer | null = null;
	private _pendingMappings: string | null = null;

	constructor(app: App, plugin: AuthorshipTrackerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Closing the settings tab must not discard an edit still inside the debounce
	// window — that would be a regression from the previous save-per-keystroke
	// behavior, and the user has no way to know it happened.
	hide(): void {
		this.flushMappings();
	}

	private flushMappings(): void {
		if (this._mappingsDebounce) {
			clearWindowTimer(this._mappingsDebounce);
			this._mappingsDebounce = null;
		}
		const pending = this._pendingMappings;
		this._pendingMappings = null;
		if (pending !== null) void this.commitMappings(pending);
	}

	// Save what the user typed, and report any pattern that cannot be used.
	//
	// Two deliberate choices here. First, the whole textarea is saved rather than
	// rejected: previously a single bad pattern discarded every other mapping the
	// user had just typed. Second, an unusable pattern is kept verbatim rather
	// than stripped — getAutoImportResult treats it as a non-match, so the
	// mapping simply never fires. Stripping it would leave a bare
	// `Folder=Author|Origin` rule that matches EVERY file in that folder, turning
	// a bad pattern into mass mis-attribution.
	private async commitMappings(value: string): Promise<void> {
		// The debounce can outlive the plugin being disabled.
		if (this.plugin.isDisabled) return;

		const mappings = parseMappings(value);
		warnAboutMappingPatterns(mappings);

		this.plugin.settings.autoImportFolders = mappings;
		await this.plugin.saveSettings();
	}

	// ── Declarative settings (Obsidian 1.13+) ────────────────────────────────
	//
	// Returning a non-empty array here means Obsidian renders the tab itself and
	// never calls display(), which buys settings search and consistent layout.
	// display() is kept below as the pre-1.13 path: older Obsidian has no call
	// site for these three methods, so they are inert there and minAppVersion
	// stays at 1.6.6 rather than cutting off everyone below 1.13.
	//
	// Called once from addSettingTab() during onload for search indexing, and on
	// every open — so it must be safe to run at load time. It is: settings are
	// loaded before the tab is registered.
	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		const configDir = this.app.vault.configDir;
		const copy = SETTING_COPY;
		return [
			{
				name: copy.authorName.name,
				desc: copy.authorName.desc,
				control: {
					type: "text",
					key: "authorName",
					placeholder: copy.authorName.placeholder,
				},
			},
			{
				name: copy.debounceMs.name,
				desc: copy.debounceMs.desc,
				control: {
					type: "number",
					key: "debounceMs",
					placeholder: copy.debounceMs.placeholder,
					min: NUMERIC_BOUNDS.debounceMs,
					// An unparseable field falls back to defaultValue, so this must
					// be a usable delay rather than the implicit 0.
					defaultValue: DEFAULT_SETTINGS.debounceMs,
					validate: (value) => validateMessage("debounceMs", value),
				},
			},
			{
				name: copy.maxCacheSize.name,
				desc: copy.maxCacheSize.desc,
				control: {
					type: "number",
					key: "maxCacheSize",
					placeholder: copy.maxCacheSize.placeholder,
					min: NUMERIC_BOUNDS.maxCacheSize,
					defaultValue: DEFAULT_SETTINGS.maxCacheSize,
					validate: (value) => validateMessage("maxCacheSize", value),
				},
			},
			{
				name: copy.ignoreFolders.name,
				desc: copy.ignoreFolders.desc,
				control: {
					type: "textarea",
					key: "ignoreFolders",
					placeholder: copy.ignoreFolders.placeholder(configDir),
				},
			},
			{
				name: copy.ignoreFiles.name,
				desc: copy.ignoreFiles.desc,
				control: {
					type: "textarea",
					key: "ignoreFiles",
					placeholder: copy.ignoreFiles.placeholder,
				},
			},
			{
				name: copy.editLogsPath.name,
				desc: copy.editLogsPath.desc,
				control: {
					type: "text",
					key: "editLogsPath",
					placeholder: copy.editLogsPath.placeholder,
					validate: (value) => validateMessage("editLogsPath", value),
				},
			},
			{
				name: copy.logRetentionDays.name,
				desc: copy.logRetentionDays.desc,
				control: {
					type: "number",
					key: "logRetentionDays",
					placeholder: copy.logRetentionDays.placeholder,
					min: NUMERIC_BOUNDS.logRetentionDays,
					defaultValue: DEFAULT_SETTINGS.logRetentionDays,
					validate: (value) => validateMessage("logRetentionDays", value),
				},
			},
			{
				type: "group",
				heading: copy.autoImportFolders.heading,
				items: [
					{
						name: copy.autoImportFolders.name,
						desc: copy.autoImportFolders.desc,
						control: {
							type: "textarea",
							key: "autoImportFolders",
							rows: 8,
							placeholder: copy.autoImportFolders.placeholder,
							// Deliberately no validate: returning a message would
							// reject the whole textarea over one bad pattern, and
							// validate also runs on mount, which would probe every
							// stored pattern on the UI thread each time settings
							// open. Unusable patterns are reported by Notice instead.
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return readControlValue(this.plugin.settings, key as SettingKey);
	}

	// Every key is handled explicitly and the write goes through the plugin's own
	// saveSettings(), never the inherited default. Two reasons:
	//
	//   * saveSettings() also resizes the live content cache. The default write
	//     path only persists, so "Cache size" would save a new number and leave
	//     the running cache at its old capacity.
	//   * the default would happily store a raw textarea string in an
	//     array-typed field; loadSettings rejects malformed values and silently
	//     substitutes defaults, so a missed key would quietly wipe the user's
	//     ignore lists and auto-import mappings on the next launch.
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (this.plugin.isDisabled) return;
		const settingKey = key as SettingKey;
		applyControlValue(this.plugin.settings, settingKey, value);
		await this.plugin.saveSettings();
		// Unlike display(), the value is stored immediately: Obsidian reseeds a
		// control from getControlValue on every render, and a render can happen
		// while a debounce is pending (search, a visibility predicate), which
		// would discard what the user had typed. Only the cost of pattern
		// validation is deferred.
		if (settingKey === "autoImportFolders") this.scheduleMappingWarning();
	}

	// Warn about unusable filename patterns, debounced. Validation probes each
	// pattern against adversarial inputs and is far too costly per keystroke.
	private scheduleMappingWarning(): void {
		if (this._mappingsDebounce) clearWindowTimer(this._mappingsDebounce);
		this._mappingsDebounce = window.setTimeout(() => {
			this._mappingsDebounce = null;
			if (this.plugin.isDisabled) return;
			warnAboutMappingPatterns(this.plugin.settings.autoImportFolders);
		}, MAPPINGS_VALIDATE_DELAY_MS);
	}

	// ── Imperative settings (pre-1.13 fallback) ──────────────────────────────
	//
	// Not called on 1.13+, where getSettingDefinitions() renders the tab instead.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(SETTING_COPY.authorName.name)
			.setDesc(SETTING_COPY.authorName.desc)
			.addText((text) =>
				text
					.setPlaceholder(SETTING_COPY.authorName.placeholder)
					.setValue(this.plugin.settings.authorName)
					.onChange(async (value) => {
						this.plugin.settings.authorName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(SETTING_COPY.debounceMs.name)
			.setDesc(SETTING_COPY.debounceMs.desc)
			.addText((text) =>
				text
					.setPlaceholder(SETTING_COPY.debounceMs.placeholder)
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const parsed = parseInt(value);
						if (!isNaN(parsed) && parsed >= 1000) {
							this.plugin.settings.debounceMs = parsed;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(SETTING_COPY.maxCacheSize.name)
			.setDesc(SETTING_COPY.maxCacheSize.desc)
			.addText((text) =>
				text
					.setPlaceholder(SETTING_COPY.maxCacheSize.placeholder)
					.setValue(String(this.plugin.settings.maxCacheSize))
					.onChange(async (value) => {
						const parsed = parseInt(value);
						if (!isNaN(parsed) && parsed >= 1) {
							this.plugin.settings.maxCacheSize = parsed;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(SETTING_COPY.ignoreFolders.name)
			.setDesc(SETTING_COPY.ignoreFolders.desc)
			.addTextArea((text) =>
				text
					.setPlaceholder(
						SETTING_COPY.ignoreFolders.placeholder(
							this.app.vault.configDir,
						),
					)
					.setValue(this.plugin.settings.ignoreFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.ignoreFolders = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(SETTING_COPY.ignoreFiles.name)
			.setDesc(SETTING_COPY.ignoreFiles.desc)
			.addTextArea((text) =>
				text
					.setPlaceholder(SETTING_COPY.ignoreFiles.placeholder)
					.setValue(this.plugin.settings.ignoreFiles.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.ignoreFiles = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(SETTING_COPY.editLogsPath.name)
			.setDesc(SETTING_COPY.editLogsPath.desc)
			.addText((text) =>
				text
					.setPlaceholder(SETTING_COPY.editLogsPath.placeholder)
					.setValue(this.plugin.settings.editLogsPath)
					.onChange(async (value) => {
						const trimmed = value.trim();
						if (!trimmed) {
							new Notice(
								"Authorship Tracker: edit logs path cannot be empty.",
							);
							return;
						}
						this.plugin.settings.editLogsPath = trimmed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(SETTING_COPY.logRetentionDays.name)
			.setDesc(SETTING_COPY.logRetentionDays.desc)
			.addText((text) =>
				text
					.setPlaceholder(SETTING_COPY.logRetentionDays.placeholder)
					.setValue(String(this.plugin.settings.logRetentionDays))
					.onChange(async (value) => {
						const parsed = parseInt(value);
						if (!isNaN(parsed) && parsed >= 0) {
							this.plugin.settings.logRetentionDays = parsed;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(SETTING_COPY.autoImportFolders.heading)
			.setHeading();

		const desc = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		desc.setText(
			"Files created in these folders are stamped with the mapped author and content origin. One mapping per line: Folder=Author|ContentOrigin[|FilenamePattern].",
		);

		new Setting(containerEl)
			.setName(SETTING_COPY.autoImportFolders.name)
			.setDesc(SETTING_COPY.autoImportFolders.desc)
			.addTextArea((text) => {
				text.inputEl.rows = 8;
				text.inputEl.cols = 50;
				text
					.setPlaceholder(
						SETTING_COPY.autoImportFolders.placeholder,
					)
					.setValue(
						serializeMappings(
							this.plugin.settings.autoImportFolders,
						),
					)
					.onChange((value) => {
						// Validation runs the pattern against adversarial probe
						// inputs, which costs real time on a pathological one, so it
						// must not run on every keystroke — and a half-typed pattern
						// like "^(" is not an error worth shouting about yet.
						if (this._mappingsDebounce) {
							clearWindowTimer(this._mappingsDebounce);
						}
						this._pendingMappings = value;
						this._mappingsDebounce = window.setTimeout(() => {
							this._mappingsDebounce = null;
							const pending = this._pendingMappings;
							this._pendingMappings = null;
							if (pending !== null) void this.commitMappings(pending);
						}, MAPPINGS_VALIDATE_DELAY_MS);
					});
			});
	}
}
