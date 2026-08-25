// Verify that a release tag is one Obsidian can actually install.
//
// Run by .github/workflows/release.yml before anything is built or published,
// and runnable locally before pushing a tag:
//
//   node scripts/check-release-version.mjs 1.0.2
//
// That local path is the point. The failure this guards — a tag Obsidian's
// plugin updater cannot map — is otherwise only discoverable by pushing a tag
// and losing.
import { readFileSync } from "fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

const tag = process.argv[2];
if (!tag) {
	console.error("::error::Usage: node scripts/check-release-version.mjs <tag>");
	process.exit(1);
}

const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");

const problems = [];

// Obsidian requires the release tag to equal manifest.json's version exactly.
// No "v" tolerance on purpose: npm's default tag-version-prefix is "v" while
// version-bump.mjs writes a bare version, so accepting "v1.0.2" would
// rubber-stamp the one mistake this repo's tooling makes by default. .npmrc
// clears that prefix; this is the check that it stayed cleared.
if (tag !== manifest.version) {
	problems.push(
		`Tag "${tag}" does not match manifest.json version "${manifest.version}". ` +
			`Obsidian requires an exact match with no "v" prefix.`,
	);
}

if (tag !== pkg.version) {
	problems.push(
		`Tag "${tag}" does not match package.json version "${pkg.version}".`,
	);
}

// Obsidian's updater reads minAppVersion out of versions.json. version-bump.mjs
// only runs via `npm version`, so a hand-edited manifest ships a release the
// updater cannot resolve a minimum app version for.
const recorded = versions[manifest.version];
if (recorded !== manifest.minAppVersion) {
	problems.push(
		`versions.json maps ${manifest.version} to ${
			recorded === undefined ? "nothing" : `"${recorded}"`
		} but manifest.json declares minAppVersion "${manifest.minAppVersion}". ` +
			`Run "npm version" rather than editing manifest.json by hand.`,
	);
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`::error::${problem}`);
	process.exit(1);
}

console.log(
	`Release ${tag} is consistent: manifest, package.json and versions.json agree ` +
		`(minAppVersion ${manifest.minAppVersion}).`,
);
