#!/usr/bin/env bun
/**
 * E2E Docker worker — runs the actual end-to-end test scenario.
 *
 * Spawned as a child process by e2e_docker.test.ts to guarantee full
 * module isolation from vi.mock() leaks in bun test.
 *
 * Outputs a JSON object to stdout with the test results. Exits 0 on
 * success, non-zero on failure.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentProcessManager } from "../src/agent-process-manager.js";
import type { Config } from "../src/config.js";
import { AppleContainerExec, DockerExec } from "../src/container-exec.js";
import { ContainerRunner } from "../src/container-runner.js";
import { AppleContainerRuntime, detectRuntime } from "../src/container-runtime.js";
import { recoverStaleContainers } from "../src/crash-recovery.js";
import { Database } from "../src/db.js";
import { SessionManager } from "../src/session-manager.js";
import { SessionOrchestrator } from "../src/session-orchestrator.js";
import { SessionScaffolder } from "../src/session-scaffolder.js";

interface TestResult {
	sessionCreated: boolean;
	sessionState: string | null;
	stopReason: string;
	messageCount: number;
	userContent: string | null;
	assistantContent: string | null;
	closedState: string | null;
}

async function run(): Promise<TestResult> {
	// 1. Create temp data dir.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-e2e-"));

	// 2. Create sessions dir inside it.
	fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });

	// 3. Build config manually (do NOT use loadConfig -- it reads env vars).
	const config: Config = Object.freeze({
		dataDir: tmpDir,
		sessionsDir: path.join(tmpDir, "sessions"),
		dbPath: path.join(tmpDir, "swapclaw.db"),
		containerImage: "alpine:latest",
		containerTimeout: 300_000,
		idleTimeout: 60_000,
		maxConcurrent: 3,
		timezone: "UTC",
		agentCommand: "bun",
		agentArgs: ["run", "tests/_mock_agent.ts"],
	});

	// 4. Create DB (real file-based).
	const db = new Database(config.dbPath);

	try {
		// 5. Detect runtime -- will find Docker.
		const runtime = await detectRuntime(config);

		// 6. Run crash recovery.
		await recoverStaleContainers(db, runtime);

		// 7. Create runner.
		const runner = new ContainerRunner(config, runtime);

		// 8. Create session manager.
		const sessionManager = new SessionManager(config, db, new SessionScaffolder());

		// 9. Create orchestrator -- NO mock client factory, use real SwapClawClient.
		const exec =
			runtime instanceof AppleContainerRuntime ? new AppleContainerExec() : new DockerExec();
		const agentProcessManager = new AgentProcessManager(
			config.agentCommand,
			config.agentArgs,
			exec,
		);
		const orchestrator = new SessionOrchestrator(
			config,
			db,
			sessionManager,
			runner,
			agentProcessManager,
		);

		try {
			// 10. Create a new session.
			const sessionId = await orchestrator.newSession("/tmp");
			const sessionRow = db.getSession(sessionId);

			// 11. Send a prompt.
			const response = await orchestrator.prompt(sessionId, [
				{ type: "text", text: "echo hello world" },
			]);

			// 12. Read messages.
			const messages = db.getMessages(sessionId);
			const userMsg = messages.find((m) => m.role === "user");
			const assistantMsg = messages.find((m) => m.role === "assistant");

			// 13. Close the session.
			await orchestrator.closeSession(sessionId);
			const closedRow = db.getSession(sessionId);

			return {
				sessionCreated: sessionRow !== null,
				sessionState: sessionRow?.state ?? null,
				stopReason: response.stopReason,
				messageCount: messages.length,
				userContent: userMsg?.content ?? null,
				assistantContent: assistantMsg?.content ?? null,
				closedState: closedRow?.state ?? null,
			};
		} finally {
			// Graceful shutdown.
			await orchestrator.shutdown();
		}
	} finally {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

try {
	const result = await run();
	console.log(JSON.stringify(result));
	process.exit(0);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	console.error(`E2E worker failed: ${message}`);
	if (stack) {
		console.error(stack);
	}
	process.exit(1);
}
