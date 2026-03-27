import type { Config } from "./config.js";
import type { ContainerRuntime, SpawnResult } from "./container-runtime.js";
import { buildMcpEnvVars, readMcpConfigs } from "./mcp-passthrough.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handle to a running detached sandbox container. */
export interface ContainerHandle {
	/** Container identifier (matches the runtime's assigned name). */
	containerId: string;
	/** Human-readable container name. */
	containerName: string;
	/** When the container was started. */
	startedAt: Date;
}

/** Internal entry that pairs a handle with its idle timer. */
interface RunnerEntry {
	handle: ContainerHandle;
	idleTimer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// ContainerRunner
// ---------------------------------------------------------------------------

/**
 * Manages container lifecycle per session.
 *
 * Each session gets a dedicated container that is started on the first
 * prompt, kept alive between prompts, and torn down after an idle timeout
 * or explicit stop.
 */
export class ContainerRunner {
	private readonly containers = new Map<string, RunnerEntry>();

	constructor(
		private readonly config: Config,
		private readonly runtime: ContainerRuntime,
	) {}

	/**
	 * Start a container for the given session.
	 *
	 * - Builds volume mounts and environment variables.
	 * - Reads MCP configs from the session folder and merges env vars.
	 * - Spawns the container via the runtime.
	 * - Starts the idle timer.
	 */
	async start(sessionId: string, cwd: string, sessionFolder: string): Promise<ContainerHandle> {
		// Build volume mounts.
		const mounts = [
			{ hostPath: cwd, containerPath: "/project", readonly: true },
			{ hostPath: sessionFolder, containerPath: "/session", readonly: false },
		];

		// Build environment variables.
		const env: Record<string, string> = {
			SESSION_ID: sessionId,
			TIMEZONE: this.config.timezone,
		};

		// Read MCP configs from session folder and merge env vars.
		const mcpConfigs = readMcpConfigs(sessionFolder);
		if (mcpConfigs.length > 0) {
			Object.assign(env, buildMcpEnvVars(mcpConfigs));
		}

		// Generate container name.
		const containerName = `swapclaw-${sessionId}-${Date.now()}`;

		// Spawn.
		const result: SpawnResult = await this.runtime.spawn({
			image: this.config.containerImage,
			name: containerName,
			mounts,
			env,
		});

		const handle: ContainerHandle = {
			containerId: result.containerId,
			containerName,
			startedAt: new Date(),
		};

		// Start idle timer and store entry.
		const idleTimer = this.startIdleTimer(sessionId);
		this.containers.set(sessionId, { handle, idleTimer });

		return handle;
	}

	/**
	 * Stop and remove a session's container.
	 */
	async stop(sessionId: string): Promise<void> {
		const entry = this.containers.get(sessionId);
		if (!entry) {
			return;
		}

		clearTimeout(entry.idleTimer);
		await this.runtime.stop(entry.handle.containerId);
		await this.runtime.remove(entry.handle.containerId);
		this.containers.delete(sessionId);
	}

	/** Get the handle for a running session, or undefined if none. */
	getHandle(sessionId: string): ContainerHandle | undefined {
		return this.containers.get(sessionId)?.handle;
	}

	/** Check whether a container is currently tracked for this session. */
	isRunning(sessionId: string): boolean {
		return this.containers.has(sessionId);
	}

	/** Reset the idle timer for a session (call on each prompt). */
	resetIdleTimer(sessionId: string): void {
		const entry = this.containers.get(sessionId);
		if (!entry) {
			return;
		}

		clearTimeout(entry.idleTimer);
		entry.idleTimer = this.startIdleTimer(sessionId);
	}

	/** Stop all running containers (for graceful shutdown). */
	async stopAll(): Promise<void> {
		const ids = [...this.containers.keys()];
		await Promise.all(ids.map((id) => this.stop(id)));
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private startIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			void this.stop(sessionId);
		}, this.config.idleTimeout);
	}
}
