import {
	App,
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";

// ─── Settings ─────────────────────────────────────────────────────────────────

interface AuthorshipTrackerSettings {
	authorName: string;
	debounceMs: number;
	maxCacheSize: number;
	ignoreFolders: string[];
	ignoreFiles: string[];
	editLogsPath: string;
}

const DEFAULT_SETTINGS: AuthorshipTrackerSettings = {
	authorName: "bryan",
	debounceMs: 10000,
	maxCacheSize: 50,
	ignoreFolders: [
		"Templates",
		"Excalidraw",
		".obsidian",
		"__pycache__",
		"smart prompts",
		"_media-sync_resources",
	],
	ignoreFiles: ["CLAUDE.md", "GEMINI.md", "claude-scratchpad.md"],
	editLogsPath: "99-System/Edit-Logs",
};

// ─── LRU Cache ────────────────────────────────────────────────────────────────

class LRUCache<K, V> {
	private maxSize: number;
	private cache: Map<K, V>;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
		this.cache = new Map();
	}

	get(key: K): V | undefined {
		if (!this.cache.has(key)) return undefined;
		const value = this.cache.get(key)!;
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) this.cache.delete(firstKey);
		}
		this.cache.set(key, value);
	}

	resize(newMax: number): void {
		this.maxSize = newMax;
		while (this.cache.size > this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) this.cache.delete(firstKey);
		}
	}
}

// ─── Diff Utilities ───────────────────────────────────────────────────────────

interface SectionMap {
	[heading: string]: string[];
}

function parseIntoSections(content: string): SectionMap {
	const lines = content.split("\n");
	const sections: SectionMap = {};
	let currentHeading = "";

	for (const line of lines) {
		if (line.startsWith("## ")) {
			currentHeading = line.slice(3).trim();
			if (!sections[currentHeading]) sections[currentHeading] = [];
		} else {
			if (!sections[currentHeading]) sections[currentHeading] = [];
			sections[currentHeading].push(line);
		}
	}
	return sections;
}

function generateDiffSummary(before: string, after: string): string {
	const beforeSections = parseIntoSections(before);
	const afterSections = parseIntoSections(after);
	const beforeKeys = Object.keys(beforeSections);
	const afterKeys = Object.keys(afterSections);
	const hasHeadings = afterKeys.some((k) => k !== "");

	if (!hasHeadings) {
		const beforeLines = before.split("\n").length;
		const afterLines = after.split("\n").length;
		const delta = afterLines - beforeLines;
		const sign = delta >= 0 ? `+${delta}` : `${delta}`;
		return `Modified content (${sign} lines)`;
	}

	const parts: string[] = [];

	for (const key of afterKeys) {
		if (key === "") continue;
		if (!beforeSections[key]) {
			parts.push(`added ## ${key}`);
		}
	}

	for (const key of beforeKeys) {
		if (key === "") continue;
		if (!afterSections[key]) {
			parts.push(`removed ## ${key}`);
		}
	}

	for (const key of afterKeys) {
		if (!beforeSections[key]) continue;
		const beforeContent = beforeSections[key].join("\n");
		const afterContent = afterSections[key].join("\n");
		if (beforeContent !== afterContent) {
			const beforeCount = beforeSections[key].filter((l) => l.trim()).length;
			const afterCount = afterSections[key].filter((l) => l.trim()).length;
			const delta = afterCount - beforeCount;
			const sign = delta >= 0 ? `+${delta}` : `${delta}`;
			const label = key !== "" ? `## ${key}` : "preamble";
			parts.push(`Modified ${label} (${sign} lines)`);
		}
	}

	return parts.length > 0
		? parts.join(", ")
		: "Minor edits (no structural changes)";
}

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

	async onload() {
		await this.loadSettings();
		this._contentCache = new LRUCache<string, string>(
			this.settings.maxCacheSize,
		);

		// editor-change: fires ONLY when user types in the editor
		// External writes (Claude CLI, PowerShell, OneDrive sync) do NOT trigger this
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
						const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
						if (activeView?.file?.path === filePath) {
							this.handleEdit(activeView.editor, activeView.file);
						}
					}, this.settings.debounceMs);

					this._debounceTimers.set(file.path, timer);
				},
			),
		);

		// Cache content when user opens/focuses a note (for diff computation)
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
						// Non-critical — diff will use fallback
					});
			}),
		);

		// Stamp created_by on new files (after Templater finishes)
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!(file instanceof TFile)) return;
				if (file.extension !== "md") return;
				if (this.shouldIgnore(file)) return;

				const createPath = file.path;
				setTimeout(() => {
					// Verify file still exists before stamping
					const currentFile = this.app.vault.getAbstractFileByPath(createPath);
					if (currentFile instanceof TFile) {
						this.handleCreate(currentFile);
					}
				}, 3000);
			}),
		);

		this.addSettingTab(
			new AuthorshipTrackerSettingTab(this.app, this),
		);
		console.log("[AuthorshipTracker] Plugin loaded");
	}

	onunload() {
		for (const timer of this._debounceTimers.values()) {
			clearTimeout(timer);
		}
		this._debounceTimers.clear();
		console.log("[AuthorshipTracker] Plugin unloaded");
	}

	private shouldIgnore(file: TFile): boolean {
		if (this.settings.ignoreFiles.includes(file.name)) return true;
		for (const folder of this.settings.ignoreFolders) {
			if (file.path.startsWith(folder + "/")) return true;
		}
		return false;
	}

	private async handleEdit(editor: Editor, file: TFile) {
		this._stampInProgress.add(file.path);
		setTimeout(() => this._stampInProgress.delete(file.path), 1000);

		const currentContent = editor.getValue();
		const cachedContent = this._contentCache.get(file.path) ?? "";

		const summary = cachedContent
			? generateDiffSummary(cachedContent, currentContent)
			: "Initial edit (no cached baseline)";

		// Update cache with post-edit snapshot
		this._contentCache.set(file.path, currentContent);

		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm["last_modified_by"] = this.settings.authorName;
				fm["edit_count"] =
					typeof fm["edit_count"] === "number"
						? fm["edit_count"] + 1
						: 1;
			});

			await this.appendLog({
				ts: new Date().toISOString().replace(/\.\d{3}Z$/, ""),
				file: file.path.replace(/\\/g, "/"),
				author: this.settings.authorName,
				action: "modified",
				summary,
			});
		} catch (err) {
			console.error("[AuthorshipTracker] Error stamping edit:", err);
		}
	}

	private async handleCreate(file: TFile) {
		this._stampInProgress.add(file.path);
		setTimeout(() => this._stampInProgress.delete(file.path), 1000);

		try {
			let alreadyHasField = false;

			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (fm["created_by"]) {
					alreadyHasField = true;
					return;
				}
				fm["created_by"] = this.settings.authorName;
			});

			if (!alreadyHasField) {
				const content = await this.app.vault.read(file);
				this._contentCache.set(file.path, content);

				await this.appendLog({
					ts: new Date().toISOString().replace(/\.\d{3}Z$/, ""),
					file: file.path.replace(/\\/g, "/"),
					author: this.settings.authorName,
					action: "created",
					summary: "File created by user",
				});
			}
		} catch (err) {
			console.error(
				"[AuthorshipTracker] Error stamping creation:",
				err,
			);
		}
	}

	private async appendLog(entry: LogEntry): Promise<void> {
		const today = new Date().toISOString().slice(0, 10);
		const logPath = `${this.settings.editLogsPath}/${today}.jsonl`;
		const line = JSON.stringify(entry) + "\n";

		try {
			const folder = this.app.vault.getAbstractFileByPath(
				this.settings.editLogsPath,
			);
			if (!folder) {
				await this.app.vault.createFolder(this.settings.editLogsPath);
			}

			const existingFile =
				this.app.vault.getAbstractFileByPath(logPath);
			if (existingFile instanceof TFile) {
				await this.app.vault.adapter.append(logPath, line);
			} else {
				await this.app.vault.create(logPath, line);
			}
		} catch (err) {
			console.error(
				"[AuthorshipTracker] Failed to write log entry:",
				err,
			);
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
		containerEl.createEl("h2", { text: "Authorship Tracker Settings" });

		new Setting(containerEl)
			.setName("Author name")
			.setDesc(
				"Name to stamp in last_modified_by and created_by fields",
			)
			.addText((text) =>
				text
					.setPlaceholder("bryan")
					.setValue(this.plugin.settings.authorName)
					.onChange(async (value) => {
						this.plugin.settings.authorName =
							value.trim() || "bryan";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Debounce delay (ms)")
			.setDesc(
				"How long to wait after last keystroke before stamping (default: 10000)",
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
			.setName("Cache size (max entries)")
			.setDesc(
				"Maximum number of file snapshots to keep in memory for diff computation",
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
				"Comma-separated list of folder names to ignore (no stamping)",
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
				"Comma-separated list of file names to ignore (no stamping)",
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("CLAUDE.md, GEMINI.md")
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
			.setDesc(
				"Vault-relative path where daily JSONL logs are written",
			)
			.addText((text) =>
				text
					.setPlaceholder("99-System/Edit-Logs")
					.setValue(this.plugin.settings.editLogsPath)
					.onChange(async (value) => {
						this.plugin.settings.editLogsPath =
							value.trim() || "99-System/Edit-Logs";
						await this.plugin.saveSettings();
					}),
			);
	}
}
