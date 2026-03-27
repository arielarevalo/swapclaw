import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ProjectSignals,
	detectProjectType,
	formatProjectContext,
} from "../src/project-detector.js";

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-detect-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a JSON file to the temp directory. */
function writeJson(name: string, data: unknown): void {
	fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(data, null, 2));
}

/** Create an empty file in the temp directory. */
function touch(name: string): void {
	fs.writeFileSync(path.join(tmpDir, name), "");
}

// ── Tests ───────────────────────────────────────────────────────────

describe("detectProjectType", () => {
	// ── No project signals ─────────────────────────────────────────

	describe("unknown project", () => {
		it("returns null for an empty directory", () => {
			expect(detectProjectType(tmpDir)).toBeNull();
		});

		it("returns null for a directory with unrecognised files", () => {
			touch("README.md");
			touch("notes.txt");
			expect(detectProjectType(tmpDir)).toBeNull();
		});
	});

	// ── Node.js / TypeScript ───────────────────────────────────────

	describe("Node.js / TypeScript", () => {
		it("detects plain JavaScript from package.json", () => {
			writeJson("package.json", { name: "my-app", dependencies: {} });
			const result = detectProjectType(tmpDir);
			expect(result).not.toBeNull();
			expect(result?.language).toBe("javascript");
		});

		it("detects TypeScript when typescript is in devDependencies", () => {
			writeJson("package.json", {
				name: "ts-app",
				devDependencies: { typescript: "^5.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.language).toBe("typescript");
		});

		it("detects TypeScript when tsconfig.json is present", () => {
			writeJson("package.json", { name: "ts-app" });
			touch("tsconfig.json");
			const result = detectProjectType(tmpDir);
			expect(result?.language).toBe("typescript");
		});

		it("detects react framework", () => {
			writeJson("package.json", {
				dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.framework).toBe("react");
		});

		it("detects next framework (over react)", () => {
			writeJson("package.json", {
				dependencies: { next: "^14.0.0", react: "^18.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.framework).toBe("next");
		});

		it("detects express framework", () => {
			writeJson("package.json", {
				dependencies: { express: "^4.18.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.framework).toBe("express");
		});

		it("detects vue framework", () => {
			writeJson("package.json", {
				dependencies: { vue: "^3.4.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.framework).toBe("vue");
		});

		it("detects angular framework", () => {
			writeJson("package.json", {
				dependencies: { "@angular/core": "^17.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.framework).toBe("angular");
		});

		it("detects svelte framework", () => {
			writeJson("package.json", {
				dependencies: { svelte: "^4.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.framework).toBe("svelte");
		});

		it("detects vitest test runner", () => {
			writeJson("package.json", {
				devDependencies: { vitest: "^3.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.testRunner).toBe("vitest");
		});

		it("detects jest test runner", () => {
			writeJson("package.json", {
				devDependencies: { jest: "^29.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.testRunner).toBe("jest");
		});

		it("detects mocha test runner", () => {
			writeJson("package.json", {
				devDependencies: { mocha: "^10.0.0" },
			});
			const result = detectProjectType(tmpDir);
			expect(result?.testRunner).toBe("mocha");
		});

		it("detects package manager from packageManager field", () => {
			writeJson("package.json", {
				packageManager: "pnpm@9.0.0",
			});
			const result = detectProjectType(tmpDir);
			expect(result?.packageManager).toBe("pnpm");
		});

		it("detects bun from bun.lockb", () => {
			writeJson("package.json", {});
			touch("bun.lockb");
			const result = detectProjectType(tmpDir);
			expect(result?.packageManager).toBe("bun");
		});

		it("detects bun from bun.lock", () => {
			writeJson("package.json", {});
			touch("bun.lock");
			const result = detectProjectType(tmpDir);
			expect(result?.packageManager).toBe("bun");
		});

		it("detects pnpm from pnpm-lock.yaml", () => {
			writeJson("package.json", {});
			touch("pnpm-lock.yaml");
			const result = detectProjectType(tmpDir);
			expect(result?.packageManager).toBe("pnpm");
		});

		it("detects yarn from yarn.lock", () => {
			writeJson("package.json", {});
			touch("yarn.lock");
			const result = detectProjectType(tmpDir);
			expect(result?.packageManager).toBe("yarn");
		});

		it("detects npm from package-lock.json", () => {
			writeJson("package.json", {});
			touch("package-lock.json");
			const result = detectProjectType(tmpDir);
			expect(result?.packageManager).toBe("npm");
		});

		it("returns no framework/test runner when none detected", () => {
			writeJson("package.json", { name: "bare-project" });
			const result = detectProjectType(tmpDir);
			expect(result?.framework).toBeUndefined();
			expect(result?.testRunner).toBeUndefined();
		});

		it("handles malformed package.json gracefully", () => {
			fs.writeFileSync(path.join(tmpDir, "package.json"), "not json");
			const result = detectProjectType(tmpDir);
			expect(result).not.toBeNull();
			expect(result?.language).toBe("javascript");
		});
	});

	// ── Rust ───────────────────────────────────────────────────────

	describe("Rust", () => {
		it("detects Rust from Cargo.toml", () => {
			touch("Cargo.toml");
			const result = detectProjectType(tmpDir);
			expect(result).toEqual({ language: "rust", testRunner: "cargo test" });
		});
	});

	// ── Go ─────────────────────────────────────────────────────────

	describe("Go", () => {
		it("detects Go from go.mod", () => {
			touch("go.mod");
			const result = detectProjectType(tmpDir);
			expect(result).toEqual({ language: "go", testRunner: "go test" });
		});
	});

	// ── Python ─────────────────────────────────────────────────────

	describe("Python", () => {
		it("detects Python from pyproject.toml", () => {
			touch("pyproject.toml");
			const result = detectProjectType(tmpDir);
			expect(result).toEqual({ language: "python" });
		});

		it("detects Python from requirements.txt", () => {
			touch("requirements.txt");
			const result = detectProjectType(tmpDir);
			expect(result).toEqual({ language: "python" });
		});
	});

	// ── Java ───────────────────────────────────────────────────────

	describe("Java", () => {
		it("detects Java/Maven from pom.xml", () => {
			touch("pom.xml");
			const result = detectProjectType(tmpDir);
			expect(result).toEqual({ language: "java", packageManager: "maven" });
		});

		it("detects Java/Gradle from build.gradle", () => {
			touch("build.gradle");
			const result = detectProjectType(tmpDir);
			expect(result).toEqual({ language: "java", packageManager: "gradle" });
		});

		it("detects Java/Gradle from build.gradle.kts", () => {
			touch("build.gradle.kts");
			const result = detectProjectType(tmpDir);
			expect(result).toEqual({ language: "java", packageManager: "gradle" });
		});
	});

	// ── Priority ───────────────────────────────────────────────────

	describe("priority", () => {
		it("prefers Node.js over other signals when package.json exists", () => {
			writeJson("package.json", { devDependencies: { typescript: "^5.0.0" } });
			touch("pyproject.toml"); // also present
			const result = detectProjectType(tmpDir);
			expect(result?.language).toBe("typescript");
		});
	});
});

// ── formatProjectContext ────────────────────────────────────────────

describe("formatProjectContext", () => {
	it("includes language", () => {
		const output = formatProjectContext({ language: "typescript" });
		expect(output).toContain("## Project Context");
		expect(output).toContain("**Language**: typescript");
	});

	it("includes all detected fields", () => {
		const signals: ProjectSignals = {
			language: "typescript",
			framework: "next",
			testRunner: "vitest",
			packageManager: "pnpm",
		};
		const output = formatProjectContext(signals);
		expect(output).toContain("**Language**: typescript");
		expect(output).toContain("**Framework**: next");
		expect(output).toContain("**Test runner**: vitest");
		expect(output).toContain("**Package manager**: pnpm");
	});

	it("omits optional fields when not present", () => {
		const output = formatProjectContext({ language: "rust" });
		expect(output).toContain("**Language**: rust");
		expect(output).not.toContain("**Framework**");
		expect(output).not.toContain("**Test runner**");
		expect(output).not.toContain("**Package manager**");
	});
});
