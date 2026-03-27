import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODE_MARKER_END, MODE_MARKER_START } from "../src/session-modes.js";
import { SessionScaffolder } from "../src/session-scaffolder.js";

// ── Tests ───────────────────────────────────────────────────────────

describe("SessionScaffolder", () => {
	let tmpDir: string;
	let scaffolder: SessionScaffolder;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-scaffolder-"));
		scaffolder = new SessionScaffolder();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── scaffold() ──────────────────────────────────────────────────

	describe("scaffold()", () => {
		it("creates the session folder with a logs/ subdirectory", () => {
			const folder = path.join(tmpDir, "session-1");
			scaffolder.scaffold(folder, "/tmp");

			expect(fs.existsSync(folder)).toBe(true);
			expect(fs.statSync(folder).isDirectory()).toBe(true);

			const logsDir = path.join(folder, "logs");
			expect(fs.existsSync(logsDir)).toBe(true);
			expect(fs.statSync(logsDir).isDirectory()).toBe(true);
		});

		it("copies CLAUDE.md template into the session folder", () => {
			const folder = path.join(tmpDir, "session-2");
			scaffolder.scaffold(folder, "/tmp");

			const claudeMdPath = path.join(folder, "CLAUDE.md");
			expect(fs.existsSync(claudeMdPath)).toBe(true);

			const content = fs.readFileSync(claudeMdPath, "utf-8");
			expect(content).toContain("swapclaw Session Sandbox");
		});

		it("appends project context when project signals are detected", () => {
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-proj-"));
			try {
				fs.writeFileSync(
					path.join(projectDir, "package.json"),
					JSON.stringify({
						devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0" },
					}),
				);

				const folder = path.join(tmpDir, "session-3");
				scaffolder.scaffold(folder, projectDir);

				const content = fs.readFileSync(path.join(folder, "CLAUDE.md"), "utf-8");
				expect(content).toContain("swapclaw Session Sandbox");
				expect(content).toContain("## Project Context");
				expect(content).toContain("**Language**: typescript");
				expect(content).toContain("**Test runner**: vitest");
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("does not append project context when no signals are detected", () => {
			const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-empty-"));
			try {
				const folder = path.join(tmpDir, "session-4");
				scaffolder.scaffold(folder, emptyDir);

				const content = fs.readFileSync(path.join(folder, "CLAUDE.md"), "utf-8");
				expect(content).toContain("swapclaw Session Sandbox");
				expect(content).not.toContain("## Project Context");
			} finally {
				fs.rmSync(emptyDir, { recursive: true, force: true });
			}
		});

		it("writes .mcp.json when mcpServers are provided", () => {
			const folder = path.join(tmpDir, "session-5");
			scaffolder.scaffold(folder, "/tmp", {
				mcpServers: [{ name: "my-server", command: "/usr/bin/server", args: ["--port", "3000"] }],
			});

			const mcpPath = path.join(folder, ".mcp.json");
			expect(fs.existsSync(mcpPath)).toBe(true);

			const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
			expect(parsed.mcpServers["my-server"]).toBeDefined();
			expect(parsed.mcpServers["my-server"].command).toBe("/usr/bin/server");
			expect(parsed.mcpServers["my-server"].args).toEqual(["--port", "3000"]);
		});

		it("does not write .mcp.json when mcpServers is empty", () => {
			const folder = path.join(tmpDir, "session-6");
			scaffolder.scaffold(folder, "/tmp", { mcpServers: [] });

			const mcpPath = path.join(folder, ".mcp.json");
			expect(fs.existsSync(mcpPath)).toBe(false);
		});

		it("does not write .mcp.json when no options are provided", () => {
			const folder = path.join(tmpDir, "session-7");
			scaffolder.scaffold(folder, "/tmp");

			const mcpPath = path.join(folder, ".mcp.json");
			expect(fs.existsSync(mcpPath)).toBe(false);
		});
	});

	// ── updateMode() ────────────────────────────────────────────────

	describe("updateMode()", () => {
		it("replaces the existing mode marker section", () => {
			const folder = path.join(tmpDir, "session-mode-1");
			fs.mkdirSync(folder, { recursive: true });

			const claudeMdPath = path.join(folder, "CLAUDE.md");
			const original = [
				"# Session",
				"",
				MODE_MARKER_START,
				"## Session Mode",
				"",
				"You are in code mode. Write, edit, and execute code freely.",
				MODE_MARKER_END,
				"",
				"## Other Section",
			].join("\n");
			fs.writeFileSync(claudeMdPath, original, "utf-8");

			scaffolder.updateMode(folder, "architect");

			const updated = fs.readFileSync(claudeMdPath, "utf-8");
			expect(updated).toContain("architect mode");
			expect(updated).not.toContain("code mode");
			expect(updated).toContain("## Other Section");
		});

		it("appends mode section when no marker exists", () => {
			const folder = path.join(tmpDir, "session-mode-2");
			fs.mkdirSync(folder, { recursive: true });

			const claudeMdPath = path.join(folder, "CLAUDE.md");
			fs.writeFileSync(claudeMdPath, "# Session\n\nSome content.\n", "utf-8");

			scaffolder.updateMode(folder, "ask");

			const updated = fs.readFileSync(claudeMdPath, "utf-8");
			expect(updated).toContain("# Session");
			expect(updated).toContain(MODE_MARKER_START);
			expect(updated).toContain("ask mode");
			expect(updated).toContain(MODE_MARKER_END);
		});

		it("is a no-op when CLAUDE.md does not exist", () => {
			const folder = path.join(tmpDir, "session-mode-3");
			fs.mkdirSync(folder, { recursive: true });

			// Should not throw
			scaffolder.updateMode(folder, "code");

			const claudeMdPath = path.join(folder, "CLAUDE.md");
			expect(fs.existsSync(claudeMdPath)).toBe(false);
		});
	});
});
