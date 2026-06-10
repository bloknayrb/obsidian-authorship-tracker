import { describe, it, expect } from "vitest";
import { localDateString, formatLocalTimestamp } from "../time";

describe("local time formatting", () => {
	// Construct via local-time components so the expectations are timezone
	// independent (Date(year, monthIndex, day, ...) interprets as local time).
	const date = new Date(2026, 2, 9, 7, 4, 5); // 2026-03-09 07:04:05 local

	it("formats a zero-padded local date", () => {
		expect(localDateString(date)).toBe("2026-03-09");
	});

	it("formats a zero-padded local timestamp without timezone suffix", () => {
		expect(formatLocalTimestamp(date)).toBe("2026-03-09T07:04:05");
	});

	it("pads single-digit hours, minutes, seconds", () => {
		const d = new Date(2026, 0, 1, 0, 0, 0);
		expect(formatLocalTimestamp(d)).toBe("2026-01-01T00:00:00");
	});
});
