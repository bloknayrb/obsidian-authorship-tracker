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

	it("resolves `../main` to the TypeScript source, not the built bundle", () => {
		// Vite orders .js ahead of .ts by default, and the production bundle is
		// emitted to ./main.js beside the source. Without resolve.extensions putting
		// .ts first, this module specifier picks up a stale artifact.
		//
		// Asserted via a named export that only the SOURCE has: the bundle is CJS
		// with a single default export, so `typeof Plugin === "function"` alone
		// would not distinguish them.
		expect(AUTO_IMPORT_STAMP_DELAY_MS).toBe(3000);
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
