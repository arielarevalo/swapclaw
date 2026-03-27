import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { McpServerConfig } from "./mcp-passthrough.js";
import { type SessionMode, isValidMode } from "./session-modes.js";
import type { SessionScaffolder } from "./session-scaffolder.js";

// ── Types ───────────────────────────────────────────────────────────

/** ACP-compatible session metadata. */
export interface SessionInfo {
	sessionId: string;
	cwd: string;
	title: string | null;
	state: string;
	folder: string;
	createdAt: string;
}

/** Options for `create()`. */
export interface CreateOptions {
	mcpServers?: McpServerConfig[];
}

/** Return value of `create()`. */
export interface CreateResult {
	sessionId: string;
	folder: string;
}

// ── SessionManager ──────────────────────────────────────────────────

export class SessionManager {
	constructor(
		private readonly config: Config,
		private readonly db: Database,
		private readonly scaffolder: SessionScaffolder,
	) {}

	/**
	 * Create a new session: generate ID, persist to DB, scaffold disk folder.
	 */
	create(cwd: string, opts?: CreateOptions): CreateResult {
		const sessionId = crypto.randomBytes(16).toString("hex"); // 32-char hex
		const folder = this.getFolder(sessionId);

		// Persist to database
		this.db.createSession(sessionId, cwd);

		// Scaffold filesystem (folder structure, template, project detection, MCP config)
		this.scaffolder.scaffold(folder, cwd, opts);

		return { sessionId, folder };
	}

	/**
	 * Load an active session by ID.
	 * Throws if the session does not exist, is closed, or its folder is missing.
	 */
	load(sessionId: string): SessionInfo {
		const row = this.db.getSession(sessionId);
		if (!row) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		if (row.state === "closed") {
			throw new Error(`Session is closed: ${sessionId}`);
		}

		const folder = this.getFolder(sessionId);
		if (!fs.existsSync(folder)) {
			throw new Error(`Session folder missing: ${folder}`);
		}

		return this.toSessionInfo(row);
	}

	/**
	 * List sessions, optionally filtered by working directory.
	 */
	list(cwd?: string): SessionInfo[] {
		const rows = this.db.listSessions(cwd);
		return rows.map((row) => this.toSessionInfo(row));
	}

	/**
	 * Close a session: mark closed in DB and clear container state.
	 * Does NOT delete the session folder (sessions are recoverable).
	 */
	close(sessionId: string): void {
		this.db.closeSession(sessionId);
		this.db.clearContainerState(sessionId);
	}

	/** Session folder path: `config.sessionsDir/<sessionId>/` */
	getFolder(sessionId: string): string {
		return path.join(this.config.sessionsDir, sessionId);
	}

	/** Path to the session's CLAUDE.md file. */
	getClaudeMdPath(sessionId: string): string {
		return path.join(this.getFolder(sessionId), "CLAUDE.md");
	}

	/**
	 * Get the current mode for a session. Defaults to "code".
	 */
	getMode(sessionId: string): SessionMode {
		const row = this.db.getSession(sessionId);
		if (!row) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		const mode = row.mode ?? "code";
		return isValidMode(mode) ? mode : "code";
	}

	/**
	 * Set the mode for a session. Updates the DB and rewrites the
	 * mode section in the session's CLAUDE.md.
	 */
	setMode(sessionId: string, mode: SessionMode): void {
		if (!isValidMode(mode)) {
			throw new Error(`Invalid session mode: ${mode}`);
		}

		// Verify session exists.
		const row = this.db.getSession(sessionId);
		if (!row) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		// Persist to DB.
		this.db.updateSession(sessionId, { mode });

		// Update CLAUDE.md via scaffolder.
		this.scaffolder.updateMode(this.getFolder(sessionId), mode);
	}

	// ── Private helpers ─────────────────────────────────────────────

	private toSessionInfo(row: {
		id: string;
		cwd: string;
		title: string | null;
		state: string;
		created_at: string;
	}): SessionInfo {
		return {
			sessionId: row.id,
			cwd: row.cwd,
			title: row.title,
			state: row.state,
			folder: this.getFolder(row.id),
			createdAt: row.created_at,
		};
	}
}
