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

// Verdicts, bounded so settings churn cannot grow the cache without limit.
// Caching the whole verdict rather than just the compiled regex matters: probing
// a bad pattern costs hundreds of milliseconds, and it is asked about from three
// places — load-time validation, the settings commit, and the first match.
interface Verdict {
	re: RegExp | null;
	problem?: PatternProblem;
}
const verdicts = new LRUCache<string, Verdict>(64);

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
//
// The fixed base is always included so that a pattern whose blowup is driven by
// a character class rather than a literal — `([^x]+)+y`, `^(\d+)+$` — is still
// exercised.
function probeAlphabet(pattern: string): string[] {
	// Strip escape sequences first, so the letter in `\d` is not read as a
	// literal "d".
	const chars = new Set(
		pattern.replace(/\\[dwsSWDbBnrtfv]/g, "").match(/[A-Za-z0-9]/g) ?? [],
	);
	for (const c of ["a", "0", "A"]) chars.add(c);
	// A handful is plenty; more only multiplies the check's own cost.
	return [...chars].slice(0, 4);
}

// Build a string satisfying whatever the pattern anchors at the start of the
// name, and report where in the pattern that head ends.
//
// Without this, an anchored pattern is never actually exercised. Probing
// `^Email-(a+)+$` with "aaaa..." fails on the first character and returns
// instantly, so the pattern validates clean and then takes 1.5 seconds on
// "Email-aaaa...". The same applies to a class head: `^\d{4}-(a+)+$` needs four
// digits before the vulnerable part is reachable at all. Anchored prefixes are
// the style the README recommends, so this is the common case.
//
// This is a deliberately small generator covering the head only — literals,
// escaped punctuation, single classes and their bounded repeats. It stops at the
// first construct it does not model, which is the safe direction: a shorter
// prefix means a weaker probe, never a wrong verdict.
function anchoredPrefix(pattern: string): { text: string; end: number } {
	if (!pattern.startsWith("^")) return { text: "", end: 0 };

	let text = "";
	let i = 1;

	const readRepeat = (): number => {
		// A quantifier after an element: emit enough copies to satisfy its minimum.
		const rest = pattern.slice(i);
		const brace = /^\{(\d+)(?:,\d*)?\}/.exec(rest);
		if (brace) {
			i += brace[0].length;
			return Math.min(Number(brace[1]), 8);
		}
		if (rest[0] === "+") {
			i += 1;
			return 1;
		}
		if (rest[0] === "*" || rest[0] === "?") {
			i += 1;
			return 0;
		}
		return 1;
	};

	while (i < pattern.length) {
		const c = pattern[i];
		let unit: string | null = null;

		if (c === "\\") {
			const next = pattern[i + 1];
			if (!next) break;
			i += 2;
			if (next === "d") unit = "0";
			else if (next === "w") unit = "a";
			else if (next === "s") unit = " ";
			else if (/[^A-Za-z0-9]/.test(next)) unit = next;
			else break;
		} else if (c === "[") {
			const close = pattern.indexOf("]", i + 1);
			if (close === -1) break;
			const body = pattern.slice(i + 1, close);
			// Negated classes are not modelled; stop rather than guess wrong.
			if (body.startsWith("^")) break;
			const sample = /0-9|\\d/.test(body)
				? "0"
				: /a-z/.test(body)
					? "a"
					: /A-Z/.test(body)
						? "A"
						: (body.match(/[A-Za-z0-9._-]/) ?? ["a"])[0];
			i = close + 1;
			unit = sample;
		} else if (c === "." ) {
			i += 1;
			unit = "a";
		} else if ("([{*+?|$".includes(c)) {
			break;
		} else {
			i += 1;
			unit = c;
		}

		if (unit === null) break;
		text += unit.repeat(readRepeat());
		if (text.length > 64) break;
	}

	return { text, end: i };
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
	const cached = verdicts.get(pattern);
	if (cached !== undefined) {
		return cached.problem === undefined
			? { ok: true }
			: { ok: false, problem: cached.problem };
	}
	const verdict = probePattern(pattern, now);
	verdicts.set(pattern, verdict);
	return verdict.problem === undefined
		? { ok: true }
		: { ok: false, problem: verdict.problem };
}

function probePattern(pattern: string, now: () => number): Verdict {
	if (pattern.length > MAX_PATTERN_LENGTH) {
		return { re: null, problem: "too-long" };
	}

	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch {
		return { re: null, problem: "invalid-syntax" };
	}

	const prefix = anchoredPrefix(pattern);
	// Take the alphabet from the part AFTER the anchored prefix. Otherwise a long
	// prefix crowds out the character that actually drives the blowup: probing
	// `^Transcript-(x+x+)+y` with T, r, a, n misses "x" entirely.
	const alphabet = probeAlphabet(pattern.slice(prefix.end));
	for (const length of PROBE_LENGTHS) {
		for (const ch of alphabet) {
			// Satisfy any anchored literal prefix, then repeat a character to drive
			// the backtracking. The trailing space is one the pattern is unlikely to
			// accept, forcing the engine to exhaust its alternatives rather than
			// matching early and returning fast.
			const subject = prefix.text + ch.repeat(length) + " ";
			const started = now();
			try {
				re.test(subject);
			} catch {
				// A pattern that throws mid-match is unusable.
				return { re: null, problem: "invalid-syntax" };
			}
			if (now() - started > PROBE_BUDGET_MS) {
				// One sample can be inflated by a GC pause, and a false "too-slow"
				// silently disables a working mapping for the session. Re-measure
				// before concluding. A genuinely exponential pattern is just as slow
				// the second time; a hiccup is not.
				const confirm = now();
				try {
					re.test(subject);
				} catch {
					return { re: null, problem: "invalid-syntax" };
				}
				if (now() - confirm > PROBE_BUDGET_MS) {
					return { re: null, problem: "too-slow" };
				}
			}
		}
	}
	return { re };
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

	let verdict = verdicts.get(pattern);
	if (verdict === undefined) {
		verdict = probePattern(pattern, now);
		verdicts.set(pattern, verdict);
	}
	if (verdict.re === null) return false;
	const re = verdict.re;

	// The name is NOT truncated. An earlier revision capped it at 255 characters,
	// but by this module's own reasoning that buys no safety — the blowup fits in
	// an ordinary filename — while truncation silently changes what `$` matches.
	const started = now();
	let result: boolean;
	try {
		result = re.test(name);
	} catch {
		poison(pattern);
		return false;
	}
	if (now() - started > PROBE_BUDGET_MS) {
		poison(pattern);
		return false;
	}
	return result;
}

// True when a pattern has been disabled at match time after passing validation.
export function isPoisoned(pattern: string): boolean {
	return poisoned.has(pattern);
}

// Notified once per pattern when one is disabled at match time. Poisoning stops
// a mapping attributing anything for the rest of the session, which must not
// happen silently — that is the failure mode load-time validation exists to
// prevent, arriving by a different route.
let onPoisoned: ((pattern: string) => void) | undefined;

export function setPoisonListener(fn: (pattern: string) => void): void {
	onPoisoned = fn;
}

function poison(pattern: string): void {
	if (poisoned.has(pattern)) return;
	poisoned.add(pattern);
	onPoisoned?.(pattern);
}

// Test hook: module-level caches would otherwise leak between test cases.
export function __resetPatternState(): void {
	verdicts.clear();
	poisoned.clear();
	onPoisoned = undefined;
}
