import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ pid: 12345 })),
}));

import { spawn } from "node:child_process";
import { AppleContainerExec, DockerExec, type ExecOptions } from "../src/container-exec.js";

// ---------------------------------------------------------------------------
// DockerExec
// ---------------------------------------------------------------------------

describe("DockerExec", () => {
	const exec = new DockerExec();

	it("spawns a basic command", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "echo",
			args: ["hello"],
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith("docker", ["exec", "ctr-1", "echo", "hello"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	});

	it("sets the working directory with -w", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "ls",
			cwd: "/project",
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith("docker", ["exec", "-w", "/project", "ctr-1", "ls"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	});

	it("passes environment variables with -e", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "env",
			env: [
				{ name: "FOO", value: "bar" },
				{ name: "BAZ", value: "qux" },
			],
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith(
			"docker",
			["exec", "-e", "FOO=bar", "-e", "BAZ=qux", "ctr-1", "env"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
	});

	it("enables interactive mode with -i and pipe stdin", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "sh",
			interactive: true,
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith("docker", ["exec", "-i", "ctr-1", "sh"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("combines cwd, env, interactive, and args", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "cat",
			args: ["file.txt"],
			cwd: "/session",
			env: [{ name: "LANG", value: "C" }],
			interactive: true,
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith(
			"docker",
			["exec", "-i", "-w", "/session", "-e", "LANG=C", "ctr-1", "cat", "file.txt"],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
	});

	it("handles missing args as empty array", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "pwd",
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith("docker", ["exec", "ctr-1", "pwd"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	});
});

// ---------------------------------------------------------------------------
// AppleContainerExec
// ---------------------------------------------------------------------------

describe("AppleContainerExec", () => {
	const exec = new AppleContainerExec();

	it("spawns a basic command", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "echo",
			args: ["hello"],
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith("container", ["exec", "ctr-1", "--", "echo", "hello"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	});

	it("sets the working directory with --workdir", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "ls",
			cwd: "/project",
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith(
			"container",
			["exec", "--workdir", "/project", "ctr-1", "--", "ls"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
	});

	it("passes environment variables with --env", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "env",
			env: [
				{ name: "FOO", value: "bar" },
				{ name: "BAZ", value: "qux" },
			],
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith(
			"container",
			["exec", "--env", "FOO=bar", "--env", "BAZ=qux", "ctr-1", "--", "env"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
	});

	it("enables interactive mode with pipe stdin", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "sh",
			interactive: true,
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith("container", ["exec", "ctr-1", "--", "sh"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("combines cwd, env, interactive, and args", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "cat",
			args: ["file.txt"],
			cwd: "/session",
			env: [{ name: "LANG", value: "C" }],
			interactive: true,
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith(
			"container",
			["exec", "--workdir", "/session", "--env", "LANG=C", "ctr-1", "--", "cat", "file.txt"],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
	});

	it("handles missing args as empty array", () => {
		const opts: ExecOptions = {
			containerId: "ctr-1",
			command: "pwd",
		};

		exec.spawn(opts);

		expect(spawn).toHaveBeenCalledWith("container", ["exec", "ctr-1", "--", "pwd"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	});
});
