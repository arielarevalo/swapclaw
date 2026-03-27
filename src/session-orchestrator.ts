import type * as acp from "@agentclientprotocol/sdk";
import type { AgentConnection, AgentProcessManager } from "./agent-process-manager.js";
import type { Config } from "./config.js";
import type { ContainerRunner } from "./container-runner.js";
import type { Database, MessageRow } from "./db.js";
import type { McpServerConfig } from "./mcp-passthrough.js";
import type { SessionInfo, SessionManager } from "./session-manager.js";
import { isValidMode } from "./session-modes.js";
import type { SessionMode } from "./session-modes.js";

// ── Types ───────────────────────────────────────────────────────────

/** State tracked for each active (connected) session. */
interface ActiveSession extends AgentConnection {
	/** Our internal session ID. */
	sessionId: string;
}

// ── SessionOrchestrator ─────────────────────────────────────────────

/**
 * Central coordinator that wires sessions to containers to ACP client
 * connections.
 *
 * On new session: create session -> start container -> connect agent ->
 *   store active session.
 * On prompt: forward to agent via client connection, persist messages.
 * On close: disconnect agent -> stop container -> close session.
 */
export class SessionOrchestrator {
	private readonly activeSessions = new Map<string, ActiveSession>();
	private sessionUpdateForwarder?: (
		sessionId: string,
		update: acp.SessionUpdate,
	) => void | Promise<void>;

	constructor(
		private readonly config: Config,
		private readonly db: Database,
		private readonly sessionManager: SessionManager,
		private readonly containerRunner: ContainerRunner,
		private readonly agentProcessManager: AgentProcessManager,
	) {}

	/**
	 * Register a callback to receive session updates as they arrive from
	 * the internal agent.  The forwarder is invoked with the *external*
	 * (our) session ID so the downstream client sees the ID it created.
	 */
	setSessionUpdateForwarder(
		fn: (sessionId: string, update: acp.SessionUpdate) => void | Promise<void>,
	): void {
		this.sessionUpdateForwarder = fn;
	}

	// ── Session lifecycle ───────────────────────────────────────────

	/**
	 * Create a new session: scaffold on disk, start container, connect
	 * agent process via AgentProcessManager, and store active session.
	 *
	 * @returns The internal session ID.
	 */
	async newSession(cwd: string, mcpServers?: McpServerConfig[]): Promise<string> {
		// 0. Capacity check — reject early if at max concurrent sessions.
		if (this.activeSessions.size >= this.config.maxConcurrent) {
			throw new Error(
				`At capacity: ${this.activeSessions.size}/${this.config.maxConcurrent} concurrent sessions`,
			);
		}

		// 1. Create session (DB + disk folder).
		const { sessionId, folder } = this.sessionManager.create(
			cwd,
			mcpServers ? { mcpServers } : undefined,
		);

		try {
			// 2. Start container.
			const handle = await this.containerRunner.start(sessionId, cwd, folder);

			// 3. Connect agent process (spawn, ACP stream, initialize, create session).
			const agentConn = await this.agentProcessManager.connect(
				handle.containerId,
				cwd,
				(update) => {
					this.sessionUpdateForwarder?.(sessionId, update);
				},
			);

			// 4. Store active session state.
			const active: ActiveSession = {
				sessionId,
				...agentConn,
			};
			this.activeSessions.set(sessionId, active);

			return sessionId;
		} catch (error) {
			// Clean up on failure: stop container and close session.
			await this.containerRunner.stop(sessionId).catch(() => {});
			this.sessionManager.close(sessionId);
			throw error;
		}
	}

	/**
	 * Send a prompt to the agent for a session.
	 *
	 * Persists the user message before sending and the assistant response
	 * after completion.
	 */
	async prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
		const active = this.getActive(sessionId);

		// Reset idle timer on activity.
		this.containerRunner.resetIdleTimer(sessionId);

		// Persist user message.
		const userText = prompt
			.filter((b) => b.type === "text")
			.map((b) => (b as acp.TextContent & { type: "text" }).text)
			.join("");
		this.db.addMessage(sessionId, "user", userText);

		// Clear collector before prompting.
		active.messageCollector.length = 0;

		// Forward to agent.
		const response = await active.connection.prompt({
			sessionId: active.agentSessionId,
			prompt,
		});

		// Persist assistant response.
		const assistantText = active.messageCollector.join("");
		if (assistantText.length > 0) {
			this.db.addMessage(sessionId, "assistant", assistantText);
		}

		return response;
	}

	/**
	 * Close a session: disconnect agent, stop container, close in DB.
	 */
	async closeSession(sessionId: string): Promise<void> {
		const active = this.activeSessions.get(sessionId);

		if (active) {
			// Disconnect agent (cancel, cleanup client, kill process).
			this.agentProcessManager.disconnect(active);

			// Remove from active sessions.
			this.activeSessions.delete(sessionId);
		}

		// Stop container.
		await this.containerRunner.stop(sessionId);

		// Close session in DB.
		this.sessionManager.close(sessionId);
	}

	/**
	 * Load session info from the database.
	 *
	 * Verifies the container is still running; if not, the session may
	 * need recovery (returned info will have state from DB).
	 */
	loadSession(sessionId: string): SessionInfo {
		return this.sessionManager.load(sessionId);
	}

	/**
	 * Retrieve persisted messages for a session (in chronological order).
	 */
	getMessages(sessionId: string): MessageRow[] {
		return this.db.getMessages(sessionId);
	}

	/**
	 * List sessions, optionally filtered by working directory.
	 */
	listSessions(cwd?: string): SessionInfo[] {
		return this.sessionManager.list(cwd);
	}

	/**
	 * Get the current mode for a session.
	 */
	getMode(sessionId: string): SessionMode {
		return this.sessionManager.getMode(sessionId);
	}

	/**
	 * Set the mode for a session.
	 */
	setMode(sessionId: string, mode: string): void {
		if (!isValidMode(mode)) {
			throw new Error(`Invalid session mode: ${mode}`);
		}
		this.sessionManager.setMode(sessionId, mode);
	}

	/**
	 * Graceful shutdown: close all active sessions.
	 */
	async shutdown(): Promise<void> {
		const sessionIds = [...this.activeSessions.keys()];
		await Promise.all(sessionIds.map((id) => this.closeSession(id)));
	}

	// ── Helpers ─────────────────────────────────────────────────────

	/** Check whether a session is active (has a live connection). */
	isActive(sessionId: string): boolean {
		return this.activeSessions.has(sessionId);
	}

	/** Get the active session state, or throw if not found. */
	private getActive(sessionId: string): ActiveSession {
		const active = this.activeSessions.get(sessionId);
		if (!active) {
			throw new Error(`No active session: ${sessionId}`);
		}
		return active;
	}
}
