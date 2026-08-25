// Compile-time conformance check: does test/obsidian-mock.ts still line up with
// the real Obsidian API?
//
// This file is compiled by tsconfig.json — the project WITHOUT the
// "obsidian" -> mock paths override — so `import from "obsidian"` here resolves to
// the real obsidian.d.ts while the mock is imported by relative path. That makes it
// the only place the two are compared.
//
// Why it is needed: neither typecheck catches mock drift on its own.
//   * `npm run typecheck` compiles main.ts against the real .d.ts, but never sees
//     the mock.
//   * `npm run typecheck:test` compiles main.ts against the mock, but never sees
//     the real .d.ts.
// Without this file the mock could rename a method, or drop one, and both stay
// green forever.
//
// What it asserts: that every member main.ts relies on exists BOTH on the real
// class and on the mock. That catches the realistic drift — a renamed or deleted
// mock method, or main.ts reaching for an API the real Obsidian does not have.
//
// What it deliberately does not assert: full signature assignability. The mock's
// TFile is a different nominal type from the real TFile, so every method that
// takes or returns one is structurally incompatible no matter how faithful the
// mock is. Chasing that would mean casts everywhere, which would assert nothing.
// Behavioral fidelity is covered by tests in test/harness.test.ts instead.
//
// Nothing here runs. Extend the member lists whenever main.ts uses a new API.
import type {
	App as RealApp,
	FileManager as RealFileManager,
	TFile as RealTFile,
	TFolder as RealTFolder,
	Vault as RealVault,
	Workspace as RealWorkspace,
} from "obsidian";
import { normalizePath as realNormalizePath } from "obsidian";

import type {
	App as MockApp,
	FileManager as MockFileManager,
	TFile as MockTFile,
	TFolder as MockTFolder,
	Vault as MockVault,
	Workspace as MockWorkspace,
} from "./obsidian-mock";
import { normalizePath as mockNormalizePath } from "./obsidian-mock";

// Resolves to `Members` when they all exist on `Actual`, and to the offending
// names otherwise — so a failure names exactly what is missing.
type Missing<Members extends string, Actual> = Exclude<Members, keyof Actual>;

// `never` means nothing is missing. Anything else fails to compile and the error
// message prints the missing member names.
type AssertNoneMissing<T extends never> = T;

// ── Vault ─────────────────────────────────────────────────────────────────────
type VaultMembers =
	| "read"
	| "create"
	| "createFolder"
	| "process"
	| "delete"
	| "getAbstractFileByPath"
	| "on";
export type _VaultOnReal = AssertNoneMissing<Missing<VaultMembers, RealVault>>;
export type _VaultOnMock = AssertNoneMissing<Missing<VaultMembers, MockVault>>;

// ── Workspace ─────────────────────────────────────────────────────────────────
type WorkspaceMembers =
	| "on"
	| "getActiveViewOfType"
	| "getLeaf"
	| "onLayoutReady";
export type _WorkspaceOnReal = AssertNoneMissing<
	Missing<WorkspaceMembers, RealWorkspace>
>;
export type _WorkspaceOnMock = AssertNoneMissing<
	Missing<WorkspaceMembers, MockWorkspace>
>;

// ── FileManager ───────────────────────────────────────────────────────────────
type FileManagerMembers = "processFrontMatter";
export type _FileManagerOnReal = AssertNoneMissing<
	Missing<FileManagerMembers, RealFileManager>
>;
export type _FileManagerOnMock = AssertNoneMissing<
	Missing<FileManagerMembers, MockFileManager>
>;

// ── App ───────────────────────────────────────────────────────────────────────
type AppMembers = "vault" | "workspace" | "fileManager";
export type _AppOnReal = AssertNoneMissing<Missing<AppMembers, RealApp>>;
export type _AppOnMock = AssertNoneMissing<Missing<AppMembers, MockApp>>;

// ── File tree ─────────────────────────────────────────────────────────────────
type TFileMembers = "path" | "name" | "basename" | "extension" | "stat";
export type _TFileOnReal = AssertNoneMissing<Missing<TFileMembers, RealTFile>>;
export type _TFileOnMock = AssertNoneMissing<Missing<TFileMembers, MockTFile>>;

type TFolderMembers = "path" | "name" | "children";
export type _TFolderOnReal = AssertNoneMissing<
	Missing<TFolderMembers, RealTFolder>
>;
export type _TFolderOnMock = AssertNoneMissing<
	Missing<TFolderMembers, MockTFolder>
>;

// ── Free functions ────────────────────────────────────────────────────────────
// No nominal Obsidian types involved here, so a real signature check is possible.
const _normalizePath: typeof realNormalizePath = mockNormalizePath;
void _normalizePath;
