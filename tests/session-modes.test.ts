import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { Database } from "../src/db.js";
import type { Database as DatabaseType, SessionRow } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";
import {
	MODE_MARKER_END,
	MODE_MARKER_START,
	applyModeToClaude,
	getModePreamble,
	isValidMode,
} from "../src/session-modes.js";
import type { SessionScaffolder } from "../src/session-scaffolder.js";

// ── Pure function tests ─────────────────────────────────────────────

describe("session-modes", () => {
	describe("getModePreamble()", () => {
		it("returns code mode preamble", () => {
			expect(getModePreamble("code")).toBe(
				"You are in code mode. Write, edit, and execute code freely.",
			);
		});

		it("returns ask mode preamble", () => {
			expect(getModePreamble("ask")).toBe(
				"You are in ask mode. Answer questions about the codebase without modifying files.",
			);
		});

		it("returns architect mode preamble", () => {
			expect(getModePreamble("architect")).toBe(
				"You are in architect mode. Plan and design but do not write implementation code.",
			);
		});
	});

	describe("isValidMode()", () => {
		it("accepts 'code'", () => {
			expect(isValidMode("code")).toBe(true);
		});

		it("accepts 'ask'", () => {
			expect(isValidMode("ask")).toBe(true);
		});

		it("accepts 'architect'", () => {
			expect(isValidMode("architect")).toBe(true);
		});

		it("rejects empty string", () => {
			expect(isValidMode("")).toBe(false);
		});

		it("rejects unknown mode", () => {
			expect(isValidMode("debug")).toBe(false);
		});

		it("rejects similar but incorrect values", () => {
			expect(isValidMode("Code")).toBe(false);
			expect(isValidMode("ASK")).toBe(false);
		});
	});

	describe("applyModeToClaude()", () => {
		it("appends mode block when no marker exists", () => {
			const original = "# CLAUDE.md\n\nSome content.";
			const result = applyModeToClaude(original, "code");

			expect(result).toContain(MODE_MARKER_START);
			expect(result).toContain(MODE_MARKER_END);
			expect(result).toContain("## Session Mode");
			expect(result).toContain(getModePreamble("code"));
		});

		it("replaces existing mode block", () => {
			const original = [
				"# CLAUDE.md",
				"",
				MODE_MARKER_START,
				"## Session Mode",
				"",
				getModePreamble("code"),
				MODE_MARKER_END,
				"",
				"## Other Section",
			].join("\n");

			const result = applyModeToClaude(original, "architect");

			expect(result).toContain(getModePreamble("architect"));
			expect(result).not.toContain(getModePreamble("code"));
			// Other content preserved.
			expect(result).toContain("## Other Section");
			// Only one mode block.
			expect(result.split(MODE_MARKER_START).length).toBe(2);
		});

		it("preserves content before and after marker", () => {
			const before = "# Header\n\nParagraph.";
			const after = "\n## Footer";
			const original = `${before}\n\n${MODE_MARKER_START}\nold\n${MODE_MARKER_END}${after}`;

			const result = applyModeToClaude(original, "ask");

			expect(result).toContain("# Header");
			expect(result).toContain("Paragraph.");
			expect(result).toContain("## Footer");
		});
	});
});

// ── SessionManager mode methods (mocked DB, no real fs) ─────────────

/** Create a mock Database with vi.fn() stubs. */
function makeMockDb(): DatabaseType {
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
		listRunningContainers: vi.fn().mockReturnValue([]),
		close: vi.fn(),
	} as unknown as DatabaseType;
}

function makeConfig(): Config {
	return Object.freeze({
		dataDir: "/tmp/swapclaw",
		containerImage: "swapclaw-agent:latest",
		containerTimeout: 300_000,
		idleTimeout: 60_000,
		maxConcurrent: 3,
		timezone: "UTC",
		sessionsDir: "/tmp/swapclaw/sessions",
		dbPath: "/tmp/swapclaw/swapclaw.db",
	});
}

function makeMockScaffolder(): SessionScaffolder {
	return {
		scaffold: vi.fn(),
		updateMode: vi.fn(),
	} as unknown as SessionScaffolder;
}

function fakeRow(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		id: overrides.id ?? "sess-test",
		cwd: overrides.cwd ?? "/project",
		title: overrides.title ?? null,
		state: overrides.state ?? "active",
		mode: overrides.mode ?? "code",
		created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
		updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
	};
}

describe("SessionManager mode methods", () => {
	let db: DatabaseType;
	let scaffolder: SessionScaffolder;
	let manager: SessionManager;

	beforeEach(() => {
		db = makeMockDb();
		scaffolder = makeMockScaffolder();
		manager = new SessionManager(makeConfig(), db, scaffolder);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("getMode()", () => {
		it("returns mode from DB row", () => {
			(db.getSession as Mock).mockReturnValue(fakeRow({ mode: "architect" }));
			expect(manager.getMode("sess-test")).toBe("architect");
		});

		it("defaults to 'code' when mode is undefined", () => {
			(db.getSession as Mock).mockReturnValue({
				...fakeRow(),
				mode: undefined,
			});
			expect(manager.getMode("sess-test")).toBe("code");
		});

		it("defaults to 'code' when mode is invalid", () => {
			(db.getSession as Mock).mockReturnValue({
				...fakeRow(),
				mode: "bogus",
			});
			expect(manager.getMode("sess-test")).toBe("code");
		});

		it("throws for nonexistent session", () => {
			(db.getSession as Mock).mockReturnValue(null);
			expect(() => manager.getMode("nonexistent")).toThrow("Session not found: nonexistent");
		});
	});

	describe("setMode()", () => {
		it("persists mode to DB", () => {
			(db.getSession as Mock).mockReturnValue(fakeRow());

			manager.setMode("sess-test", "architect");

			expect(db.updateSession).toHaveBeenCalledWith("sess-test", { mode: "architect" });
		});

		it("delegates CLAUDE.md update to scaffolder", () => {
			(db.getSession as Mock).mockReturnValue(fakeRow());

			manager.setMode("sess-test", "ask");

			expect(scaffolder.updateMode).toHaveBeenCalledWith("/tmp/swapclaw/sessions/sess-test", "ask");
		});

		it("throws for invalid mode", () => {
			(db.getSession as Mock).mockReturnValue(fakeRow());
			// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
			expect(() => manager.setMode("sess-test", "invalid" as any)).toThrow(
				"Invalid session mode: invalid",
			);
		});

		it("throws for nonexistent session", () => {
			(db.getSession as Mock).mockReturnValue(null);
			expect(() => manager.setMode("nonexistent", "code")).toThrow(
				"Session not found: nonexistent",
			);
		});
	});
});

// ── Database v2 migration ───────────────────────────────────────────

describe("Database v2 migration (mode column)", () => {
	let db: Database;

	beforeEach(() => {
		db = Database.inMemory();
	});

	it("new sessions have mode defaulting to 'code'", () => {
		db.createSession("s1", "/tmp");
		const row = db.getSession("s1");
		expect(row?.mode).toBe("code");
		db.close();
	});

	it("updateSession can set mode", () => {
		db.createSession("s1", "/tmp");
		db.updateSession("s1", { mode: "architect" });
		const row = db.getSession("s1");
		expect(row?.mode).toBe("architect");
		db.close();
	});

	it("updateSession with mode bumps updated_at", () => {
		db.createSession("s1", "/tmp");
		const before = db.getSession("s1")?.updated_at ?? "";
		db.updateSession("s1", { mode: "ask" });
		const after = db.getSession("s1")?.updated_at ?? "";
		expect(after >= before).toBe(true);
		db.close();
	});
});
