import {
	App,
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
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
	invalidPatterns,
} from "./src/mappings";
import { shouldIgnoreFile } from "./src/paths";
import { formatLocalTimestamp, localDateString } from "./src/time";

// ─── Constants ────────────────────────────────────────────────────────────────

// How long to wait after a file is created in an auto-import folder before
// stamping it, giving external importers / templates time to finish writing.
const AUTO_IMPORT_STAMP_DELAY_MS = 3000;
// Fallback author used when no author name is configured.
const FALLBACK_AUTHOR = "me";
// Minimum interval between user-facing error notices, to avoid spamming.
const NOTICE_THROTTLE_MS = 60000;

// ─── Settings ─────────────────────────────────────────────────────────────────

interface AuthorshipTrackerSettings {
	authorName: string;
	debounceMs: number;
	maxCacheSize: number;
	ignoreFolders: string[];
	ignoreFiles: string[];
	editLogsPath: string;
	logRetentionDays: number;
	autoImportFolders: AutoImportMapping[];
}

const DEFAULT_SETTINGS: AuthorshipTrackerSettings = {
	authorName: "",
	debounceMs: 10000,
	maxCacheSize: 50,
	ignoreFolders: ["Templates", "Excalidraw", ".obsidian"],
	ignoreFiles: [],
	editLogsPath: "Authorship Logs",
	logRetentionDays: 0,
	autoImportFolders: [],
};

// ─── JSONL Log Entry ──────────────────────────────────────────────────────────

interface LogEntry {
	ts: string;
	file: string;
	author: string;
	action: "modified" | "created";
	summary: string;
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class AuthorshipTrackerPlugin extends Plugin {
	settings: AuthorshipTrackerSettings;
	private _stampInProgress: Set<string> = new Set();
	private _contentCache: LRUCache<string, string>;
	private _debounceTimers: Map<string, ReturnType<typeof setTimeout>> =
		new Map();
	private _lastNoticeTime = 0;

	async onload() {
		await this.loadSettings();
		this._contentCache = new LRUCache<string, string>(
			this.settings.maxCacheSize,
		);

		// editor-change: fires ONLY when the user types in the editor.
		// External writes (CLI tools, automation, cloud sync) do NOT trigger it.
		this.registerEvent(
			this.app.workspace.on(
				"editor-change",
				(editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
					const file =
						(info as MarkdownView).file ??
						(info as MarkdownFileInfo).file;
					if (!file || !(file instanceof TFile)) return;
					if (this.shouldIgnore(file)) return;
					if (this._stampInProgress.has(file.path)) return;

					// Reset debounce timer
					const existing = this._debounceTimers.get(file.path);
					if (existing) clearTimeout(existing);

					// Capture file path for stale-reference safety check
					const filePath = file.path;
					const timer = setTimeout(() => {
						this._debounceTimers.delete(filePath);
						// Verify the editor is still showing the same file
						const activeView =
							this.app.workspace.getActiveViewOfType(MarkdownView);
						if (activeView?.file?.path === filePath) {
							this.handleEdit(activeView.editor, activeView.file);
						}
					}, this.settings.debounceMs);

					this._debounceTimers.set(file.path, timer);
				},
			),
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
					setTimeout(() => {
						const currentFile =
							this.app.vault.getAbstractFileByPath(createPath);
						if (currentFile instanceof TFile) {
							this.handleCreate(currentFile);
						}
					}, AUTO_IMPORT_STAMP_DELAY_MS);
				}),
			);

			// Prune old logs once, after the vault is ready (no-op unless the
			// user has enabled retention).
			this.pruneLogs();
		});

		this.addCommand({
			id: "stamp-current-note",
			name: "Stamp authorship on current note",
			editorCallback: (editor: Editor, ctx) => {
				const file = ctx.file;
				if (file instanceof TFile) {
					this.handleEdit(editor, file);
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
		for (const timer of this._debounceTimers.values()) {
			clearTimeout(timer);
		}
		this._debounceTimers.clear();
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

	private async handleEdit(editor: Editor, file: TFile) {
		if (this._stampInProgress.has(file.path)) return;
		this._stampInProgress.add(file.path);

		const author = this.authorName();
		const currentContent = editor.getValue();
		const cachedContent = this._contentCache.get(file.path) ?? "";

		const summary = cachedContent
			? generateDiffSummary(cachedContent, currentContent)
			: "Initial edit (no cached baseline)";

		// Update cache with post-edit snapshot
		this._contentCache.set(file.path, currentContent);

		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				// Only claim creation if no creator is recorded yet AND the file
				// is not owned by an auto-import mapping (whose create handler
				// sets the authoritative origin). Never overwrite an existing
				// content_origin.
				if (!fm["created_by"]) {
					const auto = getAutoImportResult(
						this.settings.autoImportFolders,
						file.path,
						file.name,
					);
					if (!auto) {
						fm["created_by"] = author;
						if (!fm["content_origin"]) {
							fm["content_origin"] = "human-authored";
						}
					}
				}
				fm["last_modified_by"] = author;
				fm["edit_count"] =
					typeof fm["edit_count"] === "number"
						? fm["edit_count"] + 1
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
			this._stampInProgress.delete(file.path);
		}
	}

	private async handleCreate(file: TFile) {
		if (this._stampInProgress.has(file.path)) return;
		this._stampInProgress.add(file.path);

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

			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (fm["created_by"]) {
					alreadyHasField = true;
					return;
				}
				fm["created_by"] = author;
				if (!fm["content_origin"]) {
					fm["content_origin"] = contentOrigin;
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
			this._stampInProgress.delete(file.path);
		}
	}

	private async appendLog(entry: LogEntry): Promise<void> {
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

	private async pruneLogs(): Promise<void> {
		const days = this.settings.logRetentionDays;
		if (!days || days <= 0) return;

		const dir = normalizePath(this.settings.editLogsPath);
		const folder = this.app.vault.getAbstractFileByPath(dir);
		if (!(folder instanceof TFolder)) return;

		const cutoff = Date.now() - days * 86400000;
		for (const child of folder.children) {
			if (!(child instanceof TFile)) continue;
			if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(child.name)) continue;
			const t = Date.parse(child.name.slice(0, 10) + "T00:00:00");
			if (!isNaN(t) && t < cutoff) {
				try {
					await this.app.vault.delete(child);
				} catch (err) {
					this.notifyError("Failed to prune old log", err);
				}
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
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this._contentCache?.resize(this.settings.maxCacheSize);
	}
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class AuthorshipTrackerSettingTab extends PluginSettingTab {
	plugin: AuthorshipTrackerPlugin;

	constructor(app: App, plugin: AuthorshipTrackerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Author name")
			.setDesc(
				"Name to stamp in the last_modified_by and created_by fields.",
			)
			.addText((text) =>
				text
					.setPlaceholder("me")
					.setValue(this.plugin.settings.authorName)
					.onChange(async (value) => {
						this.plugin.settings.authorName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Debounce delay")
			.setDesc(
				"Milliseconds to wait after the last keystroke before stamping (minimum 1000).",
			)
			.addText((text) =>
				text
					.setPlaceholder("10000")
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
			.setName("Cache size")
			.setDesc(
				"Maximum number of file snapshots to keep in memory for diff computation.",
			)
			.addText((text) =>
				text
					.setPlaceholder("50")
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
			.setName("Ignored folders")
			.setDesc(
				"Comma-separated folder names to exclude from tracking, matched at any depth.",
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("Templates, Excalidraw, .obsidian")
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
			.setName("Ignored files")
			.setDesc(
				"Comma-separated file names to exclude from tracking.",
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("secret.md, scratch.md")
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
			.setName("Edit logs path")
			.setDesc("Vault-relative folder where daily JSONL logs are written.")
			.addText((text) =>
				text
					.setPlaceholder("Authorship Logs")
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
			.setName("Log retention")
			.setDesc(
				"Delete daily logs older than this many days. Set to 0 to keep all logs.",
			)
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.logRetentionDays))
					.onChange(async (value) => {
						const parsed = parseInt(value);
						if (!isNaN(parsed) && parsed >= 0) {
							this.plugin.settings.logRetentionDays = parsed;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl).setName("Auto-import folders").setHeading();

		const desc = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		desc.setText(
			"Files created in these folders are stamped with the mapped author and content origin. One mapping per line: Folder=Author|ContentOrigin[|FilenamePattern].",
		);

		new Setting(containerEl)
			.setName("Folder-to-author mappings")
			.setDesc(
				"Example: Emails=importer:email|primary. The optional third field is a regex matched against the file name.",
			)
			.addTextArea((text) => {
				text.inputEl.rows = 8;
				text.inputEl.cols = 50;
				text
					.setPlaceholder(
						"Emails=importer:email|primary\nMeetings=importer:transcript|primary|^Transcript-",
					)
					.setValue(
						serializeMappings(
							this.plugin.settings.autoImportFolders,
						),
					)
					.onChange(async (value) => {
						const mappings = parseMappings(value);
						const bad = invalidPatterns(mappings);
						if (bad.length > 0) {
							new Notice(
								`Authorship Tracker: invalid filename pattern(s): ${bad.join(
									", ",
								)}`,
							);
							return;
						}
						this.plugin.settings.autoImportFolders = mappings;
						await this.plugin.saveSettings();
					});
			});
	}
}
