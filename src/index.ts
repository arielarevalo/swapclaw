#!/usr/bin/env node
import * as fs from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AgentProcessManager } from "./agent-process-manager.js";
import { loadConfig } from "./config.js";
import { AppleContainerExec, DockerExec } from "./container-exec.js";
import { ContainerRunner } from "./container-runner.js";
import { AppleContainerRuntime, detectRuntime } from "./container-runtime.js";
import { recoverStaleContainers } from "./crash-recovery.js";
import { Database } from "./db.js";
import { Logger } from "./logger.js";
import { SwapClawAgent } from "./server.js";
import { SessionManager } from "./session-manager.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { SessionScaffolder } from "./session-scaffolder.js";
import { TaskScheduler } from "./task-scheduler.js";

const log = new Logger("bootstrap");

// ── Bootstrap ────────────────────────────────────────────────────────

let db: Database | undefined;

try {
	const config = loadConfig();

	// Ensure the data directory exists before opening the database.
	fs.mkdirSync(config.dataDir, { recursive: true });

	db = new Database(config.dbPath);
	const runtime = await detectRuntime(config);

	await recoverStaleContainers(db, runtime);

	const exec =
		runtime instanceof AppleContainerRuntime ? new AppleContainerExec() : new DockerExec();
	const runner = new ContainerRunner(config, runtime);
	const scaffolder = new SessionScaffolder();
	const sessionManager = new SessionManager(config, db, scaffolder);
	const agentProcessManager = new AgentProcessManager(config.agentCommand, config.agentArgs, exec);
	const orchestrator = new SessionOrchestrator(
		config,
		db,
		sessionManager,
		runner,
		agentProcessManager,
	);

	const scheduler = new TaskScheduler(orchestrator, db);

	// ── ACP stdio transport ──────────────────────────────────────────

	const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
	const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;

	const stream = acp.ndJsonStream(output, input);
	const connection = new acp.AgentSideConnection((conn) => {
		orchestrator.setSessionUpdateForwarder((sessionId, update) => {
			conn.sessionUpdate({ sessionId, update });
		});
		return new SwapClawAgent(orchestrator, conn, scheduler);
	}, stream);

	scheduler.start();

	// ── Graceful shutdown ────────────────────────────────────────────

	connection.signal.addEventListener("abort", () => {
		scheduler.stop();
		void orchestrator.shutdown().finally(() => {
			db?.close();
		});
	});
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	log.error("Failed to start swapclaw", { error: message });
	db?.close();
	process.exit(1);
}
