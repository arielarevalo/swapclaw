import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentConnection,
	AgentProcessManager,
	SessionUpdateCallback,
} from "../src/agent-process-manager.js";
import type { Config } from "../src/config.js";
import type { ContainerHandle, ContainerRunner } from "../src/container-runner.js";
import type { Database } from "../src/db.js";
import type { CreateResult, SessionInfo, SessionManager } from "../src/session-manager.js";
import { SessionOrchestrator } from "../src/session-orchestrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubConfig: Config = {
	dataDir: "/tmp/swapclaw",
	containerImage: "alpine:latest",
	containerTimeout: 300_000,
	idleTimeout: 60_000,
	maxConcurrent: 3,
	timezone: "America/New_York",
	sessionsDir: "/tmp/swapclaw/sessions",
	dbPath: "/tmp/swapclaw/swapclaw.db",
};

function createMockSessionManager(): SessionManager {
	return {
		create: vi.fn<(cwd: string) => CreateResult>().mockReturnValue({
			sessionId: "sess-001",
			folder: "/tmp/swapclaw/sessions/sess-001",
		}),
		load: vi.fn<(id: string) => SessionInfo>().mockReturnValue({
			sessionId: "sess-001",
			cwd: "/project",
			title: null,
			state: "active",
			folder: "/tmp/swapclaw/sessions/sess-001",
			createdAt: "2026-01-01T00:00:00.000Z",
		}),
		list: vi.fn<(cwd?: string) => SessionInfo[]>().mockReturnValue([]),
		close: vi.fn(),
		getFolder: vi.fn<(id: string) => string>().mockReturnValue("/tmp/swapclaw/sessions/sess-001"),
		getClaudeMdPath: vi.fn(),
		getMode: vi.fn(),
		setMode: vi.fn(),
	} as unknown as SessionManager;
}

function createMockContainerRunner(): ContainerRunner {
	return {
		start: vi
			.fn<(sessionId: string, cwd: string, folder: string) => Promise<ContainerHandle>>()
			.mockResolvedValue({
				containerId: "container-001",
				containerName: "swapclaw-sess-001-1234",
				startedAt: new Date(),
			}),
		stop: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
		getHandle: vi.fn(),
		isRunning: vi.fn<(sessionId: string) => boolean>().mockReturnValue(true),
		resetIdleTimer: vi.fn(),
		stopAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
	} as unknown as ContainerRunner;
}

function createMockDatabase(): Database {
	return {
		addMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
		createSession: vi.fn(),
		getSession: vi.fn(),
		listSessions: vi.fn().mockReturnValue([]),
		updateSession: vi.fn(),
		closeSession: vi.fn(),
		clearContainerState: vi.fn(),
		setContainerState: vi.fn(),
		getContainerState: vi.fn(),
		listRunningContainers: vi.fn().mockReturnValue([]),
		close: vi.fn(),
	} as unknown as Database;
}

/** Create a mock AgentConnection returned by connect(). */
function createMockAgentConnection(overrides?: Partial<AgentConnection>): AgentConnection {
	return {
		connection: {
			initialize: vi.fn().mockResolvedValue({
				protocolVersion: 1,
				agentCapabilities: {},
			}),
			newSession: vi.fn().mockResolvedValue({
				sessionId: "agent-sess-001",
			}),
			prompt: vi.fn().mockResolvedValue({
				stopReason: "end_turn",
			}),
			cancel: vi.fn().mockResolvedValue(undefined),
			signal: new AbortController().signal,
			closed: new Promise<void>(() => {}),
		} as unknown as acp.ClientSideConnection,
		client: {
			cleanup: vi.fn(),
		} as unknown as AgentConnection["client"],
		agentProcess: {
			killed: false,
			kill: vi.fn(),
		} as unknown as AgentConnection["agentProcess"],
		agentSessionId: "agent-sess-001",
		messageCollector: [],
		...overrides,
	};
}

/** Captured onUpdate callback from the most recent connect() call. */
let capturedOnUpdate: SessionUpdateCallback | undefined;

function createMockAgentProcessManager(): AgentProcessManager {
	capturedOnUpdate = undefined;
	return {
		connect: vi.fn(async (_containerId: string, _cwd: string, onUpdate?: SessionUpdateCallback) => {
			capturedOnUpdate = onUpdate;
			return createMockAgentConnection();
		}),
		disconnect: vi.fn(),
	} as unknown as AgentProcessManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionOrchestrator", () => {
	let orchestrator: SessionOrchestrator;
	let sessionManager: ReturnType<typeof createMockSessionManager>;
	let containerRunner: ReturnType<typeof createMockContainerRunner>;
	let db: ReturnType<typeof createMockDatabase>;
	let agentProcessManager: ReturnType<typeof createMockAgentProcessManager>;

	beforeEach(() => {
		vi.clearAllMocks();
		sessionManager = createMockSessionManager();
		containerRunner = createMockContainerRunner();
		db = createMockDatabase();
		agentProcessManager = createMockAgentProcessManager();
		orchestrator = new SessionOrchestrator(
			stubConfig,
			db as unknown as Database,
			sessionManager as unknown as SessionManager,
			containerRunner as unknown as ContainerRunner,
			agentProcessManager as unknown as AgentProcessManager,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// newSession()
	// -----------------------------------------------------------

	describe("newSession", () => {
		it("creates session, starts container, and connects agent", async () => {
			const sessionId = await orchestrator.newSession("/project");

			// Session created.
			expect(sessionManager.create).toHaveBeenCalledWith("/project", undefined);
			expect(sessionId).toBe("sess-001");

			// Container started.
			expect(containerRunner.start).toHaveBeenCalledWith(
				"sess-001",
				"/project",
				"/tmp/swapclaw/sessions/sess-001",
			);

			// Agent process manager connect called with container ID and cwd.
			expect(agentProcessManager.connect).toHaveBeenCalledWith(
				"container-001",
				"/project",
				expect.any(Function),
			);

			// Session is now active.
			expect(orchestrator.isActive("sess-001")).toBe(true);
		});

		it("cleans up on container start failure", async () => {
			(containerRunner.start as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Docker not running"),
			);

			await expect(orchestrator.newSession("/project")).rejects.toThrow("Docker not running");

			// Session was closed in DB after failure.
			expect(sessionManager.close).toHaveBeenCalledWith("sess-001");
			// Container stop attempted.
			expect(containerRunner.stop).toHaveBeenCalledWith("sess-001");
			// Not marked as active.
			expect(orchestrator.isActive("sess-001")).toBe(false);
		});

		it("cleans up on agent connect failure", async () => {
			(agentProcessManager.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Failed to get agent process stdio"),
			);

			await expect(orchestrator.newSession("/project")).rejects.toThrow(
				"Failed to get agent process stdio",
			);

			expect(sessionManager.close).toHaveBeenCalledWith("sess-001");
			expect(containerRunner.stop).toHaveBeenCalledWith("sess-001");
		});

		it("throws when at capacity", async () => {
			// Build orchestrator with maxConcurrent = 1.
			const limitedConfig = { ...stubConfig, maxConcurrent: 1 };
			const limited = new SessionOrchestrator(
				limitedConfig,
				db as unknown as Database,
				sessionManager as unknown as SessionManager,
				containerRunner as unknown as ContainerRunner,
				agentProcessManager as unknown as AgentProcessManager,
			);

			await limited.newSession("/project");

			// Second session should be rejected.
			await expect(limited.newSession("/project2")).rejects.toThrow(
				"At capacity: 1/1 concurrent sessions",
			);
		});

		it("passes mcpServers to sessionManager.create", async () => {
			const mcpServers = [{ name: "test", command: "test-cmd" }];
			await orchestrator.newSession("/project", mcpServers);

			expect(sessionManager.create).toHaveBeenCalledWith("/project", {
				mcpServers: [{ name: "test", command: "test-cmd" }],
			});
		});

		it("works without mcpServers (backward compatible)", async () => {
			await orchestrator.newSession("/project");

			expect(sessionManager.create).toHaveBeenCalledWith("/project", undefined);
		});

		it("allows new session after closing one at capacity", async () => {
			// Build orchestrator with maxConcurrent = 1.
			const limitedConfig = { ...stubConfig, maxConcurrent: 1 };
			const limited = new SessionOrchestrator(
				limitedConfig,
				db as unknown as Database,
				sessionManager as unknown as SessionManager,
				containerRunner as unknown as ContainerRunner,
				agentProcessManager as unknown as AgentProcessManager,
			);

			await limited.newSession("/project");

			// Close the session to free the slot.
			await limited.closeSession("sess-001");

			// Set up mocks for the second session with a different ID.
			(sessionManager.create as ReturnType<typeof vi.fn>).mockReturnValue({
				sessionId: "sess-002",
				folder: "/tmp/swapclaw/sessions/sess-002",
			});

			// Should succeed now.
			const newId = await limited.newSession("/project2");
			expect(newId).toBe("sess-002");
		});
	});

	// -----------------------------------------------------------
	// prompt()
	// -----------------------------------------------------------

	describe("prompt", () => {
		it("forwards prompt to agent and returns response", async () => {
			await orchestrator.newSession("/project");

			const result = await orchestrator.prompt("sess-001", [{ type: "text", text: "Hello agent" }]);

			// The mock connection's prompt was called.
			const mockConn = (agentProcessManager.connect as ReturnType<typeof vi.fn>).mock.results[0]
				.value;
			const conn = await mockConn;
			expect(conn.connection.prompt).toHaveBeenCalledWith({
				sessionId: "agent-sess-001",
				prompt: [{ type: "text", text: "Hello agent" }],
			});
			expect(result.stopReason).toBe("end_turn");
		});

		it("persists user message to database", async () => {
			await orchestrator.newSession("/project");

			await orchestrator.prompt("sess-001", [{ type: "text", text: "What is 2+2?" }]);

			expect(db.addMessage).toHaveBeenCalledWith("sess-001", "user", "What is 2+2?");
		});

		it("persists assistant response collected from message collector", async () => {
			// Override connect to return a connection with pre-populated collector
			// that gets filled during prompt.
			const mockConnection = {
				prompt: vi.fn(async () => {
					// Simulate agent filling messageCollector during prompt.
					agentConn.messageCollector.push("The answer ", "is 4.");
					return { stopReason: "end_turn" as const };
				}),
				cancel: vi.fn().mockResolvedValue(undefined),
			} as unknown as acp.ClientSideConnection;

			const agentConn = createMockAgentConnection({ connection: mockConnection });

			(agentProcessManager.connect as ReturnType<typeof vi.fn>).mockResolvedValue(agentConn);

			await orchestrator.newSession("/project");
			await orchestrator.prompt("sess-001", [{ type: "text", text: "2+2?" }]);

			// Assistant message should be aggregated and persisted.
			expect(db.addMessage).toHaveBeenCalledWith("sess-001", "assistant", "The answer is 4.");
		});

		it("resets idle timer on prompt", async () => {
			await orchestrator.newSession("/project");

			await orchestrator.prompt("sess-001", [{ type: "text", text: "hello" }]);

			expect(containerRunner.resetIdleTimer).toHaveBeenCalledWith("sess-001");
		});

		it("throws when session is not active", async () => {
			await expect(
				orchestrator.prompt("nonexistent", [{ type: "text", text: "hi" }]),
			).rejects.toThrow("No active session: nonexistent");
		});

		it("concatenates text from multiple content blocks for user message", async () => {
			await orchestrator.newSession("/project");

			await orchestrator.prompt("sess-001", [
				{ type: "text", text: "Part 1. " },
				{ type: "text", text: "Part 2." },
			]);

			expect(db.addMessage).toHaveBeenCalledWith("sess-001", "user", "Part 1. Part 2.");
		});

		it("does not persist empty assistant response", async () => {
			await orchestrator.newSession("/project");

			await orchestrator.prompt("sess-001", [{ type: "text", text: "hello" }]);

			// Only user message persisted (no agent_message_chunk received).
			const addMessageCalls = (db.addMessage as ReturnType<typeof vi.fn>).mock.calls;
			expect(addMessageCalls).toHaveLength(1);
			expect(addMessageCalls[0][1]).toBe("user");
		});
	});

	// -----------------------------------------------------------
	// closeSession()
	// -----------------------------------------------------------

	describe("closeSession", () => {
		it("disconnects agent, stops container, and closes session", async () => {
			await orchestrator.newSession("/project");

			await orchestrator.closeSession("sess-001");

			// Agent disconnected.
			expect(agentProcessManager.disconnect).toHaveBeenCalledTimes(1);

			// Container stopped.
			expect(containerRunner.stop).toHaveBeenCalledWith("sess-001");

			// Session closed in DB.
			expect(sessionManager.close).toHaveBeenCalledWith("sess-001");

			// No longer active.
			expect(orchestrator.isActive("sess-001")).toBe(false);
		});

		it("handles non-active session (just stops container and closes DB)", async () => {
			// Never started, so no active session entry.
			await orchestrator.closeSession("unknown-session");

			// disconnect should NOT be called (no active session).
			expect(agentProcessManager.disconnect).not.toHaveBeenCalled();

			expect(containerRunner.stop).toHaveBeenCalledWith("unknown-session");
			expect(sessionManager.close).toHaveBeenCalledWith("unknown-session");
		});
	});

	// -----------------------------------------------------------
	// loadSession()
	// -----------------------------------------------------------

	describe("loadSession", () => {
		it("delegates to sessionManager.load", () => {
			const info = orchestrator.loadSession("sess-001");

			expect(sessionManager.load).toHaveBeenCalledWith("sess-001");
			expect(info.sessionId).toBe("sess-001");
		});
	});

	// -----------------------------------------------------------
	// getMessages()
	// -----------------------------------------------------------

	describe("getMessages", () => {
		it("delegates to db.getMessages and returns messages in order", () => {
			const messages = [
				{
					id: 1,
					session_id: "sess-001",
					role: "user",
					content: "Hello",
					created_at: "2026-01-01T00:00:00.000Z",
				},
				{
					id: 2,
					session_id: "sess-001",
					role: "assistant",
					content: "Hi there",
					created_at: "2026-01-01T00:00:01.000Z",
				},
			];
			(db.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(messages);

			const result = orchestrator.getMessages("sess-001");

			expect(db.getMessages).toHaveBeenCalledWith("sess-001");
			expect(result).toEqual(messages);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("assistant");
		});

		it("returns empty array when no messages exist", () => {
			(db.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([]);

			const result = orchestrator.getMessages("sess-001");

			expect(db.getMessages).toHaveBeenCalledWith("sess-001");
			expect(result).toEqual([]);
		});
	});

	// -----------------------------------------------------------
	// listSessions()
	// -----------------------------------------------------------

	describe("listSessions", () => {
		it("delegates to sessionManager.list without filter", () => {
			orchestrator.listSessions();
			expect(sessionManager.list).toHaveBeenCalledWith(undefined);
		});

		it("delegates to sessionManager.list with cwd filter", () => {
			orchestrator.listSessions("/project");
			expect(sessionManager.list).toHaveBeenCalledWith("/project");
		});
	});

	// -----------------------------------------------------------
	// shutdown()
	// -----------------------------------------------------------

	describe("shutdown", () => {
		it("closes all active sessions", async () => {
			let sessionCounter = 0;
			(sessionManager.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
				sessionCounter++;
				return {
					sessionId: `sess-${sessionCounter}`,
					folder: `/tmp/swapclaw/sessions/sess-${sessionCounter}`,
				};
			});

			let containerCounter = 0;
			(containerRunner.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
				containerCounter++;
				return Promise.resolve({
					containerId: `container-${containerCounter}`,
					containerName: `swapclaw-sess-${containerCounter}`,
					startedAt: new Date(),
				});
			});

			await orchestrator.newSession("/project1");
			await orchestrator.newSession("/project2");

			expect(orchestrator.isActive("sess-1")).toBe(true);
			expect(orchestrator.isActive("sess-2")).toBe(true);

			await orchestrator.shutdown();

			expect(orchestrator.isActive("sess-1")).toBe(false);
			expect(orchestrator.isActive("sess-2")).toBe(false);

			// Both containers stopped.
			expect(containerRunner.stop).toHaveBeenCalledWith("sess-1");
			expect(containerRunner.stop).toHaveBeenCalledWith("sess-2");

			// Both sessions closed.
			expect(sessionManager.close).toHaveBeenCalledWith("sess-1");
			expect(sessionManager.close).toHaveBeenCalledWith("sess-2");

			// Both agents disconnected.
			expect(agentProcessManager.disconnect).toHaveBeenCalledTimes(2);
		});

		it("is a no-op when no active sessions", async () => {
			await orchestrator.shutdown();
			expect(containerRunner.stop).not.toHaveBeenCalled();
			expect(sessionManager.close).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------
	// getMode() / setMode()
	// -----------------------------------------------------------

	describe("getMode", () => {
		it("delegates to sessionManager.getMode", () => {
			(sessionManager.getMode as ReturnType<typeof vi.fn>).mockReturnValue("ask");
			const mode = orchestrator.getMode("sess-001");
			expect(sessionManager.getMode).toHaveBeenCalledWith("sess-001");
			expect(mode).toBe("ask");
		});
	});

	describe("setMode", () => {
		it("delegates to sessionManager.setMode", () => {
			orchestrator.setMode("sess-001", "architect");
			expect(sessionManager.setMode).toHaveBeenCalledWith("sess-001", "architect");
		});

		it("throws for invalid mode", () => {
			expect(() => orchestrator.setMode("sess-001", "invalid")).toThrow(
				"Invalid session mode: invalid",
			);
			expect(sessionManager.setMode).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------
	// isActive()
	// -----------------------------------------------------------

	describe("isActive", () => {
		it("returns false for unknown session", () => {
			expect(orchestrator.isActive("unknown")).toBe(false);
		});

		it("returns true after newSession", async () => {
			await orchestrator.newSession("/project");
			expect(orchestrator.isActive("sess-001")).toBe(true);
		});

		it("returns false after closeSession", async () => {
			await orchestrator.newSession("/project");
			await orchestrator.closeSession("sess-001");
			expect(orchestrator.isActive("sess-001")).toBe(false);
		});
	});

	// -----------------------------------------------------------
	// session update forwarding
	// -----------------------------------------------------------

	describe("session update forwarding", () => {
		it("forwards session updates to forwarder callback", async () => {
			const forwarderSpy = vi.fn();
			orchestrator.setSessionUpdateForwarder(forwarderSpy);

			await orchestrator.newSession("/project");

			// Trigger the captured onUpdate callback (simulating the agent
			// sending an update through AgentProcessManager).
			expect(capturedOnUpdate).toBeDefined();
			const fakeUpdate = {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello" },
			} as acp.SessionUpdate;

			capturedOnUpdate?.(fakeUpdate);

			expect(forwarderSpy).toHaveBeenCalledOnce();
			expect(forwarderSpy).toHaveBeenCalledWith("sess-001", fakeUpdate);
		});

		it("no error when forwarder is not set", async () => {
			// Do NOT call setSessionUpdateForwarder — forwarder is undefined.
			await orchestrator.newSession("/project");

			// Trigger a session update through the captured onUpdate.
			expect(capturedOnUpdate).toBeDefined();
			expect(() => {
				capturedOnUpdate?.({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "no forwarder" },
				} as acp.SessionUpdate);
			}).not.toThrow();
		});
	});
});
