#!/usr/bin/env node
/**
 * Mock test agent that exercises ALL ACP Client callbacks.
 *
 * This agent parses the prompt text as commands and calls back to the client
 * accordingly. It does NOT use AI — it sends deterministic requests based on
 * the command text. Designed to pair with the e2e spike client.
 *
 * Commands:
 *   echo <text>               — echo text back via sessionUpdate (no callbacks)
 *   terminal <command>        — run command via createTerminal lifecycle
 *   read <path>               — read file via readTextFile
 *   write <path> <content>    — write file via writeTextFile
 *   combined <path> <content> — write file, then read it back, verify match
 *
 * Based on the acpx mock agent pattern (ADR 003).
 *
 * Run: bun run tests/_mock_agent.ts
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

class MockTestAgent implements acp.Agent {
	private readonly connection: acp.AgentSideConnection;

	constructor(connection: acp.AgentSideConnection) {
		this.connection = connection;
	}

	async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
			},
		};
	}

	// biome-ignore lint/suspicious/noConfusingVoidType: SDK interface requires void union
	async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse | void> {
		return {};
	}

	async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return { sessionId };
	}

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		// Extract the command text from the prompt.
		const textParts: string[] = [];
		for (const block of params.prompt) {
			if (block.type === "text") {
				textParts.push(block.text);
			}
		}
		const commandLine = textParts.join(" ").trim();

		if (!commandLine) {
			await this.sendText(params.sessionId, "Error: empty command");
			return { stopReason: "end_turn" };
		}

		// Parse the command.
		const spaceIndex = commandLine.indexOf(" ");
		const verb = spaceIndex === -1 ? commandLine : commandLine.slice(0, spaceIndex);
		const rest = spaceIndex === -1 ? "" : commandLine.slice(spaceIndex + 1);

		try {
			switch (verb) {
				case "echo":
					await this.handleEcho(params.sessionId, rest);
					break;
				case "terminal":
					await this.handleTerminal(params.sessionId, rest);
					break;
				case "read":
					await this.handleRead(params.sessionId, rest);
					break;
				case "write":
					await this.handleWrite(params.sessionId, rest);
					break;
				case "combined":
					await this.handleCombined(params.sessionId, rest);
					break;
				default:
					await this.sendText(params.sessionId, `Unknown command: ${verb}`);
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.sendText(params.sessionId, `[agent] Error: ${message}`);
		}

		return { stopReason: "end_turn" };
	}

	async cancel(_params: acp.CancelNotification): Promise<void> {}

	// ── Command handlers ─────────────────────────────────────────────

	/** Echo: just send text back via sessionUpdate. No client callbacks. */
	private async handleEcho(sessionId: string, text: string): Promise<void> {
		await this.sendText(sessionId, `Echo: ${text}`);
	}

	/** Terminal: exercise the full terminal lifecycle. */
	private async handleTerminal(sessionId: string, commandLine: string): Promise<void> {
		const parts = commandLine.split(/\s+/);
		const command = parts[0];
		const args = parts.slice(1);

		await this.sendText(sessionId, `[agent] Running terminal: ${command} ${args.join(" ")}`);

		// Step 1: createTerminal
		await this.sendText(sessionId, "[agent] Step 1: createTerminal...");
		const terminal = await this.connection.createTerminal({
			sessionId,
			command,
			args,
		});
		await this.sendText(sessionId, `[agent] Terminal created: id=${terminal.id}`);

		// Step 2: waitForExit
		await this.sendText(sessionId, "[agent] Step 2: waitForExit...");
		const exitResult = await terminal.waitForExit();
		await this.sendText(
			sessionId,
			`[agent] Exited: code=${exitResult.exitCode ?? "null"}, signal=${exitResult.signal ?? "null"}`,
		);

		// Step 3: currentOutput
		await this.sendText(sessionId, "[agent] Step 3: currentOutput...");
		const outputResult = await terminal.currentOutput();
		await this.sendText(
			sessionId,
			`[agent] Output (truncated=${outputResult.truncated}):\n${outputResult.output}`,
		);

		// Step 4: release
		await this.sendText(sessionId, "[agent] Step 4: release...");
		await terminal.release();
		await this.sendText(sessionId, "[agent] Terminal released.");
	}

	/** Read: exercise readTextFile. */
	private async handleRead(sessionId: string, path: string): Promise<void> {
		if (!path) {
			await this.sendText(sessionId, "[agent] Error: read requires a path");
			return;
		}

		await this.sendText(sessionId, `[agent] Reading file: ${path}`);
		const result = await this.connection.readTextFile({
			sessionId,
			path,
		});
		await this.sendText(sessionId, `[agent] File content:\n${result.content}`);
	}

	/** Write: exercise writeTextFile. */
	private async handleWrite(sessionId: string, rest: string): Promise<void> {
		const spaceIndex = rest.indexOf(" ");
		if (spaceIndex === -1) {
			await this.sendText(sessionId, "[agent] Error: write requires <path> <content>");
			return;
		}
		const path = rest.slice(0, spaceIndex);
		const content = rest.slice(spaceIndex + 1);

		await this.sendText(sessionId, `[agent] Writing file: ${path}`);
		await this.connection.writeTextFile({
			sessionId,
			path,
			content,
		});
		await this.sendText(sessionId, "[agent] File written successfully.");
	}

	/** Combined: write a file, then read it back, report both. */
	private async handleCombined(sessionId: string, rest: string): Promise<void> {
		const spaceIndex = rest.indexOf(" ");
		if (spaceIndex === -1) {
			await this.sendText(sessionId, "[agent] Error: combined requires <path> <content>");
			return;
		}
		const path = rest.slice(0, spaceIndex);
		const content = rest.slice(spaceIndex + 1);

		// Write
		await this.sendText(sessionId, `[agent] Combined step 1: writing "${content}" to ${path}`);
		await this.connection.writeTextFile({
			sessionId,
			path,
			content,
		});
		await this.sendText(sessionId, "[agent] Write complete.");

		// Read back
		await this.sendText(sessionId, `[agent] Combined step 2: reading back ${path}`);
		const result = await this.connection.readTextFile({
			sessionId,
			path,
		});
		await this.sendText(sessionId, `[agent] Read back content: "${result.content}"`);

		// Verify
		if (result.content === content) {
			await this.sendText(sessionId, "[agent] VERIFIED: content matches.");
		} else {
			await this.sendText(
				sessionId,
				`[agent] MISMATCH: expected "${content}", got "${result.content}"`,
			);
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────

	private async sendText(sessionId: string, text: string): Promise<void> {
		await this.connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: `${text}\n`,
				},
			},
		});
	}
}

// Wire up stdio transport (agent reads from stdin, writes to stdout).
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;

const stream = acp.ndJsonStream(output, input);
new acp.AgentSideConnection((conn) => new MockTestAgent(conn), stream);
