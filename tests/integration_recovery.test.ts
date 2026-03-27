import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProcessManager } from "../src/agent-process-manager.js";
import type { Config } from "../src/config.js";
import { ContainerRunner } from "../src/container-runner.js";
import type { ContainerRuntime } from "../src/container-runtime.js";
import { recoverStaleContainers } from "../src/crash-recovery.js";
import { Database } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";
import { SessionOrchestrator } from "../src/session-orchestrator.js";
import { SessionScaffolder } from "../src/session-scaffolder.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a minimal mock ContainerRuntime where isRunning is controllable. */
function mockRuntime(runningIds: Set<string>): ContainerRuntime {
	return {
		ensureRunning: vi.fn(),
		spawn: vi.fn(),
		stop: vi.fn(),
		remove: vi.fn(),
		isRunning: vi.fn(async (id: string) => runningIds.has(id)),
	};
}

/** Build a minimal Config pointing at temp dirs. */
function testConfig(): Config {
	return {
		dataDir: "/tmp/swapclaw-test",
		sessionsDir: "/tmp/swapclaw-test/sessions",
		dbPath: ":memory:",
		containerImage: "alpine:latest",
		containerTimeout: 300_000,
		idleTimeout: 60_000,
		maxConcurrent: 5,
		timezone: "UTC",
		agentCommand: "echo",
		agentArgs: [],
	};
}

// ── Integration test ────────────────────────────────────────────────

describe("integration: crash recovery on restart", () => {
	let db: Database;
	const now = new Date().toISOString();

	beforeEach(() => {
		db = Database.inMemory();
	});

	afterEach(() => {
		db.close();
	});

	it(
		"recovers stale sessions after simulated crash and allows fresh orchestrator start",
		{ timeout: 10_000 },
		async () => {
			// Suppress crash-recovery log output.
			vi.spyOn(console, "error").mockImplementation(() => {});

			// ── Step 1: Seed DB state (simulating state left after a crash) ──

			db.createSession("s1", "/project1");
			db.createSession("s2", "/project2");

			db.setContainerState("s1", {
				container_id: "ctr-1",
				runtime: "docker",
				status: "running",
				started_at: now,
			});

			db.setContainerState("s2", {
				container_id: "ctr-2",
				runtime: "docker",
				status: "running",
				started_at: now,
			});

			// Verify the pre-crash state is as expected.
			expect(db.getSession("s1")?.state).toBe("active");
			expect(db.getSession("s2")?.state).toBe("active");
			expect(db.getContainerState("s1")).not.toBeNull();
			expect(db.getContainerState("s2")).not.toBeNull();

			// ── Step 2: Run crash recovery with both containers dead ────────

			const runtime = mockRuntime(new Set()); // nothing running
			const recovered = await recoverStaleContainers(db, runtime);

			expect(recovered).toBe(2);

			// ── Step 3: Verify cleanup ─────────────────────────────────────

			expect(db.getSession("s1")?.state).toBe("closed");
			expect(db.getSession("s2")?.state).toBe("closed");
			expect(db.getContainerState("s1")).toBeNull();
			expect(db.getContainerState("s2")).toBeNull();

			// ── Step 4: Create fresh orchestrator with same DB ─────────────

			const config = testConfig();
			const freshRuntime = mockRuntime(new Set());
			const runner = new ContainerRunner(config, freshRuntime);
			const sessionManager = new SessionManager(config, db, new SessionScaffolder());
			const mockAgentProcessManager = {
				connect: vi.fn(),
				disconnect: vi.fn(),
			} as unknown as AgentProcessManager;
			const orchestrator = new SessionOrchestrator(
				config,
				db,
				sessionManager,
				runner,
				mockAgentProcessManager,
			);

			// ── Step 5: Verify fresh start works ───────────────────────────

			const sessions = orchestrator.listSessions();

			// Both old sessions should be visible but closed.
			expect(sessions).toHaveLength(2);

			const s1 = sessions.find((s) => s.sessionId === "s1");
			const s2 = sessions.find((s) => s.sessionId === "s2");

			expect(s1).toBeDefined();
			expect(s1?.state).toBe("closed");
			expect(s2).toBeDefined();
			expect(s2?.state).toBe("closed");

			// Neither should be tracked as active in the orchestrator.
			expect(orchestrator.isActive("s1")).toBe(false);
			expect(orchestrator.isActive("s2")).toBe(false);
		},
	);
});
