import { describe, it, expect } from "vitest";
import { parseIntoSections, generateDiffSummary } from "../diff";

describe("parseIntoSections", () => {
	it("groups lines under their ## heading", () => {
		const sections = parseIntoSections("intro\n## A\nline a\n## B\nline b");
		expect(Object.keys(sections)).toEqual(["", "A", "B"]);
		expect(sections["A"]).toEqual(["line a"]);
		expect(sections["B"]).toEqual(["line b"]);
	});
});

describe("generateDiffSummary", () => {
	it("reports line delta for heading-less documents", () => {
		expect(generateDiffSummary("a\nb", "a\nb\nc")).toBe(
			"Modified content (+1 lines)",
		);
		expect(generateDiffSummary("a\nb\nc", "a")).toBe(
			"Modified content (-2 lines)",
		);
	});

	it("reports an added section", () => {
		const before = "## A\ntext";
		const after = "## A\ntext\n## B\nmore";
		expect(generateDiffSummary(before, after)).toBe("added ## B");
	});

	it("reports a removed section", () => {
		const before = "## A\ntext\n## B\nmore";
		const after = "## A\ntext";
		expect(generateDiffSummary(before, after)).toBe("removed ## B");
	});

	it("reports modified sections with a line delta", () => {
		const before = "## A\none";
		const after = "## A\none\ntwo\nthree";
		expect(generateDiffSummary(before, after)).toBe("Modified ## A (+2 lines)");
	});

	it("falls back when headings exist but nothing structural changed", () => {
		const doc = "## A\nsame";
		expect(generateDiffSummary(doc, doc)).toBe(
			"Minor edits (no structural changes)",
		);
	});
});
