import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { formatLocalTimestamp } from "../src/time";

const root = resolve(__dirname, "..");
const contractPath = resolve(root, "docs/agent-provenance-contract.md");
const skillPath = resolve(root, "skills/obsidian-authorship-tracker/SKILL.md");
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("agent provenance contract", () => {
	it("ships a cooperative-provenance contract and portable skill", () => {
		const contract = read(contractPath);
		const skill = read(skillPath);

		expect(contract).toContain("cooperative, best-effort declared provenance");
		expect(contract).toContain("not identity verification");
		expect(contract).toContain("tamper-evident audit logging");
		expect(skill).toMatch(/^---\nname: obsidian-authorship-tracker\n/);
		expect(skill).toContain("Read back");
	});

	it("defines stable external-event fields without changing legacy fields", () => {
		const contract = read(contractPath);

		for (const field of [
			"ts",
			"file",
			"author",
			"action",
			"summary",
			"provenance_version",
			"writer_kind",
			"writer_id",
			"event_id",
		]) {
			expect(contract).toContain(`\`${field}\``);
		}
		expect(contract).toContain("`created`");
		expect(contract).toContain("`modified`");
	});

	it("documents timestamps in the plugin's local wall-clock format", () => {
		const contract = read(contractPath);

		for (const ts of contract.match(/"ts":"[^"]*"/g) ?? []) {
			expect(ts).toMatch(/^"ts":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"$/);
		}
		expect(contract).toContain(formatLocalTimestamp(new Date(2026, 7, 25, 18, 0, 0)));
		expect(contract).not.toMatch(/RFC 3339 UTC/);
	});

	it("requires abstention, preserves original provenance, and leaves edit_count plugin-owned", () => {
		const skill = read(skillPath);

		expect(skill).toContain("Ask the user");
		expect(skill).toContain("Never use a human name");
		expect(skill).toContain("Do not change `created_by`");
		expect(skill).toContain("Do not change `content_origin`");
		expect(skill).toContain("Do not modify `edit_count`");
		expect(skill).toContain("partial provenance recorded");
	});

	it("uses Hermes-compatible frontmatter and resolves the contract link", () => {
		const skill = read(skillPath);
		const match = skill.match(/^---\n([\s\S]*?)\n---\n/);
		expect(match?.[1]).toContain("metadata:\n  hermes:\n    tags:");
		expect(match?.[1]).toContain("related_skills:");

		const contractLink = skill.match(/\]\((\.\.\/\.\.\/docs\/agent-provenance-contract\.md)\)/)?.[1];
		expect(contractLink).toBeDefined();
		expect(existsSync(resolve(dirname(skillPath), contractLink!))).toBe(true);
	});

	it("documents the auto-import exception for external filesystem creates", () => {
		const contract = read(contractPath);
		const readme = read(resolve(root, "README.md"));

		for (const text of [contract, readme]) {
			expect(text).toContain("auto-import");
			expect(text).toContain("does not detect or enforce ordinary or unmapped filesystem edits");
		}
	});

	it("links the public README to existing contract and skill files without claiming automatic enforcement", () => {
		const readme = read(resolve(root, "README.md"));
		const contractLink = readme.match(/\]\((docs\/agent-provenance-contract\.md)\)/)?.[1];
		const skillLink = readme.match(/\]\((skills\/obsidian-authorship-tracker\/SKILL\.md)\)/)?.[1];

		expect(contractLink).toBeDefined();
		expect(skillLink).toBeDefined();
		expect(existsSync(resolve(root, contractLink!))).toBe(true);
		expect(existsSync(resolve(root, skillLink!))).toBe(true);
		expect(relative(root, resolve(root, contractLink!)).replace(/\\/g, "/")).toBe("docs/agent-provenance-contract.md");
		expect(readme).toContain("does not detect or enforce ordinary or unmapped filesystem edits");
	});
});
