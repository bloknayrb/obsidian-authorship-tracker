// Local-time formatting for log timestamps and daily filenames. Using local
// wall-clock (rather than UTC) keeps evening edits in the correct day's log
// file for users west of UTC and matches the timestamps shown in the README.
// Pure logic — no Obsidian dependency, so it is unit testable in isolation.

function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

// "YYYY-MM-DD" in local time.
export function localDateString(date: Date): string {
	return (
		date.getFullYear() +
		"-" +
		pad2(date.getMonth() + 1) +
		"-" +
		pad2(date.getDate())
	);
}

// "YYYY-MM-DDTHH:mm:ss" in local time (no timezone suffix, no milliseconds).
export function formatLocalTimestamp(date: Date): string {
	return (
		localDateString(date) +
		"T" +
		pad2(date.getHours()) +
		":" +
		pad2(date.getMinutes()) +
		":" +
		pad2(date.getSeconds())
	);
}
