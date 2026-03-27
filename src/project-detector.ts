import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────

/** Signals detected from a project's root directory. */
export interface ProjectSignals {
	language: string;
	framework?: string;
	testRunner?: string;
	packageManager?: string;
}

// ── Detection helpers ───────────────────────────────────────────────

/** Check whether a file exists at `dir/name`. */
function hasFile(dir: string, name: string): boolean {
	return fs.existsSync(path.join(dir, name));
}

/** Safely read and parse a JSON file. Returns `null` on any error. */
function readJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Extract all dependency names from a package.json object. */
function allDeps(pkg: Record<string, unknown>): Set<string> {
	const names = new Set<string>();
	for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
		const deps = pkg[field];
		if (deps && typeof deps === "object") {
			for (const key of Object.keys(deps as Record<string, unknown>)) {
				names.add(key);
			}
		}
	}
	return names;
}

/** Detect the package manager from the packageManager field or lock files. */
function detectPackageManager(dir: string, pkg: Record<string, unknown>): string | undefined {
	// Explicit packageManager field (e.g. "pnpm@9.0.0")
	const field = pkg.packageManager;
	if (typeof field === "string") {
		const name = field.split("@")[0];
		if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") {
			return name;
		}
	}

	// Fall back to lock file detection
	if (hasFile(dir, "bun.lockb") || hasFile(dir, "bun.lock")) return "bun";
	if (hasFile(dir, "pnpm-lock.yaml")) return "pnpm";
	if (hasFile(dir, "yarn.lock")) return "yarn";
	if (hasFile(dir, "package-lock.json")) return "npm";

	return undefined;
}

/** Detect framework from package.json dependencies. */
function detectFramework(deps: Set<string>): string | undefined {
	// Order matters: more specific frameworks first
	if (deps.has("next")) return "next";
	if (deps.has("nuxt")) return "nuxt";
	if (deps.has("@angular/core")) return "angular";
	if (deps.has("svelte") || deps.has("@sveltejs/kit")) return "svelte";
	if (deps.has("vue")) return "vue";
	if (deps.has("react")) return "react";
	if (deps.has("express")) return "express";
	if (deps.has("fastify")) return "fastify";
	if (deps.has("hono")) return "hono";
	if (deps.has("koa")) return "koa";
	return undefined;
}

/** Detect test runner from package.json dependencies. */
function detectTestRunner(deps: Set<string>): string | undefined {
	if (deps.has("vitest")) return "vitest";
	if (deps.has("jest")) return "jest";
	if (deps.has("mocha")) return "mocha";
	if (deps.has("ava")) return "ava";
	if (deps.has("tap")) return "tap";
	return undefined;
}

// ── Node.js / TypeScript detection ──────────────────────────────────

function detectNode(dir: string): ProjectSignals | null {
	if (!hasFile(dir, "package.json")) return null;

	const pkg = readJson(path.join(dir, "package.json"));
	if (!pkg) {
		return { language: "javascript" };
	}

	const deps = allDeps(pkg);
	const isTypeScript = deps.has("typescript") || hasFile(dir, "tsconfig.json");

	return {
		language: isTypeScript ? "typescript" : "javascript",
		framework: detectFramework(deps),
		testRunner: detectTestRunner(deps),
		packageManager: detectPackageManager(dir, pkg),
	};
}

// ── Main entry point ────────────────────────────────────────────────

/**
 * Scan a directory for project signals and return detected metadata.
 * Returns `null` if no recognisable project type is found.
 */
export function detectProjectType(cwd: string): ProjectSignals | null {
	// Check Node.js/TypeScript first (most common for this tool)
	const node = detectNode(cwd);
	if (node) return node;

	// Rust
	if (hasFile(cwd, "Cargo.toml")) {
		return { language: "rust", testRunner: "cargo test" };
	}

	// Go
	if (hasFile(cwd, "go.mod")) {
		return { language: "go", testRunner: "go test" };
	}

	// Python
	if (hasFile(cwd, "pyproject.toml") || hasFile(cwd, "requirements.txt")) {
		return { language: "python" };
	}

	// Java (Maven or Gradle)
	if (hasFile(cwd, "pom.xml")) {
		return { language: "java", packageManager: "maven" };
	}
	if (hasFile(cwd, "build.gradle") || hasFile(cwd, "build.gradle.kts")) {
		return { language: "java", packageManager: "gradle" };
	}

	return null;
}

// ── CLAUDE.md section formatter ─────────────────────────────────────

/**
 * Format detected project signals as a Markdown section suitable for
 * appending to a session's CLAUDE.md.
 */
export function formatProjectContext(signals: ProjectSignals): string {
	const lines: string[] = ["", "## Project Context", ""];
	lines.push(`- **Language**: ${signals.language}`);
	if (signals.framework) {
		lines.push(`- **Framework**: ${signals.framework}`);
	}
	if (signals.testRunner) {
		lines.push(`- **Test runner**: ${signals.testRunner}`);
	}
	if (signals.packageManager) {
		lines.push(`- **Package manager**: ${signals.packageManager}`);
	}
	lines.push("");
	return lines.join("\n");
}
