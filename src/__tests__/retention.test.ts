import { describe, it, expect } from "vitest";
import { isLogExpired, logAgeInDays, parseLogFileName } from "../retention";

// All dates are built with `new Date(y, m, d, ...)` so the suite is
// timezone-independent, matching the convention in time.test.ts.
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

describe("parseLogFileName", () => {
	it("accepts a well-formed daily log name", () => {
		expect(parseLogFileName("2026-08-25.jsonl")).toEqual({
			year: 2026,
			month: 8,
			day: 25,
		});
	});

	it("rejects names that are not daily logs", () => {
		for (const name of [
			"notes.md",
			"README.md",
			"20260825.jsonl",
			"2026-08-25.jsonl.bak",
			"2026-08-25.json",
			"x2026-08-25.jsonl",
		]) {
			expect(parseLogFileName(name), name).toBeNull();
		}
	});

	it("rejects impossible dates rather than treating them as very old", () => {
		// These matter: under a naive lexicographic compare, "0000-00-00.jsonl"
		// sorts before any cutoff and would be silently deleted.
		for (const name of [
			"0000-00-00.jsonl",
			"2026-13-01.jsonl",
			"2026-00-10.jsonl",
			"2026-02-30.jsonl",
			"2026-04-31.jsonl",
			"2026-08-32.jsonl",
		]) {
			expect(parseLogFileName(name), name).toBeNull();
		}
	});

	it("accepts a real leap day and rejects a fake one", () => {
		expect(parseLogFileName("2024-02-29.jsonl")).not.toBeNull();
		expect(parseLogFileName("2026-02-29.jsonl")).toBeNull();
	});
});

describe("logAgeInDays", () => {
	it("counts whole calendar days", () => {
		const now = noon(2026, 8, 25);
		expect(logAgeInDays("2026-08-25.jsonl", now)).toBe(0);
		expect(logAgeInDays("2026-08-24.jsonl", now)).toBe(1);
		expect(logAgeInDays("2026-08-18.jsonl", now)).toBe(7);
	});

	it("is unaffected by the time of day", () => {
		// One second past midnight is still the same calendar day. This is the
		// crux of #4: a rolling-millisecond window would call yesterday's log a
		// full day old the instant the clock ticked over.
		const justAfterMidnight = new Date(2026, 7, 25, 0, 0, 1);
		const justBeforeMidnight = new Date(2026, 7, 25, 23, 59, 59);
		expect(logAgeInDays("2026-08-24.jsonl", justAfterMidnight)).toBe(1);
		expect(logAgeInDays("2026-08-24.jsonl", justBeforeMidnight)).toBe(1);
	});

	it("spans month and year boundaries", () => {
		expect(logAgeInDays("2026-02-26.jsonl", noon(2026, 3, 1))).toBe(3);
		expect(logAgeInDays("2024-02-29.jsonl", noon(2024, 3, 1))).toBe(1);
		expect(logAgeInDays("2025-12-30.jsonl", noon(2026, 1, 2))).toBe(3);
	});

	it("spans a DST transition without drifting", () => {
		// US spring-forward 2026-03-08 gives a 23-hour local day; autumn
		// fall-back 2026-11-01 gives a 25-hour one. Counting on a UTC day grid
		// means neither shifts the answer, in any timezone.
		expect(logAgeInDays("2026-03-07.jsonl", noon(2026, 3, 9))).toBe(2);
		expect(logAgeInDays("2026-10-31.jsonl", noon(2026, 11, 2))).toBe(2);
	});

	it("returns null for names that are not daily logs", () => {
		expect(logAgeInDays("notes.md", noon(2026, 8, 25))).toBeNull();
	});
});

describe("isLogExpired", () => {
	const now = noon(2026, 8, 25);

	it("keeps yesterday's log at retention 1 — the #4 regression", () => {
		// Reproduces the reported failure directly: one second past midnight,
		// with retention set to 1, yesterday's log must survive.
		const justAfterMidnight = new Date(2026, 7, 25, 0, 0, 1);
		expect(isLogExpired("2026-08-25.jsonl", justAfterMidnight, 1)).toBe(false);
		expect(isLogExpired("2026-08-24.jsonl", justAfterMidnight, 1)).toBe(false);
		expect(isLogExpired("2026-08-23.jsonl", justAfterMidnight, 1)).toBe(true);
	});

	it("expires strictly beyond the window", () => {
		expect(isLogExpired("2026-08-18.jsonl", now, 7)).toBe(false); // age 7
		expect(isLogExpired("2026-08-17.jsonl", now, 7)).toBe(true); // age 8
	});

	it("keeps everything when retention is disabled or nonsensical", () => {
		for (const days of [0, -1, -100, NaN, Infinity]) {
			expect(isLogExpired("2020-01-01.jsonl", now, days), String(days)).toBe(
				false,
			);
		}
	});

	it("never expires a file that is not a daily log", () => {
		for (const name of ["notes.md", "0000-00-00.jsonl", "2026-02-30.jsonl"]) {
			expect(isLogExpired(name, now, 1), name).toBe(false);
		}
	});

	it("never expires a future-dated log", () => {
		expect(isLogExpired("2026-08-26.jsonl", now, 1)).toBe(false);
	});

	it("holds the boundary across month and year underflow", () => {
		// What retentionCutoffDate used to assert, expressed through the function
		// that production code actually calls.
		expect(isLogExpired("2026-02-26.jsonl", noon(2026, 3, 1), 3)).toBe(false);
		expect(isLogExpired("2026-02-25.jsonl", noon(2026, 3, 1), 3)).toBe(true);
		expect(isLogExpired("2025-12-26.jsonl", noon(2026, 1, 2), 7)).toBe(false);
		expect(isLogExpired("2025-12-25.jsonl", noon(2026, 1, 2), 7)).toBe(true);
		expect(isLogExpired("2024-02-28.jsonl", noon(2024, 3, 1), 2)).toBe(false);
		expect(isLogExpired("2024-02-27.jsonl", noon(2024, 3, 1), 2)).toBe(true);
	});
});
