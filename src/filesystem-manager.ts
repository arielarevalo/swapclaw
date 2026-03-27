import { RequestError } from "@agentclientprotocol/sdk";
import type { ContainerExec } from "./container-exec.js";

// ---------------------------------------------------------------------------
// FilesystemManager
// ---------------------------------------------------------------------------

/**
 * Routes readTextFile / writeTextFile into a Docker container via
 * `docker exec`.
 *
 * All operations are async (using `spawn` with Promises) to avoid blocking
 * the event loop. Parent directories are auto-created on write.
 */
export class FilesystemManager {
	constructor(
		private readonly containerId: string,
		private readonly exec: ContainerExec,
	) {}

	/**
	 * Read a file from inside the container via `ContainerExec`.
	 *
	 * Supports optional `line` (1-based start) and `limit` (max lines)
	 * parameters by delegating to `sed` or `head` inside the container.
	 */
	async read(path: string, line?: number | null, limit?: number | null): Promise<string> {
		if (line != null && line < 1) {
			throw new RequestError(-32001, `Invalid line: ${line} (must be >= 1)`);
		}
		if (limit != null && limit < 1) {
			throw new RequestError(-32001, `Invalid limit: ${limit} (must be >= 1)`);
		}

		let command: string;
		let args: string[];

		if (line != null && limit != null) {
			const endLine = line + limit - 1;
			command = "sed";
			args = ["-n", `${line},${endLine}p`, path];
		} else if (line != null) {
			command = "sed";
			args = ["-n", `${line},$p`, path];
		} else if (limit != null) {
			command = "head";
			args = ["-n", String(limit), path];
		} else {
			command = "cat";
			args = [path];
		}

		try {
			return await this.spawnAndCollect({ containerId: this.containerId, command, args });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new RequestError(-32001, `Failed to read file ${path}: ${message}`);
		}
	}

	/**
	 * Write a file inside the container via `ContainerExec`.
	 *
	 * Auto-creates parent directories. Content is piped to stdin of
	 * `cat > <path>` inside the container.
	 */
	async write(path: string, content: string): Promise<void> {
		// Ensure parent directory exists.
		const parentDir = path.replace(/\/[^/]+$/, "");
		if (parentDir && parentDir !== path) {
			try {
				await this.spawnAndCollect({
					containerId: this.containerId,
					command: "mkdir",
					args: ["-p", parentDir],
				});
			} catch {
				// Ignore mkdir failure — the write itself will report the error.
			}
		}

		// Write content by piping to stdin.
		const escaped = this.escapePath(path);
		try {
			await this.spawnWithStdin(
				{
					containerId: this.containerId,
					command: "sh",
					args: ["-c", `cat > '${escaped}'`],
					interactive: true,
				},
				content,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new RequestError(-32001, `Failed to write file ${path}: ${message}`);
		}
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/** Escape single quotes in paths for shell commands. */
	private escapePath(path: string): string {
		return path.replace(/'/g, "'\\''");
	}

	/** Spawn a command in the container and return stdout as a string. */
	private spawnAndCollect(opts: {
		containerId: string;
		command: string;
		args?: string[];
	}): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc = this.exec.spawn(opts);

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				if (code === 0) {
					resolve(stdout);
				} else {
					reject(new Error(stderr || `Process exited with code ${code}`));
				}
			});

			proc.on("error", (err) => {
				reject(err);
			});
		});
	}

	/** Spawn a command in the container with content piped to stdin. */
	private spawnWithStdin(
		opts: {
			containerId: string;
			command: string;
			args?: string[];
			interactive?: boolean;
		},
		input: string,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc = this.exec.spawn(opts);

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				if (code === 0) {
					resolve(stdout);
				} else {
					reject(new Error(stderr || `Process exited with code ${code}`));
				}
			});

			proc.on("error", (err) => {
				reject(err);
			});

			proc.stdin?.write(input);
			proc.stdin?.end();
		});
	}
}
