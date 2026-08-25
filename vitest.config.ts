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
		// emitted to ./main.js beside the source, so `import from "../main"` would
		// silently resolve to that stale artifact instead of main.ts — green on a
		// fresh CI checkout, quietly stale on a machine that has run a build.
		//
		// Importing as "../main.ts" is not an alternative: TS 4.7.4 rejects .ts
		// specifiers (TS2691) and allowImportingTsExtensions is TS 5.0+.
		//
		// Note this REPLACES vite's default list rather than reordering it, so it
		// will lag if vite adds an extension. The deeper fix is to stop having the
		// source and the build artifact share a basename at the repo root.
		extensions: [".ts", ".mts", ".mjs", ".js", ".tsx", ".jsx", ".json"],
	},
	test: {
		// No `globals: true`: every test file imports describe/it/expect/vi
		// explicitly, matching the existing suites in src/__tests__.
		environment: "node",
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
	},
});
