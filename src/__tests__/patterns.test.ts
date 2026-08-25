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
	// Deliberately slow: it runs a real probe against every known-catastrophic
	// pattern, which is the point. ~2.4s locally, more on a shared CI runner, so
	// it gets an explicit timeout rather than relying on the 5s default.
	it("rejects every catastrophic pattern", () => {
		for (const p of CATASTROPHIC) {
			const result = checkPattern(p);
			expect(result.ok, `${p} should be rejected`).toBe(false);
			expect(result.problem, p).toBe("too-slow");
		}
	}, 30_000);

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
	}, 30_000);

	it("probes using the pattern's own alphabet", () => {
		// Probing (x+x+)+y with "a"s makes it look instant, because the pattern
		// fails on the first character. The alphabet has to come from the pattern.
		expect(checkPattern("(x+x+)+y").problem).toBe("too-slow");
		expect(checkPattern("(q+)+Z").problem).toBe("too-slow");
		// Same for digit classes, where the escape letter is not a literal.
		expect(checkPattern("^(\\d+)+$").problem).toBe("too-slow");
	}, 30_000);

	it("rejects a wildly over-budget reading without re-measuring", () => {
		// Far beyond the budget is not a hiccup. Taking it at face value is what
		// keeps rejection from costing twice as much as it needs to.
		let t = 0;
		const now = () => (t += 10_000);
		expect(checkPattern("^Transcript-", now)).toEqual({
			ok: false,
			problem: "too-slow",
		});
	});

	it("re-measures a borderline reading and keeps the pattern if it was a blip", () => {
		// A GC pause is tens of milliseconds — just over the budget, not orders of
		// magnitude over. It must not disable a working pattern for the session.
		const readings = [0, 25]; // first probe: 25ms, just over the 20ms budget
		let i = 0;
		const now = () => (i < readings.length ? readings[i++] : 25);
		expect(checkPattern("^Transcript-", now)).toEqual({ ok: true });
	});

	it("rejects a borderline reading that reproduces", () => {
		// Same shape, but every measurement is over budget, so it is real.
		let t = 0;
		const now = () => (t += 25);
		expect(checkPattern("^Transcript-", now)).toEqual({
			ok: false,
			problem: "too-slow",
		});
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
