// Positive control for the test harness itself.
//
// Every negative assertion elsewhere ("ignored files are not stamped", "retention 0
// deletes nothing") would also pass against a completely dead harness. This file
// exists to prove the harness is live: if the plugin cannot be constructed, cannot
// receive events, or cannot write, these fail loudly and the negative assertions
// elsewhere become trustworthy.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, MarkdownView, TFile } from "obsidian";
import AuthorshipTrackerPlugin, { AUTO_IMPORT_STAMP_DELAY_MS } from "../main";
import {
	boot,
	edit,
	installFakeClock,
	readFrontMatter,
	readLog,
} from "./helpers";

describe("harness smoke test", () => {
	let app: App;
	let plugin: AuthorshipTrackerPlugin | undefined;

	beforeEach(() => {
		installFakeClock();
		app = new App();
	});

	afterEach(() => {
		plugin?.onunload();
		plugin = undefined;
		vi.useRealTimers();
	});

	it("loads the plugin module at all", () => {
		// Not a resolver guard. esbuild re-exports every named export, so nothing
		// observable at runtime distinguishes ../main.ts from a built ../main.js —
		// an earlier version of this test claimed to and did not.
		//
		// What actually protects us is that the CJS bundle's require("obsidian")
		// is not rewritten by the vite alias, so if resolve.extensions ever stopped
		// putting ".ts" first, this import would throw MODULE_NOT_FOUND and every
		// test in the suite would fail loudly. The knowledge lives in the
		// vitest.config.ts comment; this only pins that the module loads.
		expect(typeof AuthorshipTrackerPlugin).toBe("function");
		expect(AUTO_IMPORT_STAMP_DELAY_MS).toBe(3000);
	});

	it("warms the diff cache on active-leaf-change", async () => {
		// main.ts registers an active-leaf-change handler to snapshot a note's
		// content as the diff baseline. Nothing else in the suite exercises it.
		const file = app.vault.__seed("Notes/a.md", "# A\n\n## One\n\nbody\n");
		plugin = await boot(app);

		// Opening the leaf fires active-leaf-change, seeding the baseline. The edit
		// then adds a section, so the summary must name it rather than falling back
		// to the no-baseline wording.
		await edit(app, file, "# A\n\n## One\n\nbody\n\n## Two\n\nmore\n");

		const [entry] = readLog(app);
		expect(entry.summary).toContain("## Two");
		expect(entry.summary).not.toContain("no cached baseline");
	});

	it("stamps frontmatter and writes a log line for a real edit", async () => {
		const file = app.vault.__seed("Notes/a.md", "# A\n\nhello\n");
		plugin = await boot(app);

		await edit(app, file, "# A\n\nhello world\n");

		expect(readFrontMatter(app, "Notes/a.md")).toMatchObject({
			created_by: "tester",
			last_modified_by: "tester",
			edit_count: 1,
		});
		expect(readLog(app)).toMatchObject([
			{ file: "Notes/a.md", author: "tester", action: "modified" },
		]);
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

	it("mock fidelity: TFile derives its name parts from its path", () => {
		const f = new TFile("Folder/note.md");
		expect(f.name).toBe("note.md");
		expect(f.basename).toBe("note");
		expect(f.extension).toBe("md");
	});

	it("mock fidelity: instanceof works across the module alias", () => {
		const file = app.vault.__seed("Notes/b.md", "");
		expect(file).toBeInstanceOf(TFile);

		const view = app.workspace.__openLeaf(file, "");
		expect(view).toBeInstanceOf(MarkdownView);
		expect(app.workspace.getActiveViewOfType(MarkdownView)).toBe(view);
	});
});
