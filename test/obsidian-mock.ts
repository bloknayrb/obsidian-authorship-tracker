// In-memory stand-in for the `obsidian` module.
//
// `main.ts` imports from "obsidian", which ships only type declarations — esbuild
// marks it external and Obsidian supplies the implementation at runtime. To exercise
// the plugin in tests we substitute this fake, wired up by `resolve.alias` in
// vitest.config.ts.
//
// Fidelity rules this file tries to honour, because tests depend on them:
//   * `vault.delete` splices the parent's `children` array (that mutation-during-
//     iteration is a real failure mode in pruneLogs).
//   * `vault.rename` mutates `path`/`name` on the *same* TFile instance, which is
//     what Obsidian does and what makes the debounce fix's identity checks meaningful.
//   * `vault.create` rejects when the parent folder is missing, which is what drives
//     the createFolder branch in appendLog.
//
// Deliberate gap: processFrontMatter here is a scalar-only YAML shim. Tests must
// assert through `readFrontMatter()` rather than against raw file text, so they are
// not coupled to this fake's serializer.

// ─── Events ───────────────────────────────────────────────────────────────────

export interface EventRef {
	off(): void;
}

type Handler = (...args: any[]) => any;

class Events {
	private _handlers = new Map<string, Set<Handler>>();

	on(name: string, cb: Handler): EventRef {
		let set = this._handlers.get(name);
		if (!set) {
			set = new Set();
			this._handlers.set(name, set);
		}
		set.add(cb);
		return { off: () => set!.delete(cb) };
	}

	off(name: string, cb: Handler): void {
		this._handlers.get(name)?.delete(cb);
	}

	// Test hook: fire an event exactly as Obsidian would.
	trigger(name: string, ...args: unknown[]): void {
		for (const cb of [...(this._handlers.get(name) ?? [])]) cb(...args);
	}

	__handlerCount(name: string): number {
		return this._handlers.get(name)?.size ?? 0;
	}
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "");
}

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

function splitExtension(name: string): { basename: string; extension: string } {
	const i = name.lastIndexOf(".");
	if (i <= 0) return { basename: name, extension: "" };
	return { basename: name.slice(0, i), extension: name.slice(i + 1) };
}

// ─── File tree ────────────────────────────────────────────────────────────────

export abstract class TAbstractFile {
	vault!: Vault;
	path = "";
	name = "";
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "";
	stat = { ctime: 0, mtime: 0, size: 0 };

	// Derive name/basename/extension from the path. main.ts gates auto-import on
	// `file.extension !== "md"` (main.ts:148) and reads `file.name` (main.ts:154),
	// so a TFile with an undefined extension would short-circuit those paths and
	// make the tests pass vacuously.
	constructor(path?: string) {
		super();
		if (path !== undefined) this.__setPath(path);
	}

	__setPath(path: string): void {
		this.path = normalizePath(path);
		this.name = basename(this.path);
		const { basename: b, extension: e } = splitExtension(this.name);
		this.basename = b;
		this.extension = e;
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	constructor(path?: string) {
		super();
		if (path !== undefined) {
			this.path = normalizePath(path);
			this.name = basename(this.path);
		}
	}

	isRoot(): boolean {
		return this.path === "";
	}
}

// ─── Vault ────────────────────────────────────────────────────────────────────

export class Vault extends Events {
	private _files = new Map<string, TAbstractFile>();
	private _content = new Map<string, string>();
	private _root: TFolder;

	constructor() {
		super();
		this._root = new TFolder("");
		this._root.vault = this;
		this._files.set("", this._root);
	}

	getRoot(): TFolder {
		return this._root;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this._files.get(normalizePath(path)) ?? null;
	}

	getFiles(): TFile[] {
		return [...this._files.values()].filter(
			(f): f is TFile => f instanceof TFile,
		);
	}

	async read(file: TFile): Promise<string> {
		const data = this._content.get(file.path);
		if (data === undefined) {
			throw new Error(`ENOENT: ${file.path}`);
		}
		return data;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	async create(path: string, data: string): Promise<TFile> {
		const p = normalizePath(path);
		if (this._files.has(p)) {
			throw new Error(`File already exists: ${p}`);
		}
		const parentPath = dirname(p);
		const parent = this._files.get(parentPath);
		if (!(parent instanceof TFolder)) {
			// Obsidian refuses to create a file whose folder does not exist. This is
			// what exercises appendLog's createFolder branch.
			throw new Error(`Folder does not exist: ${parentPath}`);
		}
		const file = this._makeFile(p);
		this._content.set(p, data);
		parent.children.push(file);
		file.parent = parent;
		this.trigger("create", file);
		return file;
	}

	async createFolder(path: string): Promise<TFolder> {
		const p = normalizePath(path);
		if (this._files.has(p)) {
			throw new Error(`Folder already exists: ${p}`);
		}
		const parentPath = dirname(p);
		let parent = this._files.get(parentPath);
		if (!(parent instanceof TFolder)) {
			parent = await this.createFolder(parentPath);
		}
		const folder = new TFolder(p);
		folder.vault = this;
		folder.parent = parent as TFolder;
		(parent as TFolder).children.push(folder);
		this._files.set(p, folder);
		this.trigger("create", folder);
		return folder;
	}

	async modify(file: TFile, data: string): Promise<void> {
		this._content.set(file.path, data);
		this.trigger("modify", file);
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const before = await this.read(file);
		const after = fn(before);
		this._content.set(file.path, after);
		this.trigger("modify", file);
		return after;
	}

	async delete(file: TAbstractFile): Promise<void> {
		this._files.delete(file.path);
		this._content.delete(file.path);
		// Splice the parent's children — pruneLogs iterates that array, so a fake
		// that skipped this would hide a real mutation-during-iteration bug.
		const parent = file.parent;
		if (parent) {
			const i = parent.children.indexOf(file);
			if (i !== -1) parent.children.splice(i, 1);
		}
		this.trigger("delete", file);
	}

	async trash(file: TAbstractFile): Promise<void> {
		return this.delete(file);
	}

	async rename(file: TAbstractFile, newPath: string): Promise<void> {
		const oldPath = file.path;
		const p = normalizePath(newPath);
		this._files.delete(oldPath);
		const data = this._content.get(oldPath);
		this._content.delete(oldPath);
		if (data !== undefined) this._content.set(p, data);

		// Mutate in place: Obsidian keeps the same TFile instance across a rename.
		if (file instanceof TFile) file.__setPath(p);
		else {
			file.path = p;
			file.name = basename(p);
		}
		this._files.set(p, file);

		const oldParent = file.parent;
		if (oldParent) {
			const i = oldParent.children.indexOf(file);
			if (i !== -1) oldParent.children.splice(i, 1);
		}
		const newParent = this._files.get(dirname(p));
		if (newParent instanceof TFolder) {
			newParent.children.push(file);
			file.parent = newParent;
		}
		this.trigger("rename", file, oldPath);
	}

	private _makeFile(p: string): TFile {
		const file = new TFile(p);
		file.vault = this;
		this._files.set(p, file);
		return file;
	}

	// ── Test helpers ──────────────────────────────────────────────────────────

	// Seed a file, creating parent folders, without firing any events. Use this for
	// arranging state; use create() when the test wants the create event to fire.
	__seed(path: string, data = ""): TFile {
		const p = normalizePath(path);
		const parentPath = dirname(p);
		if (parentPath && !(this._files.get(parentPath) instanceof TFolder)) {
			this.__seedFolder(parentPath);
		}
		const existing = this._files.get(p);
		if (existing instanceof TFile) {
			this._content.set(p, data);
			return existing;
		}
		const file = this._makeFile(p);
		this._content.set(p, data);
		const parent = this._files.get(parentPath);
		if (parent instanceof TFolder) {
			parent.children.push(file);
			file.parent = parent;
		}
		return file;
	}

	__seedFolder(path: string): TFolder {
		const p = normalizePath(path);
		const existing = this._files.get(p);
		if (existing instanceof TFolder) return existing;
		const parentPath = dirname(p);
		const parent =
			parentPath === p ? this._root : this.__seedFolder(parentPath);
		const folder = new TFolder(p);
		folder.vault = this;
		folder.parent = parent;
		parent.children.push(folder);
		this._files.set(p, folder);
		return folder;
	}

	__contentOf(path: string): string | undefined {
		return this._content.get(normalizePath(path));
	}

	__exists(path: string): boolean {
		return this._files.has(normalizePath(path));
	}
}

// ─── Frontmatter ──────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// Scalar-only YAML parse. The plugin writes strings and one number, nothing nested.
export function parseFrontMatter(text: string): Record<string, unknown> {
	const m = FRONTMATTER_RE.exec(text);
	if (!m) return {};
	const out: Record<string, unknown> = {};
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const i = line.indexOf(":");
		if (i === -1) continue;
		const key = line.slice(0, i).trim();
		let raw = line.slice(i + 1).trim();
		if (
			(raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) ||
			(raw.startsWith("'") && raw.endsWith("'") && raw.length > 1)
		) {
			raw = raw.slice(1, -1);
		}
		if (raw === "") out[key] = "";
		else if (/^-?\d+$/.test(raw)) out[key] = Number(raw);
		else if (raw === "true" || raw === "false") out[key] = raw === "true";
		else out[key] = raw;
	}
	return out;
}

function serializeFrontMatter(fm: Record<string, unknown>): string {
	const keys = Object.keys(fm).filter((k) => fm[k] !== undefined);
	if (keys.length === 0) return "";
	const body = keys
		.map((k) => {
			const v = fm[k];
			if (typeof v === "number" || typeof v === "boolean") return `${k}: ${v}`;
			const s = String(v);
			// Quote anything YAML would misread as structure.
			return /^[\s]|[:#]|[\s]$/.test(s) ? `${k}: "${s}"` : `${k}: ${s}`;
		})
		.join("\n");
	return `---\n${body}\n---\n`;
}

export class FileManager {
	constructor(private vault: Vault) {}

	async processFrontMatter(
		file: TFile,
		fn: (frontmatter: any) => void,
	): Promise<void> {
		const text = await this.vault.read(file);
		const m = FRONTMATTER_RE.exec(text);
		const fm = parseFrontMatter(text);
		const body = m ? text.slice(m[0].length) : text;
		fn(fm);
		await this.vault.modify(file, serializeFrontMatter(fm) + body);
	}

	async trashFile(file: TAbstractFile): Promise<void> {
		await this.vault.delete(file);
	}
}

// ─── Editor / views ───────────────────────────────────────────────────────────

export class Editor {
	constructor(private _value = "") {}
	getValue(): string {
		return this._value;
	}
	setValue(v: string): void {
		this._value = v;
	}
}

export interface MarkdownFileInfo {
	file: TFile | null;
}

export class View {
	constructor(public app: App) {}
}

export class MarkdownView extends View {
	file: TFile | null = null;
	editor: Editor;

	constructor(app: App, file: TFile | null = null, content = "") {
		super(app);
		this.file = file;
		this.editor = new Editor(content);
	}
}

export class WorkspaceLeaf {
	view: unknown = null;
	constructor(public app: App) {}
	async openFile(file: TFile): Promise<void> {
		const view = new MarkdownView(this.app, file);
		this.view = view;
	}
	getViewState() {
		return { type: this.view instanceof MarkdownView ? "markdown" : "empty" };
	}
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export class Workspace extends Events {
	private _layoutReadyCallbacks: (() => any)[] = [];
	private _layoutReady = false;
	private _leaves: WorkspaceLeaf[] = [];
	activeLeaf: WorkspaceLeaf | null = null;

	constructor(private app: App) {
		super();
	}

	// Queued, not fired immediately — Obsidian defers these until the vault has
	// finished indexing, and firing early would run pruneLogs before a test could
	// configure retention.
	onLayoutReady(cb: () => any): void {
		if (this._layoutReady) cb();
		else this._layoutReadyCallbacks.push(cb);
	}

	__triggerLayoutReady(): void {
		this._layoutReady = true;
		const cbs = this._layoutReadyCallbacks;
		this._layoutReadyCallbacks = [];
		for (const cb of cbs) cb();
	}

	getActiveViewOfType<T>(type: new (...args: any[]) => T): T | null {
		const view = this.activeLeaf?.view;
		return view instanceof type ? (view as T) : null;
	}

	getLeavesOfType(viewType: string): WorkspaceLeaf[] {
		if (viewType !== "markdown") return [];
		return this._leaves.filter((l) => l.view instanceof MarkdownView);
	}

	getLeaf(_newLeaf?: boolean): WorkspaceLeaf {
		if (!this.activeLeaf) {
			const leaf = new WorkspaceLeaf(this.app);
			this._leaves.push(leaf);
			this.activeLeaf = leaf;
		}
		return this.activeLeaf;
	}

	// ── Test helpers ──────────────────────────────────────────────────────────

	// Open `file` in a new leaf and make it active. Returns the view so a test can
	// drive its editor.
	__openLeaf(file: TFile, content = "", makeActive = true): MarkdownView {
		const leaf = new WorkspaceLeaf(this.app);
		const view = new MarkdownView(this.app, file, content);
		leaf.view = view;
		this._leaves.push(leaf);
		if (makeActive) this.activeLeaf = leaf;
		return view;
	}

	__setActive(view: MarkdownView): void {
		const leaf = this._leaves.find((l) => l.view === view);
		if (leaf) this.activeLeaf = leaf;
	}

	__leafCount(): number {
		return this._leaves.length;
	}
}

// ─── App ──────────────────────────────────────────────────────────────────────

export class App {
	vault: Vault;
	workspace: Workspace;
	fileManager: FileManager;

	// Test-visible collections populated by the Plugin base class.
	__commands: Command[] = [];
	__settingTabs: PluginSettingTab[] = [];
	__pluginData: unknown = undefined;

	constructor() {
		this.vault = new Vault();
		this.workspace = new Workspace(this);
		this.fileManager = new FileManager(this.vault);
	}
}

// ─── Notices ──────────────────────────────────────────────────────────────────

export const __notices: string[] = [];

export function __resetNotices(): void {
	__notices.length = 0;
}

export class Notice {
	constructor(public message: string, public timeout?: number) {
		__notices.push(message);
	}
	hide(): void {
		/* no-op */
	}
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export interface Command {
	id: string;
	name: string;
	callback?: () => any;
	editorCallback?: (editor: Editor, ctx: any) => any;
}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	author?: string;
	description?: string;
}

export class Component {
	registerEvent(_ref: EventRef): void {
		/* refs collected by Plugin */
	}
}

export class Plugin extends Component {
	private _eventRefs: EventRef[] = [];

	constructor(public app: App, public manifest: PluginManifest) {
		super();
	}

	registerEvent(ref: EventRef): void {
		this._eventRefs.push(ref);
	}

	addCommand(cmd: Command): Command {
		this.app.__commands.push(cmd);
		return cmd;
	}

	addSettingTab(tab: PluginSettingTab): void {
		this.app.__settingTabs.push(tab);
	}

	async loadData(): Promise<unknown> {
		const raw = this.app.__pluginData;
		// Round-trip so a caller cannot mutate the "stored" object by reference —
		// this is what makes settings-persistence tests meaningful.
		return raw === undefined ? null : JSON.parse(JSON.stringify(raw));
	}

	async saveData(data: unknown): Promise<void> {
		this.app.__pluginData = JSON.parse(JSON.stringify(data));
	}

	onload(): void | Promise<void> {
		/* overridden */
	}

	onunload(): void {
		/* overridden */
	}

	// Test helper: detach every registered event, as Obsidian does on unload.
	__offAll(): void {
		for (const ref of this._eventRefs) ref.off();
		this._eventRefs = [];
	}
}

// ─── Settings UI ──────────────────────────────────────────────────────────────

// Minimal stand-in for Obsidian's HTMLElement extensions. vitest runs in the node
// environment and Obsidian's createEl/setText are not standard DOM anyway, so the
// element surface the settings tab touches is stubbed by hand.
export class FakeEl {
	children: FakeEl[] = [];
	tag: string;
	cls: string;
	text = "";

	constructor(tag = "div", cls = "") {
		this.tag = tag;
		this.cls = cls;
	}

	empty(): void {
		this.children = [];
	}

	createEl(tag: string, opts?: { cls?: string; text?: string }): FakeEl {
		const el = new FakeEl(tag, opts?.cls ?? "");
		if (opts?.text) el.text = opts.text;
		this.children.push(el);
		return el;
	}

	createDiv(cls?: string): FakeEl {
		return this.createEl("div", { cls });
	}

	setText(text: string): void {
		this.text = text;
	}
}

class ValueComponent<T> {
	value!: T;
	protected _onChange?: (value: T) => any;
	inputEl: { rows: number; cols: number; value: string } = {
		rows: 0,
		cols: 0,
		value: "",
	};

	setValue(v: T): this {
		this.value = v;
		this.inputEl.value = String(v);
		return this;
	}

	getValue(): T {
		return this.value;
	}

	setPlaceholder(_p: string): this {
		return this;
	}

	onChange(cb: (value: T) => any): this {
		this._onChange = cb;
		return this;
	}

	// Test helper: simulate the user typing `value`, awaiting the async handler.
	async __type(value: T): Promise<void> {
		this.value = value;
		this.inputEl.value = String(value);
		await this._onChange?.(value);
	}
}

export class TextComponent extends ValueComponent<string> {}
export class TextAreaComponent extends ValueComponent<string> {}
export class ToggleComponent extends ValueComponent<boolean> {}

export class Setting {
	name = "";
	desc = "";
	isHeading = false;
	components: ValueComponent<any>[] = [];

	constructor(public containerEl: FakeEl) {
		// Register on the container so a test can find settings by name.
		(containerEl as any).__settings ??= [];
		(containerEl as any).__settings.push(this);
	}

	setName(name: string): this {
		this.name = name;
		return this;
	}

	setDesc(desc: string): this {
		this.desc = desc;
		return this;
	}

	setHeading(): this {
		this.isHeading = true;
		return this;
	}

	addText(cb: (t: TextComponent) => any): this {
		const c = new TextComponent();
		this.components.push(c);
		cb(c);
		return this;
	}

	addTextArea(cb: (t: TextAreaComponent) => any): this {
		const c = new TextAreaComponent();
		this.components.push(c);
		cb(c);
		return this;
	}

	addToggle(cb: (t: ToggleComponent) => any): this {
		const c = new ToggleComponent();
		this.components.push(c);
		cb(c);
		return this;
	}
}

export class PluginSettingTab {
	containerEl: FakeEl = new FakeEl();

	constructor(public app: App, public plugin: Plugin) {}

	display(): void {
		/* overridden */
	}

	hide(): void {
		/* no-op */
	}

	// Test helper: find a Setting by its displayed name.
	__setting(name: string): Setting | undefined {
		return ((this.containerEl as any).__settings as Setting[] | undefined)?.find(
			(s) => s.name === name,
		);
	}
}

// ─── Test utilities ───────────────────────────────────────────────────────────

// Read a file's frontmatter as parsed values. Tests should use this rather than
// asserting on raw text, so they are not coupled to this fake's serializer.
export function readFrontMatter(
	vault: Vault,
	path: string,
): Record<string, unknown> {
	return parseFrontMatter(vault.__contentOf(path) ?? "");
}

export function __resetMockState(): void {
	__resetNotices();
}
