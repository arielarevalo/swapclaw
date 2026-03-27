import * as acp from "@agentclientprotocol/sdk";
import type { MessageRow } from "./db.js";
import { fromAcpMcpServers } from "./mcp-passthrough.js";
import type { SessionOrchestrator } from "./session-orchestrator.js";
import type { TaskSchedule, TaskScheduler } from "./task-scheduler.js";

// ── Types ───────────────────────────────────────────────────────────

/** Client capabilities stored at initialization. */
interface StoredClientCapabilities {
	fs?: acp.FileSystemCapabilities;
	terminal?: boolean;
}

// ── SwapClawAgent ────────────────────────────────────────────────────

/**
 * ACP agent that delegates all session and prompt operations to the
 * SessionOrchestrator. The orchestrator handles container lifecycle,
 * agent process management, and ACP client connections.
 */
export class SwapClawAgent implements acp.Agent {
	private clientCapabilities: StoredClientCapabilities = {};

	constructor(
		private readonly orchestrator: SessionOrchestrator,
		private readonly connection: acp.AgentSideConnection,
		private readonly scheduler?: TaskScheduler,
	) {}

	// ── Lifecycle ─────────────────────────────────────────────────────

	async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		// Store client capabilities for later use.
		if (params.clientCapabilities) {
			this.clientCapabilities = {
				fs: params.clientCapabilities.fs,
				terminal: params.clientCapabilities.terminal,
			};
		}

		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: {
					close: {},
					list: {},
				},
			},
		};
	}

	// biome-ignore lint/suspicious/noConfusingVoidType: SDK interface requires void union
	async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse | void> {
		return {};
	}

	// ── Session management ────────────────────────────────────────────

	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		// Extract MCP server configs if provided.
		const raw = params as Record<string, unknown>;
		const mcpServers = raw.mcpServers
			? fromAcpMcpServers(raw.mcpServers as acp.McpServer[])
			: undefined;
		const sessionId = await this.orchestrator.newSession(params.cwd, mcpServers);
		return { sessionId };
	}

	async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		// Verify session exists.
		this.orchestrator.loadSession(params.sessionId);

		// Replay persisted message history so the client sees prior conversation.
		const messages: MessageRow[] = this.orchestrator.getMessages(params.sessionId);
		for (const msg of messages) {
			await this.connection.sessionUpdate({
				sessionId: params.sessionId,
				update: {
					sessionUpdate: msg.role === "user" ? "user_message_chunk" : "agent_message_chunk",
					content: { type: "text", text: msg.content },
				} as acp.SessionUpdate,
			});
		}

		return {};
	}

	async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		const sessions = this.orchestrator.listSessions(params.cwd ?? undefined);
		return {
			sessions: sessions.map((s) => ({
				sessionId: s.sessionId,
				cwd: s.cwd,
				title: s.title,
				updatedAt: s.createdAt,
			})),
		};
	}

	async unstable_closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
		await this.orchestrator.closeSession(params.sessionId);
		return {};
	}

	// ── Prompt processing ─────────────────────────────────────────────

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		return this.orchestrator.prompt(params.sessionId, params.prompt);
	}

	// ── Cancellation ──────────────────────────────────────────────────

	async cancel(params: acp.CancelNotification): Promise<void> {
		await this.orchestrator.cancel(params.sessionId);
	}

	// ── Extensions ───────────────────────────────────────────────────

	async extMethod(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		switch (method) {
			case "swapclaw/getSessionMode": {
				const sessionId = requireString(params, "sessionId");
				const mode = this.orchestrator.getMode(sessionId);
				return { mode };
			}
			case "swapclaw/setSessionMode": {
				const sessionId = requireString(params, "sessionId");
				const mode = requireString(params, "mode");
				this.orchestrator.setMode(sessionId, mode);
				await this.connection.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `Mode changed to ${mode}` },
					},
				});
				return { mode };
			}
			case "swapclaw/createTask": {
				const sched = this.requireScheduler();
				const sessionId = requireString(params, "sessionId");
				const prompt = requireString(params, "prompt");
				const schedule = requireSchedule(params);
				const task = sched.createTask(sessionId, prompt, schedule);
				return task as unknown as Record<string, unknown>;
			}
			case "swapclaw/listTasks": {
				const sched = this.requireScheduler();
				const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
				const tasks = sched.listTasks(sessionId);
				return { tasks } as unknown as Record<string, unknown>;
			}
			case "swapclaw/cancelTask": {
				const sched = this.requireScheduler();
				const taskId = requireString(params, "taskId");
				sched.cancelTask(taskId);
				return {};
			}
			default:
				throw new acp.RequestError(-32601, `Unknown extension method: ${method}`);
		}
	}

	async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {}

	private requireScheduler(): TaskScheduler {
		if (!this.scheduler) {
			throw new acp.RequestError(-32601, "Task scheduler is not configured");
		}
		return this.scheduler;
	}
}

// ── Param validation helpers ────────────────────────────────────────

/** Extract a required string param or throw RequestError(-32602). */
function requireString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string") {
		throw new acp.RequestError(-32602, `Missing or invalid param: ${key} must be a string`);
	}
	return value;
}

/** Extract and validate the schedule param or throw RequestError(-32602). */
function requireSchedule(params: Record<string, unknown>): TaskSchedule {
	const schedule = params.schedule;
	if (
		typeof schedule !== "object" ||
		schedule === null ||
		!("type" in schedule) ||
		typeof (schedule as Record<string, unknown>).type !== "string"
	) {
		throw new acp.RequestError(
			-32602,
			"Missing or invalid param: schedule must be an object with a type field",
		);
	}
	return schedule as TaskSchedule;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Extract plain text from a PromptRequest's content blocks. */
export function extractPromptText(params: acp.PromptRequest): string {
	return params.prompt
		.filter((block): block is acp.TextContent & { type: "text" } => block.type === "text")
		.map((block) => block.text)
		.join("");
}
