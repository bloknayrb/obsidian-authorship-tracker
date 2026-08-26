// Baseline coverage for the plugin lifecycle, pinning behavior as it exists today.
//
// Scope note: this file deliberately contains NO regression tests for the open bugs
// (#3 dropped edits on tab switch, #4 rolling-window retention). Those fail against
// current code and land with their fixes. What is here is the behavior a fix must
// not break.
//
// Two rules this suite follows, because the alternative is tests that pass against a
// dead harness:
//   * every negative assertion carries a positive control in the same test body
//   * frontmatter is asserted through readFrontMatter(), never against raw file text,
//     so the assertions are not coupled to the mock's YAML serializer
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, __notices, __resetNotices } from "obsidian";
import AuthorshipTrackerPlugin, { AUTO_IMPORT_STAMP_DELAY_MS } from "../main";
import {
	DEBOUNCE,
	boot,
	edit,
	fireEdit,
	folderContents,
	installFakeClock,
	logPathForToday,
	readFrontMatter,
	readLog,
} from "./helpers";

describe("AuthorshipTrackerPlugin", () => {
	let app: App;
	let plugin: AuthorshipTrackerPlugin | undefined;

	beforeEach(() => {
		installFakeClock();
		app = new App();
		__resetNotices();
	});

	afterEach(() => {
		plugin?.onunload();
		plugin = undefined;
		vi.useRealTimers();
	});

	// ── Debounce ──────────────────────────────────────────────────────────────

	describe("editor-change debounce", () => {
		it("does not stamp before the debounce elapses", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			plugin = await boot(app);
			fireEdit(app, file, "# A\n\nmore\n");
			await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
			expect(readFrontMatter(app, "Notes/a.md")).toEqual({});

			// Positive control: the same edit DOES stamp once the window closes, so
			// the assertion above is about timing rather than a dead harness.
			await vi.advanceTimersByTimeAsync(1);
			expect(readFrontMatter(app, "Notes/a.md").last_modified_by).toBe(
				"tester",
			);
		});

		it("coalesces a burst of edits into a single stamp", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			plugin = await boot(app);
			const view = app.workspace.__openLeaf(file, "# A\n");

			for (let i = 0; i < 5; i++) {
				view.editor.setValue(`# A\n\nline ${i}\n`);
				app.workspace.trigger("editor-change", view.editor, view);
				await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			}
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(1);
			expect(readLog(app)).toHaveLength(1);
		});

		it("increments edit_count across separate stamps", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			plugin = await boot(app);
			await edit(app, file, "# A\n\none\n");
			await edit(app, file, "# A\n\none\ntwo\n");

			expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(2);
			expect(readLog(app)).toHaveLength(2);
		});

		it("clears pending timers on unload", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			plugin = await boot(app);
			fireEdit(app, file, "# A\n\nedited\n");
			plugin.onunload();
			await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

			expect(readFrontMatter(app, "Notes/a.md")).toEqual({});
		});
	});

	// ── Frontmatter ───────────────────────────────────────────────────────────

	describe("frontmatter stamping", () => {
		it("writes the full field set on a first edit", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n\nbody\n");
			plugin = await boot(app);
			await edit(app, file, "# A\n\nbody edited\n");

			expect(readFrontMatter(app, "Notes/a.md")).toMatchObject({
				created_by: "tester",
				content_origin: "human-authored",
				last_modified_by: "tester",
				edit_count: 1,
			});
		});

		it("never overwrites an existing created_by or content_origin", async () => {
			const file = app.vault.__seed(
				"Notes/a.md",
				"---\ncreated_by: someone-else\ncontent_origin: ai-derived\n---\n# A\n",
			);
			plugin = await boot(app);
			await edit(app, file, "# A\n\nedited\n");

			const fm = readFrontMatter(app, "Notes/a.md");
			expect(fm.created_by).toBe("someone-else");
			expect(fm.content_origin).toBe("ai-derived");
			// Positive control: the fields that SHOULD change did, proving the write
			// path ran rather than silently no-opping.
			expect(fm.last_modified_by).toBe("tester");
			expect(fm.edit_count).toBe(1);
		});

		it("continues an existing numeric edit_count", async () => {
			const file = app.vault.__seed(
				"Notes/a.md",
				"---\ncreated_by: x\nedit_count: 5\n---\n# A\n",
			);
			plugin = await boot(app);
			await edit(app, file, "# A\n\nedited\n");

			expect(readFrontMatter(app, "Notes/a.md").edit_count).toBe(6);
		});

		it("falls back to 'me' when no author name is configured", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			plugin = await boot(app, { authorName: "" });
			await edit(app, file, "# A\n\nedited\n");

			expect(readFrontMatter(app, "Notes/a.md").last_modified_by).toBe("me");
		});
	});

	// ── Ignore rules ──────────────────────────────────────────────────────────

	describe("ignore rules", () => {
		it("ignores the vault's configured folder rather than assuming .obsidian", async () => {
			app.vault.configDir = "Vault Settings";
			const configFile = app.vault.__seed(
				"Vault Settings/appearance.md",
				"# Settings\n",
			);
			const ordinaryFile = app.vault.__seed("Notes/a.md", "# Note\n");
			plugin = await boot(app);

			await edit(app, configFile, "# Settings\nchanged\n");
			await edit(app, ordinaryFile, "# Note\nchanged\n");

			expect(readFrontMatter(app, configFile.path)).toEqual({});
			expect(readFrontMatter(app, ordinaryFile.path).last_modified_by).toBe(
				"tester",
			);
		});

		it("skips ignored folders while still stamping everything else", async () => {
			const keep = app.vault.__seed("Notes/keep.md", "# keep\n");
			const skip = app.vault.__seed("Templates/skip.md", "# skip\n");
			plugin = await boot(app);

			await edit(app, keep, "# keep\n\nedited\n");
			await edit(app, skip, "# skip\n\nedited\n");

			// Exact set, not `.not.toContain` — a dead harness would produce an empty
			// log and satisfy a negative-only assertion.
			expect(readLog(app).map((e) => e.file)).toEqual(["Notes/keep.md"]);
			expect(readFrontMatter(app, "Templates/skip.md")).toEqual({});
		});

		it("skips ignored file names", async () => {
			const keep = app.vault.__seed("Notes/keep.md", "# keep\n");
			const skip = app.vault.__seed("Notes/secret.md", "# secret\n");
			plugin = await boot(app, { ignoreFiles: ["secret.md"] });

			for (const f of [keep, skip]) await edit(app, f, "# edited\n");

			expect(readLog(app).map((e) => e.file)).toEqual(["Notes/keep.md"]);
		});
	});

	// ── Logging ───────────────────────────────────────────────────────────────

	describe("JSONL logging", () => {
		it("creates the log folder when it does not exist", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			expect(app.vault.__exists("Authorship Logs")).toBe(false);
			plugin = await boot(app);

			await edit(app, file, "# A\n\nedited\n");

			expect(app.vault.__exists("Authorship Logs")).toBe(true);
			expect(readLog(app)).toHaveLength(1);
		});

		it("writes one well-formed JSON object per line and appends", async () => {
			const a = app.vault.__seed("Notes/a.md", "# A\n");
			const b = app.vault.__seed("Notes/b.md", "# B\n");
			plugin = await boot(app);

			for (const f of [a, b]) {
			await edit(app, f, "# edited\n");
			}

			const entries = readLog(app);
			expect(entries).toHaveLength(2);
			for (const e of entries) {
				expect(Object.keys(e).sort()).toEqual([
					"action",
					"author",
					"file",
					"summary",
					"ts",
				]);
				expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
			}
			expect(entries.map((e) => e.file)).toEqual(["Notes/a.md", "Notes/b.md"]);
		});

		it("honours a custom log folder", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			plugin = await boot(app, { editLogsPath: "meta/logs" });

			await edit(app, file, "# A\n\nedited\n");

			expect(readLog(app, "meta/logs")).toHaveLength(1);
			expect(app.vault.__exists(logPathForToday())).toBe(false);
		});
	});

	// ── Auto-import ───────────────────────────────────────────────────────────

	describe("auto-import on create", () => {
		const mapping = [
			{ folder: "Emails", author: "importer:email", contentOrigin: "primary" },
		];

		it("stamps a mapped file after the settle delay", async () => {
			plugin = await boot(app, { autoImportFolders: mapping });
			app.vault.__seedFolder("Emails");

			await app.vault.create("Emails/msg.md", "# hello\n");
			expect(readFrontMatter(app, "Emails/msg.md")).toEqual({});

			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);

			expect(readFrontMatter(app, "Emails/msg.md")).toMatchObject({
				created_by: "importer:email",
				content_origin: "primary",
			});
			expect(readLog(app)).toMatchObject([
				{ file: "Emails/msg.md", action: "created" },
			]);
		});

		it("leaves unmapped folders alone", async () => {
			plugin = await boot(app, { autoImportFolders: mapping });
			app.vault.__seedFolder("Emails");
			app.vault.__seedFolder("Other");

			await app.vault.create("Other/note.md", "# hi\n");
			await app.vault.create("Emails/msg.md", "# hi\n");
			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);

			expect(readFrontMatter(app, "Other/note.md")).toEqual({});
			// Positive control: the mapped sibling in the same burst was stamped.
			expect(readFrontMatter(app, "Emails/msg.md").created_by).toBe(
				"importer:email",
			);
		});

		it("ignores create events fired before layout is ready", async () => {
			// The create handler is registered inside onLayoutReady specifically to
			// dodge the vault-indexing stampede on startup.
			plugin = await boot(
				app,
				{ autoImportFolders: mapping },
				{ layoutReady: false },
			);

			app.vault.__seedFolder("Emails");
			await app.vault.create("Emails/early.md", "# hi\n");
			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);
			expect(readFrontMatter(app, "Emails/early.md")).toEqual({});

			// Positive control: once layout is ready, the same create does stamp.
			app.workspace.__triggerLayoutReady();
			await app.vault.create("Emails/late.md", "# hi\n");
			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);
			expect(readFrontMatter(app, "Emails/late.md").created_by).toBe(
				"importer:email",
			);
		});

		it("does not re-stamp a file that already records a creator", async () => {
			plugin = await boot(app, { autoImportFolders: mapping });
			app.vault.__seedFolder("Emails");

			await app.vault.create(
				"Emails/msg.md",
				"---\ncreated_by: original\n---\n# hi\n",
			);
			// Positive control: a sibling with no creator, created in the same burst,
			// IS stamped — so the assertions below are about the existing field, not
			// about auto-import being wired up wrong.
			await app.vault.create("Emails/fresh.md", "# hi\n");
			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);

			expect(readFrontMatter(app, "Emails/msg.md").created_by).toBe(
				"original",
			);
			expect(readFrontMatter(app, "Emails/fresh.md").created_by).toBe(
				"importer:email",
			);
			expect(readLog(app).map((e) => e.file)).toEqual(["Emails/fresh.md"]);
		});

		it("survives a file deleted inside the settle window", async () => {
			plugin = await boot(app, { autoImportFolders: mapping });
			app.vault.__seedFolder("Emails");

			const file = await app.vault.create("Emails/msg.md", "# hi\n");
			await app.vault.delete(file);
			// Positive control: a sibling that survives the window IS stamped, so
			// "no log line for the deleted file" cannot pass on dead create wiring.
			await app.vault.create("Emails/survivor.md", "# hi\n");

			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);

			// No assertion on "did not throw": handleCreate swallows errors through
			// notifyError, so it could never throw here regardless. Assert instead
			// that nothing was logged for the vanished file, and that no error
			// Notice was raised.
			expect(readLog(app).map((e) => e.file)).toEqual(["Emails/survivor.md"]);
			expect(__notices).toEqual([]);
		});
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	describe("commands", () => {
		it("registers both commands", async () => {
			plugin = await boot(app);
			expect(app.__commands.map((c) => c.id).sort()).toEqual([
				"open-todays-log",
				"stamp-current-note",
			]);
		});

		it("stamp-current-note stamps immediately, without waiting for a debounce", async () => {
			const file = app.vault.__seed("Notes/a.md", "# A\n");
			plugin = await boot(app);
			const view = app.workspace.__openLeaf(file, "# A\n\nedited\n");

			const cmd = app.__commands.find((c) => c.id === "stamp-current-note")!;
			await cmd.editorCallback!(view.editor, { file });
			await vi.advanceTimersByTimeAsync(0);

			expect(readFrontMatter(app, "Notes/a.md").last_modified_by).toBe(
				"tester",
			);
		});

		it("open-todays-log notices when no log exists yet", async () => {
			plugin = await boot(app);
			const cmd = app.__commands.find((c) => c.id === "open-todays-log")!;
			await cmd.callback!();
			expect(__notices.join("\n")).toContain("No authorship log for today");
		});
	});

	// ── Settings ──────────────────────────────────────────────────────────────

	describe("settings", () => {
		it("merges a partial stored blob over the defaults", async () => {
			plugin = await boot(app, { authorName: "stored", debounceMs: 4321 });

			expect(plugin.settings.authorName).toBe("stored");
			expect(plugin.settings.debounceMs).toBe(4321);
			// Values that had to come from DEFAULT_SETTINGS.
			expect(plugin.settings.maxCacheSize).toBe(50);
			expect(plugin.settings.editLogsPath).toBe("Authorship Logs");
			expect(plugin.settings.logRetentionDays).toBe(0);
			expect(plugin.settings.ignoreFolders).toEqual([
				"Templates",
				"Excalidraw",
				".obsidian",
			]);
		});

		it("registers a settings tab", async () => {
			plugin = await boot(app);
			expect(app.__settingTabs).toHaveLength(1);
		});
	});

	// ── Unusable filename patterns ────────────────────────────────────────────

	describe("unusable filename patterns", () => {
		it("warns at load about a stored pattern that cannot be used", async () => {
			// A stored pattern never passes back through the settings tab, so
			// without this the mapping would just stop attributing anything with no
			// indication why.
			plugin = await boot(app, {
				autoImportFolders: [
					{
						folder: "Emails",
						author: "importer:email",
						contentOrigin: "primary",
						filenamePattern: "(a+)+$",
					},
				],
			});

			expect(__notices.join("\n")).toMatch(/unusable filename pattern/i);
			expect(__notices.join("\n")).toContain("(a+)+$");
		});

		it("says nothing at load when every pattern is fine", async () => {
			plugin = await boot(app, {
				autoImportFolders: [
					{
						folder: "Emails",
						author: "importer:email",
						contentOrigin: "primary",
						filenamePattern: "^Transcript-",
					},
				],
			});

			expect(__notices).toEqual([]);
		});

		it("debounces mapping validation instead of running it per keystroke", async () => {
			plugin = await boot(app, { autoImportFolders: [] });
			const tab = app.__settingTabs[0];
			tab.display();
			const field = tab.__setting("Folder-to-author mappings")!.components[0];

			// Half-typed states used to each raise an error and reject the save.
			await field.__type("Emails=importer:email|primary|^(");
			await field.__type("Emails=importer:email|primary|^(Notes");
			await field.__type("Emails=importer:email|primary|^(Notes|Transcript)-");
			expect(__notices).toEqual([]);
			expect(plugin.settings.autoImportFolders).toEqual([]);

			await vi.advanceTimersByTimeAsync(1000);

			// Only the final, complete value is validated and saved.
			expect(__notices).toEqual([]);
			expect(plugin.settings.autoImportFolders).toEqual([
				{
					folder: "Emails",
					author: "importer:email",
					contentOrigin: "primary",
					filenamePattern: "^(Notes|Transcript)-",
				},
			]);
		});

		it("does not lose a mapping edit when the settings tab closes", async () => {
			// Closing the tab inside the debounce window used to discard the edit
			// silently — a regression from the previous save-per-keystroke behavior.
			plugin = await boot(app, { autoImportFolders: [] });
			const tab = app.__settingTabs[0];
			tab.display();
			const field = tab.__setting("Folder-to-author mappings")!.components[0];

			await field.__type("Emails=importer:email|primary");
			expect(plugin.settings.autoImportFolders).toEqual([]);

			tab.hide();
			await vi.advanceTimersByTimeAsync(0);

			expect(plugin.settings.autoImportFolders).toEqual([
				{
					folder: "Emails",
					author: "importer:email",
					contentOrigin: "primary",
				},
			]);
		});

		it("reports an unusable pattern on save without discarding the rest", async () => {
			plugin = await boot(app, { autoImportFolders: [] });
			const tab = app.__settingTabs[0];
			tab.display();
			const field = tab.__setting("Folder-to-author mappings")!.components[0];

			await field.__type(
				"Emails=importer:email|primary\nMeetings=importer:x|primary|(a+)+$",
			);
			await vi.advanceTimersByTimeAsync(1000);

			expect(__notices.join("\n")).toMatch(/unusable filename pattern/i);
			// The good mapping survives; one bad line no longer discards everything.
			expect(plugin.settings.autoImportFolders).toHaveLength(2);
			expect(plugin.settings.autoImportFolders[0]).toEqual({
				folder: "Emails",
				author: "importer:email",
				contentOrigin: "primary",
			});
		});

		it("drops a stored mapping whose filenamePattern is not a string", async () => {
			// data.json is a plain file a user (or a sync conflict) can corrupt. A
			// non-string pattern used to slip past the settings guard and then throw
			// out of pattern validation during onload, taking the whole plugin down.
			plugin = await boot(app, {
				autoImportFolders: [
					{
						folder: "Emails",
						author: "importer:email",
						contentOrigin: "primary",
						filenamePattern: 42,
					},
					{
						folder: "Meetings",
						author: "importer:transcript",
						contentOrigin: "primary",
					},
				],
			});
			app.vault.__seedFolder("Emails");
			app.vault.__seedFolder("Meetings");

			await app.vault.create("Emails/msg.md", "# hi\n");
			await app.vault.create("Meetings/note.md", "# hi\n");
			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);

			expect(plugin.settings.autoImportFolders).toHaveLength(1);
			expect(readFrontMatter(app, "Emails/msg.md")).toEqual({});
			// Positive control: the well-formed mapping still works.
			expect(readFrontMatter(app, "Meetings/note.md").created_by).toBe(
				"importer:transcript",
			);
		});

		it("does not hang vault event handling on a catastrophic pattern", async () => {
			// The headline claim for #7. Unguarded, this filename against this
			// pattern takes roughly 80 seconds on the UI thread. The bound is
			// deliberately loose — wall-clock assertions are flaky on shared CI, and
			// the failure being caught here is four orders of magnitude, not four
			// hundred milliseconds.
			plugin = await boot(app, {
				autoImportFolders: [
					{
						folder: "Emails",
						author: "importer:email",
						contentOrigin: "primary",
						filenamePattern: "(a+)+$",
					},
				],
			});
			app.vault.__seedFolder("Emails");

			const evil = "a".repeat(32) + "!.md";
			const started = performance.now();
			await app.vault.create(`Emails/${evil}`, "# hi\n");
			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);
			const elapsed = performance.now() - started;

			expect(elapsed).toBeLessThan(5000);
			expect(readFrontMatter(app, `Emails/${evil}`)).toEqual({});
		});

		it("fails closed: a mapping with an unusable pattern matches nothing", async () => {
			// Critically it must not fall back to matching EVERY file in the folder,
			// which would turn a bad pattern into mass mis-attribution.
			plugin = await boot(app, {
				autoImportFolders: [
					{
						folder: "Emails",
						author: "importer:email",
						contentOrigin: "primary",
						filenamePattern: "(a+)+$",
					},
					{
						folder: "Meetings",
						author: "importer:transcript",
						contentOrigin: "primary",
					},
				],
			});
			app.vault.__seedFolder("Emails");
			app.vault.__seedFolder("Meetings");

			await app.vault.create("Emails/msg.md", "# hi\n");
			await app.vault.create("Meetings/note.md", "# hi\n");
			await vi.advanceTimersByTimeAsync(AUTO_IMPORT_STAMP_DELAY_MS);

			expect(readFrontMatter(app, "Emails/msg.md")).toEqual({});
			// Positive control: the unaffected mapping still works.
			expect(readFrontMatter(app, "Meetings/note.md").created_by).toBe(
				"importer:transcript",
			);
		});
	});

	// ── Retention (current behavior) ──────────────────────────────────────────

	describe("log retention", () => {
		it("keeps every log when retention is disabled", async () => {
			app.vault.__seed("Authorship Logs/2020-01-01.jsonl", "{}\n");
			app.vault.__seed("Authorship Logs/2026-08-24.jsonl", "{}\n");
			plugin = await boot(app, { logRetentionDays: 0 });
			await vi.advanceTimersByTimeAsync(0);

			// Exact surviving set, so this cannot pass on an empty folder.
			expect(folderContents(app, "Authorship Logs")).toEqual([
				"2020-01-01.jsonl",
				"2026-08-24.jsonl",
			]);
		});

		it("deletes clearly-expired logs and keeps recent ones", async () => {
			app.vault.__seed("Authorship Logs/2020-01-01.jsonl", "{}\n");
			app.vault.__seed("Authorship Logs/2026-08-25.jsonl", "{}\n");
			app.vault.__seed("Authorship Logs/notes.md", "not a log\n");
			plugin = await boot(app, { logRetentionDays: 7 });
			await vi.advanceTimersByTimeAsync(0);

			const names = folderContents(app, "Authorship Logs");
			expect(names).toContain("2026-08-25.jsonl");
			expect(names).not.toContain("2020-01-01.jsonl");
			// Non-log files are never deletion candidates.
			expect(names).toContain("notes.md");
		});
	});
});
