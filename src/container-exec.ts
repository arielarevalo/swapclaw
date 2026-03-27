import { type ChildProcess, spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for executing a command inside a running container. */
export interface ExecOptions {
	containerId: string;
	command: string;
	args?: string[];
	cwd?: string;
	env?: Array<{ name: string; value: string }>;
	interactive?: boolean;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Abstraction over executing commands inside a container. */
export interface ContainerExec {
	spawn(opts: ExecOptions): ChildProcess;
}

// ---------------------------------------------------------------------------
// DockerExec
// ---------------------------------------------------------------------------

/** Executes commands via `docker exec`. */
export class DockerExec implements ContainerExec {
	spawn(opts: ExecOptions): ChildProcess {
		const args = ["exec"];
		if (opts.interactive) args.push("-i");
		if (opts.cwd) args.push("-w", opts.cwd);
		if (opts.env) {
			for (const e of opts.env) args.push("-e", `${e.name}=${e.value}`);
		}
		args.push(opts.containerId, opts.command, ...(opts.args ?? []));
		return spawn("docker", args, {
			stdio: [opts.interactive ? "pipe" : "ignore", "pipe", "pipe"],
		});
	}
}

// ---------------------------------------------------------------------------
// AppleContainerExec
// ---------------------------------------------------------------------------

/** Executes commands via `container exec` (Apple Container CLI). */
export class AppleContainerExec implements ContainerExec {
	spawn(opts: ExecOptions): ChildProcess {
		const args = ["exec"];
		if (opts.cwd) args.push("--workdir", opts.cwd);
		if (opts.env) {
			for (const e of opts.env) args.push("--env", `${e.name}=${e.value}`);
		}
		args.push(opts.containerId, "--", opts.command, ...(opts.args ?? []));
		return spawn("container", args, {
			stdio: [opts.interactive ? "pipe" : "ignore", "pipe", "pipe"],
		});
	}
}
