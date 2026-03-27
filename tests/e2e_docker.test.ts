import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Docker availability check (synchronous to avoid bun test concurrency issues)
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

const dockerAvailable = isDockerAvailable();

// ---------------------------------------------------------------------------
// E2E test suite — real Docker containers with mock agent
//
// This test spawns the E2E scenario as a child process to guarantee full
// module isolation. bun test runs all files in the same process, so
// vi.mock() calls in other test files (e.g. session-orchestrator.test.ts
// mocking @agentclientprotocol/sdk and node:child_process) leak into this
// file's module cache. Running in a subprocess avoids the issue entirely.
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)("E2E: Docker containers with mock agent", () => {
	it("echo round-trip: prompt -> agent -> sessionUpdate -> persist", async () => {
		const scriptPath = path.resolve(__dirname, "_e2e_docker_worker.ts");
		const proc = Bun.spawn(["bun", "run", scriptPath], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;

		// Parse the JSON result from the worker script.
		if (exitCode !== 0) {
			throw new Error(
				`E2E worker exited with code ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
			);
		}

		const result = JSON.parse(stdout.trim());

		// Validate assertions from the worker.
		expect(result.sessionCreated).toBe(true);
		expect(result.sessionState).toBe("active");
		expect(result.stopReason).toBe("end_turn");
		expect(result.messageCount).toBeGreaterThanOrEqual(2);
		expect(result.userContent).toBe("echo hello world");
		expect(result.assistantContent).toContain("Echo: hello world");
		expect(result.closedState).toBe("closed");
	}, 60_000);
});
