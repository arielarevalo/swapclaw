import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { type SessionUpdateHandler, SwapClawClient } from "./acp-client.js";
import type { ContainerExec } from "./container-exec.js";
import { FilesystemManager } from "./filesystem-manager.js";
import { TerminalManager } from "./terminal-manager.js";

/** Factory for creating ACP clients. Defaults to SwapClawClient constructor. */
export type ClientFactory = (
	containerId: string,
	exec: ContainerExec,
	handler?: SessionUpdateHandler,
) => SwapClawClient;

/** State returned by a successful connect(). */
export interface AgentConnection {
	connection: acp.ClientSideConnection;
	client: SwapClawClient;
	agentProcess: ChildProcess;
	agentSessionId: string;
	messageCollector: string[];
}

/** Callback type for session update notifications. */
export type SessionUpdateCallback = (update: acp.SessionUpdate) => void;

/**
 * Manages the lifecycle of agent child processes and their ACP connections.
 *
 * Encapsulates: process spawning, stdio stream setup, ACP client creation,
 * connection initialization, and agent session creation.
 */
export class AgentProcessManager {
	private readonly createClient: ClientFactory;

	constructor(
		private readonly agentCommand: string,
		private readonly agentArgs: string[],
		private readonly exec: ContainerExec,
		createClient?: ClientFactory,
	) {
		this.createClient =
			createClient ??
			((id, containerExec, handler) => {
				const tm = new TerminalManager(id, containerExec);
				const fm = new FilesystemManager(id, containerExec);
				return new SwapClawClient(tm, fm, handler);
			});
	}

	/**
	 * Spawn an agent process, connect via ACP, initialize, and create an
	 * agent session.
	 *
	 * @param containerId - The container to route agent callbacks into.
	 * @param cwd - Working directory for the agent session.
	 * @param onUpdate - Optional callback for session update notifications.
	 * @returns The connected agent state.
	 */
	async connect(
		containerId: string,
		cwd: string,
		onUpdate?: SessionUpdateCallback,
	): Promise<AgentConnection> {
		// 1. Spawn external agent process.
		const agentProcess = spawn(this.agentCommand, this.agentArgs, {
			stdio: ["pipe", "pipe", "inherit"],
		});

		if (!agentProcess.stdin || !agentProcess.stdout) {
			agentProcess.kill();
			throw new Error("Failed to get agent process stdio");
		}

		// 2. Set up ACP stream.
		const messageCollector: string[] = [];

		const clientInput = Writable.toWeb(agentProcess.stdin) as WritableStream<Uint8Array>;
		const clientOutput = Readable.toWeb(
			agentProcess.stdout,
		) as unknown as ReadableStream<Uint8Array>;
		const stream = acp.ndJsonStream(clientInput, clientOutput);

		// 3. Create SwapClawClient with session update handler.
		const client = this.createClient(containerId, this.exec, (params) => {
			const update = params.update;
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
				messageCollector.push(update.content.text);
			}
			onUpdate?.(params.update);
		});

		const connection = new acp.ClientSideConnection((_agent) => client, stream);

		// 4. Initialize with full capabilities.
		await connection.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {
				terminal: true,
				fs: {
					readTextFile: true,
					writeTextFile: true,
				},
			},
		});

		// 5. Create agent session.
		const agentSession = await connection.newSession({
			cwd,
			mcpServers: [],
		});

		return {
			connection,
			client,
			agentProcess,
			agentSessionId: agentSession.sessionId,
			messageCollector,
		};
	}

	/**
	 * Cancel any active prompt, clean up the client, and kill the agent
	 * process.
	 */
	disconnect(conn: AgentConnection): void {
		// 1. Cancel any active prompt (fire-and-forget).
		try {
			void conn.connection.cancel({ sessionId: conn.agentSessionId }).catch(() => {});
		} catch {
			// Ignore cancel errors (prompt may not be active).
		}

		// 2. SwapClawClient cleanup (release all terminals).
		conn.client.cleanup();

		// 3. Kill the agent process.
		if (!conn.agentProcess.killed) {
			conn.agentProcess.kill();
		}
	}
}
