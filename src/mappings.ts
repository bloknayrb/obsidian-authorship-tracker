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

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, "");
}

// Resolve the author/content-origin for a file path against the mappings, or
// null if no mapping applies. An invalid `filenamePattern` is treated as a
// non-match rather than throwing, so a bad setting can never break vault events.
export function getAutoImportResult(
	mappings: AutoImportMapping[],
	path: string,
	name: string,
): AutoImportResult | null {
	for (const mapping of mappings) {
		const folder = trimSlashes(mapping.folder);
		if (!folder) continue;
		if (!path.startsWith(folder + "/")) continue;
		if (mapping.filenamePattern) {
			let pattern: RegExp;
			try {
				pattern = new RegExp(mapping.filenamePattern);
			} catch {
				continue;
			}
			if (!pattern.test(name)) continue;
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

// Return the list of invalid filename-pattern regexes (for settings validation).
export function invalidPatterns(mappings: AutoImportMapping[]): string[] {
	const invalid: string[] = [];
	for (const m of mappings) {
		if (!m.filenamePattern) continue;
		try {
			new RegExp(m.filenamePattern);
		} catch {
			invalid.push(m.filenamePattern);
		}
	}
	return invalid;
}
