import { type SpawnOptions, execFile, spawn } from "node:child_process";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A bind-mount mapping between host and container paths. */
export interface VolumeMount {
	hostPath: string;
	containerPath: string;
	readonly: boolean;
}

/** Result of spawning a container. */
export interface SpawnResult {
	/** Container identifier (the assigned name). */
	containerId: string;
}

/** Default keep-alive command for sandbox containers. */
export const SANDBOX_KEEPALIVE_CMD = ["sleep", "infinity"];

/** Options for spawning a container. */
export interface SpawnOpts {
	/** Container image to run. */
	image: string;
	/** Container name for identification. */
	name: string;
	/** Volume mounts. */
	mounts: VolumeMount[];
	/** Environment variables to inject. */
	env: Record<string, string>;
	/** Optional command to run inside the container. */
	cmd?: string[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Abstraction over container runtimes (Docker, Apple Container). */
export interface ContainerRuntime {
	/** Verify the runtime daemon/CLI is available. Throws if not. */
	ensureRunning(): Promise<void>;

	/** Spawn a new detached container and return its ID. */
	spawn(opts: SpawnOpts): Promise<SpawnResult>;

	/** Stop a running container (SIGTERM, grace period, then SIGKILL). */
	stop(containerId: string): Promise<void>;

	/** Force-remove a container. */
	remove(containerId: string): Promise<void>;

	/** Check whether a container is currently running. */
	isRunning(containerId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Promisified execFile for one-shot commands. */
function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, (error, stdout, stderr) => {
			if (error) {
				reject(error);
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

// ---------------------------------------------------------------------------
// DockerRuntime
// ---------------------------------------------------------------------------

/** Container runtime backed by the Docker CLI. */
export class DockerRuntime implements ContainerRuntime {
	async ensureRunning(): Promise<void> {
		try {
			await execFileAsync("docker", ["info"]);
		} catch {
			throw new Error("Docker daemon is not running. Start Docker Desktop or the dockerd service.");
		}
	}

	/** Build `docker run` arguments from SpawnOpts. */
	buildRunArgs(opts: SpawnOpts): string[] {
		const args: string[] = ["run", "-d", "--rm", "--name", opts.name];

		for (const mount of opts.mounts) {
			const suffix = mount.readonly ? ":ro" : "";
			args.push("-v", `${mount.hostPath}:${mount.containerPath}${suffix}`);
		}

		for (const [key, value] of Object.entries(opts.env)) {
			args.push("-e", `${key}=${value}`);
		}

		args.push(opts.image);

		const cmd = opts.cmd ?? SANDBOX_KEEPALIVE_CMD;
		args.push(...cmd);

		return args;
	}

	async spawn(opts: SpawnOpts): Promise<SpawnResult> {
		const args = this.buildRunArgs(opts);
		const spawnOpts: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"] };
		const child = spawn("docker", args, spawnOpts);

		// Wait for docker run -d to print the container ID and exit.
		return new Promise((resolve, reject) => {
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => {
				if (code === 0) {
					resolve({ containerId: opts.name });
				} else {
					reject(new Error(`docker run failed (exit ${code}): ${stderr.trim()}`));
				}
			});
			child.on("error", reject);
		});
	}

	async stop(containerId: string): Promise<void> {
		try {
			await execFileAsync("docker", ["stop", "--time=10", containerId]);
		} catch {
			// Container may have already exited; force kill just in case.
			try {
				await execFileAsync("docker", ["kill", containerId]);
			} catch {
				// Already gone — nothing to do.
			}
		}
	}

	async remove(containerId: string): Promise<void> {
		try {
			await execFileAsync("docker", ["rm", "-f", containerId]);
		} catch {
			// Container may already be removed (--rm flag).
		}
	}

	async isRunning(containerId: string): Promise<boolean> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect",
				"--format={{.State.Running}}",
				containerId,
			]);
			return stdout.trim() === "true";
		} catch {
			return false;
		}
	}
}

// ---------------------------------------------------------------------------
// AppleContainerRuntime
// ---------------------------------------------------------------------------

/** Container runtime backed by Apple's `container` CLI. */
export class AppleContainerRuntime implements ContainerRuntime {
	async ensureRunning(): Promise<void> {
		try {
			await execFileAsync("which", ["container"]);
		} catch {
			throw new Error(
				"Apple Container CLI not found. Ensure the 'container' command is installed and on PATH.",
			);
		}
	}

	/** Build `container run` arguments from SpawnOpts. */
	buildRunArgs(opts: SpawnOpts): string[] {
		const args: string[] = ["run", "--detach", "--name", opts.name];

		for (const mount of opts.mounts) {
			const suffix = mount.readonly ? ":ro" : "";
			args.push("--mount", `src=${mount.hostPath},dst=${mount.containerPath}${suffix}`);
		}

		for (const [key, value] of Object.entries(opts.env)) {
			args.push("--env", `${key}=${value}`);
		}

		args.push(opts.image);

		const cmd = opts.cmd ?? SANDBOX_KEEPALIVE_CMD;
		args.push(...cmd);

		return args;
	}

	async spawn(opts: SpawnOpts): Promise<SpawnResult> {
		const args = this.buildRunArgs(opts);
		const spawnOpts: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"] };
		const child = spawn("container", args, spawnOpts);

		// Wait for container run --detach to print the container ID and exit.
		return new Promise((resolve, reject) => {
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => {
				if (code === 0) {
					resolve({ containerId: opts.name });
				} else {
					reject(new Error(`container run failed (exit ${code}): ${stderr.trim()}`));
				}
			});
			child.on("error", reject);
		});
	}

	async stop(containerId: string): Promise<void> {
		try {
			await execFileAsync("container", ["stop", containerId]);
		} catch {
			// Container may have already exited.
		}
	}

	async remove(containerId: string): Promise<void> {
		try {
			await execFileAsync("container", ["rm", containerId]);
		} catch {
			// Container may already be removed.
		}
	}

	async isRunning(containerId: string): Promise<boolean> {
		try {
			await execFileAsync("container", ["inspect", containerId]);
			return true;
		} catch {
			return false;
		}
	}
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/**
 * Detect the best available container runtime for the current platform.
 *
 * - macOS: try Apple Container first, fall back to Docker.
 * - Linux: Docker only.
 * - Throws if no runtime is available.
 */
export async function detectRuntime(_config: Config): Promise<ContainerRuntime> {
	if (process.platform === "darwin") {
		const apple = new AppleContainerRuntime();
		try {
			await apple.ensureRunning();
			return apple;
		} catch {
			// Fall through to Docker.
		}
	}

	const docker = new DockerRuntime();
	try {
		await docker.ensureRunning();
		return docker;
	} catch {
		throw new Error(
			`No container runtime available on ${process.platform}. ${process.platform === "darwin" ? "Install Docker Desktop or Apple Container CLI." : "Install and start Docker."}`,
		);
	}
}
