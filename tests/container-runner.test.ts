import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { ContainerRunner } from "../src/container-runner.js";
import type { ContainerRuntime, SpawnResult } from "../src/container-runtime.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
	// readMcpConfigs checks fs.existsSync for .mcp.json in the session folder.
	vi.spyOn(fs, "existsSync").mockReturnValue(false);
});

/** Stub config. */
const stubConfig: Config = {
	dataDir: "/tmp/swapclaw",
	containerImage: "alpine:latest",
	containerTimeout: 300_000,
	idleTimeout: 5_000,
	maxConcurrent: 3,
	timezone: "America/New_York",
	sessionsDir: "/tmp/swapclaw/sessions",
	dbPath: "/tmp/swapclaw/swapclaw.db",
};

/** Build a mock ContainerRuntime. */
function createMockRuntime(): ContainerRuntime {
	return {
		ensureRunning: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		spawn: vi.fn<(opts: unknown) => Promise<SpawnResult>>().mockResolvedValue({
			containerId: "mock-container-id",
		}),
		stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		remove: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		isRunning: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
	};
}

/** Flush the microtask queue so resolved promises execute. */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => {
		queueMicrotask(resolve);
	});
}

// ---------------------------------------------------------------------------
// ContainerRunner
// ---------------------------------------------------------------------------

describe("ContainerRunner", () => {
	let runtime: ReturnType<typeof createMockRuntime>;
	let runner: ContainerRunner;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		runtime = createMockRuntime();
		runner = new ContainerRunner(stubConfig, runtime);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// start()
	// -----------------------------------------------------------

	describe("start", () => {
		it("calls runtime.spawn() with correct volume mounts", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");

			const spawnCall = (runtime.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.mounts).toEqual([
				{ hostPath: "/home/user/project", containerPath: "/project", readonly: true },
				{
					hostPath: "/tmp/swapclaw/sessions/sess-1",
					containerPath: "/session",
					readonly: false,
				},
			]);
		});

		it("passes SESSION_ID and TIMEZONE in env", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");

			const spawnCall = (runtime.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.env.SESSION_ID).toBe("sess-1");
			expect(spawnCall.env.TIMEZONE).toBe("America/New_York");
		});

		it("uses the container image from config", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");

			const spawnCall = (runtime.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.image).toBe("alpine:latest");
		});

		it("generates a container name with the session ID", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");

			const spawnCall = (runtime.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(spawnCall.name).toMatch(/^swapclaw-sess-1-\d+$/);
		});

		it("returns a ContainerHandle with correct properties", async () => {
			const handle = await runner.start(
				"sess-1",
				"/home/user/project",
				"/tmp/swapclaw/sessions/sess-1",
			);

			expect(handle.containerId).toBe("mock-container-id");
			expect(handle.containerName).toMatch(/^swapclaw-sess-1-\d+$/);
			expect(handle.startedAt).toBeInstanceOf(Date);
		});

		it("stores the handle so getHandle returns it", async () => {
			const handle = await runner.start(
				"sess-1",
				"/home/user/project",
				"/tmp/swapclaw/sessions/sess-1",
			);

			expect(runner.getHandle("sess-1")).toBe(handle);
		});

		it("marks the session as running", async () => {
			expect(runner.isRunning("sess-1")).toBe(false);
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");
			expect(runner.isRunning("sess-1")).toBe(true);
		});
	});

	// -----------------------------------------------------------
	// stop()
	// -----------------------------------------------------------

	describe("stop", () => {
		it("calls runtime.stop() and runtime.remove()", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");
			await runner.stop("sess-1");

			expect(runtime.stop).toHaveBeenCalledWith("mock-container-id");
			expect(runtime.remove).toHaveBeenCalledWith("mock-container-id");
		});

		it("removes the session from the internal map", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");
			await runner.stop("sess-1");

			expect(runner.getHandle("sess-1")).toBeUndefined();
			expect(runner.isRunning("sess-1")).toBe(false);
		});

		it("is a no-op for unknown session IDs", async () => {
			await runner.stop("nonexistent");

			expect(runtime.stop).not.toHaveBeenCalled();
			expect(runtime.remove).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------
	// Idle timeout
	// -----------------------------------------------------------

	describe("idle timeout", () => {
		it("fires stop() after the configured idle delay", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");

			// Advance just past the idle timeout.
			vi.advanceTimersByTime(stubConfig.idleTimeout);
			// Flush the microtask queue so the async stop() completes.
			await flushPromises();

			expect(runtime.stop).toHaveBeenCalledWith("mock-container-id");
			expect(runtime.remove).toHaveBeenCalledWith("mock-container-id");
			expect(runner.isRunning("sess-1")).toBe(false);
		});

		it("does not fire before the idle delay", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");

			// Advance to just before the timeout.
			vi.advanceTimersByTime(stubConfig.idleTimeout - 1);

			expect(runtime.stop).not.toHaveBeenCalled();
			expect(runner.isRunning("sess-1")).toBe(true);
		});

		it("is cancelled by stop()", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");
			await runner.stop("sess-1");

			// Clear call history after explicit stop.
			(runtime.stop as ReturnType<typeof vi.fn>).mockClear();
			(runtime.remove as ReturnType<typeof vi.fn>).mockClear();

			// Advance past the original timeout.
			vi.advanceTimersByTime(stubConfig.idleTimeout + 1_000);
			await flushPromises();

			// Should NOT have been called again by the timer.
			expect(runtime.stop).not.toHaveBeenCalled();
		});

		it("is reset by resetIdleTimer()", async () => {
			await runner.start("sess-1", "/home/user/project", "/tmp/swapclaw/sessions/sess-1");

			// Advance almost to timeout, then reset.
			vi.advanceTimersByTime(stubConfig.idleTimeout - 100);
			runner.resetIdleTimer("sess-1");

			// Advance the remaining original time — should NOT fire.
			vi.advanceTimersByTime(200);
			await flushPromises();
			expect(runtime.stop).not.toHaveBeenCalled();

			// Advance the full new timeout period.
			vi.advanceTimersByTime(stubConfig.idleTimeout);
			await flushPromises();
			expect(runtime.stop).toHaveBeenCalledWith("mock-container-id");
		});
	});

	// -----------------------------------------------------------
	// getHandle / isRunning
	// -----------------------------------------------------------

	describe("getHandle", () => {
		it("returns undefined for unknown session IDs", () => {
			expect(runner.getHandle("unknown")).toBeUndefined();
		});
	});

	describe("isRunning", () => {
		it("returns false for unknown session IDs", () => {
			expect(runner.isRunning("unknown")).toBe(false);
		});
	});

	// -----------------------------------------------------------
	// stopAll()
	// -----------------------------------------------------------

	describe("stopAll", () => {
		it("stops all running containers", async () => {
			// Spawn unique containers for each session.
			let callCount = 0;
			(runtime.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
				callCount++;
				return Promise.resolve({
					containerId: `container-${callCount}`,
				});
			});

			await runner.start("sess-1", "/home/user/p1", "/tmp/swapclaw/sessions/sess-1");
			await runner.start("sess-2", "/home/user/p2", "/tmp/swapclaw/sessions/sess-2");
			await runner.start("sess-3", "/home/user/p3", "/tmp/swapclaw/sessions/sess-3");

			await runner.stopAll();

			expect(runtime.stop).toHaveBeenCalledTimes(3);
			expect(runtime.remove).toHaveBeenCalledTimes(3);
			expect(runner.isRunning("sess-1")).toBe(false);
			expect(runner.isRunning("sess-2")).toBe(false);
			expect(runner.isRunning("sess-3")).toBe(false);
		});

		it("is a no-op when no containers are running", async () => {
			await runner.stopAll();

			expect(runtime.stop).not.toHaveBeenCalled();
			expect(runtime.remove).not.toHaveBeenCalled();
		});
	});
});
