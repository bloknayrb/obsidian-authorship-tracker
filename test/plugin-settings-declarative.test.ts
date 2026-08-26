// Coverage for the declarative settings path added in Obsidian 1.13.
//
// On 1.13+ Obsidian renders the tab from getSettingDefinitions() and never calls
// display(), so this path shares no code with the imperative one beyond the copy
// constants. The framework is not available in the unit suite; what stands in
// for it is the small render emulation on the mock PluginSettingTab, which
// models only what the real typings actually document:
//   * a control is seeded from getControlValue on every render
//   * a change runs validate first, and a returned message rejects it
//
// Behaviour the typings leave unspecified — whether hide() fires in declarative
// mode, whether writes are per-keystroke or on commit — is deliberately not
// asserted here, because a mock cannot establish it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, __notices, __resetNotices } from "obsidian";
import AuthorshipTrackerPlugin from "../main";
import { SETTING_COPY } from "../src/settings-controls";
import { boot, installFakeClock, readFrontMatter } from "./helpers";

const COPY = SETTING_COPY;

describe("declarative settings (Obsidian 1.13+)", () => {
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

	const tabOf = () => app.__settingTabs[0];

	it("declares a control for every persisted setting", async () => {
		// The write path keys off these strings and Obsidian types them as plain
		// `string`, so a missing or misspelled key is not a compile error — it
		// silently falls through to the default write path.
		plugin = await boot(app);
		const keys = tabOf()
			.__controls()
			.map((d) => d.control.key)
			.sort();

		expect(keys).toEqual(
			[
				"authorName",
				"autoImportFolders",
				"debounceMs",
				"editLogsPath",
				"ignoreFiles",
				"ignoreFolders",
				"logRetentionDays",
				"maxCacheSize",
			].sort(),
		);
	});

	it("renders stored values, including the ones stored as arrays", async () => {
		plugin = await boot(app, {
			authorName: "tester",
			ignoreFolders: ["Templates", "Private"],
			ignoreFiles: ["secret.md"],
			autoImportFolders: [
				{
					folder: "Emails",
					author: "importer:email",
					contentOrigin: "primary",
				},
			],
		});
		const tab = tabOf();

		expect(tab.__renderedValue(COPY.authorName.name)).toBe("tester");
		// Stored as arrays, edited as text — the seam this path has to bridge.
		expect(tab.__renderedValue(COPY.ignoreFolders.name)).toBe(
			"Templates, Private",
		);
		expect(tab.__renderedValue(COPY.ignoreFiles.name)).toBe("secret.md");
		expect(tab.__renderedValue(COPY.autoImportFolders.name)).toBe(
			"Emails=importer:email|primary",
		);
	});

	it("round-trips a comma-separated list back into an array", async () => {
		plugin = await boot(app, { ignoreFolders: [] });
		const tab = tabOf();

		expect(
			await tab.__setControlFromUser(
				COPY.ignoreFolders.name,
				" Templates , Archive ,, ",
			),
		).toBeNull();

		// Persisted as a real array, not the raw string: loadSettings rejects a
		// malformed value and silently resets it to defaults on next launch.
		expect(plugin.settings.ignoreFolders).toEqual(["Templates", "Archive"]);
		expect(Array.isArray(plugin.settings.ignoreFolders)).toBe(true);
		expect(tab.__renderedValue(COPY.ignoreFolders.name)).toBe(
			"Templates, Archive",
		);
	});

	it("resizes the live content cache when cache size changes", async () => {
		// The inherited write path only persists. saveSettings() also resizes the
		// running cache, so a write that bypassed it would store the new number
		// and leave the cache at its old capacity.
		plugin = await boot(app, { maxCacheSize: 50 });
		const cache = (plugin as unknown as { _contentCache: { size: number } })
			._contentCache;
		const seed = plugin as unknown as {
			_contentCache: { set(k: string, v: string): void };
		};
		seed._contentCache.set("a.md", "a");
		seed._contentCache.set("b.md", "b");
		seed._contentCache.set("c.md", "c");
		expect(cache.size).toBe(3);

		expect(
			await tabOf().__setControlFromUser(COPY.maxCacheSize.name, 1),
		).toBeNull();

		expect(plugin.settings.maxCacheSize).toBe(1);
		expect(cache.size).toBe(1);
	});

	describe("numeric guards", () => {
		it("rejects a below-minimum debounce with an inline message", async () => {
			plugin = await boot(app, { debounceMs: 10000 });

			const message = await tabOf().__setControlFromUser(
				COPY.debounceMs.name,
				500,
			);

			expect(message).toMatch(/at least 1000/);
			expect(plugin.settings.debounceMs).toBe(10000);
		});

		it("never stores a zero debounce from an unparseable field", async () => {
			// A number control "falls back to defaultValue (or 0) if the input
			// cannot be parsed". debounceMs = 0 would stamp frontmatter and append
			// a log line on essentially every keystroke, so the write path clamps
			// even when the framework hands it 0.
			plugin = await boot(app, { debounceMs: 10000 });
			const tab = tabOf();

			await tab.setControlValue("debounceMs", 0);
			expect(plugin.settings.debounceMs).toBeGreaterThanOrEqual(1000);

			await tab.setControlValue("maxCacheSize", 0);
			expect(plugin.settings.maxCacheSize).toBeGreaterThanOrEqual(1);
		});

		it("declares a usable defaultValue for every number control", async () => {
			// The documented fallback is defaultValue, or 0 when absent.
			plugin = await boot(app);
			for (const def of tabOf().__controls()) {
				if (def.control.type !== "number") continue;
				expect(typeof def.control.defaultValue).toBe("number");
			}
		});

		it("accepts zero retention, which means keep everything", async () => {
			plugin = await boot(app, { logRetentionDays: 7 });

			expect(
				await tabOf().__setControlFromUser(COPY.logRetentionDays.name, 0),
			).toBeNull();
			expect(plugin.settings.logRetentionDays).toBe(0);
		});
	});

	it("refuses an empty edit logs path", async () => {
		// Empty would resolve log writes to the vault root and send the retention
		// pass walking it.
		plugin = await boot(app, { editLogsPath: "Authorship Logs" });

		const message = await tabOf().__setControlFromUser(
			COPY.editLogsPath.name,
			"   ",
		);

		expect(message).toMatch(/cannot be empty/i);
		expect(plugin.settings.editLogsPath).toBe("Authorship Logs");
	});

	describe("auto-import mappings", () => {
		it("stores a mapping immediately rather than on a debounce", async () => {
			// Obsidian reseeds a control from getControlValue on every render, and a
			// render can land while a debounce is pending — which would throw away
			// what the user had typed. Only the pattern warning is deferred.
			plugin = await boot(app, { autoImportFolders: [] });

			await tabOf().__setControlFromUser(
				COPY.autoImportFolders.name,
				"Emails=importer:email|primary",
			);

			expect(plugin.settings.autoImportFolders).toEqual([
				{
					folder: "Emails",
					author: "importer:email",
					contentOrigin: "primary",
				},
			]);
		});

		it("keeps an unusable pattern verbatim and warns after the debounce", async () => {
			// Rejecting would discard every other mapping in the textarea, and
			// stripping the pattern would leave a bare Folder=Author|Origin rule
			// matching every file in the folder.
			plugin = await boot(app, { autoImportFolders: [] });

			const message = await tabOf().__setControlFromUser(
				COPY.autoImportFolders.name,
				"Emails=importer:email|primary\nMeetings=importer:x|primary|(a+)+$",
			);

			expect(message).toBeNull();
			expect(plugin.settings.autoImportFolders).toHaveLength(2);
			expect(plugin.settings.autoImportFolders[1].filenamePattern).toBe(
				"(a+)+$",
			);
			// Validation is expensive, so the warning is debounced, not skipped.
			expect(__notices).toEqual([]);
			await vi.advanceTimersByTimeAsync(1000);
			expect(__notices.join("\n")).toMatch(/unusable filename pattern/i);
		});

		it("fails closed: the unusable mapping still matches nothing", async () => {
			plugin = await boot(app, { autoImportFolders: [] });
			app.vault.__seedFolder("Emails");

			await tabOf().__setControlFromUser(
				COPY.autoImportFolders.name,
				"Emails=importer:email|primary|(a+)+$",
			);
			await vi.advanceTimersByTimeAsync(1000);

			await app.vault.create("Emails/msg.md", "# hi\n");
			await vi.advanceTimersByTimeAsync(5000);

			expect(readFrontMatter(app, "Emails/msg.md")).toEqual({});
		});

		it("does not warn after the plugin is unloaded", async () => {
			// The debounce can outlive the plugin being disabled.
			plugin = await boot(app, { autoImportFolders: [] });

			await tabOf().__setControlFromUser(
				COPY.autoImportFolders.name,
				"Meetings=importer:x|primary|(a+)+$",
			);
			plugin.onunload();
			plugin = undefined;
			await vi.advanceTimersByTimeAsync(1000);

			expect(__notices).toEqual([]);
		});
	});

	it("shows the same names in both settings paths", async () => {
		// The two renderings are independent code; the copy constants are what
		// keeps them from drifting.
		plugin = await boot(app);
		const tab = tabOf();
		tab.display();

		for (const def of tab.__controls()) {
			expect(tab.__setting(def.name)).toBeDefined();
		}
	});
});
