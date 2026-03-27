import { EventEmitter } from "node:events";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerExec } from "../src/container-exec.js";

// ---------------------------------------------------------------------------
// Mock modules
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
import type { SessionUpdateHandler, SwapClawClient } from "../src/acp-client.js";
import { AgentProcessManager, type ClientFactory } from "../src/agent-process-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Create a mock ClientSideConnection. */
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

/** Mock client factory and captured handler. */
let mockClientFactory: ReturnType<typeof vi.fn>;
let mockCleanup: ReturnType<typeof vi.fn>;
let capturedHandler: SessionUpdateHandler | undefined;

function createMockClientFactory() {
	mockCleanup = vi.fn();
	capturedHandler = undefined;
	mockClientFactory = vi.fn(
		(_containerId: string, _exec: ContainerExec, handler?: SessionUpdateHandler) => {
			capturedHandler = handler;
			return {
				cleanup: mockCleanup,
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
			} as unknown as SwapClawClient;
		},
	);
	return mockClientFactory as unknown as ClientFactory;
}

/** Set up all mocks for a successful connect flow. */
function setupConnectMocks() {
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

describe("AgentProcessManager", () => {
	let manager: AgentProcessManager;

	beforeEach(() => {
		vi.clearAllMocks();
		const clientFactory = createMockClientFactory();
		const stubExec: ContainerExec = { spawn: vi.fn() };
		manager = new AgentProcessManager("test-agent", ["--acp"], stubExec, clientFactory);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// connect()
	// -----------------------------------------------------------

	describe("connect", () => {
		it("spawns agent, creates stream, initializes connection, and creates session", async () => {
			const { agentProc, mockConnection } = setupConnectMocks();

			const conn = await manager.connect("container-001", "/project");

			// Agent spawned.
			expect(spawn).toHaveBeenCalledWith("test-agent", ["--acp"], {
				stdio: ["pipe", "pipe", "inherit"],
			});

			// Stream created.
			expect(Writable.toWeb).toHaveBeenCalledWith(agentProc.stdin);
			expect(Readable.toWeb).toHaveBeenCalledWith(agentProc.stdout);
			expect(acpMock.ndJsonStream).toHaveBeenCalledWith("mock-writable", "mock-readable");

			// SwapClawClient created with container ID and exec.
			expect(mockClientFactory).toHaveBeenCalledWith(
				"container-001",
				expect.objectContaining({ spawn: expect.any(Function) }),
				expect.any(Function),
			);

			// Connection initialized.
			expect(mockConnection.initialize).toHaveBeenCalledWith({
				protocolVersion: 1,
				clientCapabilities: {
					terminal: true,
					fs: {
						readTextFile: true,
						writeTextFile: true,
					},
				},
			});

			// Agent session created.
			expect(mockConnection.newSession).toHaveBeenCalledWith({
				cwd: "/project",
				mcpServers: [],
			});

			// Returns correct agent connection state.
			expect(conn.agentSessionId).toBe("agent-sess-001");
			expect(conn.agentProcess).toBe(agentProc);
			expect(conn.connection).toBe(mockConnection);
			expect(conn.messageCollector).toEqual([]);
		});

		it("throws and kills process when stdio is unavailable", async () => {
			const brokenProc = createMockAgentProcess();
			// @ts-expect-error - simulating broken stdio
			brokenProc.stdin = null;
			(spawn as ReturnType<typeof vi.fn>).mockReturnValue(brokenProc);

			await expect(manager.connect("container-001", "/project")).rejects.toThrow(
				"Failed to get agent process stdio",
			);

			expect(brokenProc.kill).toHaveBeenCalled();
		});

		it("throws on connection initialize failure", async () => {
			const { mockConnection } = setupConnectMocks();
			mockConnection.initialize.mockRejectedValue(new Error("Protocol mismatch"));

			await expect(manager.connect("container-001", "/project")).rejects.toThrow(
				"Protocol mismatch",
			);
		});

		it("throws on agent newSession failure", async () => {
			const { mockConnection } = setupConnectMocks();
			mockConnection.newSession.mockRejectedValue(new Error("Agent rejected session"));

			await expect(manager.connect("container-001", "/project")).rejects.toThrow(
				"Agent rejected session",
			);
		});

		it("collects text chunks into messageCollector", async () => {
			setupConnectMocks();

			const conn = await manager.connect("container-001", "/project");

			// Simulate agent sending text chunks via the captured handler.
			expect(capturedHandler).toBeDefined();
			capturedHandler?.({
				sessionId: "agent-sess-001",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Hello " },
				} as acp.SessionUpdate,
			});
			capturedHandler?.({
				sessionId: "agent-sess-001",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "World" },
				} as acp.SessionUpdate,
			});

			expect(conn.messageCollector).toEqual(["Hello ", "World"]);
		});

		it("calls onUpdate callback for session updates", async () => {
			setupConnectMocks();

			const onUpdate = vi.fn();
			await manager.connect("container-001", "/project", onUpdate);

			// Simulate agent sending update via the captured handler.
			expect(capturedHandler).toBeDefined();
			const fakeUpdate = {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello" },
			} as acp.SessionUpdate;

			capturedHandler?.({
				sessionId: "agent-sess-001",
				update: fakeUpdate,
			});

			expect(onUpdate).toHaveBeenCalledWith(fakeUpdate);
		});

		it("works without onUpdate callback", async () => {
			setupConnectMocks();

			const conn = await manager.connect("container-001", "/project");

			// Trigger a session update without onUpdate — should not throw.
			expect(capturedHandler).toBeDefined();
			expect(() => {
				capturedHandler?.({
					sessionId: "agent-sess-001",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "no callback" },
					} as acp.SessionUpdate,
				});
			}).not.toThrow();

			// Still collects into messageCollector.
			expect(conn.messageCollector).toEqual(["no callback"]);
		});
	});

	// -----------------------------------------------------------
	// disconnect()
	// -----------------------------------------------------------

	describe("disconnect", () => {
		it("cancels prompt, cleans up client, and kills process", async () => {
			const { agentProc, mockConnection } = setupConnectMocks();

			const conn = await manager.connect("container-001", "/project");

			manager.disconnect(conn);

			// Cancel sent (fire-and-forget).
			expect(mockConnection.cancel).toHaveBeenCalledWith({
				sessionId: "agent-sess-001",
			});

			// Client cleaned up.
			expect(mockCleanup).toHaveBeenCalled();

			// Agent killed.
			expect(agentProc.kill).toHaveBeenCalled();
		});

		it("does not kill already-killed process", async () => {
			const { agentProc } = setupConnectMocks();

			const conn = await manager.connect("container-001", "/project");

			// Simulate process already killed.
			agentProc.killed = true;
			agentProc.kill.mockClear();

			manager.disconnect(conn);

			// kill() should not be called again.
			expect(agentProc.kill).not.toHaveBeenCalled();
		});

		it("handles cancel error gracefully", async () => {
			const { mockConnection } = setupConnectMocks();

			const conn = await manager.connect("container-001", "/project");

			// Make cancel throw synchronously.
			mockConnection.cancel.mockImplementation(() => {
				throw new Error("No active prompt");
			});

			// Should not throw.
			expect(() => manager.disconnect(conn)).not.toThrow();

			// Still cleaned up.
			expect(mockCleanup).toHaveBeenCalled();
		});
	});
});
