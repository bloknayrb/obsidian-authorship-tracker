// Safety checks for the user-supplied filename regexes in auto-import mappings.
//
// The risk is not an attacker — the pattern is typed by the vault owner into
// their own settings and matched against their own filenames. The failure being
// prevented is "I typed a plausible-looking regex and Obsidian froze", because
// the match runs synchronously on the UI thread inside a vault event handler.
//
// The freeze is real and it is not bounded by filename length. Measured here:
// `(a+)+$` against a 30-character name takes about 12 seconds, and against a
// 31-character one about 80. Every catastrophic case fits comfortably inside an
// ordinary filename, so capping the input length rules out nothing.
//
// What does NOT work, and why the obvious approaches are rejected:
//
//   * A pre-match step or time bound. V8 exposes no RegExp timeout and the match
//     is synchronous and uninterruptible. Moving it to a worker is out too:
//     manifest.json sets isDesktopOnly false and esbuild externalises all node
//     builtins, so worker_threads would break the mobile build.
//   * A static "nested quantifier" screen. It is unsound in both directions.
//     `(a|a)*$` has no quantifier inside its quantified group and still takes
//     7+ seconds, while realistic patterns like `^(\w+-)+\d+\.md$` would be
//     rejected despite running in under a tenth of a millisecond.
//
// What is done instead: run the pattern against short adversarial inputs and
// time it. Blowup is exponential in the input length, so a pattern that is going
// to hang on a real filename is already measurably slow on a 24-character probe,
// while a linear one stays microscopic. Escalating lengths with an early bail
// keep the check's own cost bounded (worst observed: ~400ms) rather than
// exponential.
//
// This is empirical, not a proof. It has no false positives on realistic
// patterns and caught every catastrophic pattern tested, but it cannot promise
// to catch every possible one — see matchesPattern for the runtime backstop.
//
// Pure logic — no Obsidian dependency, so it is unit testable in isolation.
import { LRUCache } from "./lru";

// Long enough for any realistic filename pattern; short enough that a pasted
// nightmare is rejected before it is ever compiled.
export const MAX_PATTERN_LENGTH = 200;

// Probe input lengths, ascending. Short enough that even an exponential pattern
// costs milliseconds at the first step, long enough that one is unmistakable by
// the last.
const PROBE_LENGTHS = [12, 18, 24];

// Per-probe budget. Linear patterns finish in microseconds, so this is orders of
// magnitude above the noise floor.
const PROBE_BUDGET_MS = 20;

// Filenames are bounded in practice; this only guards against a pathological
// caller. It is not protection in itself — see the note above.
const MAX_NAME_LENGTH = 255;

// Compiled patterns, bounded so settings churn cannot grow it without limit.
// `null` records a pattern that must never be used.
const compiled = new LRUCache<string, RegExp | null>(64);

// Patterns that blew the budget at match time despite passing validation. Once
// poisoned, a pattern is treated as a non-match for the rest of the session.
const poisoned = new Set<string>();

// Monotonic where available, falling back to wall clock. Obsidian runs in
// Electron, so performance is always present in practice; the fallback is for
// bare-node contexts such as tests.
const monotonicNow: () => number =
	typeof performance !== "undefined" && typeof performance.now === "function"
		? () => performance.now()
		: () => Date.now();

export type PatternProblem = "too-long" | "invalid-syntax" | "too-slow";

export interface PatternCheck {
	ok: boolean;
	problem?: PatternProblem;
}

// Human-readable explanation, for the settings error.
export function describeProblem(problem: PatternProblem): string {
	switch (problem) {
		case "too-long":
			return `longer than ${MAX_PATTERN_LENGTH} characters`;
		case "invalid-syntax":
			return "not a valid regular expression";
		case "too-slow":
			return "too slow to match safely — it can freeze Obsidian on ordinary filenames; simplify nested groups and repetition";
	}
}

// Characters to build probe inputs from. A pattern over "x" must be probed with
// "x"s: probing `(x+x+)+y` with "a"s makes it look instant.
function probeAlphabet(pattern: string): string[] {
	const chars = new Set<string>();
	// Drop escape sequences first so the letter in `\d` is not read as a literal.
	const literals = pattern.replace(/\\[dwsSWDbBnrtfv]/g, "");
	for (const c of literals.match(/[A-Za-z0-9]/g) ?? []) chars.add(c);
	// Class shorthands imply alphabets of their own.
	if (/\\d/.test(pattern) || /\[[^\]]*0-9/.test(pattern)) chars.add("0");
	if (/\\w|\\S|\./.test(pattern) || /a-z/.test(pattern)) chars.add("a");
	if (/A-Z/.test(pattern)) chars.add("A");
	if (chars.size === 0) chars.add("a");
	// A handful is plenty; more only multiplies the check's cost.
	return [...chars].slice(0, 4);
}

// Validate a pattern for use as a filename matcher.
//
// `now` is injectable purely so tests can drive the timing deterministically;
// production passes nothing.
//
// performance.now() rather than Date.now(): this measures a duration, so it must
// be monotonic. Date.now() can jump backwards on a clock adjustment, and test
// suites routinely freeze it.
export function checkPattern(
	pattern: string,
	now: () => number = monotonicNow,
): PatternCheck {
	if (pattern.length > MAX_PATTERN_LENGTH) {
		return { ok: false, problem: "too-long" };
	}

	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch {
		return { ok: false, problem: "invalid-syntax" };
	}

	const alphabet = probeAlphabet(pattern);
	for (const length of PROBE_LENGTHS) {
		for (const ch of alphabet) {
			// A trailing space that the pattern is unlikely to accept forces the
			// backtracking engine to exhaust its alternatives rather than matching
			// early and returning fast.
			const subject = ch.repeat(length) + " ";
			const started = now();
			try {
				re.test(subject);
			} catch {
				// A pattern that throws mid-match is unusable.
				return { ok: false, problem: "invalid-syntax" };
			}
			if (now() - started > PROBE_BUDGET_MS) {
				return { ok: false, problem: "too-slow" };
			}
		}
	}
	return { ok: true };
}

// Match a filename, refusing to use any pattern that fails validation.
//
// A rejected pattern is a non-match rather than an error: a bad setting must
// never break vault event handling. The caller is responsible for telling the
// user, which main.ts does at settings-save time and again at load.
//
// The timing check here is a backstop for anything checkPattern missed. It
// cannot prevent the first slow match — by the time the duration is known, the
// cost has been paid — but it stops that cost recurring on every subsequent
// vault event, which is what would otherwise make the vault unusable.
export function matchesPattern(
	pattern: string,
	name: string,
	now: () => number = monotonicNow,
): boolean {
	if (poisoned.has(pattern)) return false;

	let re = compiled.get(pattern);
	if (re === undefined) {
		re = checkPattern(pattern, now).ok ? new RegExp(pattern) : null;
		compiled.set(pattern, re);
	}
	if (re === null) return false;

	const subject =
		name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;

	const started = now();
	let result: boolean;
	try {
		result = re.test(subject);
	} catch {
		poisoned.add(pattern);
		return false;
	}
	if (now() - started > PROBE_BUDGET_MS) {
		poisoned.add(pattern);
		return false;
	}
	return result;
}

// True when a pattern has been disabled at match time after passing validation.
export function isPoisoned(pattern: string): boolean {
	return poisoned.has(pattern);
}

// Test hook: module-level caches would otherwise leak between test cases.
export function __resetPatternState(): void {
	compiled.clear();
	poisoned.clear();
}
