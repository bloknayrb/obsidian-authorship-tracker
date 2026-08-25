// Daily-log retention, measured in whole *local calendar days* to match how the
// log file names are produced (localDateString in ./time).
//
// The previous implementation compared `Date.now() - days * 86_400_000` against a
// local-midnight parse of the file name. That is a rolling 24-hour window, not a
// calendar one: with retention set to 1, yesterday's log was deleted the moment
// the clock passed midnight rather than surviving the day.
//
// Semantics here: a log is expired when its age in whole local calendar days is
// strictly greater than `retentionDays`. So retention 1 keeps today's log and
// yesterday's, and deletes the day before. Retention 0 disables pruning entirely.
//
// Pure logic — no Obsidian dependency, so it is unit testable in isolation.

// Daily logs are named "YYYY-MM-DD.jsonl". Shape only — the round-trip check in
// parseLogFileName is what rejects nonsense like "0000-00-00" or "2026-02-30",
// so the ranges are not also encoded here.
const LOG_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

interface CalendarDate {
	year: number;
	month: number;
	day: number;
}

// Parse a daily-log file name, or null if it is not one. Names that match the
// shape but are not real dates (2026-02-30) are rejected by round-tripping.
export function parseLogFileName(fileName: string): CalendarDate | null {
	const m = LOG_FILE_RE.exec(fileName);
	if (!m) return null;

	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);

	const probe = new Date(Date.UTC(year, month - 1, day));
	if (
		probe.getUTCFullYear() !== year ||
		probe.getUTCMonth() !== month - 1 ||
		probe.getUTCDate() !== day
	) {
		return null;
	}
	return { year, month, day };
}

// Days since the epoch for a calendar date, via UTC midnight.
//
// Both operands of the subtraction in logAgeInDays go through this, so a 23- or
// 25-hour local day at a DST boundary cannot shift the difference. Using UTC here
// is not a timezone choice — it is just a stable grid to count days on. Which
// calendar day "today" is remains a local-time question, answered by today().
function toDayNumber({ year, month, day }: CalendarDate): number {
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

function today(now: Date): CalendarDate {
	// Local components directly: localDateString would zero-pad these same three
	// values only for us to split and Number() them back.
	return {
		year: now.getFullYear(),
		month: now.getMonth() + 1,
		day: now.getDate(),
	};
}

// Whole local calendar days between a log's date and `now`. Positive means past;
// null if the name is not a daily log.
export function logAgeInDays(fileName: string, now: Date): number | null {
	const parsed = parseLogFileName(fileName);
	if (parsed === null) return null;
	return toDayNumber(today(now)) - toDayNumber(parsed);
}

// True when a daily log falls outside the retention window.
//
// Guards `retentionDays <= 0` itself rather than relying on the caller: a pure
// module whose contract is "0 deletes everything" sitting behind a caller that
// means "0 keeps everything" is a vault-deletion footgun for the next refactor.
// Anything unparseable is kept — never delete what we do not understand.
export function isLogExpired(
	fileName: string,
	now: Date,
	retentionDays: number,
): boolean {
	if (!Number.isFinite(retentionDays) || retentionDays <= 0) return false;
	const age = logAgeInDays(fileName, now);
	if (age === null) return false;
	return age > retentionDays;
}
