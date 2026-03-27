import { EventEmitter } from "node:events";
import { RequestError } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerExec, ExecOptions } from "../src/container-exec.js";
import { FilesystemManager } from "../src/filesystem-manager.js";

// ---------------------------------------------------------------------------
// Mock ContainerExec
// ---------------------------------------------------------------------------

/** Create a fake ChildProcess-like object with EventEmitter semantics. */
function createMockProcess(options?: { withStdin?: boolean }) {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | null;
		pid: number;
		kill: ReturnType<typeof vi.fn>;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = options?.withStdin ? { write: vi.fn(), end: vi.fn() } : null;
	proc.pid = 12345;
	proc.kill = vi.fn();
	return proc;
}

/**
 * Set up exec.spawn mock to auto-resolve with given output when process
 * emits close. Uses mockImplementation so each call creates a fresh process.
 */
function setupSpawnSuccess(mockExec: ContainerExec, output: string) {
	(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
		const proc = createMockProcess();
		queueMicrotask(() => {
			proc.stdout.emit("data", Buffer.from(output));
			proc.emit("close", 0);
		});
		return proc;
	});
}

function setupSpawnFailure(mockExec: ContainerExec, stderr: string, exitCode: number) {
	(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
		const proc = createMockProcess();
		queueMicrotask(() => {
			proc.stderr.emit("data", Buffer.from(stderr));
			proc.emit("close", exitCode);
		});
		return proc;
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FilesystemManager", () => {
	let manager: FilesystemManager;
	let mockExec: ContainerExec;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExec = { spawn: vi.fn() };
		manager = new FilesystemManager("test-container-id", mockExec);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// read input validation
	// -----------------------------------------------------------

	describe("read input validation", () => {
		it("throws when line is less than 1", async () => {
			await expect(manager.read("/tmp/test.txt", -1)).rejects.toThrow(RequestError);
			await expect(manager.read("/tmp/test.txt", -1)).rejects.toMatchObject({
				code: -32001,
			});
		});

		it("throws when limit is less than 1", async () => {
			await expect(manager.read("/tmp/test.txt", null, -1)).rejects.toThrow(RequestError);
			await expect(manager.read("/tmp/test.txt", null, -1)).rejects.toMatchObject({
				code: -32001,
			});
		});

		it("throws when line is 0", async () => {
			await expect(manager.read("/tmp/test.txt", 0)).rejects.toThrow(RequestError);
			await expect(manager.read("/tmp/test.txt", 0)).rejects.toMatchObject({
				code: -32001,
			});
		});
	});

	// -----------------------------------------------------------
	// read()
	// -----------------------------------------------------------

	describe("read", () => {
		it("reads a file via exec.spawn with cat", async () => {
			setupSpawnSuccess(mockExec, "file content\n");

			const result = await manager.read("/tmp/test.txt");

			expect(result).toBe("file content\n");
			expect(mockExec.spawn).toHaveBeenCalledWith({
				containerId: "test-container-id",
				command: "cat",
				args: ["/tmp/test.txt"],
			});
		});

		it("uses sed with line and limit parameters", async () => {
			setupSpawnSuccess(mockExec, "line 3\nline 4\n");

			const result = await manager.read("/tmp/test.txt", 3, 2);

			expect(result).toBe("line 3\nline 4\n");
			expect(mockExec.spawn).toHaveBeenCalledWith({
				containerId: "test-container-id",
				command: "sed",
				args: ["-n", "3,4p", "/tmp/test.txt"],
			});
		});

		it("uses sed with line parameter only", async () => {
			setupSpawnSuccess(mockExec, "line 5\nline 6\n");

			const result = await manager.read("/tmp/test.txt", 5);

			expect(result).toBe("line 5\nline 6\n");
			expect(mockExec.spawn).toHaveBeenCalledWith({
				containerId: "test-container-id",
				command: "sed",
				args: ["-n", "5,$p", "/tmp/test.txt"],
			});
		});

		it("uses head with limit parameter only", async () => {
			setupSpawnSuccess(mockExec, "line 1\nline 2\n");

			const result = await manager.read("/tmp/test.txt", null, 2);

			expect(result).toBe("line 1\nline 2\n");
			expect(mockExec.spawn).toHaveBeenCalledWith({
				containerId: "test-container-id",
				command: "head",
				args: ["-n", "2", "/tmp/test.txt"],
			});
		});

		it("throws RequestError on failure", async () => {
			setupSpawnFailure(mockExec, "cat: /nonexistent: No such file or directory", 1);

			await expect(manager.read("/nonexistent")).rejects.toThrow(RequestError);
			await expect(manager.read("/nonexistent")).rejects.toThrow(/Failed to read file/);
		});
	});

	// -----------------------------------------------------------
	// write()
	// -----------------------------------------------------------

	describe("write", () => {
		it("creates parent directories and writes via exec.spawn", async () => {
			const spawnCalls: ExecOptions[] = [];

			(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation((opts: ExecOptions) => {
				spawnCalls.push(opts);
				const isMkdir = opts.command === "mkdir";
				const proc = createMockProcess({ withStdin: !isMkdir });

				queueMicrotask(() => {
					proc.emit("close", 0);
				});

				return proc;
			});

			await manager.write("/tmp/deep/dir/file.txt", "hello world");

			// First call: mkdir -p
			expect(spawnCalls[0]).toEqual({
				containerId: "test-container-id",
				command: "mkdir",
				args: ["-p", "/tmp/deep/dir"],
			});

			// Second call: sh -c cat > path (interactive for stdin)
			expect(spawnCalls[1]).toEqual({
				containerId: "test-container-id",
				command: "sh",
				args: ["-c", "cat > '/tmp/deep/dir/file.txt'"],
				interactive: true,
			});
		});

		it("pipes content to stdin", async () => {
			let writeProc: ReturnType<typeof createMockProcess> | null = null;

			(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation((opts: ExecOptions) => {
				const isMkdir = opts.command === "mkdir";
				const proc = createMockProcess({ withStdin: !isMkdir });

				if (!isMkdir) {
					writeProc = proc;
				}

				queueMicrotask(() => {
					proc.emit("close", 0);
				});

				return proc;
			});

			await manager.write("/tmp/test.txt", "hello world");

			expect(writeProc).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe after toBeNull guard
			expect(writeProc!.stdin?.write).toHaveBeenCalledWith("hello world");
			// biome-ignore lint/style/noNonNullAssertion: safe after toBeNull guard
			expect(writeProc!.stdin?.end).toHaveBeenCalled();
		});

		it("escapes single quotes in paths", async () => {
			const spawnCalls: ExecOptions[] = [];

			(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation((opts: ExecOptions) => {
				spawnCalls.push(opts);
				const isMkdir = opts.command === "mkdir";
				const proc = createMockProcess({ withStdin: !isMkdir });

				queueMicrotask(() => {
					proc.emit("close", 0);
				});

				return proc;
			});

			await manager.write("/tmp/it's a file.txt", "content");

			// The write call should have escaped single quotes.
			const writeCall = spawnCalls.find((c) => c.command === "sh");
			expect(writeCall).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe after toBeDefined guard
			expect(writeCall!.args).toContain("cat > '/tmp/it'\\''s a file.txt'");
		});

		it("throws RequestError on write failure", async () => {
			(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation((opts: ExecOptions) => {
				const isMkdir = opts.command === "mkdir";
				const proc = createMockProcess({ withStdin: !isMkdir });

				queueMicrotask(() => {
					if (isMkdir) {
						proc.emit("close", 0);
					} else {
						proc.stderr.emit("data", Buffer.from("Permission denied"));
						proc.emit("close", 1);
					}
				});

				return proc;
			});

			await expect(manager.write("/readonly/file.txt", "content")).rejects.toThrow(RequestError);
			await expect(manager.write("/readonly/file.txt", "content")).rejects.toThrow(
				/Failed to write file/,
			);
		});

		it("continues writing even if mkdir fails", async () => {
			const spawnCalls: ExecOptions[] = [];

			(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation((opts: ExecOptions) => {
				spawnCalls.push(opts);
				const isMkdir = opts.command === "mkdir";
				const proc = createMockProcess({ withStdin: !isMkdir });

				queueMicrotask(() => {
					if (isMkdir) {
						proc.stderr.emit("data", Buffer.from("Permission denied"));
						proc.emit("close", 1);
					} else {
						proc.emit("close", 0);
					}
				});

				return proc;
			});

			// Should not throw even though mkdir fails.
			await manager.write("/tmp/file.txt", "content");

			// Both mkdir and write should have been attempted.
			expect(spawnCalls).toHaveLength(2);
		});
	});
});
