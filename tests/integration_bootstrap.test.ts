import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdateHandler, SwapClawClient } from "../src/acp-client.js";
import { AgentProcessManager } from "../src/agent-process-manager.js";
import type { Config } from "../src/config.js";
import type { ContainerExec } from "../src/container-exec.js";
import { ContainerRunner } from "../src/container-runner.js";
import type { ContainerRuntime, SpawnOpts, SpawnResult } from "../src/container-runtime.js";
import { Database } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";
import { SessionOrchestrator } from "../src/session-orchestrator.js";
import { SessionScaffolder } from "../src/session-scaffolder.js";

// ---------------------------------------------------------------------------
// Mock ContainerRuntime — no Docker needed
// ---------------------------------------------------------------------------

function createMockRuntime(): ContainerRuntime {
	return {
		ensureRunning: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		spawn: vi.fn<(opts: SpawnOpts) => Promise<SpawnResult>>().mockResolvedValue({
			containerId: "mock-ctr-001",
		}),
		stop: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
		remove: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
		isRunning: vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true),
	};
}

// ---------------------------------------------------------------------------
// Mock SwapClawClient factory — no-op terminal/FS methods
// ---------------------------------------------------------------------------

function createMockClientFactory() {
	const factory = vi.fn(
		(_containerId: string, _exec: ContainerExec, handler?: SessionUpdateHandler) => {
			return {
				cleanup: vi.fn(),
				requestPermission: vi
					.fn()
					.mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow_once" } }),
				sessionUpdate: vi.fn(async (params: unknown) => {
					if (handler) {
						await handler(params as Parameters<SessionUpdateHandler>[0]);
					}
				}),
				createTerminal: vi.fn().mockResolvedValue({ id: "term-noop" }),
				terminalOutput: vi.fn().mockResolvedValue({ output: "", truncated: false }),
				waitForTerminalExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
				killTerminal: vi.fn().mockResolvedValue({}),
				releaseTerminal: vi.fn().mockResolvedValue({}),
				readTextFile: vi.fn().mockResolvedValue({ content: "" }),
				writeTextFile: vi.fn().mockResolvedValue({}),
				extMethod: vi.fn().mockResolvedValue({}),
				extNotification: vi.fn().mockResolvedValue(undefined),
			} as unknown as SwapClawClient;
		},
	);
	return factory;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Integration: bootstrap to prompt flow", () => {
	let tmpDir: string;
	let config: Config;
	let db: Database;
	let mockRuntime: ContainerRuntime;
	let runner: ContainerRunner;
	let sessionManager: SessionManager;
	let orchestrator: SessionOrchestrator;

	beforeEach(() => {
		// Create temp directory structure.
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-integ-"));
		const dataDir = path.join(tmpDir, "data");
		const sessionsDir = path.join(dataDir, "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });

		config = {
			dataDir,
			containerImage: "alpine:latest",
			containerTimeout: 300_000,
			idleTimeout: 60_000,
			maxConcurrent: 3,
			timezone: "UTC",
			sessionsDir,
			dbPath: path.join(dataDir, "swapclaw.db"),
			agentCommand: "bun",
			agentArgs: ["run", "tests/_mock_agent.ts"],
		};

		// Real in-memory DB.
		db = Database.inMemory();

		// Mock runtime, real runner.
		mockRuntime = createMockRuntime();
		runner = new ContainerRunner(config, mockRuntime);

		// Real session manager.
		sessionManager = new SessionManager(config, db, new SessionScaffolder());

		// Orchestrator with real agent process + mock client factory.
		const mockClientFactory = createMockClientFactory();
		const stubExec: ContainerExec = { spawn: vi.fn() };
		const agentProcessManager = new AgentProcessManager(
			config.agentCommand,
			config.agentArgs,
			stubExec,
			mockClientFactory,
		);
		orchestrator = new SessionOrchestrator(config, db, sessionManager, runner, agentProcessManager);
	});

	afterEach(async () => {
		// Shut down orchestrator (kills agent processes, cleans up).
		try {
			await orchestrator.shutdown();
		} catch {
			// Best effort.
		}

		// Close DB.
		try {
			db.close();
		} catch {
			// Best effort.
		}

		// Remove temp dir.
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	});

	// -------------------------------------------------------------------
	// Scenario 1: Full lifecycle
	// -------------------------------------------------------------------

	it(
		"full lifecycle: newSession -> prompt -> closeSession -> DB state is closed",
		async () => {
			// 1. Create session.
			const sessionId = await orchestrator.newSession(tmpDir);
			expect(sessionId).toBeTruthy();
			expect(orchestrator.isActive(sessionId)).toBe(true);

			// Verify container runtime was called.
			expect(mockRuntime.spawn).toHaveBeenCalledTimes(1);

			// 2. Send prompt.
			const response = await orchestrator.prompt(sessionId, [{ type: "text", text: "echo hello" }]);
			expect(response.stopReason).toBe("end_turn");

			// 3. Close session.
			await orchestrator.closeSession(sessionId);
			expect(orchestrator.isActive(sessionId)).toBe(false);

			// 4. Verify DB state.
			const row = db.getSession(sessionId);
			expect(row).not.toBeNull();
			expect(row?.state).toBe("closed");
		},
		{ timeout: 30_000 },
	);

	// -------------------------------------------------------------------
	// Scenario 2: Message persistence
	// -------------------------------------------------------------------

	it(
		"messages are persisted: user message and assistant response in DB",
		async () => {
			const sessionId = await orchestrator.newSession(tmpDir);

			// Send echo command — agent echoes back via sessionUpdate.
			await orchestrator.prompt(sessionId, [{ type: "text", text: "echo hello" }]);

			// Check persisted messages.
			const messages = db.getMessages(sessionId);
			expect(messages.length).toBeGreaterThanOrEqual(2);

			// First message: user's prompt.
			const userMsg = messages.find((m) => m.role === "user");
			expect(userMsg).toBeDefined();
			expect(userMsg?.content).toBe("echo hello");

			// Second message: assistant's response (contains "Echo: hello").
			const assistantMsg = messages.find((m) => m.role === "assistant");
			expect(assistantMsg).toBeDefined();
			expect(assistantMsg?.content).toContain("Echo: hello");

			// Clean up.
			await orchestrator.closeSession(sessionId);
		},
		{ timeout: 30_000 },
	);

	// -------------------------------------------------------------------
	// Scenario 3: Shutdown
	// -------------------------------------------------------------------

	it(
		"shutdown deactivates all sessions",
		async () => {
			const sessionId = await orchestrator.newSession(tmpDir);
			expect(orchestrator.isActive(sessionId)).toBe(true);

			// Shutdown all.
			await orchestrator.shutdown();

			// Session is no longer active.
			expect(orchestrator.isActive(sessionId)).toBe(false);
		},
		{ timeout: 30_000 },
	);
});
