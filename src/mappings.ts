// Auto-import folder mappings: how files appearing in designated folders are
// attributed to an external source (an email importer, a meeting-transcript
// pipeline, etc). Pure logic — no Obsidian dependency, so it is unit testable.

export interface AutoImportMapping {
	folder: string;
	author: string;
	contentOrigin: string;
	// Optional regex (as a string) for mixed-content folders. Only files whose
	// name matches are attributed to this mapping.
	filenamePattern?: string;
}

export interface AutoImportResult {
	author: string;
	contentOrigin: string;
}

import {
	type PatternProblem,
	checkPattern,
	matchesPattern,
} from "./patterns";

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, "");
}

// Resolve the author/content-origin for a file path against the mappings, or
// null if no mapping applies. A `filenamePattern` that is invalid or unsafe is
// treated as a non-match rather than throwing, so a bad setting can never break
// vault events. Callers surface the problem to the user separately.
export function getAutoImportResult(
	mappings: AutoImportMapping[],
	path: string,
	name: string,
): AutoImportResult | null {
	for (const mapping of mappings) {
		const folder = trimSlashes(mapping.folder);
		if (!folder) continue;
		if (!path.startsWith(folder + "/")) continue;
		if (
			mapping.filenamePattern &&
			!matchesPattern(mapping.filenamePattern, name)
		) {
			continue;
		}
		return {
			author: mapping.author,
			contentOrigin: mapping.contentOrigin || "primary",
		};
	}
	return null;
}

// Parse the settings textarea (one mapping per line:
// `Folder=Author|ContentOrigin[|FilenamePattern]`) into structured mappings.
export function parseMappings(text: string): AutoImportMapping[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes("="))
		.map((line) => {
			const eqIdx = line.indexOf("=");
			const folder = line.slice(0, eqIdx).trim();
			const rest = line.slice(eqIdx + 1).trim();
			const parts = rest.split("|");
			const mapping: AutoImportMapping = {
				folder,
				author: parts[0]?.trim() || "",
				contentOrigin: parts[1]?.trim() || "primary",
			};
			if (parts[2]?.trim()) {
				mapping.filenamePattern = parts[2].trim();
			}
			return mapping;
		})
		.filter((m) => m.folder && m.author);
}

// Serialize structured mappings back to the textarea format.
export function serializeMappings(mappings: AutoImportMapping[]): string {
	return mappings
		.map(
			(m) =>
				m.folder +
				"=" +
				m.author +
				"|" +
				m.contentOrigin +
				(m.filenamePattern ? "|" + m.filenamePattern : ""),
		)
		.join("\n");
}

export interface PatternIssue {
	pattern: string;
	problem: PatternProblem;
}

// Filename patterns that cannot be used, with the reason for each — so the
// settings error can say WHY rather than just listing them.
export function patternProblems(
	mappings: AutoImportMapping[],
): PatternIssue[] {
	const issues: PatternIssue[] = [];
	for (const m of mappings) {
		if (!m.filenamePattern) continue;
		const result = checkPattern(m.filenamePattern);
		if (!result.ok && result.problem) {
			issues.push({ pattern: m.filenamePattern, problem: result.problem });
		}
	}
	return issues;
}
