/**
 * Integration tests for error paths.
 *
 * Uses real Database (in-memory), real SessionManager, real ContainerRunner
 * with a mock ContainerRuntime. The ACP SDK and child_process are mocked
 * since they require a real agent process and ACP handshake.
 *
 * Verifies that failures propagate correctly across real component boundaries:
 * orchestrator -> session manager -> DB, orchestrator -> container runner -> runtime.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock modules (external boundaries only — internal modules stay real)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

vi.mock("node:stream", () => ({
	Writable: { toWeb: vi.fn() },
	Readable: { toWeb: vi.fn() },
}));

vi.mock("@agentclientprotocol/sdk", () => ({
	ndJsonStream: vi.fn(),
	ClientSideConnection: vi.fn(),
	PROTOCOL_VERSION: 1,
}));

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acpMock from "@agentclientprotocol/sdk";
import type { SessionUpdateHandler } from "../src/acp-client.js";
import { AgentProcessManager, type ClientFactory } from "../src/agent-process-manager.js";
import type { Config } from "../src/config.js";
import type { ContainerExec } from "../src/container-exec.js";
import { ContainerRunner } from "../src/container-runner.js";
import type { ContainerRuntime, SpawnOpts, SpawnResult } from "../src/container-runtime.js";
import { Database } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";
import { SessionOrchestrator } from "../src/session-orchestrator.js";
import { SessionScaffolder } from "../src/session-scaffolder.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Temporary directories to clean up after all tests. */
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-int-errors-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** Build a Config pointing at a temp data directory. */
function makeConfig(dataDir: string, overrides?: Partial<Config>): Config {
	return {
		dataDir,
		containerImage: "alpine:latest",
		containerTimeout: 300_000,
		idleTimeout: 60_000,
		maxConcurrent: 3,
		timezone: "UTC",
		agentCommand: "test-agent",
		agentArgs: [],
		sessionsDir: path.join(dataDir, "sessions"),
		dbPath: path.join(dataDir, "swapclaw.db"),
		...overrides,
	};
}

/** Create a mock ContainerRuntime that succeeds by default. */
function makeMockRuntime(): ContainerRuntime {
	return {
		ensureRunning: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		spawn: vi.fn<(opts: SpawnOpts) => Promise<SpawnResult>>().mockImplementation(async (opts) => ({
			containerId: opts.name,
		})),
		stop: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
		remove: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
		isRunning: vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true),
	};
}

/** Create a fake ChildProcess with stdin/stdout. */
function createMockAgentProcess() {
	const proc = new EventEmitter() as EventEmitter & {
		stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		killed: boolean;
		kill: ReturnType<typeof vi.fn>;
	};
	proc.stdin = { write: vi.fn(), end: vi.fn() };
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 99999;
	proc.killed = false;
	proc.kill = vi.fn(() => {
		proc.killed = true;
	});
	return proc;
}

/** Create a mock ACP ClientSideConnection. */
function createMockConnection() {
	return {
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
	};
}

const stubExec: ContainerExec = { spawn: vi.fn() };

/** Create a mock ClientFactory returning a no-op SwapClawClient. */
function makeMockClientFactory(): ClientFactory {
	return vi.fn((_containerId: string, _exec: ContainerExec, _handler?: SessionUpdateHandler) => ({
		cleanup: vi.fn(),
		requestPermission: vi.fn(),
		sessionUpdate: vi.fn(),
		createTerminal: vi.fn(),
		terminalOutput: vi.fn(),
		waitForTerminalExit: vi.fn(),
		killTerminal: vi.fn(),
		releaseTerminal: vi.fn(),
		readTextFile: vi.fn(),
		writeTextFile: vi.fn(),
		extMethod: vi.fn(),
		extNotification: vi.fn(),
	})) as unknown as ClientFactory;
}

/** Wire up all mocks for a successful newSession flow. */
function setupNewSessionMocks() {
	const agentProc = createMockAgentProcess();
	(spawn as ReturnType<typeof vi.fn>).mockReturnValue(agentProc);

	(Writable.toWeb as ReturnType<typeof vi.fn>).mockReturnValue("mock-writable");
	(Readable.toWeb as ReturnType<typeof vi.fn>).mockReturnValue("mock-readable");
	(acpMock.ndJsonStream as ReturnType<typeof vi.fn>).mockReturnValue("mock-stream");

	const mockConnection = createMockConnection();
	(acpMock.ClientSideConnection as unknown as ReturnType<typeof vi.fn>).mockImplementation(
		(toClientFn: (agent: acp.Agent) => acp.Client) => {
			const fakeAgent = {} as acp.Agent;
			toClientFn(fakeAgent);
			return mockConnection;
		},
	);

	return { agentProc, mockConnection };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: error paths", () => {
	let dataDir: string;
	let config: Config;
	let db: Database;
	let sessionManager: SessionManager;
	let mockRuntime: ContainerRuntime;
	let runner: ContainerRunner;

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.clearAllMocks();

		dataDir = makeTempDir();
		config = makeConfig(dataDir);

		// Ensure sessions directory exists for SessionManager.
		fs.mkdirSync(config.sessionsDir, { recursive: true });

		db = Database.inMemory();
		sessionManager = new SessionManager(config, db, new SessionScaffolder());
		mockRuntime = makeMockRuntime();
		runner = new ContainerRunner(config, mockRuntime);
	});

	afterEach(() => {
		vi.useRealTimers();
		db.close();
	});

	// -----------------------------------------------------------------------
	// Scenario 1: Container spawn fails -> session creation rolls back
	// -----------------------------------------------------------------------

	describe("container spawn fails -> session creation rolls back", () => {
		it("rejects with the runtime error", async () => {
			(mockRuntime.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Docker not available"),
			);

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			await expect(orchestrator.newSession("/tmp")).rejects.toThrow("Docker not available");
		});

		it("closes the session in DB after spawn failure", async () => {
			(mockRuntime.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Docker not available"),
			);

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			await orchestrator.newSession("/tmp").catch(() => {});

			// Session was created then closed by the error handler.
			const allSessions = db.listSessions();
			expect(allSessions.length).toBe(1);
			expect(allSessions[0].state).toBe("closed");
		});

		it("does not leave an active session entry after spawn failure", async () => {
			(mockRuntime.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Docker not available"),
			);

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			await orchestrator.newSession("/tmp").catch(() => {});

			// Find the session ID from DB to check isActive.
			const allSessions = db.listSessions();
			expect(orchestrator.isActive(allSessions[0].id)).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// Scenario 2: At capacity -> rejects, then frees slot
	// -----------------------------------------------------------------------

	describe("at capacity -> rejects, then frees slot", () => {
		it("rejects second session when at max capacity", async () => {
			const limitedConfig = makeConfig(dataDir, { maxConcurrent: 1 });
			const limitedRunner = new ContainerRunner(limitedConfig, mockRuntime);

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				limitedConfig,
				db,
				sessionManager,
				limitedRunner,
				agentProcessManager,
			);

			setupNewSessionMocks();
			const firstId = await orchestrator.newSession("/tmp");
			expect(firstId).toBeDefined();

			// Second session should be rejected.
			await expect(orchestrator.newSession("/tmp2")).rejects.toThrow(
				"At capacity: 1/1 concurrent sessions",
			);
		});

		it("accepts a new session after closing the first", async () => {
			const limitedConfig = makeConfig(dataDir, { maxConcurrent: 1 });
			const limitedRunner = new ContainerRunner(limitedConfig, mockRuntime);

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				limitedConfig,
				db,
				sessionManager,
				limitedRunner,
				agentProcessManager,
			);

			setupNewSessionMocks();
			const firstId = await orchestrator.newSession("/tmp");

			// Close the session to free the slot.
			await orchestrator.closeSession(firstId);

			// New session should succeed now.
			setupNewSessionMocks();
			const thirdId = await orchestrator.newSession("/tmp3");
			expect(thirdId).toBeDefined();
			expect(thirdId).not.toBe(firstId);
		});
	});

	// -----------------------------------------------------------------------
	// Scenario 3: Double-close session -> idempotent
	// -----------------------------------------------------------------------

	describe("double-close session -> idempotent", () => {
		it("first close succeeds", async () => {
			setupNewSessionMocks();

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			const sessionId = await orchestrator.newSession("/tmp");

			// First close should succeed.
			await expect(orchestrator.closeSession(sessionId)).resolves.toBeUndefined();
		});

		it("second close does not throw", async () => {
			setupNewSessionMocks();

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			const sessionId = await orchestrator.newSession("/tmp");

			await orchestrator.closeSession(sessionId);
			// Second close should also not throw.
			await expect(orchestrator.closeSession(sessionId)).resolves.toBeUndefined();
		});

		it("session remains closed in DB after double close", async () => {
			setupNewSessionMocks();

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			const sessionId = await orchestrator.newSession("/tmp");

			await orchestrator.closeSession(sessionId);
			await orchestrator.closeSession(sessionId);

			// Verify DB state is "closed".
			const row = db.getSession(sessionId);
			expect(row).not.toBeNull();
			expect(row?.state).toBe("closed");
		});
	});

	// -----------------------------------------------------------------------
	// Scenario 4: Agent connection fails mid-prompt -> prompt rejects
	// -----------------------------------------------------------------------

	describe("agent connection fails mid-prompt -> prompt rejects", () => {
		it("rejects prompt when connection.prompt throws", async () => {
			const { mockConnection } = setupNewSessionMocks();

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			const sessionId = await orchestrator.newSession("/tmp");

			// Simulate the agent process crashing: the ACP connection rejects
			// the prompt call with a stream error.
			mockConnection.prompt.mockRejectedValue(new Error("Connection closed: stream ended"));

			await expect(
				orchestrator.prompt(sessionId, [{ type: "text", text: "hello" }]),
			).rejects.toThrow("Connection closed: stream ended");
		});

		it("closeSession still works after a failed prompt", async () => {
			const { mockConnection } = setupNewSessionMocks();

			const agentProcessManager = new AgentProcessManager(
				"test-agent",
				[],
				stubExec,
				makeMockClientFactory(),
			);
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				agentProcessManager,
			);

			const sessionId = await orchestrator.newSession("/tmp");

			// Simulate connection failure on prompt.
			mockConnection.prompt.mockRejectedValue(new Error("Connection closed: stream ended"));

			await orchestrator.prompt(sessionId, [{ type: "text", text: "hello" }]).catch(() => {});

			// closeSession should still work without throwing.
			await expect(orchestrator.closeSession(sessionId)).resolves.toBeUndefined();

			// Session no longer active.
			expect(orchestrator.isActive(sessionId)).toBe(false);

			// Session closed in DB.
			const row = db.getSession(sessionId);
			expect(row).not.toBeNull();
			expect(row?.state).toBe("closed");
		});
	});
});
