import { describe, it, expect, beforeEach } from "vitest";
import {
	MAX_PATTERN_LENGTH,
	__resetPatternState,
	checkPattern,
	describeProblem,
	isPoisoned,
	matchesPattern,
} from "../patterns";

// Patterns that hang a backtracking engine on ordinary-length input. Each was
// measured taking seconds to minutes on a ~30-character filename.
const CATASTROPHIC = [
	"(a+)+$",
	// Anchored forms. These are the important ones: a probe built from
	// homogeneous strings never satisfies the anchor, so the pattern fails
	// instantly on the probe and validates clean while still hanging on a real
	// filename. `^Email-(a+)+$` measured 1530ms on a 35-character name.
	"^Email-(a+)+$",
	"^Transcript-(x+x+)+y",
	"^\\d{4}-(a+)+$",
	"^Notes/(a|a)*$",
	"^[A-Z]{2}-(a+)+$",
	"(a|a)*$",
	"([a-z]|[a-c])*$",
	"(x+x+)+y",
	"(a*)*b",
	"(q+)+Z",
	"^(\\d+)+$",
	"([0-9]+)*#",
];

// Realistic filename patterns, including the two the README documents.
const BENIGN = [
	"^Transcript-",
	"^Meeting-\\d{4}-\\d{2}\\.md$",
	"^[A-Z]{2}-\\d+\\.md$",
	"^archive/\\d{4}/.*\\.md$",
	"^Notes-",
	"\\.pdf$",
	"^(?:[A-Za-z0-9_-]+\\s)+meeting\\.md$",
	"^(\\w+-)+\\d+\\.md$",
	"^\\d{4}-\\d{2}-\\d{2}",
	"(Notes|Transcript)-.*\\.md$",
	"[A-Za-z_]+",
	"^Meeting \\d+",
	"email-.*",
	"^(inbox|archive)/",
	"^\\d{4}-\\d{2}-\\d{2}-.*\\.md$",
	"^(Draft|Final)_[A-Za-z0-9]+\\.md$",
];

beforeEach(() => {
	__resetPatternState();
});

describe("checkPattern", () => {
	it("rejects every catastrophic pattern", () => {
		for (const p of CATASTROPHIC) {
			const result = checkPattern(p);
			expect(result.ok, `${p} should be rejected`).toBe(false);
			expect(result.problem, p).toBe("too-slow");
		}
	});

	it("accepts every realistic pattern", () => {
		// The false-positive case matters more than the false-negative one: a
		// wrongly-rejected pattern silently stops attributing a user's imports.
		for (const p of BENIGN) {
			expect(checkPattern(p).ok, `${p} should be accepted`).toBe(true);
		}
	});

	it("accepts the patterns the README documents", () => {
		expect(checkPattern("^Transcript-").ok).toBe(true);
		expect(checkPattern("^Notes-").ok).toBe(true);
	});

	it("rejects unparseable regexes", () => {
		for (const p of ["(", "[", "a{2,1}", "(?<"]) {
			expect(checkPattern(p), p).toEqual({
				ok: false,
				problem: "invalid-syntax",
			});
		}
	});

	it("rejects over-length patterns before compiling them", () => {
		const long = "a".repeat(MAX_PATTERN_LENGTH + 1);
		expect(checkPattern(long)).toEqual({ ok: false, problem: "too-long" });
		// The boundary itself is allowed.
		expect(checkPattern("a".repeat(MAX_PATTERN_LENGTH)).ok).toBe(true);
	});

	it("is not fooled by escaped metacharacters", () => {
		// Literal parens and a literal plus — no grouping, no quantifier.
		expect(checkPattern("\\(a\\+\\)").ok).toBe(true);
		expect(checkPattern("[(+]").ok).toBe(true);
	});

	it("satisfies an anchored head so the rest of the pattern is reachable", () => {
		// Literal prefix, class prefix, and a bounded repeat of a class.
		expect(checkPattern("^Email-(a+)+$").problem).toBe("too-slow");
		expect(checkPattern("^\\d{4}-(a+)+$").problem).toBe("too-slow");
		expect(checkPattern("^[A-Z]{2}-(a+)+$").problem).toBe("too-slow");
		// And the alphabet comes from AFTER the prefix, so a long literal head
		// cannot crowd out the character driving the blowup.
		expect(checkPattern("^Transcript-(x+x+)+y").problem).toBe("too-slow");
	});

	it("probes using the pattern's own alphabet", () => {
		// Probing (x+x+)+y with "a"s makes it look instant, because the pattern
		// fails on the first character. The alphabet has to come from the pattern.
		expect(checkPattern("(x+x+)+y").problem).toBe("too-slow");
		expect(checkPattern("(q+)+Z").problem).toBe("too-slow");
		// Same for digit classes, where the escape letter is not a literal.
		expect(checkPattern("^(\\d+)+$").problem).toBe("too-slow");
	});

	it("rejects when a slow measurement is confirmed", () => {
		// A clock that always reports the budget as blown: both the first
		// measurement and the confirming one.
		let t = 0;
		const now = () => (t += 10_000);
		expect(checkPattern("^Transcript-", now)).toEqual({
			ok: false,
			problem: "too-slow",
		});
	});

	it("does not reject on a single spike that does not reproduce", () => {
		// A GC pause during one probe must not disable a working pattern for the
		// session. Only the first reading pair is slow here; the confirming
		// measurement comes back fast, so the pattern stands.
		let reading = 0;
		const now = () => {
			reading++;
			// Readings 1 and 2 straddle a 10s "pause"; everything after is instant.
			if (reading === 1) return 0;
			if (reading === 2) return 10_000;
			return 10_000;
		};
		expect(checkPattern("^Transcript-", now)).toEqual({ ok: true });
	});
});

describe("matchesPattern", () => {
	it("matches and rejects like a plain regex for good patterns", () => {
		expect(matchesPattern("^Transcript-", "Transcript-a.md")).toBe(true);
		expect(matchesPattern("^Transcript-", "Notes-a.md")).toBe(false);
		expect(matchesPattern("\\.pdf$", "paper.pdf")).toBe(true);
	});

	it("treats an unusable pattern as a non-match instead of throwing", () => {
		// A bad setting must never break vault event handling.
		expect(() => matchesPattern("(", "a.md")).not.toThrow();
		expect(matchesPattern("(", "a.md")).toBe(false);
		expect(matchesPattern("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBe(
			false,
		);
	});

	it("matches the whole name rather than a truncated prefix", () => {
		// Truncating would silently change what `$` means. A long name is fine:
		// this pattern is linear, so length costs nothing.
		const long = "a".repeat(10_000) + "b";
		expect(matchesPattern("^a+b$", long)).toBe(true);
	});

	it("poisons a pattern that blows the budget at match time", () => {
		// Backstop for anything validation missed: a pattern that is slow only on
		// one particular name. Warm the cache with a real clock first, so the
		// injected clock below is used by the match and not by validation.
		expect(matchesPattern("^Transcript-", "Transcript-a.md")).toBe(true);
		expect(isPoisoned("^Transcript-")).toBe(false);

		let reading = 0;
		const now = () => (reading++ === 0 ? 0 : 10_000);
		matchesPattern("^Transcript-", "Transcript-a.md", now);
		expect(isPoisoned("^Transcript-")).toBe(true);

		// Once poisoned it stays a non-match, without being re-run.
		expect(matchesPattern("^Transcript-", "Transcript-a.md")).toBe(false);
	});

	it("reuses a compiled pattern across calls", () => {
		// Correctness is what is observable here: repeated calls agree, and the
		// cache does not corrupt results for different names.
		for (let i = 0; i < 5; i++) {
			expect(matchesPattern("^Notes-", "Notes-x.md")).toBe(true);
			expect(matchesPattern("^Notes-", "Other-x.md")).toBe(false);
		}
	});
});

describe("describeProblem", () => {
	it("gives a distinct, human-readable reason for each problem", () => {
		const messages = (["too-long", "invalid-syntax", "too-slow"] as const).map(
			describeProblem,
		);
		expect(new Set(messages).size).toBe(3);
		for (const m of messages) expect(m.length).toBeGreaterThan(10);
		expect(describeProblem("too-slow")).toMatch(/freeze/i);
	});
});
