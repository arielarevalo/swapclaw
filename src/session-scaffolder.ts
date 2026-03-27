import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "./mcp-passthrough.js";
import { writeMcpConfigFile } from "./mcp-passthrough.js";
import { detectProjectType, formatProjectContext } from "./project-detector.js";
import { type SessionMode, applyModeToClaude } from "./session-modes.js";

// ── Template path ───────────────────────────────────────────────────

/** Resolve the bundled CLAUDE.md template shipped with the package. */
export function resolveTemplatePath(): string {
	// Walk up from src/ to project root, then into templates/
	return path.resolve(import.meta.dirname, "..", "templates", "CLAUDE.md");
}

// ── SessionScaffolder ───────────────────────────────────────────────

/** Options for `scaffold()`. */
export interface ScaffoldOptions {
	mcpServers?: McpServerConfig[];
}

/**
 * Handles filesystem operations for session setup and mode updates.
 *
 * Responsible for:
 * - Creating session folder structure
 * - Copying and augmenting the CLAUDE.md template
 * - Detecting project type and appending context
 * - Writing MCP config files
 * - Updating the mode section in CLAUDE.md
 */
export class SessionScaffolder {
	/**
	 * Create folder structure, copy template, detect project type, write MCP config.
	 */
	scaffold(folder: string, cwd: string, opts?: ScaffoldOptions): void {
		// Create session folder structure
		fs.mkdirSync(path.join(folder, "logs"), { recursive: true });

		// Copy CLAUDE.md template into the session folder
		const templatePath = resolveTemplatePath();
		const claudeMdPath = path.join(folder, "CLAUDE.md");
		fs.copyFileSync(templatePath, claudeMdPath);

		// Detect project type and append context to CLAUDE.md
		const signals = detectProjectType(cwd);
		if (signals) {
			fs.appendFileSync(claudeMdPath, formatProjectContext(signals));
		}

		// Write MCP server configs if provided
		if (opts?.mcpServers && opts.mcpServers.length > 0) {
			writeMcpConfigFile(folder, opts.mcpServers);
		}
	}

	/**
	 * Update the mode section in a session's CLAUDE.md.
	 */
	updateMode(folder: string, mode: SessionMode): void {
		const claudeMdPath = path.join(folder, "CLAUDE.md");
		if (fs.existsSync(claudeMdPath)) {
			const content = fs.readFileSync(claudeMdPath, "utf-8");
			const updated = applyModeToClaude(content, mode);
			fs.writeFileSync(claudeMdPath, updated, "utf-8");
		}
	}
}
