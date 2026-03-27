import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapClawClient } from "../src/acp-client.js";
import type { FilesystemManager } from "../src/filesystem-manager.js";
import type { TerminalManager } from "../src/terminal-manager.js";

// ---------------------------------------------------------------------------
// Mock managers
// ---------------------------------------------------------------------------

function createMockTerminalManager() {
	return {
		create: vi.fn().mockReturnValue({ terminalId: "term-1" }),
		getOutput: vi.fn().mockReturnValue({ output: "", truncated: false }),
		waitForExit: vi.fn().mockResolvedValue({ exitCode: 0, signal: null }),
		kill: vi.fn().mockReturnValue({}),
		release: vi.fn().mockReturnValue({}),
		releaseAll: vi.fn(),
	} as unknown as TerminalManager;
}

function createMockFilesystemManager() {
	return {
		read: vi.fn().mockResolvedValue("file content\n"),
		write: vi.fn().mockResolvedValue(undefined),
	} as unknown as FilesystemManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SwapClawClient", () => {
	let client: SwapClawClient;
	let mockTm: TerminalManager;
	let mockFm: FilesystemManager;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTm = createMockTerminalManager();
		mockFm = createMockFilesystemManager();
		client = new SwapClawClient(mockTm, mockFm);
	});

	afterEach(() => {
		client.cleanup();
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// requestPermission()
	// -----------------------------------------------------------

	describe("requestPermission", () => {
		it("auto-approves by selecting the first option", async () => {
			const result = await client.requestPermission({
				sessionId: "sess-1",
				toolCall: {
					toolCallId: "tc-1",
					title: "Run command",
				},
				options: [
					{ optionId: "opt-allow", name: "Allow", kind: "allow_once" },
					{ optionId: "opt-reject", name: "Reject", kind: "reject_once" },
				],
			} as acp.RequestPermissionRequest);

			expect(result.outcome).toEqual({
				outcome: "selected",
				optionId: "opt-allow",
			});
		});

		it("selects the first option even if it is reject", async () => {
			const result = await client.requestPermission({
				sessionId: "sess-1",
				toolCall: {
					toolCallId: "tc-1",
					title: "Dangerous op",
				},
				options: [{ optionId: "opt-reject", name: "Reject", kind: "reject_once" }],
			} as acp.RequestPermissionRequest);

			expect(result.outcome).toEqual({
				outcome: "selected",
				optionId: "opt-reject",
			});
		});
	});

	// -----------------------------------------------------------
	// sessionUpdate()
	// -----------------------------------------------------------

	describe("sessionUpdate", () => {
		it("forwards updates to the handler", async () => {
			const received: acp.SessionNotification[] = [];
			const handlerClient = new SwapClawClient(mockTm, mockFm, (params) => {
				received.push(params);
			});

			const notification: acp.SessionNotification = {
				sessionId: "sess-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Hello" },
				} as acp.SessionUpdate,
			};

			await handlerClient.sessionUpdate(notification);

			expect(received).toHaveLength(1);
			expect(received[0]).toBe(notification);

			handlerClient.cleanup();
		});

		it("does not throw when no handler is registered", async () => {
			await expect(
				client.sessionUpdate({
					sessionId: "sess-1",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Hello" },
					} as acp.SessionUpdate,
				}),
			).resolves.toBeUndefined();
		});

		it("awaits an async handler", async () => {
			let resolved = false;
			const handlerClient = new SwapClawClient(mockTm, mockFm, async () => {
				await new Promise<void>((r) => queueMicrotask(r));
				resolved = true;
			});

			await handlerClient.sessionUpdate({
				sessionId: "sess-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Hello" },
				} as acp.SessionUpdate,
			});

			expect(resolved).toBe(true);

			handlerClient.cleanup();
		});
	});

	// -----------------------------------------------------------
	// Terminal callbacks (delegation to TerminalManager)
	// -----------------------------------------------------------

	describe("createTerminal", () => {
		it("delegates to TerminalManager.create and returns its result", async () => {
			const result = await client.createTerminal({
				sessionId: "sess-1",
				command: "echo",
				args: ["hello"],
			});

			expect(result.terminalId).toBe("term-1");
			expect(mockTm.create as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
				sessionId: "sess-1",
				command: "echo",
				args: ["hello"],
			});
		});
	});

	describe("terminalOutput", () => {
		it("delegates to TerminalManager.getOutput", async () => {
			(mockTm.getOutput as ReturnType<typeof vi.fn>).mockReturnValue({
				output: "hello\n",
				truncated: false,
			});

			const output = await client.terminalOutput({ terminalId: "term-1" });

			expect(output.output).toBe("hello\n");
			expect(mockTm.getOutput as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("term-1");
		});
	});

	describe("waitForTerminalExit", () => {
		it("delegates to TerminalManager.waitForExit", async () => {
			(mockTm.waitForExit as ReturnType<typeof vi.fn>).mockResolvedValue({
				exitCode: 0,
				signal: null,
			});

			const result = await client.waitForTerminalExit({ terminalId: "term-1" });

			expect(result).toEqual({ exitCode: 0, signal: null });
			expect(mockTm.waitForExit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("term-1");
		});
	});

	describe("killTerminal", () => {
		it("delegates to TerminalManager.kill", async () => {
			await client.killTerminal({ terminalId: "term-1" });

			expect(mockTm.kill as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("term-1");
		});
	});

	describe("releaseTerminal", () => {
		it("delegates to TerminalManager.release", async () => {
			const result = await client.releaseTerminal({ terminalId: "term-1" });

			expect(result).toEqual({});
			expect(mockTm.release as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("term-1");
		});
	});

	// -----------------------------------------------------------
	// Filesystem callbacks (delegation to FilesystemManager)
	// -----------------------------------------------------------

	describe("readTextFile", () => {
		it("delegates to FilesystemManager.read and wraps result", async () => {
			(mockFm.read as ReturnType<typeof vi.fn>).mockResolvedValue("file content\n");

			const result = await client.readTextFile({
				sessionId: "sess-1",
				path: "/tmp/test.txt",
			});

			expect(result.content).toBe("file content\n");
			expect(mockFm.read as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
				"/tmp/test.txt",
				undefined,
				undefined,
			);
		});

		it("passes line and limit parameters to FilesystemManager.read", async () => {
			(mockFm.read as ReturnType<typeof vi.fn>).mockResolvedValue("line 3\n");

			const result = await client.readTextFile({
				sessionId: "sess-1",
				path: "/tmp/test.txt",
				line: 3,
				limit: 1,
			});

			expect(result.content).toBe("line 3\n");
			expect(mockFm.read as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/tmp/test.txt", 3, 1);
		});
	});

	describe("writeTextFile", () => {
		it("delegates to FilesystemManager.write", async () => {
			const result = await client.writeTextFile({
				sessionId: "sess-1",
				path: "/tmp/test.txt",
				content: "hello world",
			});

			expect(result).toEqual({});
			expect(mockFm.write as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
				"/tmp/test.txt",
				"hello world",
			);
		});
	});

	// -----------------------------------------------------------
	// Extension callbacks
	// -----------------------------------------------------------

	describe("extMethod", () => {
		it("returns empty object", async () => {
			const result = await client.extMethod("custom.method", {
				key: "value",
			});
			expect(result).toEqual({});
		});
	});

	describe("extNotification", () => {
		it("returns void without throwing", async () => {
			await expect(
				client.extNotification("custom.notification", {
					key: "value",
				}),
			).resolves.toBeUndefined();
		});
	});

	// -----------------------------------------------------------
	// cleanup()
	// -----------------------------------------------------------

	describe("cleanup", () => {
		it("delegates to TerminalManager.releaseAll", () => {
			client.cleanup();

			expect(mockTm.releaseAll as ReturnType<typeof vi.fn>).toHaveBeenCalled();
		});
	});
});
