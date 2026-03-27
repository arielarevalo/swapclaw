import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Database, SessionRow } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";
import type { SessionScaffolder } from "../src/session-scaffolder.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Create a minimal Config pointing at the given temp directory. */
function makeConfig(tmpDir: string): Config {
	return Object.freeze({
		dataDir: tmpDir,
		containerImage: "swapclaw-agent:latest",
		containerTimeout: 300_000,
		idleTimeout: 60_000,
		maxConcurrent: 3,
		timezone: "UTC",
		sessionsDir: path.join(tmpDir, "sessions"),
		dbPath: path.join(tmpDir, "swapclaw.db"),
	});
}

/** Create a mock Database with vi.fn() stubs. */
function makeMockDb(): Database {
	return {
		createSession: vi.fn(),
		getSession: vi.fn(),
		listSessions: vi.fn().mockReturnValue([]),
		updateSession: vi.fn(),
		closeSession: vi.fn(),
		clearContainerState: vi.fn(),
		addMessage: vi.fn(),
		getMessages: vi.fn(),
		setContainerState: vi.fn(),
		getContainerState: vi.fn(),
		close: vi.fn(),
	} as unknown as Database;
}

/** Create a mock SessionScaffolder with vi.fn() stubs. */
function makeMockScaffolder(): SessionScaffolder {
	return {
		scaffold: vi.fn(),
		updateMode: vi.fn(),
	} as unknown as SessionScaffolder;
}

/** Build a fake SessionRow for testing. */
function fakeRow(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		id: overrides.id ?? "abcd1234abcd1234abcd1234abcd1234",
		cwd: overrides.cwd ?? "/home/user/project",
		title: overrides.title ?? null,
		state: overrides.state ?? "active",
		mode: overrides.mode ?? "code",
		created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
		updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
	};
}

// ── Tests ───────────────────────────────────────────────────────────

describe("SessionManager", () => {
	let tmpDir: string;
	let config: Config;
	let db: Database;
	let scaffolder: SessionScaffolder;
	let manager: SessionManager;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-test-"));
		config = makeConfig(tmpDir);
		db = makeMockDb();
		scaffolder = makeMockScaffolder();
		manager = new SessionManager(config, db, scaffolder);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── create() ────────────────────────────────────────────────────

	describe("create()", () => {
		it("generates a 32-character hex session ID", () => {
			const { sessionId } = manager.create("/home/user/project");
			expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
		});

		it("generates unique IDs on successive calls", () => {
			const a = manager.create("/tmp");
			const b = manager.create("/tmp");
			expect(a.sessionId).not.toBe(b.sessionId);
		});

		it("inserts a session row into the database", () => {
			const { sessionId } = manager.create("/home/user/project");
			expect(db.createSession).toHaveBeenCalledWith(sessionId, "/home/user/project");
		});

		it("returns the correct folder path under sessionsDir", () => {
			const { sessionId, folder } = manager.create("/tmp");
			expect(folder).toBe(path.join(config.sessionsDir, sessionId));
		});

		it("delegates filesystem scaffolding to SessionScaffolder", () => {
			const { folder } = manager.create("/home/user/project", {
				mcpServers: [{ name: "test", command: "echo" }],
			});
			expect(scaffolder.scaffold).toHaveBeenCalledWith(folder, "/home/user/project", {
				mcpServers: [{ name: "test", command: "echo" }],
			});
		});

		it("calls scaffolder.scaffold with no options when none provided", () => {
			const { folder } = manager.create("/tmp");
			expect(scaffolder.scaffold).toHaveBeenCalledWith(folder, "/tmp", undefined);
		});
	});

	// ── load() ──────────────────────────────────────────────────────

	describe("load()", () => {
		it("returns SessionInfo for an active session", () => {
			// Create a real folder so the existsSync check passes
			const row = fakeRow();
			(db.getSession as Mock).mockReturnValue(row);
			const folder = manager.getFolder(row.id);
			fs.mkdirSync(folder, { recursive: true });

			const info = manager.load(row.id);
			expect(info.sessionId).toBe(row.id);
			expect(info.cwd).toBe(row.cwd);
			expect(info.title).toBeNull();
			expect(info.state).toBe("active");
			expect(info.folder).toBe(folder);
			expect(info.createdAt).toBe(row.created_at);
		});

		it("throws for an unknown session ID", () => {
			(db.getSession as Mock).mockReturnValue(null);
			expect(() => manager.load("nonexistent")).toThrow("Session not found: nonexistent");
		});

		it("throws for a closed session", () => {
			const row = fakeRow({ state: "closed" });
			(db.getSession as Mock).mockReturnValue(row);

			expect(() => manager.load(row.id)).toThrow(`Session is closed: ${row.id}`);
		});

		it("throws when the session folder is missing from disk", () => {
			const row = fakeRow();
			(db.getSession as Mock).mockReturnValue(row);
			// Don't create the folder

			expect(() => manager.load(row.id)).toThrow("Session folder missing:");
		});
	});

	// ── list() ──────────────────────────────────────────────────────

	describe("list()", () => {
		it("returns all sessions when no cwd filter is provided", () => {
			const rows = [fakeRow({ id: "aaa", cwd: "/a" }), fakeRow({ id: "bbb", cwd: "/b" })];
			(db.listSessions as Mock).mockReturnValue(rows);

			const result = manager.list();
			expect(db.listSessions).toHaveBeenCalledWith(undefined);
			expect(result).toHaveLength(2);
			expect(result[0].sessionId).toBe("aaa");
			expect(result[1].sessionId).toBe("bbb");
		});

		it("passes cwd filter to the database", () => {
			const rows = [fakeRow({ id: "aaa", cwd: "/project-a" })];
			(db.listSessions as Mock).mockReturnValue(rows);

			const result = manager.list("/project-a");
			expect(db.listSessions).toHaveBeenCalledWith("/project-a");
			expect(result).toHaveLength(1);
			expect(result[0].cwd).toBe("/project-a");
		});

		it("returns empty array when no sessions match", () => {
			(db.listSessions as Mock).mockReturnValue([]);

			const result = manager.list("/nonexistent");
			expect(result).toHaveLength(0);
		});

		it("maps DB rows to SessionInfo objects", () => {
			const row = fakeRow({ id: "abc123", title: "My Session" });
			(db.listSessions as Mock).mockReturnValue([row]);

			const [info] = manager.list();
			expect(info.sessionId).toBe("abc123");
			expect(info.title).toBe("My Session");
			expect(info.folder).toBe(path.join(config.sessionsDir, "abc123"));
			expect(info.createdAt).toBe(row.created_at);
		});
	});

	// ── close() ─────────────────────────────────────────────────────

	describe("close()", () => {
		it("marks the session as closed in the database", () => {
			manager.close("sess-1");
			expect(db.closeSession).toHaveBeenCalledWith("sess-1");
		});

		it("clears container state", () => {
			manager.close("sess-1");
			expect(db.clearContainerState).toHaveBeenCalledWith("sess-1");
		});

		it("does not delete the session folder", () => {
			// Create a session folder to verify it survives close()
			const folder = manager.getFolder("sess-1");
			fs.mkdirSync(folder, { recursive: true });

			manager.close("sess-1");

			expect(fs.existsSync(folder)).toBe(true);
		});
	});

	// ── getFolder() / getClaudeMdPath() ─────────────────────────────

	describe("getFolder()", () => {
		it("returns sessionsDir/<sessionId>", () => {
			expect(manager.getFolder("abc123")).toBe(path.join(config.sessionsDir, "abc123"));
		});
	});

	describe("getClaudeMdPath()", () => {
		it("returns sessionsDir/<sessionId>/CLAUDE.md", () => {
			expect(manager.getClaudeMdPath("abc123")).toBe(
				path.join(config.sessionsDir, "abc123", "CLAUDE.md"),
			);
		});
	});
});
