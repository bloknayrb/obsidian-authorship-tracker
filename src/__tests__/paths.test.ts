import { describe, it, expect } from "vitest";
import { isInFolder, shouldIgnoreFile } from "../paths";

describe("isInFolder", () => {
	it("matches a top-level folder", () => {
		expect(isInFolder("Templates/a.md", "Templates")).toBe(true);
	});

	it("matches a nested folder at any depth", () => {
		expect(isInFolder("Foo/Templates/a.md", "Templates")).toBe(true);
		expect(isInFolder("Foo/Bar/Templates/a.md", "Templates")).toBe(true);
	});

	it("does not match a partial segment name", () => {
		expect(isInFolder("MyTemplates/a.md", "Templates")).toBe(false);
		expect(isInFolder("Foo/MyTemplates/a.md", "Templates")).toBe(false);
	});

	it("supports multi-segment folders", () => {
		expect(isInFolder("Chats/messages/a.md", "Chats/messages")).toBe(true);
		expect(isInFolder("X/Chats/messages/a.md", "Chats/messages")).toBe(true);
	});
});

describe("shouldIgnoreFile", () => {
	it("ignores by exact file name", () => {
		expect(shouldIgnoreFile("a/secret.md", "secret.md", ["secret.md"], [])).toBe(
			true,
		);
	});

	it("ignores by folder", () => {
		expect(
			shouldIgnoreFile("Foo/Templates/x.md", "x.md", [], ["Templates"]),
		).toBe(true);
	});

	it("tracks unrelated files", () => {
		expect(shouldIgnoreFile("Notes/x.md", "x.md", ["secret.md"], ["Templates"])).toBe(
			false,
		);
	});
});
