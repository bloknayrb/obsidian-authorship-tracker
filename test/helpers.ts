// Shared setup for the plugin integration suites.
//
// This cannot live in test/obsidian-mock.ts: that module would have to import
// main.ts, which imports "obsidian" — aliased straight back to the mock.
import { vi } from "vitest";
import { App, MarkdownView, TFile, parseFrontMatter } from "obsidian";
import AuthorshipTrackerPlugin from "../main";
import { localDateString } from "../src/time";

// Obsidian runs in a browser window; the unit suite runs in Vitest's Node
// environment. Keep the mock runtime honest after production code switches to
// window-scoped timers for popout-window compatibility.
if (!("window" in globalThis)) {
	Object.assign(globalThis, { window: globalThis });
}

export const MANIFEST = {
	id: "authorship-tracker",
	name: "Authorship Tracker",
	version: "0.0.0-test",
	minAppVersion: "1.2.0",
};

// Short enough to keep tests fast, above the plugin's 1000ms settings floor.
export const DEBOUNCE = 1000;

// Pinned wall-clock for the whole suite. Fake timers mock Date, so without a
// system time every log would land in 1970-01-01.jsonl and notifyError's 60s
// throttle would suppress the first Notice. Fixtures that name a date (e.g.
// "2026-08-25.jsonl") are pinned to this value.
export const TEST_NOW = new Date(2026, 7, 25, 12, 0, 0);

export function installFakeClock(): void {
	// performance is deliberately left real: src/patterns.ts measures how long a
	// regex takes to run, and a frozen monotonic clock would report every pattern
	// as instantaneous.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(TEST_NOW);
}

export interface BootOptions {
	// Leave false to test behavior before the vault finishes indexing — the
	// vault "create" handler is registered inside onLayoutReady.
	layoutReady?: boolean;
}

export async function boot(
	app: App,
	settings: Record<string, unknown> = {},
	{ layoutReady = true }: BootOptions = {},
): Promise<AuthorshipTrackerPlugin> {
	app.__pluginData = { debounceMs: DEBOUNCE, authorName: "tester", ...settings };
	const plugin = new AuthorshipTrackerPlugin(app, MANIFEST);
	await plugin.onload();
	if (layoutReady) app.workspace.__triggerLayoutReady();
	return plugin;
}

// Set an already-open view's buffer and fire editor-change, without advancing the
// clock and without opening a new leaf.
//
// Reopening a leaf re-seeds the diff baseline from the vault copy via
// active-leaf-change, which by then carries frontmatter the editor buffer does
// not — so any test comparing successive edits of the same note must reuse one
// view and go through here.
export function fireEditIn(
	app: App,
	view: MarkdownView,
	content: string,
): MarkdownView {
	view.editor.setValue(content);
	app.workspace.trigger("editor-change", view.editor, view);
	return view;
}

// Open `file` in a leaf with `content` and fire editor-change, WITHOUT advancing
// the clock. For tests that need to act inside the debounce window.
export function fireEdit(app: App, file: TFile, content: string): MarkdownView {
	return fireEditIn(app, app.workspace.__openLeaf(file, content), content);
}

// Fire an edit and advance past the debounce so the stamp completes.
//
// Must be the async timer advance: the debounce callback awaits
// processFrontMatter and appendLog, and a synchronous advance would run none of
// that post-await work — positive assertions would fail and negative ones would
// pass vacuously.
export async function edit(
	app: App,
	file: TFile,
	content: string,
): Promise<MarkdownView> {
	const view = fireEdit(app, file, content);
	await vi.advanceTimersByTimeAsync(DEBOUNCE);
	return view;
}

// Seed daily-log fixtures. Dates are bare "YYYY-MM-DD"; the suite clock is
// pinned to TEST_NOW.
export function seedLogs(
	app: App,
	dates: string[],
	dir = "Authorship Logs",
): void {
	for (const d of dates) app.vault.__seed(`${dir}/${d}.jsonl`, "{}\n");
}

export function logPathForToday(dir = "Authorship Logs"): string {
	// Derived, never hardcoded, so the assertion stays timezone-independent.
	return `${dir}/${localDateString(new Date())}.jsonl`;
}

export function readLog(app: App, dir = "Authorship Logs"): any[] {
	const raw = app.vault.__contentOf(logPathForToday(dir));
	if (!raw) return [];
	return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Read a file's frontmatter as parsed values. Tests assert through this rather
// than against raw file text, so they pin the plugin's callback logic instead of
// the mock's YAML serializer.
export function readFrontMatter(
	app: App,
	path: string,
): Record<string, unknown> {
	return parseFrontMatter(app.vault.__contentOf(path) ?? "");
}

// Names of the files directly inside a folder, sorted. Used for exact-set
// assertions so a test cannot pass against an empty or missing folder.
export function folderContents(app: App, dir: string): string[] {
	const folder = app.vault.getAbstractFileByPath(dir);
	if (!folder || !("children" in folder)) return [];
	return (folder as any).children.map((c: TFile) => c.name).sort();
}
