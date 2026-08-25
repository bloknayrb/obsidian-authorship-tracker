import { describe, it, expect } from "vitest";
import {
	getAutoImportResult,
	parseMappings,
	serializeMappings,
	patternProblems,
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

	it("keeps alternations inside a pattern rather than truncating at the pipe", () => {
		// Only the first two pipes delimit fields. Splitting naively stored
		// "(Notes|Transcript)-.*\\.md$" as "(Notes", which then reported itself as
		// invalid syntax.
		const parsed = parseMappings(
			"Meetings=importer:x|primary|(Notes|Transcript)-.*\\.md$",
		);
		expect(parsed[0].filenamePattern).toBe("(Notes|Transcript)-.*\\.md$");
		// And it survives a round trip through the textarea format.
		expect(parseMappings(serializeMappings(parsed))).toEqual(parsed);
	});

	it("skips malformed lines and defaults the content origin", () => {
		const parsed = parseMappings("Emails=importer:email\nnonsense\n=lonely");
		expect(parsed).toEqual([
			{ folder: "Emails", author: "importer:email", contentOrigin: "primary" },
		]);
	});
});

describe("patternProblems", () => {
	it("reports unparseable regexes with a reason", () => {
		const list: AutoImportMapping[] = [
			{ folder: "A", author: "a", contentOrigin: "primary", filenamePattern: "^ok$" },
			{ folder: "B", author: "b", contentOrigin: "primary", filenamePattern: "(" },
		];
		expect(patternProblems(list)).toEqual([
			{ pattern: "(", problem: "invalid-syntax" },
		]);
	});

	it("reports patterns that would freeze the UI", () => {
		const list: AutoImportMapping[] = [
			{ folder: "A", author: "a", contentOrigin: "primary", filenamePattern: "(a+)+$" },
		];
		expect(patternProblems(list)).toEqual([
			{ pattern: "(a+)+$", problem: "too-slow" },
		]);
	});

	it("says nothing about mappings with no pattern, or with good ones", () => {
		const list: AutoImportMapping[] = [
			{ folder: "A", author: "a", contentOrigin: "primary" },
			{
				folder: "B",
				author: "b",
				contentOrigin: "primary",
				filenamePattern: "^Transcript-",
			},
		];
		expect(patternProblems(list)).toEqual([]);
	});
});
