// Positive control for the test harness itself.
//
// Every negative assertion elsewhere ("ignored files are not stamped", "retention 0
// deletes nothing") would also pass against a completely dead harness. This file
// exists to prove the harness is live: if the plugin cannot be constructed, cannot
// receive events, or cannot write, these tests fail loudly and the negative
// assertions elsewhere become trustworthy.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, MarkdownView, TFile, readFrontMatter } from "obsidian";
import AuthorshipTrackerPlugin from "../main";
import { localDateString } from "../src/time";

const MANIFEST = {
	id: "authorship-tracker",
	name: "Authorship Tracker",
	version: "0.0.0-test",
	minAppVersion: "1.2.0",
};

async function bootPlugin(app: App, settings: Record<string, unknown> = {}) {
	app.__pluginData = { debounceMs: 1000, ...settings };
	const plugin = new AuthorshipTrackerPlugin(app as any, MANIFEST as any);
	await plugin.onload();
	app.workspace.__triggerLayoutReady();
	return plugin;
}

describe("harness smoke test", () => {
	let app: App;

	beforeEach(() => {
		vi.useFakeTimers();
		// Fake timers also mock Date. Without a real system time every log would
		// land in 1970-01-01.jsonl and notifyError's 60s throttle would misbehave.
		vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0));
		app = new App();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves `../main` to the TypeScript source, not the built bundle", async () => {
		// Vite orders .js before .ts by default, and the production bundle is emitted
		// to ./main.js. Without resolve.extensions putting .ts first, this import
		// silently picks up a stale artifact. The bundle is CommonJS and requires the
		// real "obsidian" module, so it would fail to construct here.
		expect(typeof AuthorshipTrackerPlugin).toBe("function");
		const plugin = new AuthorshipTrackerPlugin(new App() as any, MANIFEST as any);
		expect(plugin).toBeInstanceOf(AuthorshipTrackerPlugin);
	});

	it("stamps frontmatter and writes a log line for a real edit", async () => {
		const file = app.vault.__seed("Notes/a.md", "# A\n\nhello\n");
		const plugin = await bootPlugin(app, { authorName: "tester" });

		const view = app.workspace.__openLeaf(file, "# A\n\nhello world\n");
		app.workspace.trigger("editor-change", view.editor, view);

		// Must be the async variant: the debounce callback awaits processFrontMatter
		// and appendLog, and a synchronous advance would run none of that.
		await vi.advanceTimersByTimeAsync(1000);

		const fm = readFrontMatter(app.vault, "Notes/a.md");
		expect(fm.last_modified_by).toBe("tester");
		expect(fm.created_by).toBe("tester");
		expect(fm.edit_count).toBe(1);

		const logPath = `Authorship Logs/${localDateString(new Date())}.jsonl`;
		const log = app.vault.__contentOf(logPath);
		expect(log, "expected a JSONL log to be written").toBeTruthy();

		const entries = log!.trim().split("\n").map((l) => JSON.parse(l));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			file: "Notes/a.md",
			author: "tester",
			action: "modified",
		});

		plugin.onunload();
	});

	it("mock fidelity: delete splices parent.children", async () => {
		app.vault.__seed("Logs/2026-08-01.jsonl", "{}\n");
		app.vault.__seed("Logs/2026-08-02.jsonl", "{}\n");
		const folder = app.vault.getAbstractFileByPath("Logs") as any;
		expect(folder.children).toHaveLength(2);

		await app.vault.delete(folder.children[0]);
		expect(folder.children).toHaveLength(1);
	});

	it("mock fidelity: rename mutates the same TFile instance in place", async () => {
		const file = app.vault.__seed("Notes/old.md", "x");
		await app.vault.rename(file, "Notes/new.md");
		expect(file.path).toBe("Notes/new.md");
		expect(file.name).toBe("new.md");
		expect(file.extension).toBe("md");
		expect(app.vault.getAbstractFileByPath("Notes/new.md")).toBe(file);
	});

	it("mock fidelity: TFile derives extension from its path", () => {
		const f = new TFile("Folder/note.md");
		expect(f.extension).toBe("md");
		expect(f.basename).toBe("note");
		expect(f.name).toBe("note.md");
	});

	it("mock fidelity: instanceof works across the alias", () => {
		const file = app.vault.__seed("Notes/b.md", "");
		expect(file).toBeInstanceOf(TFile);
		const view = app.workspace.__openLeaf(file, "");
		expect(view).toBeInstanceOf(MarkdownView);
		expect(app.workspace.getActiveViewOfType(MarkdownView)).toBe(view);
	});
});
