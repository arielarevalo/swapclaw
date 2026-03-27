import * as child_process from "node:child_process";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
	AppleContainerRuntime,
	DockerRuntime,
	SANDBOX_KEEPALIVE_CMD,
	type SpawnOpts,
	detectRuntime,
} from "../src/container-runtime.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
	spawn: vi.fn(),
}));

const mockedExecFile = child_process.execFile as unknown as MockInstance;
const mockedSpawn = child_process.spawn as unknown as MockInstance;

/** Stub config — only the shape matters for detectRuntime. */
const stubConfig: Config = {
	dataDir: "/tmp/swapclaw",
	containerImage: "alpine:latest",
	containerTimeout: 300_000,
	idleTimeout: 60_000,
	maxConcurrent: 3,
	timezone: "UTC",
	sessionsDir: "/tmp/swapclaw/sessions",
	dbPath: "/tmp/swapclaw/swapclaw.db",
};

/** Standard SpawnOpts fixture used by arg-building tests. */
const baseOpts: SpawnOpts = {
	image: "alpine:latest",
	name: "session-abc123",
	mounts: [
		{ hostPath: "/host/project", containerPath: "/project", readonly: true },
		{ hostPath: "/host/session", containerPath: "/session", readonly: false },
	],
	env: { SESSION_ID: "abc123", TIMEZONE: "UTC" },
	cmd: ["sleep", "infinity"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make execFile invoke the callback with success. */
function mockExecFileSuccess(stdout = "", stderr = "") {
	mockedExecFile.mockImplementation(
		(
			_cmd: string,
			_args: string[],
			cb: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			cb(null, stdout, stderr);
		},
	);
}

/** Make execFile invoke the callback with an error. */
function mockExecFileFailure(message = "command failed") {
	mockedExecFile.mockImplementation(
		(
			_cmd: string,
			_args: string[],
			cb: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			cb(new Error(message), "", "");
		},
	);
}

/** Add a handler to a handler map, initializing the array if needed. */
function addHandler(
	map: Record<string, ((...args: unknown[]) => void)[]>,
	event: string,
	handler: (...args: unknown[]) => void,
): void {
	if (!map[event]) {
		map[event] = [];
	}
	map[event].push(handler);
}

/** Return a minimal fake ChildProcess that simulates detached container spawn. */
function fakeDetachedProcess(exitCode = 0) {
	const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

	const fake = {
		stdin: {},
		stdout: {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				addHandler(handlers, `stdout:${event}`, handler);
			}),
		},
		stderr: {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				addHandler(handlers, `stderr:${event}`, handler);
			}),
		},
		pid: 12345,
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			addHandler(handlers, event, handler);
			// Auto-fire close event on next tick to simulate docker run -d exiting.
			if (event === "close") {
				queueMicrotask(() => {
					for (const h of handlers.close ?? []) {
						h(exitCode);
					}
				});
			}
		}),
	};

	return fake;
}

// ---------------------------------------------------------------------------
// DockerRuntime
// ---------------------------------------------------------------------------

describe("DockerRuntime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// buildRunArgs
	// -----------------------------------------------------------

	describe("buildRunArgs", () => {
		it("includes -d, --rm, --name, volume mounts, env vars, image, and cmd", () => {
			const runtime = new DockerRuntime();
			const args = runtime.buildRunArgs(baseOpts);

			expect(args).toEqual([
				"run",
				"-d",
				"--rm",
				"--name",
				"session-abc123",
				"-v",
				"/host/project:/project:ro",
				"-v",
				"/host/session:/session",
				"-e",
				"SESSION_ID=abc123",
				"-e",
				"TIMEZONE=UTC",
				"alpine:latest",
				"sleep",
				"infinity",
			]);
		});

		it("defaults to SANDBOX_KEEPALIVE_CMD when cmd is not provided", () => {
			const runtime = new DockerRuntime();
			const opts: SpawnOpts = { ...baseOpts, cmd: undefined };
			const args = runtime.buildRunArgs(opts);

			// Should end with the keepalive command.
			const lastArgs = args.slice(-SANDBOX_KEEPALIVE_CMD.length);
			expect(lastArgs).toEqual(SANDBOX_KEEPALIVE_CMD);
		});

		it("handles empty mounts and env with keepalive default", () => {
			const runtime = new DockerRuntime();
			const opts: SpawnOpts = {
				image: "test:latest",
				name: "empty-container",
				mounts: [],
				env: {},
			};
			const args = runtime.buildRunArgs(opts);

			expect(args).toEqual([
				"run",
				"-d",
				"--rm",
				"--name",
				"empty-container",
				"test:latest",
				...SANDBOX_KEEPALIVE_CMD,
			]);
		});

		it("appends :ro only for readonly mounts", () => {
			const runtime = new DockerRuntime();
			const args = runtime.buildRunArgs(baseOpts);

			expect(args).toContain("/host/project:/project:ro");
			expect(args).toContain("/host/session:/session");
		});
	});

	// -----------------------------------------------------------
	// ensureRunning
	// -----------------------------------------------------------

	describe("ensureRunning", () => {
		it("resolves when docker info succeeds", async () => {
			mockExecFileSuccess("Docker version info...");
			const runtime = new DockerRuntime();
			await expect(runtime.ensureRunning()).resolves.toBeUndefined();
		});

		it("throws descriptive error when docker info fails", async () => {
			mockExecFileFailure("Cannot connect to Docker daemon");
			const runtime = new DockerRuntime();
			await expect(runtime.ensureRunning()).rejects.toThrow("Docker daemon is not running");
		});
	});

	// -----------------------------------------------------------
	// spawn
	// -----------------------------------------------------------

	describe("spawn", () => {
		it("calls child_process.spawn with docker and correct args, resolves on success", async () => {
			const fake = fakeDetachedProcess(0);
			mockedSpawn.mockReturnValue(fake);

			const runtime = new DockerRuntime();
			const result = await runtime.spawn(baseOpts);

			expect(mockedSpawn).toHaveBeenCalledWith("docker", runtime.buildRunArgs(baseOpts), {
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(result.containerId).toBe("session-abc123");
		});

		it("rejects when docker run exits with non-zero code", async () => {
			const fake = fakeDetachedProcess(1);
			mockedSpawn.mockReturnValue(fake);

			const runtime = new DockerRuntime();
			await expect(runtime.spawn(baseOpts)).rejects.toThrow("docker run failed (exit 1)");
		});
	});

	// -----------------------------------------------------------
	// stop
	// -----------------------------------------------------------

	describe("stop", () => {
		it("calls docker stop with --time=10", async () => {
			mockExecFileSuccess();
			const runtime = new DockerRuntime();
			await runtime.stop("my-container");

			expect(mockedExecFile).toHaveBeenCalledWith(
				"docker",
				["stop", "--time=10", "my-container"],
				expect.any(Function),
			);
		});

		it("falls back to docker kill when stop fails", async () => {
			let callCount = 0;
			mockedExecFile.mockImplementation(
				(
					_cmd: string,
					args: string[],
					cb: (err: Error | null, stdout: string, stderr: string) => void,
				) => {
					callCount++;
					if (args[0] === "stop") {
						cb(new Error("timeout"), "", "");
					} else {
						cb(null, "", "");
					}
				},
			);

			const runtime = new DockerRuntime();
			await runtime.stop("my-container");

			expect(callCount).toBe(2);
			expect(mockedExecFile).toHaveBeenCalledWith(
				"docker",
				["kill", "my-container"],
				expect.any(Function),
			);
		});
	});

	// -----------------------------------------------------------
	// remove
	// -----------------------------------------------------------

	describe("remove", () => {
		it("calls docker rm -f", async () => {
			mockExecFileSuccess();
			const runtime = new DockerRuntime();
			await runtime.remove("my-container");

			expect(mockedExecFile).toHaveBeenCalledWith(
				"docker",
				["rm", "-f", "my-container"],
				expect.any(Function),
			);
		});
	});

	// -----------------------------------------------------------
	// isRunning
	// -----------------------------------------------------------

	describe("isRunning", () => {
		it("returns true when inspect reports Running=true", async () => {
			mockExecFileSuccess("true\n");
			const runtime = new DockerRuntime();
			const result = await runtime.isRunning("my-container");
			expect(result).toBe(true);
		});

		it("returns false when inspect reports Running=false", async () => {
			mockExecFileSuccess("false\n");
			const runtime = new DockerRuntime();
			const result = await runtime.isRunning("my-container");
			expect(result).toBe(false);
		});

		it("returns false when inspect fails", async () => {
			mockExecFileFailure("No such container");
			const runtime = new DockerRuntime();
			const result = await runtime.isRunning("my-container");
			expect(result).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// AppleContainerRuntime
// ---------------------------------------------------------------------------

describe("AppleContainerRuntime", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// buildRunArgs
	// -----------------------------------------------------------

	describe("buildRunArgs", () => {
		it("includes --detach, --name, --mount with src/dst syntax, --env, image, and cmd", () => {
			const runtime = new AppleContainerRuntime();
			const args = runtime.buildRunArgs(baseOpts);

			expect(args).toEqual([
				"run",
				"--detach",
				"--name",
				"session-abc123",
				"--mount",
				"src=/host/project,dst=/project:ro",
				"--mount",
				"src=/host/session,dst=/session",
				"--env",
				"SESSION_ID=abc123",
				"--env",
				"TIMEZONE=UTC",
				"alpine:latest",
				"sleep",
				"infinity",
			]);
		});

		it("defaults to SANDBOX_KEEPALIVE_CMD when cmd is not provided", () => {
			const runtime = new AppleContainerRuntime();
			const opts: SpawnOpts = { ...baseOpts, cmd: undefined };
			const args = runtime.buildRunArgs(opts);

			// Should end with the keepalive command.
			const lastArgs = args.slice(-SANDBOX_KEEPALIVE_CMD.length);
			expect(lastArgs).toEqual(SANDBOX_KEEPALIVE_CMD);
		});

		it("uses --mount with src/dst instead of Docker -v syntax", () => {
			const runtime = new AppleContainerRuntime();
			const args = runtime.buildRunArgs(baseOpts);

			// Should NOT contain Docker-style -v flags.
			expect(args).not.toContain("-v");
			// Should use --mount with src=...,dst=... format.
			expect(args).toContain("src=/host/project,dst=/project:ro");
			expect(args).toContain("src=/host/session,dst=/session");
		});
	});

	// -----------------------------------------------------------
	// ensureRunning
	// -----------------------------------------------------------

	describe("ensureRunning", () => {
		it("resolves when container CLI is found", async () => {
			mockExecFileSuccess("/usr/local/bin/container");
			const runtime = new AppleContainerRuntime();
			await expect(runtime.ensureRunning()).resolves.toBeUndefined();
		});

		it("throws descriptive error when container CLI is not found", async () => {
			mockExecFileFailure("not found");
			const runtime = new AppleContainerRuntime();
			await expect(runtime.ensureRunning()).rejects.toThrow("Apple Container CLI not found");
		});
	});

	// -----------------------------------------------------------
	// spawn
	// -----------------------------------------------------------

	describe("spawn", () => {
		it("calls child_process.spawn with container and correct args, resolves on success", async () => {
			const fake = fakeDetachedProcess(0);
			mockedSpawn.mockReturnValue(fake);

			const runtime = new AppleContainerRuntime();
			const result = await runtime.spawn(baseOpts);

			expect(mockedSpawn).toHaveBeenCalledWith("container", runtime.buildRunArgs(baseOpts), {
				stdio: ["pipe", "pipe", "pipe"],
			});
			expect(result.containerId).toBe("session-abc123");
		});

		it("rejects when container run exits with non-zero code", async () => {
			const fake = fakeDetachedProcess(1);
			mockedSpawn.mockReturnValue(fake);

			const runtime = new AppleContainerRuntime();
			await expect(runtime.spawn(baseOpts)).rejects.toThrow("container run failed (exit 1)");
		});
	});

	// -----------------------------------------------------------
	// stop
	// -----------------------------------------------------------

	describe("stop", () => {
		it("calls container stop", async () => {
			mockExecFileSuccess();
			const runtime = new AppleContainerRuntime();
			await runtime.stop("my-container");

			expect(mockedExecFile).toHaveBeenCalledWith(
				"container",
				["stop", "my-container"],
				expect.any(Function),
			);
		});
	});

	// -----------------------------------------------------------
	// remove
	// -----------------------------------------------------------

	describe("remove", () => {
		it("calls container rm", async () => {
			mockExecFileSuccess();
			const runtime = new AppleContainerRuntime();
			await runtime.remove("my-container");

			expect(mockedExecFile).toHaveBeenCalledWith(
				"container",
				["rm", "my-container"],
				expect.any(Function),
			);
		});
	});

	// -----------------------------------------------------------
	// isRunning
	// -----------------------------------------------------------

	describe("isRunning", () => {
		it("returns true when inspect succeeds", async () => {
			mockExecFileSuccess("running");
			const runtime = new AppleContainerRuntime();
			const result = await runtime.isRunning("my-container");
			expect(result).toBe(true);
		});

		it("returns false when inspect fails", async () => {
			mockExecFileFailure("No such container");
			const runtime = new AppleContainerRuntime();
			const result = await runtime.isRunning("my-container");
			expect(result).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// detectRuntime
// ---------------------------------------------------------------------------

describe("detectRuntime", () => {
	const originalPlatform = process.platform;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("prefers AppleContainerRuntime on darwin when available", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		// `which container` succeeds.
		mockExecFileSuccess("/usr/local/bin/container");

		const runtime = await detectRuntime(stubConfig);
		expect(runtime).toBeInstanceOf(AppleContainerRuntime);
	});

	it("falls back to DockerRuntime on darwin when Apple Container unavailable", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });

		let callCount = 0;
		mockedExecFile.mockImplementation(
			(
				cmd: string,
				_args: string[],
				cb: (err: Error | null, stdout: string, stderr: string) => void,
			) => {
				callCount++;
				if (cmd === "which") {
					// Apple Container CLI not found.
					cb(new Error("not found"), "", "");
				} else {
					// docker info succeeds.
					cb(null, "Docker OK", "");
				}
			},
		);

		const runtime = await detectRuntime(stubConfig);
		expect(runtime).toBeInstanceOf(DockerRuntime);
		expect(callCount).toBe(2);
	});

	it("uses DockerRuntime on linux", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		mockExecFileSuccess("Docker OK");

		const runtime = await detectRuntime(stubConfig);
		expect(runtime).toBeInstanceOf(DockerRuntime);
	});

	it("throws when no runtime is available on darwin", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		mockExecFileFailure("not found");

		await expect(detectRuntime(stubConfig)).rejects.toThrow(
			"No container runtime available on darwin",
		);
	});

	it("throws when no runtime is available on linux", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		mockExecFileFailure("not found");

		await expect(detectRuntime(stubConfig)).rejects.toThrow(
			"No container runtime available on linux",
		);
	});

	it("error message suggests Docker on linux", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		mockExecFileFailure("not found");

		await expect(detectRuntime(stubConfig)).rejects.toThrow("Install and start Docker");
	});

	it("error message suggests both runtimes on darwin", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		mockExecFileFailure("not found");

		await expect(detectRuntime(stubConfig)).rejects.toThrow(
			"Install Docker Desktop or Apple Container CLI",
		);
	});
});
