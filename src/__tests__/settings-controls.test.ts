import { describe, expect, it } from "vitest";

import {
	AuthorshipTrackerSettings,
	NUMERIC_BOUNDS,
	SETTING_COPY,
	SettingKey,
	applyControlValue,
	readControlValue,
	validateControlValue,
} from "../settings-controls";

function settings(
	overrides: Partial<AuthorshipTrackerSettings> = {},
): AuthorshipTrackerSettings {
	return {
		authorName: "me",
		debounceMs: 10000,
		maxCacheSize: 50,
		ignoreFolders: ["Templates"],
		ignoreFiles: [],
		editLogsPath: "Authorship Logs",
		logRetentionDays: 0,
		autoImportFolders: [],
		...overrides,
	};
}

const ALL_KEYS: SettingKey[] = [
	"authorName",
	"debounceMs",
	"maxCacheSize",
	"ignoreFolders",
	"ignoreFiles",
	"editLogsPath",
	"logRetentionDays",
	"autoImportFolders",
];

describe("readControlValue", () => {
	it("returns a displayable value for every setting", () => {
		const s = settings();
		for (const key of ALL_KEYS) {
			const value = readControlValue(s, key);
			expect(["string", "number"]).toContain(typeof value);
		}
	});

	it("serializes the array-backed settings as text", () => {
		const s = settings({
			ignoreFolders: ["Templates", "Excalidraw"],
			ignoreFiles: ["a.md", "b.md"],
			autoImportFolders: [
				{
					folder: "Emails",
					author: "importer:email",
					contentOrigin: "primary",
					filenamePattern: "^Transcript-",
				},
			],
		});

		expect(readControlValue(s, "ignoreFolders")).toBe("Templates, Excalidraw");
		expect(readControlValue(s, "ignoreFiles")).toBe("a.md, b.md");
		expect(readControlValue(s, "autoImportFolders")).toBe(
			"Emails=importer:email|primary|^Transcript-",
		);
	});
});

describe("applyControlValue", () => {
	it("round-trips every setting through read and back", () => {
		const original = settings({
			authorName: "bryan",
			debounceMs: 2500,
			maxCacheSize: 12,
			ignoreFolders: ["Templates", "Private"],
			ignoreFiles: ["secret.md"],
			editLogsPath: "Logs",
			logRetentionDays: 30,
			autoImportFolders: [
				{
					folder: "Emails",
					author: "importer:email",
					contentOrigin: "primary",
				},
			],
		});
		const target = settings();

		for (const key of ALL_KEYS) {
			applyControlValue(target, key, readControlValue(original, key));
		}

		expect(target).toEqual(original);
	});

	it("trims the author name", () => {
		const s = settings();
		applyControlValue(s, "authorName", "  bryan  ");
		expect(s.authorName).toBe("bryan");
	});

	it("clamps a number below its minimum instead of storing it", () => {
		const s = settings();

		applyControlValue(s, "debounceMs", 0);
		applyControlValue(s, "maxCacheSize", 0);
		applyControlValue(s, "logRetentionDays", -5);

		expect(s.debounceMs).toBe(NUMERIC_BOUNDS.debounceMs);
		expect(s.maxCacheSize).toBe(NUMERIC_BOUNDS.maxCacheSize);
		expect(s.logRetentionDays).toBe(NUMERIC_BOUNDS.logRetentionDays);
	});

	it("leaves a setting untouched when the value is unusable", () => {
		const s = settings();

		applyControlValue(s, "debounceMs", "not a number");
		applyControlValue(s, "authorName", 42);
		applyControlValue(s, "editLogsPath", "   ");
		applyControlValue(s, "ignoreFolders", null);

		expect(s.debounceMs).toBe(10000);
		expect(s.authorName).toBe("me");
		expect(s.editLogsPath).toBe("Authorship Logs");
		expect(s.ignoreFolders).toEqual(["Templates"]);
	});

	it("keeps the array-backed settings as arrays", () => {
		// The whole point of the override: the inherited write path would store
		// the raw string here, and loadSettings would reject it and silently
		// reset the setting to its default on the next launch.
		const s = settings();

		applyControlValue(s, "ignoreFolders", "A, B");
		applyControlValue(s, "ignoreFiles", "x.md");
		applyControlValue(s, "autoImportFolders", "Emails=importer:email|primary");

		expect(Array.isArray(s.ignoreFolders)).toBe(true);
		expect(Array.isArray(s.ignoreFiles)).toBe(true);
		expect(Array.isArray(s.autoImportFolders)).toBe(true);
		expect(s.autoImportFolders[0].folder).toBe("Emails");
	});

	it("drops empty entries from a comma-separated list", () => {
		const s = settings();
		applyControlValue(s, "ignoreFolders", " A ,, B , ");
		expect(s.ignoreFolders).toEqual(["A", "B"]);
	});

	it("stores a mapping whose pattern is unusable", () => {
		// Reported by notice, not rejected: rejecting would discard the other
		// mappings, and stripping the pattern would make the rule match every file
		// in the folder.
		const s = settings();
		applyControlValue(
			s,
			"autoImportFolders",
			"Emails=importer:email|primary|(a+)+$",
		);

		expect(s.autoImportFolders).toHaveLength(1);
		expect(s.autoImportFolders[0].filenamePattern).toBe("(a+)+$");
	});
});

describe("validateControlValue", () => {
	it("rejects a below-minimum number and an unparseable one", () => {
		expect(validateControlValue("debounceMs", 999)).toMatch(/at least 1000/);
		expect(validateControlValue("maxCacheSize", 0)).toMatch(/at least 1/);
		expect(validateControlValue("debounceMs", "abc")).toMatch(/number/i);
	});

	it("accepts values at the boundary", () => {
		expect(validateControlValue("debounceMs", 1000)).toBeNull();
		expect(validateControlValue("maxCacheSize", 1)).toBeNull();
		expect(validateControlValue("logRetentionDays", 0)).toBeNull();
	});

	it("rejects only a blank edit logs path", () => {
		expect(validateControlValue("editLogsPath", "   ")).toMatch(/empty/i);
		expect(validateControlValue("editLogsPath", "Logs")).toBeNull();
	});

	it("never rejects what applyControlValue would store", () => {
		// The two must agree: a value validate accepts has to be one apply can
		// store, or the control reports success and nothing changes.
		const accepted: Array<[SettingKey, unknown]> = [
			["authorName", "bryan"],
			["debounceMs", 1000],
			["maxCacheSize", 1],
			["logRetentionDays", 0],
			["ignoreFolders", "A, B"],
			["ignoreFiles", "x.md"],
			["editLogsPath", "Logs"],
			["autoImportFolders", "Emails=importer:email|primary"],
		];

		for (const [key, value] of accepted) {
			expect(validateControlValue(key, value)).toBeNull();
			const s = settings();
			applyControlValue(s, key, value);
			// Read-back, not inequality: some accepted values match the starting
			// value, and "nothing changed" would not distinguish stored from
			// ignored.
			expect(readControlValue(s, key)).toBe(
				typeof value === "string" ? value.replace(/\s*,\s*/g, ", ") : value,
			);
		}
	});

	it("does not validate the mappings textarea", () => {
		// validate also runs on mount, which would probe every stored pattern on
		// the UI thread each time the settings tab opens.
		expect(
			validateControlValue("autoImportFolders", "Emails=x|primary|(a+)+$"),
		).toBeNull();
	});
});

describe("SETTING_COPY", () => {
	it("covers every setting", () => {
		for (const key of ALL_KEYS) {
			expect(SETTING_COPY[key].name).toBeTruthy();
			expect(SETTING_COPY[key].desc).toBeTruthy();
		}
	});

	it("documents the mapping format, which its group heading cannot carry", () => {
		// SettingDefinitionGroup has no desc field, so the format spec display()
		// renders as a loose paragraph has to live on the control itself.
		expect(SETTING_COPY.autoImportFolders.desc).toContain(
			"Folder=Author|ContentOrigin",
		);
	});
});
