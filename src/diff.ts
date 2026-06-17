// Section-level diff summaries for the JSONL edit log. Compares two versions of
// a note by their `## ` headings and reports which sections were added, removed,
// or modified. Falls back to a line-count delta for heading-less documents.
// Pure logic — no Obsidian dependency, so it is unit testable in isolation.

export interface SectionMap {
	[heading: string]: string[];
}

export function parseIntoSections(content: string): SectionMap {
	const lines = content.split("\n");
	const sections: SectionMap = {};
	let currentHeading = "";

	for (const line of lines) {
		if (line.startsWith("## ")) {
			currentHeading = line.slice(3).trim();
			if (!sections[currentHeading]) sections[currentHeading] = [];
		} else {
			if (!sections[currentHeading]) sections[currentHeading] = [];
			sections[currentHeading].push(line);
		}
	}
	return sections;
}

export function generateDiffSummary(before: string, after: string): string {
	const beforeSections = parseIntoSections(before);
	const afterSections = parseIntoSections(after);
	const beforeKeys = Object.keys(beforeSections);
	const afterKeys = Object.keys(afterSections);
	const hasHeadings = afterKeys.some((k) => k !== "");

	if (!hasHeadings) {
		const beforeLines = before.split("\n").length;
		const afterLines = after.split("\n").length;
		const delta = afterLines - beforeLines;
		const sign = delta >= 0 ? `+${delta}` : `${delta}`;
		return `Modified content (${sign} lines)`;
	}

	const parts: string[] = [];

	for (const key of afterKeys) {
		if (key === "") continue;
		if (!beforeSections[key]) {
			parts.push(`added ## ${key}`);
		}
	}

	for (const key of beforeKeys) {
		if (key === "") continue;
		if (!afterSections[key]) {
			parts.push(`removed ## ${key}`);
		}
	}

	for (const key of afterKeys) {
		if (!beforeSections[key]) continue;
		const beforeContent = beforeSections[key].join("\n");
		const afterContent = afterSections[key].join("\n");
		if (beforeContent !== afterContent) {
			const beforeCount = beforeSections[key].filter((l) => l.trim()).length;
			const afterCount = afterSections[key].filter((l) => l.trim()).length;
			const delta = afterCount - beforeCount;
			const sign = delta >= 0 ? `+${delta}` : `${delta}`;
			const label = key !== "" ? `## ${key}` : "preamble";
			parts.push(`Modified ${label} (${sign} lines)`);
		}
	}

	return parts.length > 0
		? parts.join(", ")
		: "Minor edits (no structural changes)";
}
