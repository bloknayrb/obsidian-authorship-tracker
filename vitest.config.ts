import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		// `main.ts` imports from "obsidian", which is a types-only package at build
		// time and marked external by esbuild — there is no runtime implementation
		// to import. Point the bare specifier at an in-memory fake so the plugin
		// class can actually be instantiated. Anchored regex so only the exact
		// specifier is rewritten, never a deep import.
		alias: [
			{
				find: /^obsidian$/,
				replacement: fileURLToPath(
					new URL("./test/obsidian-mock.ts", import.meta.url),
				),
			},
		],
		// Vite's default order puts ".js" before ".ts". The production bundle is
		// emitted to ./main.js, so `import from "../main"` would silently resolve
		// to that stale artifact instead of main.ts — and would differ between a
		// clean checkout and one that has been built. Put ".ts" first.
		extensions: [".ts", ".mts", ".mjs", ".js", ".tsx", ".jsx", ".json"],
	},
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
	},
});
