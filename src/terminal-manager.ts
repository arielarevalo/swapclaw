import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ContainerExec } from "./container-exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tracked state for an active terminal (a running docker exec process). */
interface TerminalState {
	/** The child process running `docker exec`. */
	process: ChildProcess;
	/** Accumulated stdout + stderr. */
	outputBuffer: string;
	/** Maximum bytes to retain (from CreateTerminalRequest.outputByteLimit). */
	outputByteLimit: number | null;
	/** Whether output was truncated due to byte limit. */
	truncated: boolean;
	/** Resolved when the process exits. */
	exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
	/** Cached exit result after process finishes. */
	exitResult: { exitCode: number | null; signal: string | null } | null;
}

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

/**
 * Manages terminals by routing commands into a Docker container via
 * `docker exec`.
 *
 * Each terminal maps to a child process spawned with `docker exec`.
 * stdout and stderr are captured into an output buffer that respects
 * the optional byte limit by truncating from the beginning.
 */
export class TerminalManager {
	private readonly terminals = new Map<string, TerminalState>();
	private nextId = 1;

	constructor(
		private readonly containerId: string,
		private readonly exec: ContainerExec,
	) {}

	/**
	 * Create a terminal: spawn a command in the container via `ContainerExec`.
	 *
	 * Delegates arg-building and process spawning to the injected
	 * `ContainerExec` implementation and starts capturing output.
	 */
	create(params: acp.CreateTerminalRequest): acp.CreateTerminalResponse {
		const terminalId = `term-${this.nextId++}`;

		const proc = this.exec.spawn({
			containerId: this.containerId,
			command: params.command,
			args: params.args,
			cwd: params.cwd ?? undefined,
			env: params.env?.map((e) => ({ name: e.name, value: e.value })),
		});

		const state: TerminalState = {
			process: proc,
			outputBuffer: "",
			outputByteLimit: params.outputByteLimit ?? null,
			truncated: false,
			exitResult: null,
			exitPromise: new Promise((resolve) => {
				proc.on("close", (code, signal) => {
					const result = { exitCode: code, signal };
					state.exitResult = result;
					resolve(result);
				});
				proc.on("error", (err) => {
					const result = { exitCode: 1, signal: null };
					state.exitResult = result;
					state.outputBuffer += `\n[error] ${err.message}`;
					resolve(result);
				});
			}),
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			this.appendOutput(state, chunk.toString());
		});

		proc.stderr?.on("data", (chunk: Buffer) => {
			this.appendOutput(state, chunk.toString());
		});

		this.terminals.set(terminalId, state);
		return { terminalId };
	}

	/** Get current output (non-blocking). */
	getOutput(terminalId: string): acp.TerminalOutputResponse {
		const state = this.getTerminal(terminalId);
		const response: acp.TerminalOutputResponse = {
			output: state.outputBuffer,
			truncated: state.truncated,
		};
		if (state.exitResult) {
			response.exitStatus = {
				exitCode: state.exitResult.exitCode,
				signal: state.exitResult.signal,
			};
		}
		return response;
	}

	/** Wait for the terminal process to exit. */
	async waitForExit(terminalId: string): Promise<acp.WaitForTerminalExitResponse> {
		const state = this.getTerminal(terminalId);
		const result = await state.exitPromise;
		return { exitCode: result.exitCode, signal: result.signal };
	}

	/** Kill the terminal process (keep terminal valid). */
	kill(terminalId: string): acp.KillTerminalResponse {
		const state = this.getTerminal(terminalId);
		if (!state.exitResult) {
			state.process.kill("SIGTERM");
		}
		return {};
	}

	/** Release the terminal (kill if running, free resources). */
	release(terminalId: string): acp.ReleaseTerminalResponse {
		const state = this.terminals.get(terminalId);
		if (!state) return {};
		if (!state.exitResult) {
			state.process.kill("SIGKILL");
		}
		this.terminals.delete(terminalId);
		return {};
	}

	/** Release all terminals. */
	releaseAll(): void {
		for (const [id] of this.terminals) {
			this.release(id);
		}
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private getTerminal(terminalId: string): TerminalState {
		const state = this.terminals.get(terminalId);
		if (!state) {
			throw new RequestError(-32001, `Terminal not found: ${terminalId}`);
		}
		return state;
	}

	private appendOutput(state: TerminalState, data: string): void {
		state.outputBuffer += data;
		if (
			state.outputByteLimit !== null &&
			Buffer.byteLength(state.outputBuffer) > state.outputByteLimit
		) {
			const buf = Buffer.from(state.outputBuffer);
			const excess = buf.byteLength - state.outputByteLimit;
			state.outputBuffer = buf.subarray(excess).toString();
			state.truncated = true;
		}
	}
}
