// Path helpers for deciding whether a file falls under an ignored folder.
// Pure logic — no Obsidian dependency, so it is unit testable in isolation.

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, "");
}

// True if `filePath` is inside `folder`, matching `folder` as a whole path
// segment (or segment sequence) at any depth. `folder: "Templates"` matches
// both `Templates/a.md` and `Foo/Templates/a.md`, but not `MyTemplates/a.md`.
export function isInFolder(filePath: string, folder: string): boolean {
	const f = trimSlashes(folder);
	if (!f) return false;
	if (filePath === f) return true;
	if (filePath.startsWith(f + "/")) return true;
	return filePath.includes("/" + f + "/");
}

// True if the file (by name and path) should be excluded from tracking.
export function shouldIgnoreFile(
	filePath: string,
	fileName: string,
	ignoreFiles: string[],
	ignoreFolders: string[],
): boolean {
	if (ignoreFiles.includes(fileName)) return true;
	for (const folder of ignoreFolders) {
		if (isInFolder(filePath, folder)) return true;
	}
	return false;
}
