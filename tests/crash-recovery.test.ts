import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerRuntime } from "../src/container-runtime.js";
import { recoverStaleContainers } from "../src/crash-recovery.js";
import { Database } from "../src/db.js";

/** Minimal mock of ContainerRuntime — only isRunning is needed. */
function mockRuntime(runningIds: Set<string>): ContainerRuntime {
	return {
		ensureRunning: vi.fn(),
		spawn: vi.fn(),
		stop: vi.fn(),
		remove: vi.fn(),
		isRunning: vi.fn(async (id: string) => runningIds.has(id)),
	};
}

describe("recoverStaleContainers", () => {
	let db: Database;

	beforeEach(() => {
		db = Database.inMemory();
	});

	afterEach(() => {
		db.close();
	});

	it("clears stale container states when container is not running", async () => {
		db.createSession("s1", "/tmp");
		db.setContainerState("s1", {
			container_id: "ctr-dead",
			runtime: "docker",
			status: "running",
			started_at: new Date().toISOString(),
		});

		const runtime = mockRuntime(new Set()); // nothing actually running

		const count = await recoverStaleContainers(db, runtime);

		expect(count).toBe(1);
		expect(db.getContainerState("s1")).toBeNull();
		expect(runtime.isRunning).toHaveBeenCalledWith("ctr-dead");
	});

	it("closes session in DB when its container is dead", async () => {
		db.createSession("s1", "/tmp");
		db.setContainerState("s1", {
			container_id: "ctr-dead",
			runtime: "docker",
			status: "running",
			started_at: new Date().toISOString(),
		});

		const runtime = mockRuntime(new Set()); // nothing running

		await recoverStaleContainers(db, runtime);

		const session = db.getSession("s1");
		expect(session).not.toBeNull();
		expect(session?.state).toBe("closed");
	});

	it("leaves running containers untouched", async () => {
		db.createSession("s1", "/tmp");
		db.setContainerState("s1", {
			container_id: "ctr-alive",
			runtime: "docker",
			status: "running",
			started_at: new Date().toISOString(),
		});

		const runtime = mockRuntime(new Set(["ctr-alive"]));

		const count = await recoverStaleContainers(db, runtime);

		expect(count).toBe(0);
		expect(db.getContainerState("s1")).not.toBeNull();
		expect(db.getContainerState("s1")?.status).toBe("running");
	});

	it("returns count of recovered sessions", async () => {
		db.createSession("s1", "/tmp");
		db.createSession("s2", "/tmp");
		db.createSession("s3", "/tmp");

		for (const [sid, cid] of [
			["s1", "ctr-1"],
			["s2", "ctr-2"],
			["s3", "ctr-3"],
		]) {
			db.setContainerState(sid, {
				container_id: cid,
				runtime: "docker",
				status: "running",
				started_at: new Date().toISOString(),
			});
		}

		// Only ctr-2 is actually running
		const runtime = mockRuntime(new Set(["ctr-2"]));

		const count = await recoverStaleContainers(db, runtime);

		expect(count).toBe(2);
		// s1 and s3 cleared, s2 kept
		expect(db.getContainerState("s1")).toBeNull();
		expect(db.getContainerState("s2")).not.toBeNull();
		expect(db.getContainerState("s3")).toBeNull();
	});

	it("handles empty container_state table (no-op)", async () => {
		const runtime = mockRuntime(new Set());

		const count = await recoverStaleContainers(db, runtime);

		expect(count).toBe(0);
		expect(runtime.isRunning).not.toHaveBeenCalled();
	});

	it("ignores containers with non-running status", async () => {
		db.createSession("s1", "/tmp");
		db.setContainerState("s1", {
			container_id: "ctr-stopped",
			runtime: "docker",
			status: "stopped",
			started_at: new Date().toISOString(),
			stopped_at: new Date().toISOString(),
		});

		const runtime = mockRuntime(new Set());

		const count = await recoverStaleContainers(db, runtime);

		expect(count).toBe(0);
		// stopped row untouched
		expect(db.getContainerState("s1")).not.toBeNull();
		expect(runtime.isRunning).not.toHaveBeenCalled();
	});

	it("logs recovered sessions to stderr", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		db.createSession("s1", "/tmp");
		db.setContainerState("s1", {
			container_id: "ctr-gone",
			runtime: "docker",
			status: "running",
			started_at: new Date().toISOString(),
		});

		const runtime = mockRuntime(new Set());

		await recoverStaleContainers(db, runtime);

		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('"sessionId":"s1"'));
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('"recovered":1'));

		stderrSpy.mockRestore();
	});

	it("stops and removes orphaned container when session is closed in DB", async () => {
		db.createSession("s1", "/tmp");
		db.closeSession("s1"); // session already closed
		db.setContainerState("s1", {
			container_id: "ctr-orphan",
			runtime: "docker",
			status: "running",
			started_at: new Date().toISOString(),
		});

		const runtime = mockRuntime(new Set(["ctr-orphan"])); // container still alive

		const count = await recoverStaleContainers(db, runtime);

		expect(count).toBe(1);
		expect(runtime.stop).toHaveBeenCalledWith("ctr-orphan");
		expect(runtime.remove).toHaveBeenCalledWith("ctr-orphan");
		expect(db.getContainerState("s1")).toBeNull();
	});

	it("leaves container untouched when session is active and container is alive", async () => {
		db.createSession("s1", "/tmp");
		// session stays active (default state)
		db.setContainerState("s1", {
			container_id: "ctr-alive",
			runtime: "docker",
			status: "running",
			started_at: new Date().toISOString(),
		});

		const runtime = mockRuntime(new Set(["ctr-alive"])); // container alive

		const count = await recoverStaleContainers(db, runtime);

		expect(count).toBe(0);
		expect(runtime.stop).not.toHaveBeenCalled();
		expect(runtime.remove).not.toHaveBeenCalled();
		expect(db.getContainerState("s1")).not.toBeNull();
		expect(db.getSession("s1")?.state).toBe("active");
	});
});
