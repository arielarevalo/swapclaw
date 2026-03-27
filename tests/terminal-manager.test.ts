import { EventEmitter } from "node:events";
import { RequestError } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerExec } from "../src/container-exec.js";
import { TerminalManager } from "../src/terminal-manager.js";

// ---------------------------------------------------------------------------
// Mock ContainerExec
// ---------------------------------------------------------------------------

/** Create a fake ChildProcess-like object with EventEmitter semantics. */
function createMockProcess() {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		stdin: null;
		pid: number;
		kill: ReturnType<typeof vi.fn>;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = null;
	proc.pid = 12345;
	proc.kill = vi.fn();
	return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TerminalManager", () => {
	let manager: TerminalManager;
	let mockProc: ReturnType<typeof createMockProcess>;
	let mockExec: ContainerExec;

	beforeEach(() => {
		vi.clearAllMocks();
		mockProc = createMockProcess();
		mockExec = { spawn: vi.fn().mockReturnValue(mockProc) };
		manager = new TerminalManager("test-container-id", mockExec);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// create()
	// -----------------------------------------------------------

	describe("create", () => {
		it("returns a terminalId", () => {
			const result = manager.create({
				sessionId: "sess-1",
				command: "echo",
				args: ["hello"],
			});

			expect(result.terminalId).toBe("term-1");
		});

		it("calls exec.spawn with correct ExecOptions", () => {
			manager.create({
				sessionId: "sess-1",
				command: "echo",
				args: ["hello"],
			});

			expect(mockExec.spawn).toHaveBeenCalledWith({
				containerId: "test-container-id",
				command: "echo",
				args: ["hello"],
				cwd: undefined,
				env: undefined,
			});
		});

		it("passes cwd in ExecOptions when provided", () => {
			manager.create({
				sessionId: "sess-1",
				command: "ls",
				cwd: "/project",
			});

			expect(mockExec.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					containerId: "test-container-id",
					command: "ls",
					cwd: "/project",
				}),
			);
		});

		it("passes env in ExecOptions when provided", () => {
			manager.create({
				sessionId: "sess-1",
				command: "env",
				env: [
					{ name: "FOO", value: "bar" },
					{ name: "BAZ", value: "qux" },
				],
			});

			expect(mockExec.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					containerId: "test-container-id",
					command: "env",
					env: [
						{ name: "FOO", value: "bar" },
						{ name: "BAZ", value: "qux" },
					],
				}),
			);
		});

		it("increments terminal IDs", () => {
			const r1 = manager.create({
				sessionId: "sess-1",
				command: "echo",
				args: ["1"],
			});
			const r2 = manager.create({
				sessionId: "sess-1",
				command: "echo",
				args: ["2"],
			});

			expect(r1.terminalId).toBe("term-1");
			expect(r2.terminalId).toBe("term-2");
		});

		it("handles command with no args", () => {
			manager.create({
				sessionId: "sess-1",
				command: "whoami",
			});

			expect(mockExec.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					containerId: "test-container-id",
					command: "whoami",
				}),
			);
		});
	});

	// -----------------------------------------------------------
	// getOutput()
	// -----------------------------------------------------------

	describe("getOutput", () => {
		it("returns captured stdout", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "echo",
				args: ["hello"],
			});

			mockProc.stdout.emit("data", Buffer.from("hello\n"));

			const output = manager.getOutput(terminalId);
			expect(output.output).toBe("hello\n");
			expect(output.truncated).toBe(false);
		});

		it("returns captured stderr combined with stdout", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "sh",
				args: ["-c", "echo out; echo err >&2"],
			});

			mockProc.stdout.emit("data", Buffer.from("out\n"));
			mockProc.stderr.emit("data", Buffer.from("err\n"));

			const output = manager.getOutput(terminalId);
			expect(output.output).toBe("out\nerr\n");
		});

		it("includes exitStatus when process has exited", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "echo",
				args: ["done"],
			});

			mockProc.stdout.emit("data", Buffer.from("done\n"));
			mockProc.emit("close", 0, null);

			const output = manager.getOutput(terminalId);
			expect(output.exitStatus).toEqual({
				exitCode: 0,
				signal: null,
			});
		});

		it("does not include exitStatus when process is still running", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "sleep",
				args: ["100"],
			});

			const output = manager.getOutput(terminalId);
			expect(output.exitStatus).toBeUndefined();
		});

		it("throws RequestError for unknown terminal", () => {
			expect(() => manager.getOutput("nonexistent")).toThrow(RequestError);
			expect(() => manager.getOutput("nonexistent")).toThrow("Terminal not found: nonexistent");
		});
	});

	// -----------------------------------------------------------
	// Output byte limit truncation
	// -----------------------------------------------------------

	describe("output byte limit", () => {
		it("truncates from the beginning when limit is exceeded", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "cat",
				args: ["/dev/urandom"],
				outputByteLimit: 10,
			});

			// Emit 20 bytes of output.
			mockProc.stdout.emit("data", Buffer.from("01234567890123456789"));

			const output = manager.getOutput(terminalId);
			expect(output.truncated).toBe(true);
			expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(10);
		});

		it("does not truncate when within limit", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "echo",
				args: ["hi"],
				outputByteLimit: 100,
			});

			mockProc.stdout.emit("data", Buffer.from("hi\n"));

			const output = manager.getOutput(terminalId);
			expect(output.truncated).toBe(false);
			expect(output.output).toBe("hi\n");
		});
	});

	// -----------------------------------------------------------
	// waitForExit()
	// -----------------------------------------------------------

	describe("waitForExit", () => {
		it("resolves with exit code on normal exit", async () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "true",
			});

			mockProc.emit("close", 0, null);

			const result = await manager.waitForExit(terminalId);
			expect(result).toEqual({ exitCode: 0, signal: null });
		});

		it("resolves with signal on signal death", async () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "sleep",
				args: ["100"],
			});

			mockProc.emit("close", null, "SIGTERM");

			const result = await manager.waitForExit(terminalId);
			expect(result).toEqual({ exitCode: null, signal: "SIGTERM" });
		});

		it("resolves with exit code 1 on process error", async () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "nonexistent",
			});

			mockProc.emit("error", new Error("spawn ENOENT"));

			const result = await manager.waitForExit(terminalId);
			expect(result).toEqual({ exitCode: 1, signal: null });
		});

		it("throws RequestError for unknown terminal", async () => {
			await expect(manager.waitForExit("nonexistent")).rejects.toThrow(RequestError);
		});
	});

	// -----------------------------------------------------------
	// kill()
	// -----------------------------------------------------------

	describe("kill", () => {
		it("sends SIGTERM to running process", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "sleep",
				args: ["100"],
			});

			manager.kill(terminalId);

			expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("does not kill already exited process", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "true",
			});

			mockProc.emit("close", 0, null);
			manager.kill(terminalId);

			expect(mockProc.kill).not.toHaveBeenCalled();
		});

		it("throws RequestError for unknown terminal", () => {
			expect(() => manager.kill("nonexistent")).toThrow(RequestError);
		});
	});

	// -----------------------------------------------------------
	// release()
	// -----------------------------------------------------------

	describe("release", () => {
		it("sends SIGKILL to running process and removes terminal", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "sleep",
				args: ["100"],
			});

			manager.release(terminalId);

			expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
			expect(() => manager.getOutput(terminalId)).toThrow(RequestError);
		});

		it("removes terminal even if process already exited", () => {
			const { terminalId } = manager.create({
				sessionId: "sess-1",
				command: "true",
			});

			mockProc.emit("close", 0, null);
			const result = manager.release(terminalId);

			expect(result).toEqual({});
			expect(mockProc.kill).not.toHaveBeenCalled();
			expect(() => manager.getOutput(terminalId)).toThrow(RequestError);
		});

		it("is a no-op for already released terminal", () => {
			const result = manager.release("nonexistent");
			expect(result).toEqual({});
		});
	});

	// -----------------------------------------------------------
	// releaseAll()
	// -----------------------------------------------------------

	describe("releaseAll", () => {
		it("releases all tracked terminals", () => {
			const procs: ReturnType<typeof createMockProcess>[] = [];
			(mockExec.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
				const p = createMockProcess();
				procs.push(p);
				return p;
			});

			const r1 = manager.create({
				sessionId: "sess-1",
				command: "sleep",
				args: ["100"],
			});
			const r2 = manager.create({
				sessionId: "sess-1",
				command: "sleep",
				args: ["200"],
			});

			manager.releaseAll();

			expect(procs[0].kill).toHaveBeenCalledWith("SIGKILL");
			expect(procs[1].kill).toHaveBeenCalledWith("SIGKILL");
			expect(() => manager.getOutput(r1.terminalId)).toThrow(RequestError);
			expect(() => manager.getOutput(r2.terminalId)).toThrow(RequestError);
		});

		it("is a no-op when no terminals exist", () => {
			// Should not throw.
			manager.releaseAll();
		});
	});
});
