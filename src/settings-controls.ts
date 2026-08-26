// The bridge between stored settings and the declarative settings controls
// added in Obsidian 1.13.
//
// Three settings are stored as arrays but edited as text — `ignoreFolders`,
// `ignoreFiles`, and `autoImportFolders` — so the value a control shows is not
// the value the plugin persists. Obsidian resolves that through
// `getControlValue`/`setControlValue`, which are typed `(key: string) => unknown`:
// no compile-time link between the key strings in the definitions and the
// branches that handle them.
//
// That untyped seam is the whole reason this module exists. Both functions
// switch over a `SettingKey` union with a `never` default, so adding a setting
// without handling it here fails to compile rather than silently falling
// through to Obsidian's default write path — which would store a raw textarea
// string in an array-typed field, and `loadSettings` would then reject the
// malformed value and quietly reset it to defaults on the next launch.
//
// Pure logic — no Obsidian dependency, so it is unit testable in isolation.

import {
	AutoImportMapping,
	parseMappings,
	serializeMappings,
} from "./mappings";

export interface AuthorshipTrackerSettings {
	authorName: string;
	debounceMs: number;
	maxCacheSize: number;
	ignoreFolders: string[];
	ignoreFiles: string[];
	editLogsPath: string;
	logRetentionDays: number;
	autoImportFolders: AutoImportMapping[];
}

export type SettingKey = keyof AuthorshipTrackerSettings;

// Lower bounds for the numeric settings.
//
// These are enforced on write, not merely declared. A `number` control "falls
// back to `defaultValue` (or `0`) if the input cannot be parsed", so an emptied
// field arrives here as 0 — and `debounceMs: 0` would stamp frontmatter and
// append a log line on essentially every keystroke. `min` on the control is an
// input attribute, not a guarantee; this is the guarantee.
export const NUMERIC_BOUNDS: Record<
	"debounceMs" | "maxCacheSize" | "logRetentionDays",
	number
> = {
	debounceMs: 1000,
	maxCacheSize: 1,
	logRetentionDays: 0,
};

// Display copy shared by both settings paths — the declarative definitions and
// the deprecated imperative `display()`. Kept in one place so the two renderings
// cannot drift apart.
//
// `ignoreFolders.placeholder` is a function because it interpolates
// `vault.configDir`, which is user-configurable and unknown at module scope.
export const SETTING_COPY = {
	authorName: {
		name: "Author name",
		desc: "Name to stamp in the last_modified_by and created_by fields.",
		placeholder: "me",
	},
	debounceMs: {
		name: "Debounce delay",
		desc: "Milliseconds to wait after the last keystroke before stamping (minimum 1000).",
		placeholder: "10000",
	},
	maxCacheSize: {
		name: "Cache size",
		desc: "Maximum number of file snapshots to keep in memory for diff computation.",
		placeholder: "50",
	},
	ignoreFolders: {
		name: "Ignored folders",
		desc: "Comma-separated folder names to exclude from tracking, matched at any depth.",
		placeholder: (configDir: string) =>
			`Templates, Excalidraw, ${configDir}`,
	},
	ignoreFiles: {
		name: "Ignored files",
		desc: "Comma-separated file names to exclude from tracking.",
		placeholder: "secret.md, scratch.md",
	},
	editLogsPath: {
		name: "Edit logs path",
		desc: "Vault-relative folder where daily JSONL logs are written.",
		placeholder: "Authorship Logs",
	},
	logRetentionDays: {
		name: "Log retention",
		desc: "Delete daily logs older than this many days, counted in whole calendar days. Today's log is always kept, and 1 also keeps yesterday's. Set to 0 to keep all logs.",
		placeholder: "0",
	},
	autoImportFolders: {
		name: "Folder-to-author mappings",
		// The group heading this sits under cannot carry prose of its own:
		// SettingDefinitionGroup has no `desc` field. The format spec that
		// display() renders as a loose <p> therefore lives here, so 1.13 users
		// still get it.
		desc: "One mapping per line: Folder=Author|ContentOrigin[|FilenamePattern]. Example: Emails=importer:email|primary. The optional third field is a regex matched against the file name.",
		heading: "Auto-import folders",
		placeholder:
			"Emails=importer:email|primary\nMeetings=importer:transcript|primary|^Transcript-",
	},
} as const;

// Split a comma-separated control value into trimmed, non-empty entries.
function splitList(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// The value a control should display for `key`. Obsidian calls the setting
// tab's `getControlValue` on every render of a control-type definition, so this
// must stay cheap and side-effect free.
export function readControlValue(
	settings: AuthorshipTrackerSettings,
	key: SettingKey,
): string | number {
	switch (key) {
		case "authorName":
			return settings.authorName;
		case "editLogsPath":
			return settings.editLogsPath;
		case "debounceMs":
			return settings.debounceMs;
		case "maxCacheSize":
			return settings.maxCacheSize;
		case "logRetentionDays":
			return settings.logRetentionDays;
		case "ignoreFolders":
			return settings.ignoreFolders.join(", ");
		case "ignoreFiles":
			return settings.ignoreFiles.join(", ");
		case "autoImportFolders":
			return serializeMappings(settings.autoImportFolders);
		default: {
			// Exhaustiveness: a new SettingKey without a branch fails here.
			const unhandled: never = key;
			return unhandled;
		}
	}
}

// Coerce a control value to a number at or above `min`, or reject it.
//
// Returns null when the value cannot be used, and the caller leaves the stored
// setting untouched — matching what display() does today for unparseable input.
function toBoundedNumber(value: unknown, min: number): number | null {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return null;
	return Math.max(min, Math.floor(parsed));
}

// Apply a control value to `settings`, mutating it in place.
//
// A value that cannot be used leaves the setting unchanged rather than storing
// something the rest of the plugin would have to defend against.
export function applyControlValue(
	settings: AuthorshipTrackerSettings,
	key: SettingKey,
	value: unknown,
): void {
	switch (key) {
		case "authorName": {
			if (typeof value === "string") settings.authorName = value.trim();
			return;
		}
		case "editLogsPath": {
			// An empty path would resolve log writes to the vault root, and the
			// retention pass would then walk it. display() refuses the same value.
			if (typeof value !== "string") return;
			const trimmed = value.trim();
			if (trimmed) settings.editLogsPath = trimmed;
			return;
		}
		case "debounceMs":
		case "maxCacheSize":
		case "logRetentionDays": {
			const bounded = toBoundedNumber(value, NUMERIC_BOUNDS[key]);
			if (bounded !== null) settings[key] = bounded;
			return;
		}
		case "ignoreFolders": {
			if (typeof value === "string") settings.ignoreFolders = splitList(value);
			return;
		}
		case "ignoreFiles": {
			if (typeof value === "string") settings.ignoreFiles = splitList(value);
			return;
		}
		case "autoImportFolders": {
			// Parsed and stored verbatim, bad filename patterns included. Rejecting
			// the value would discard every other mapping in the textarea, and
			// stripping the pattern would leave a bare Folder=Author|Origin rule
			// matching every file in that folder. getAutoImportResult already
			// treats an unusable pattern as a non-match, so the mapping simply
			// never fires; the caller warns separately.
			if (typeof value === "string") {
				settings.autoImportFolders = parseMappings(value);
			}
			return;
		}
		default: {
			const unhandled: never = key;
			void unhandled;
			return;
		}
	}
}

// Reject a value the user typed, for the control's inline error message.
//
// Returns a message to show, or null to accept. Obsidian rejects the change
// when validate returns a string, so this must only refuse values that
// applyControlValue would also refuse — otherwise the two disagree about what
// is stored.
export function validateControlValue(
	key: SettingKey,
	value: unknown,
): string | null {
	switch (key) {
		case "editLogsPath":
			return typeof value === "string" && value.trim()
				? null
				: "Edit logs path cannot be empty.";
		case "debounceMs":
		case "maxCacheSize":
		case "logRetentionDays": {
			const min = NUMERIC_BOUNDS[key];
			const parsed = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(parsed)) return "Enter a number.";
			return parsed < min ? `Must be at least ${min}.` : null;
		}
		default:
			return null;
	}
}
