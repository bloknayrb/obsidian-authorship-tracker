import { describe, it, expect } from "vitest";
import {
	getAutoImportResult,
	parseMappings,
	serializeMappings,
	invalidPatterns,
	AutoImportMapping,
} from "../mappings";

const mappings: AutoImportMapping[] = [
	{ folder: "Emails", author: "importer:email", contentOrigin: "primary" },
	{
		folder: "Meetings",
		author: "importer:transcript",
		contentOrigin: "primary",
		filenamePattern: "^Transcript-",
	},
	{
		folder: "Meetings",
		author: "importer:notes",
		contentOrigin: "ai-derived",
		filenamePattern: "^Notes-",
	},
];

describe("getAutoImportResult", () => {
	it("matches a plain prefix folder", () => {
		expect(getAutoImportResult(mappings, "Emails/a.md", "a.md")).toEqual({
			author: "importer:email",
			contentOrigin: "primary",
		});
	});

	it("respects filename patterns within a shared folder", () => {
		expect(
			getAutoImportResult(mappings, "Meetings/Transcript-x.md", "Transcript-x.md"),
		).toEqual({ author: "importer:transcript", contentOrigin: "primary" });
		expect(
			getAutoImportResult(mappings, "Meetings/Notes-x.md", "Notes-x.md"),
		).toEqual({ author: "importer:notes", contentOrigin: "ai-derived" });
	});

	it("returns null when no mapping matches", () => {
		expect(getAutoImportResult(mappings, "Other/a.md", "a.md")).toBeNull();
		expect(
			getAutoImportResult(mappings, "Meetings/random.md", "random.md"),
		).toBeNull();
	});

	it("does not throw on an invalid pattern, just skips it", () => {
		const bad: AutoImportMapping[] = [
			{ folder: "X", author: "a", contentOrigin: "primary", filenamePattern: "[" },
		];
		expect(getAutoImportResult(bad, "X/a.md", "a.md")).toBeNull();
	});

	it("tolerates leading/trailing slashes in the folder", () => {
		const slashed: AutoImportMapping[] = [
			{ folder: "/Emails/", author: "a", contentOrigin: "primary" },
		];
		expect(getAutoImportResult(slashed, "Emails/a.md", "a.md")).toEqual({
			author: "a",
			contentOrigin: "primary",
		});
	});
});

describe("parse/serialize round-trip", () => {
	it("round-trips mappings through the textarea format", () => {
		const text = serializeMappings(mappings);
		expect(parseMappings(text)).toEqual(mappings);
	});

	it("skips malformed lines and defaults the content origin", () => {
		const parsed = parseMappings("Emails=importer:email\nnonsense\n=lonely");
		expect(parsed).toEqual([
			{ folder: "Emails", author: "importer:email", contentOrigin: "primary" },
		]);
	});
});

describe("invalidPatterns", () => {
	it("flags only unparseable regexes", () => {
		const list: AutoImportMapping[] = [
			{ folder: "A", author: "a", contentOrigin: "primary", filenamePattern: "^ok$" },
			{ folder: "B", author: "b", contentOrigin: "primary", filenamePattern: "(" },
		];
		expect(invalidPatterns(list)).toEqual(["("]);
	});
});
