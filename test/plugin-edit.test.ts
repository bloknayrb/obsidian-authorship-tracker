// Regression coverage for #3 (debounced edits lost when focus moves) and #4
// (retention using a rolling window instead of calendar days).
//
// Each test in the "#3" and "#4" blocks was confirmed to FAIL against the code
// before the fix; see the PR description for the recorded failures.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App } from "obsidian";
import AuthorshipTrackerPlugin, { AUTO_IMPORT_STAMP_DELAY_MS } from "../main";
import {
	DEBOUNCE,
	boot,
	fireEdit,
	fireEditIn,
	folderContents,
	installFakeClock,
	readFrontMatter,
	readLog,
	seedLogs,
} from "./helpers";

describe("#3 — attribute a debounced edit to the note that emitted it", () => {
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

	it("stamps the edited note after the user switches to another note", async () => {
		const a = app.vault.__seed("Notes/a.md", "# A\n\nhello\n");
		const b = app.vault.__seed("Notes/b.md", "# B\n");
		plugin = await boot(app);

		fireEdit(app, a, "# A\n\nhello world\n");
		// Switch to B before the debounce fires. Previously the callback looked up
		// the ACTIVE view, saw B, and silently dropped A's edit.
		app.workspace.__openLeaf(b, "# B\n");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		expect(readFrontMatter(app, "Notes/a.md").last_modified_by).toBe("tester");
		expect(readLog(app).map((e) => e.file)).toEqual(["Notes/a.md"]);
		// B was only opened, never edited.
		expect(readFrontMatter(app, "Notes/b.md")).toEqual({});
	});

	it("stamps a note edited in a background split pane", async () => {
		const a = app.vault.__seed("Notes/a.md", "# A\n\nhello\n");
		const b = app.vault.__seed("Notes/b.md", "# B\n");
		plugin = await boot(app);

		const viewA = app.workspace.__openLeaf(a, "# A\n\nhello\n");
		// B becomes the active pane; A stays open beside it.
		app.workspace.__openLeaf(b, "# B\n");

		fireEditIn(app, viewA, "# A\n\nhello world\n");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		expect(readFrontMatter(app, "Notes/a.md").last_modified_by).toBe("tester");
	});

	it("uses the emitting note's content, not whatever the leaf now shows", async () => {
		// The anti-cross-contamination case. An Obsidian leaf can be re-pointed at
		// another note (clicking a link in the same tab) and the Editor object
		// survives. Trusting it blindly would stamp A's frontmatter using B's text
		// and cache B's text as A's diff baseline. A naive "just capture the
		// editor" fix passes the two tests above and fails this one.
		const a = app.vault.__seed("Notes/a.md", "# A\n\n## Alpha\n\nalpha body\n");
		const b = app.vault.__seed("Notes/b.md", "# B\n\n## Beta\n\nbeta body\n");
		plugin = await boot(app);

		const edited = "# A\n\n## Alpha\n\nalpha body\n\n## Added\n\nnew\n";
		const view = app.workspace.__openLeaf(a, "# A\n\n## Alpha\n\nalpha body\n");
		fireEditIn(app, view, edited);

		// Obsidian flushes the buffer to disk on its own schedule; do that here so
		// the fallback path has the edited text rather than a stale copy.
		await app.vault.modify(a, edited);

		// Same leaf, now showing B — the Editor object survives the switch.
		view.file = b;
		view.editor.setValue("# B\n\n## Beta\n\nbeta body\n");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		// A must be described by A's own content. "## Beta" appearing here would
		// mean B's text was attributed to A.
		const entries = readLog(app);
		expect(entries.map((e) => e.file)).toEqual(["Notes/a.md"]);
		expect(entries[0].summary).toContain("## Added");
		expect(entries[0].summary).not.toContain("## Beta");
		expect(readFrontMatter(app, "Notes/b.md")).toEqual({});
	});

	it("still stamps a note renamed during the debounce window", async () => {
		const a = app.vault.__seed("Notes/a.md", "# A\n\nhello\n");
		plugin = await boot(app);

		fireEdit(app, a, "# A\n\nhello world\n");
		await app.vault.rename(a, "Notes/renamed.md");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		// Keyed by the TFile object, so the pending edit follows the rename. A
		// path-keyed map would have resolved the old path to nothing here.
		expect(readFrontMatter(app, "Notes/renamed.md").last_modified_by).toBe(
			"tester",
		);
		expect(readLog(app).map((e) => e.file)).toEqual(["Notes/renamed.md"]);
	});

	it("carries the diff baseline across a rename", async () => {
		const a = app.vault.__seed("Notes/a.md", "# A\n\n## One\n\nbody\n");
		plugin = await boot(app);
		// Opening seeds the baseline under the OLD path via active-leaf-change.
		// That handler caches asynchronously and reads file.path only after its
		// await, so let it settle before renaming — otherwise the cache write
		// races the path mutation and lands under the new path by accident,
		// which would pass with or without the rename handler.
		const view = app.workspace.__openLeaf(a, "# A\n\n## One\n\nbody\n");
		await vi.advanceTimersByTimeAsync(0);

		await app.vault.rename(a, "Notes/renamed.md");

		// Reuse the same view rather than reopening, so the assertion depends on
		// the rename handler re-keying the cache.
		fireEditIn(app, view, "# A\n\n## One\n\nbody\n\n## Two\n\nmore\n");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		const [entry] = readLog(app);
		expect(entry.summary).toContain("## Two");
		expect(entry.summary).not.toContain("no cached baseline");
	});

	it("drops a pending edit for a note deleted during the window", async () => {
		const a = app.vault.__seed("Notes/a.md", "# A\n");
		const b = app.vault.__seed("Notes/b.md", "# B\n");
		plugin = await boot(app);

		fireEdit(app, a, "# A\n\nedited\n");
		await app.vault.delete(a);
		// Positive control: a sibling edited in the same window is still stamped.
		fireEdit(app, b, "# B\n\nedited\n");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		expect(readLog(app).map((e) => e.file)).toEqual(["Notes/b.md"]);
	});

	it("skips a no-op edit rather than inflating edit_count", async () => {
		const a = app.vault.__seed("Notes/a.md", "# A\n\nhello\n");
		plugin = await boot(app);

		// One view throughout: reopening a leaf would re-seed the diff baseline
		// from the vault copy, which by then carries frontmatter the editor buffer
		// does not, so the two sides would never compare equal.
		const view = app.workspace.__openLeaf(a, "# A\n\nhello\n");
		const fire = async (value: string) => {
			fireEditIn(app, view, value);
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
		};

		await fire("# A\n\nhello world\n");
		expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(1);

		// Same content again: no new stamp, no new log line.
		await fire("# A\n\nhello world\n");
		expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(1);
		expect(readLog(app)).toHaveLength(1);

		// Positive control: a real change still counts.
		await fire("# A\n\nhello world again\n");
		expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(2);
		expect(readLog(app)).toHaveLength(2);
	});

	it("stamp-current-note always stamps, even on unchanged content", async () => {
		// The no-op guard suppresses echo/undo on the DEBOUNCE path only. An
		// explicit user command must still stamp: the common moment to reach for
		// it is right after an auto-stamp, when content matches the cache exactly.
		const a = app.vault.__seed("Notes/a.md", "# A\n");
		plugin = await boot(app);
		const view = app.workspace.__openLeaf(a, "# A\n");

		fireEditIn(app, view, "# A\n\nedited\n");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(1);

		const cmd = app.__commands.find((c) => c.id === "stamp-current-note")!;
		await cmd.editorCallback!(view.editor, { file: a });
		await vi.advanceTimersByTimeAsync(0);

		expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(2);
		expect(readLog(app)).toHaveLength(2);
	});

	it("abandons a stamp already in flight when the plugin unloads", async () => {
		// Cancelling timers is not enough: the debounce callback can already have
		// fired and be awaiting vault.read / processFrontMatter when the user
		// disables the plugin. Without a check on the write path, the stamp landed
		// anyway.
		const a = app.vault.__seed("Notes/a.md", "# A\n");
		plugin = await boot(app);
		const view = app.workspace.__openLeaf(a, "# A\n");

		fireEditIn(app, view, "# A\n\nedited\n");
		// Sync advance fires the timer without draining the async chain it starts.
		vi.advanceTimersByTime(DEBOUNCE);
		plugin.onunload();
		await vi.advanceTimersByTimeAsync(0);

		expect(readFrontMatter(app, "Notes/a.md")).toEqual({});
		expect(readLog(app)).toEqual([]);
	});

	it("releases the in-progress key under the path it claimed", async () => {
		// _stampInProgress is keyed by path while the stamp awaits. A rename
		// mid-stamp mutates TFile.path in place, so releasing under the new path
		// stranded the old one — and any note later created at that path was
		// silently never stamped again for the rest of the session.
		const a = app.vault.__seed("Notes/a.md", "# A\n");
		plugin = await boot(app);
		const view = app.workspace.__openLeaf(a, "# A\n");

		fireEditIn(app, view, "# A\n\nedited\n");
		vi.advanceTimersByTime(DEBOUNCE);
		await app.vault.rename(a, "Notes/moved.md");
		await vi.advanceTimersByTimeAsync(10);

		// A different note now occupies the original path.
		const fresh = app.vault.__seed("Notes/a.md", "# fresh\n");
		const freshView = app.workspace.__openLeaf(fresh, "# fresh\n");
		fireEditIn(app, freshView, "# fresh\n\nedited\n");
		await vi.advanceTimersByTimeAsync(DEBOUNCE);

		expect(readFrontMatter(app, "Notes/a.md").last_modified_by).toBe("tester");
	});

	it("does not arm the auto-import handler if unloaded before layout-ready", async () => {
		// The create handler is registered inside onLayoutReady to dodge the
		// vault-indexing stampede. A user who disables the plugin while the vault
		// is still indexing would otherwise get a handler armed after unload.
		plugin = await boot(
			app,
			{
				autoImportFolders: [
					{
						folder: "Emails",
						author: "importer:email",
						contentOrigin: "primary",
					},
				],
			},
			{ layoutReady: false },
		);
		app.vault.__seedFolder("Emails");

		plugin.onunload();
		app.workspace.__triggerLayoutReady();

		await app.vault.create("Emails/msg.md", "# hi\n");
		await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS * 2);

		expect(readFrontMatter(app, "Emails/msg.md")).toEqual({});
		expect(readLog(app)).toEqual([]);
	});

	it("writes nothing to the vault after unload", async () => {
		const a = app.vault.__seed("Notes/a.md", "# A\n");
		plugin = await boot(app, {
			autoImportFolders: [
				{ folder: "Emails", author: "importer:email", contentOrigin: "primary" },
			],
		});
		app.vault.__seedFolder("Emails");

		// One pending debounced edit and one pending auto-import settle timer.
		fireEdit(app, a, "# A\n\nedited\n");
		await app.vault.create("Emails/msg.md", "# hi\n");

		plugin.onunload();
		await vi.advanceTimersByTimeAsync(
			Math.max(DEBOUNCE, AUTO_IMPORT_STAMP_DELAY_MS) * 2,
		);

		expect(readFrontMatter(app, "Notes/a.md")).toEqual({});
		expect(readFrontMatter(app, "Emails/msg.md")).toEqual({});
		expect(readLog(app)).toEqual([]);
	});
});

describe("#4 — calendar-day log retention", () => {
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

	it("keeps yesterday's log at retention 1", async () => {
		seedLogs(app, ["2026-08-25", "2026-08-24", "2026-08-23", "2026-08-22"]);
		plugin = await boot(app, { logRetentionDays: 1 });
		await vi.advanceTimersByTimeAsync(0);

		expect(folderContents(app, "Authorship Logs")).toEqual([
			"2026-08-24.jsonl",
			"2026-08-25.jsonl",
		]);
	});

	it("deletes every expired log, not every other one", async () => {
		// The mutation-during-iteration regression: pruneLogs walked
		// folder.children while vault.delete spliced that same array, so with four
		// consecutive expired logs, 2020-01-02 and 2020-01-04 survived.
		seedLogs(app, ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2026-08-25"]);
		plugin = await boot(app, { logRetentionDays: 7 });
		await vi.advanceTimersByTimeAsync(0);

		expect(folderContents(app, "Authorship Logs")).toEqual(["2026-08-25.jsonl"]);
		expect(app.fileManager.__trashed.map((file) => file.name).sort()).toEqual([
			"2020-01-01.jsonl",
			"2020-01-02.jsonl",
			"2020-01-03.jsonl",
			"2020-01-04.jsonl",
		]);
	});

	it("keeps everything at retention 0", async () => {
		seedLogs(app, ["2020-01-01", "2020-01-02", "2026-08-25"]);
		plugin = await boot(app, { logRetentionDays: 0 });
		await vi.advanceTimersByTimeAsync(0);

		expect(folderContents(app, "Authorship Logs")).toEqual([
			"2020-01-01.jsonl",
			"2020-01-02.jsonl",
			"2026-08-25.jsonl",
		]);
	});

	it("never deletes files that are not daily logs", async () => {
		seedLogs(app, ["2020-01-01"]);
		app.vault.__seed("Authorship Logs/notes.md", "keep me\n");
		app.vault.__seed("Authorship Logs/0000-00-00.jsonl", "junk\n");
		app.vault.__seed("Authorship Logs/2020-01-01.jsonl.bak", "backup\n");
		plugin = await boot(app, { logRetentionDays: 1 });
		await vi.advanceTimersByTimeAsync(0);

		// The real log went; everything unrecognised stayed.
		expect(folderContents(app, "Authorship Logs")).toEqual([
			"0000-00-00.jsonl",
			"2020-01-01.jsonl.bak",
			"notes.md",
		]);
	});

	it("prunes on the boundary exactly", async () => {
		seedLogs(app, ["2026-08-18", "2026-08-17"]);
		plugin = await boot(app, { logRetentionDays: 7 });
		await vi.advanceTimersByTimeAsync(0);

		// Age 7 is kept, age 8 is not.
		expect(folderContents(app, "Authorship Logs")).toEqual(["2026-08-18.jsonl"]);
	});

	it("stops pruning when the plugin is unloaded mid-sweep", async () => {
		// pruneLogs is launched un-awaited from onLayoutReady, so without a check
		// it kept deleting after the user disabled the plugin — contradicting the
		// guarantee that a disabled plugin never touches the vault.
		seedLogs(app, [
			"2020-01-01",
			"2020-01-02",
			"2020-01-03",
			"2020-01-04",
			"2020-01-05",
			"2020-01-06",
		]);
		plugin = await boot(app, { logRetentionDays: 1 });
		// The sweep is already in flight by the time boot() returns — onLayoutReady
		// starts it — so the guarantee is that it STOPS, not that nothing was
		// deleted. Without the check, all six go.
		plugin.onunload();
		await vi.advanceTimersByTimeAsync(0);

		expect(folderContents(app, "Authorship Logs").length).toBeGreaterThan(0);
	});

	it("prunes the whole sweep when it is not interrupted", async () => {
		// Positive control for the test above: the same fixture, left to run,
		// deletes everything expired. Without it, "some logs survived" would also
		// pass on a prune that never ran.
		seedLogs(app, [
			"2020-01-01",
			"2020-01-02",
			"2020-01-03",
			"2020-01-04",
			"2020-01-05",
			"2020-01-06",
		]);
		plugin = await boot(app, { logRetentionDays: 1 });
		await vi.advanceTimersByTimeAsync(0);

		expect(folderContents(app, "Authorship Logs")).toEqual([]);
	});

	it("leaves a missing log folder alone", async () => {
		plugin = await boot(app, { logRetentionDays: 1 });
		await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
		expect(app.vault.__exists("Authorship Logs")).toBe(false);
	});
});
