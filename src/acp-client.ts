import type * as acp from "@agentclientprotocol/sdk";
import type { FilesystemManager } from "./filesystem-manager.js";
import type { TerminalManager } from "./terminal-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback invoked on each session update from the agent. */
export type SessionUpdateHandler = (params: acp.SessionNotification) => void | Promise<void>;

// ---------------------------------------------------------------------------
// SwapClawClient
// ---------------------------------------------------------------------------

/**
 * ACP Client implementation for swapclaw.
 *
 * Routes agent callbacks into a Docker container:
 * - Terminal operations → `TerminalManager` → `docker exec`
 * - File operations → `FilesystemManager` → `docker exec`
 * - Permission requests → auto-approve (container provides isolation)
 * - Session updates → forwarded to an optional handler
 *
 * The client is constructed with a `containerId` (provided by the
 * `ContainerRunner`) and an optional session update handler for
 * persistence and UI delivery.
 */
export class SwapClawClient implements acp.Client {
	constructor(
		private readonly terminalManager: TerminalManager,
		private readonly fsManager: FilesystemManager,
		private readonly sessionUpdateHandler?: SessionUpdateHandler,
	) {}

	// ── Required callbacks ───────────────────────────────────────────

	/**
	 * Auto-approve permission requests.
	 *
	 * Container isolation provides the security boundary, so all
	 * operations inside the sandbox are safe to approve. Selects the
	 * first option (typically "allow_once").
	 */
	async requestPermission(
		params: acp.RequestPermissionRequest,
	): Promise<acp.RequestPermissionResponse> {
		const firstOption = params.options[0];
		return {
			outcome: { outcome: "selected", optionId: firstOption.optionId },
		};
	}

	/**
	 * Forward session updates to the registered handler.
	 *
	 * Session updates include agent message chunks, tool call progress,
	 * plans, and usage information. The handler can persist these for
	 * session replay or forward them to a UI.
	 */
	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		if (this.sessionUpdateHandler) {
			await this.sessionUpdateHandler(params);
		}
	}

	// ── Terminal callbacks ───────────────────────────────────────────

	async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
		return this.terminalManager.create(params);
	}

	async terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
		return this.terminalManager.getOutput(params.terminalId);
	}

	async waitForTerminalExit(
		params: acp.WaitForTerminalExitRequest,
	): Promise<acp.WaitForTerminalExitResponse> {
		return this.terminalManager.waitForExit(params.terminalId);
	}

	async killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
		return this.terminalManager.kill(params.terminalId);
	}

	async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
		return this.terminalManager.release(params.terminalId);
	}

	// ── Filesystem callbacks ────────────────────────────────────────

	async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
		const content = await this.fsManager.read(params.path, params.line, params.limit);
		return { content };
	}

	async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
		await this.fsManager.write(params.path, params.content);
		return {};
	}

	// ── Extension callbacks ─────────────────────────────────────────

	async extMethod(
		_method: string,
		_params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return {};
	}

	async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {
		// No-op for unrecognised notifications.
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	/** Release all terminals and free resources. */
	cleanup(): void {
		this.terminalManager.releaseAll();
	}
}
