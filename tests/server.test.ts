import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwapClawAgent } from "../src/server.js";
import type { SessionOrchestrator } from "../src/session-orchestrator.js";
import type { TaskScheduler } from "../src/task-scheduler.js";

// ── Mock factories ──────────────────────────────────────────────────

function createMockConnection() {
	const conn = {
		sessionUpdate: vi.fn(async () => {}),
		signal: new AbortController().signal,
	} as unknown as acp.AgentSideConnection;
	return conn;
}

function createMockOrchestrator(): SessionOrchestrator {
	return {
		newSession: vi.fn(async (_cwd: string) => "sess-abc123"),
		loadSession: vi.fn((_sessionId: string) => ({
			sessionId: "sess-abc123",
			cwd: "/project",
			title: null,
			state: "active",
			folder: "/tmp/sessions/sess-abc123",
			createdAt: "2026-01-01T00:00:00.000Z",
		})),
		getMessages: vi.fn((_sessionId: string) => []),
		listSessions: vi.fn((_cwd?: string) => [
			{
				sessionId: "sess-abc123",
				cwd: "/project",
				title: "Test Session",
				state: "active",
				folder: "/tmp/sessions/sess-abc123",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		]),
		closeSession: vi.fn(async (_sessionId: string) => {}),
		prompt: vi.fn(async (_sessionId: string, _prompt: acp.ContentBlock[]) => ({
			stopReason: "end_turn" as const,
		})),
		shutdown: vi.fn(async () => {}),
		isActive: vi.fn((_sessionId: string) => true),
		getMode: vi.fn(() => "code"),
		setMode: vi.fn(),
	} as unknown as SessionOrchestrator;
}

function createMockScheduler(): TaskScheduler {
	return {
		createTask: vi.fn((_sessionId: string, _prompt: string, _schedule: unknown) => ({
			id: "task-001",
			sessionId: "sess-abc123",
			prompt: "do something",
			schedule: { type: "once", at: "2026-06-01T00:00:00Z" },
			status: "pending",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastRunAt: null,
			nextRunAt: "2026-06-01T00:00:00Z",
		})),
		listTasks: vi.fn((_sessionId?: string) => [
			{
				id: "task-001",
				sessionId: "sess-abc123",
				prompt: "do something",
				schedule: { type: "once", at: "2026-06-01T00:00:00Z" },
				status: "pending",
				createdAt: "2026-01-01T00:00:00.000Z",
				lastRunAt: null,
				nextRunAt: "2026-06-01T00:00:00Z",
			},
		]),
		cancelTask: vi.fn((_taskId: string) => {}),
		start: vi.fn(),
		stop: vi.fn(),
		processDueTasks: vi.fn(async () => {}),
	} as unknown as TaskScheduler;
}

// ── Test suite ──────────────────────────────────────────────────────

describe("SwapClawAgent", () => {
	let agent: SwapClawAgent;
	let conn: acp.AgentSideConnection;
	let orchestrator: SessionOrchestrator;
	let scheduler: TaskScheduler;

	beforeEach(() => {
		conn = createMockConnection();
		orchestrator = createMockOrchestrator();
		scheduler = createMockScheduler();
		agent = new SwapClawAgent(orchestrator, conn, scheduler);
	});

	// ── initialize() ────────────────────────────────────────────────

	describe("initialize()", () => {
		it("returns protocol version and capabilities", async () => {
			const result = await agent.initialize({
				protocolVersion: 1,
			} as acp.InitializeRequest);

			expect(result.protocolVersion).toBe(1);
			expect(result.agentCapabilities).toMatchObject({
				loadSession: true,
				sessionCapabilities: {
					close: {},
					list: {},
				},
			});
		});

		it("stores client capabilities", async () => {
			await agent.initialize({
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: true },
					terminal: true,
				},
			} as unknown as acp.InitializeRequest);

			// No direct accessor; just verify it doesn't throw.
			// The capabilities are used internally by prompt().
		});
	});

	// ── authenticate() ──────────────────────────────────────────────

	describe("authenticate()", () => {
		it("returns empty object (no auth for local stdio)", async () => {
			const result = await agent.authenticate({} as acp.AuthenticateRequest);
			expect(result).toEqual({});
		});
	});

	// ── newSession() ────────────────────────────────────────────────

	describe("newSession()", () => {
		it("delegates to orchestrator.newSession()", async () => {
			const result = await agent.newSession({
				cwd: "/project",
				mcpServers: [],
			} as acp.NewSessionRequest);

			expect(result.sessionId).toBe("sess-abc123");
			expect(orchestrator.newSession).toHaveBeenCalledWith("/project", []);
		});

		it("extracts and passes mcpServers", async () => {
			const result = await agent.newSession({
				cwd: "/project",
				mcpServers: [
					{
						name: "test-server",
						command: "test-cmd",
						args: ["--flag"],
						env: [],
					},
				],
			} as acp.NewSessionRequest);

			expect(result.sessionId).toBe("sess-abc123");
			expect(orchestrator.newSession).toHaveBeenCalledWith("/project", [
				{ name: "test-server", command: "test-cmd", args: ["--flag"] },
			]);
		});
	});

	// ── loadSession() ───────────────────────────────────────────────

	describe("loadSession()", () => {
		it("delegates to orchestrator.loadSession()", async () => {
			const result = await agent.loadSession({
				sessionId: "sess-abc123",
				cwd: "/project",
				mcpServers: [],
			} as acp.LoadSessionRequest);

			expect(orchestrator.loadSession).toHaveBeenCalledWith("sess-abc123");
			expect(result).toEqual({});
		});

		it("throws when session not found", async () => {
			(orchestrator.loadSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("Session not found: nonexistent");
			});

			await expect(
				agent.loadSession({
					sessionId: "nonexistent",
					cwd: "/project",
					mcpServers: [],
				} as acp.LoadSessionRequest),
			).rejects.toThrow("Session not found: nonexistent");
		});

		it("replays history with correct session update types", async () => {
			(orchestrator.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
				{
					id: 1,
					session_id: "sess-abc123",
					role: "user",
					content: "Hello",
					created_at: "2026-01-01T00:00:00.000Z",
				},
				{
					id: 2,
					session_id: "sess-abc123",
					role: "assistant",
					content: "Hi there",
					created_at: "2026-01-01T00:00:01.000Z",
				},
			]);

			await agent.loadSession({
				sessionId: "sess-abc123",
				cwd: "/project",
				mcpServers: [],
			} as acp.LoadSessionRequest);

			expect(orchestrator.getMessages).toHaveBeenCalledWith("sess-abc123");
			expect(conn.sessionUpdate).toHaveBeenCalledTimes(2);
			expect(conn.sessionUpdate).toHaveBeenNthCalledWith(1, {
				sessionId: "sess-abc123",
				update: {
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: "Hello" },
				},
			});
			expect(conn.sessionUpdate).toHaveBeenNthCalledWith(2, {
				sessionId: "sess-abc123",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Hi there" },
				},
			});
		});

		it("does not call sessionUpdate when history is empty", async () => {
			(orchestrator.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([]);

			await agent.loadSession({
				sessionId: "sess-abc123",
				cwd: "/project",
				mcpServers: [],
			} as acp.LoadSessionRequest);

			expect(orchestrator.getMessages).toHaveBeenCalledWith("sess-abc123");
			expect(conn.sessionUpdate).not.toHaveBeenCalled();
		});
	});

	// ── listSessions() ──────────────────────────────────────────────

	describe("listSessions()", () => {
		it("delegates and maps format", async () => {
			const result = await agent.listSessions({
				cwd: "/project",
			} as acp.ListSessionsRequest);

			expect(orchestrator.listSessions).toHaveBeenCalledWith("/project");
			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0]).toMatchObject({
				sessionId: "sess-abc123",
				cwd: "/project",
				title: "Test Session",
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
		});

		it("passes undefined when cwd is null", async () => {
			await agent.listSessions({
				cwd: null,
			} as unknown as acp.ListSessionsRequest);

			expect(orchestrator.listSessions).toHaveBeenCalledWith(undefined);
		});
	});

	// ── prompt() ────────────────────────────────────────────────────

	describe("prompt()", () => {
		it("delegates with content blocks", async () => {
			const result = await agent.prompt({
				sessionId: "sess-abc123",
				prompt: [{ type: "text", text: "Say hello" }],
			} as acp.PromptRequest);

			expect(orchestrator.prompt).toHaveBeenCalledWith("sess-abc123", [
				{ type: "text", text: "Say hello" },
			]);
			expect(result.stopReason).toBe("end_turn");
		});

		it("throws for nonexistent session", async () => {
			(orchestrator.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("No active session: bad-id"),
			);

			await expect(
				agent.prompt({
					sessionId: "bad-id",
					prompt: [{ type: "text", text: "test" }],
				} as acp.PromptRequest),
			).rejects.toThrow("No active session: bad-id");
		});
	});

	// ── cancel() ────────────────────────────────────────────────────

	describe("cancel()", () => {
		it("is a no-op (does not throw)", async () => {
			await expect(
				agent.cancel({ sessionId: "sess-abc123" } as acp.CancelNotification),
			).resolves.toBeUndefined();
		});
	});

	// ── unstable_closeSession() ─────────────────────────────────────

	describe("unstable_closeSession()", () => {
		it("delegates to orchestrator.closeSession()", async () => {
			const result = await agent.unstable_closeSession({
				sessionId: "sess-abc123",
			} as acp.CloseSessionRequest);

			expect(orchestrator.closeSession).toHaveBeenCalledWith("sess-abc123");
			expect(result).toEqual({});
		});
	});

	// ── Error propagation ───────────────────────────────────────────

	describe("error propagation", () => {
		it("surfaces orchestrator errors from newSession()", async () => {
			(orchestrator.newSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Docker not running"),
			);

			await expect(
				agent.newSession({ cwd: "/project", mcpServers: [] } as acp.NewSessionRequest),
			).rejects.toThrow("Docker not running");
		});

		it("surfaces orchestrator errors from closeSession()", async () => {
			(orchestrator.closeSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Container stop failed"),
			);

			await expect(
				agent.unstable_closeSession({
					sessionId: "sess-abc123",
				} as acp.CloseSessionRequest),
			).rejects.toThrow("Container stop failed");
		});
	});

	// ── extMethod / extNotification ─────────────────────────────────

	describe("extMethod()", () => {
		it("swapclaw/getSessionMode returns mode from orchestrator", async () => {
			(orchestrator.getMode as ReturnType<typeof vi.fn>).mockReturnValue("ask");

			const result = await agent.extMethod("swapclaw/getSessionMode", {
				sessionId: "sess-abc123",
			});

			expect(orchestrator.getMode).toHaveBeenCalledWith("sess-abc123");
			expect(result).toEqual({ mode: "ask" });
		});

		it("swapclaw/setSessionMode calls orchestrator.setMode and sends sessionUpdate", async () => {
			const result = await agent.extMethod("swapclaw/setSessionMode", {
				sessionId: "sess-abc123",
				mode: "architect",
			});

			expect(orchestrator.setMode).toHaveBeenCalledWith("sess-abc123", "architect");
			expect(conn.sessionUpdate).toHaveBeenCalledWith({
				sessionId: "sess-abc123",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Mode changed to architect" },
				},
			});
			expect(result).toEqual({ mode: "architect" });
		});

		it("swapclaw/setSessionMode with invalid mode throws error", async () => {
			(orchestrator.setMode as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("Invalid session mode: invalid");
			});

			await expect(
				agent.extMethod("swapclaw/setSessionMode", {
					sessionId: "sess-abc123",
					mode: "invalid",
				}),
			).rejects.toThrow("Invalid session mode: invalid");
		});

		it("throws RequestError for unknown methods", async () => {
			await expect(agent.extMethod("test.method", { key: "value" })).rejects.toThrow(RequestError);
		});

		it("swapclaw/createTask delegates to scheduler.createTask()", async () => {
			const result = await agent.extMethod("swapclaw/createTask", {
				sessionId: "sess-abc123",
				prompt: "do something",
				schedule: { type: "once", at: "2026-06-01T00:00:00Z" },
			});

			expect(scheduler.createTask).toHaveBeenCalledWith("sess-abc123", "do something", {
				type: "once",
				at: "2026-06-01T00:00:00Z",
			});
			expect(result).toMatchObject({ id: "task-001", sessionId: "sess-abc123" });
		});

		it("swapclaw/listTasks delegates to scheduler.listTasks()", async () => {
			const result = await agent.extMethod("swapclaw/listTasks", {
				sessionId: "sess-abc123",
			});

			expect(scheduler.listTasks).toHaveBeenCalledWith("sess-abc123");
			expect(result).toMatchObject({
				tasks: [{ id: "task-001", sessionId: "sess-abc123" }],
			});
		});

		it("swapclaw/listTasks works without sessionId", async () => {
			await agent.extMethod("swapclaw/listTasks", {});

			expect(scheduler.listTasks).toHaveBeenCalledWith(undefined);
		});

		it("swapclaw/cancelTask delegates to scheduler.cancelTask()", async () => {
			const result = await agent.extMethod("swapclaw/cancelTask", {
				taskId: "task-001",
			});

			expect(scheduler.cancelTask).toHaveBeenCalledWith("task-001");
			expect(result).toEqual({});
		});

		it("throws RequestError when scheduler is not configured", async () => {
			const agentNoScheduler = new SwapClawAgent(orchestrator, conn);

			await expect(
				agentNoScheduler.extMethod("swapclaw/createTask", {
					sessionId: "sess-abc123",
					prompt: "test",
					schedule: { type: "once" },
				}),
			).rejects.toThrow(RequestError);

			await expect(agentNoScheduler.extMethod("swapclaw/listTasks", {})).rejects.toThrow(
				RequestError,
			);

			await expect(
				agentNoScheduler.extMethod("swapclaw/cancelTask", {
					taskId: "task-001",
				}),
			).rejects.toThrow(RequestError);
		});
	});

	// ── extMethod validation ────────────────────────────────────────

	describe("extMethod validation", () => {
		it("throws RequestError for unknown method", async () => {
			await expect(agent.extMethod("swapclaw/nonexistent", {})).rejects.toThrow(RequestError);
			await expect(agent.extMethod("swapclaw/nonexistent", {})).rejects.toMatchObject({
				code: -32601,
			});
		});

		it("throws RequestError when sessionId is not a string in getSessionMode", async () => {
			await expect(agent.extMethod("swapclaw/getSessionMode", { sessionId: 123 })).rejects.toThrow(
				RequestError,
			);
			await expect(
				agent.extMethod("swapclaw/getSessionMode", { sessionId: 123 }),
			).rejects.toMatchObject({ code: -32602 });
		});

		it("throws RequestError when mode is not a string in setSessionMode", async () => {
			await expect(
				agent.extMethod("swapclaw/setSessionMode", {
					sessionId: "sess-abc123",
					mode: 42,
				}),
			).rejects.toThrow(RequestError);
			await expect(
				agent.extMethod("swapclaw/setSessionMode", {
					sessionId: "sess-abc123",
					mode: 42,
				}),
			).rejects.toMatchObject({ code: -32602 });
		});

		it("throws RequestError for scheduler methods when scheduler is not configured", async () => {
			const agentNoScheduler = new SwapClawAgent(orchestrator, conn);

			await expect(
				agentNoScheduler.extMethod("swapclaw/createTask", {
					sessionId: "sess-abc123",
					prompt: "test",
					schedule: { type: "once" },
				}),
			).rejects.toThrow(RequestError);
			await expect(
				agentNoScheduler.extMethod("swapclaw/createTask", {
					sessionId: "sess-abc123",
					prompt: "test",
					schedule: { type: "once" },
				}),
			).rejects.toMatchObject({ code: -32601 });

			await expect(agentNoScheduler.extMethod("swapclaw/listTasks", {})).rejects.toThrow(
				RequestError,
			);
			await expect(agentNoScheduler.extMethod("swapclaw/listTasks", {})).rejects.toMatchObject({
				code: -32601,
			});

			await expect(
				agentNoScheduler.extMethod("swapclaw/cancelTask", { taskId: "task-001" }),
			).rejects.toThrow(RequestError);
			await expect(
				agentNoScheduler.extMethod("swapclaw/cancelTask", { taskId: "task-001" }),
			).rejects.toMatchObject({ code: -32601 });
		});
	});

	describe("extNotification()", () => {
		it("does nothing and returns void", async () => {
			await expect(agent.extNotification("test.notify", { key: "value" })).resolves.toBeUndefined();
		});
	});
});
