import * as fs from "node:fs";
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Internal representation of an MCP server config for container passthrough.
 *
 * Only stdio transport is supported for container-based execution. HTTP/SSE
 * servers are filtered out during conversion from ACP McpServer configs.
 */
export interface McpServerConfig {
	name: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

// ── Conversion ──────────────────────────────────────────────────────

/**
 * Convert ACP McpServer configs to our internal McpServerConfig format.
 *
 * Only stdio-transport servers are supported (HTTP/SSE are skipped since
 * they cannot be spawned inside the container). ACP's `EnvVariable[]`
 * format is normalized to a plain `Record<string, string>`.
 */
export function fromAcpMcpServers(servers: acp.McpServer[]): McpServerConfig[] {
	const configs: McpServerConfig[] = [];

	for (const server of servers) {
		// HTTP and SSE transports have a `type` discriminant; stdio does not.
		if ("type" in server) {
			continue;
		}

		const stdio = server as acp.McpServerStdio;
		const config: McpServerConfig = {
			name: stdio.name,
			command: stdio.command,
		};

		if (stdio.args.length > 0) {
			config.args = stdio.args;
		}

		if (stdio.env.length > 0) {
			const envRecord: Record<string, string> = {};
			for (const entry of stdio.env) {
				envRecord[entry.name] = entry.value;
			}
			config.env = envRecord;
		}

		configs.push(config);
	}

	return configs;
}

// ── Serialization ───────────────────────────────────────────────────

/**
 * Serialize MCP server configs to a JSON string for container transport.
 * Returns an empty string if no configs are provided.
 */
export function serializeMcpConfigs(configs: McpServerConfig[]): string {
	if (configs.length === 0) {
		return "";
	}
	return JSON.stringify(configs);
}

/**
 * Build environment variables to inject into a container for MCP passthrough.
 *
 * Sets `SWAPCLAW_MCP_SERVERS` with the serialized config JSON.
 * Returns an empty object if no configs are provided.
 */
export function buildMcpEnvVars(configs: McpServerConfig[]): Record<string, string> {
	const serialized = serializeMcpConfigs(configs);
	if (serialized === "") {
		return {};
	}
	return { SWAPCLAW_MCP_SERVERS: serialized };
}

// ── Config file ─────────────────────────────────────────────────────

/**
 * Claude Code's `.mcp.json` format: a map of server name to config.
 *
 * See: https://docs.anthropic.com/en/docs/claude-code/mcp
 */
interface ClaudeCodeMcpJson {
	mcpServers: Record<
		string,
		{
			command: string;
			args?: string[];
			env?: Record<string, string>;
		}
	>;
}

/**
 * Read MCP server configs from a session folder's `.mcp.json` file.
 *
 * Returns an empty array if the file does not exist or contains no servers.
 */
export function readMcpConfigs(sessionFolder: string): McpServerConfig[] {
	const filePath = path.join(sessionFolder, ".mcp.json");

	if (!fs.existsSync(filePath)) {
		return [];
	}

	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw) as ClaudeCodeMcpJson;

	if (!parsed.mcpServers || Object.keys(parsed.mcpServers).length === 0) {
		return [];
	}

	const configs: McpServerConfig[] = [];
	for (const [name, entry] of Object.entries(parsed.mcpServers)) {
		const config: McpServerConfig = {
			name,
			command: entry.command,
		};
		if (entry.args && entry.args.length > 0) {
			config.args = entry.args;
		}
		if (entry.env && Object.keys(entry.env).length > 0) {
			config.env = entry.env;
		}
		configs.push(config);
	}
	return configs;
}

/**
 * Write a `.mcp.json` config file into the session folder so Claude Code
 * inside the container picks up the MCP servers automatically.
 *
 * No-op if the configs array is empty.
 */
export function writeMcpConfigFile(sessionFolder: string, configs: McpServerConfig[]): void {
	if (configs.length === 0) {
		return;
	}

	const mcpJson: ClaudeCodeMcpJson = { mcpServers: {} };

	for (const config of configs) {
		const entry: { command: string; args?: string[]; env?: Record<string, string> } = {
			command: config.command,
		};

		if (config.args && config.args.length > 0) {
			entry.args = config.args;
		}

		if (config.env && Object.keys(config.env).length > 0) {
			entry.env = config.env;
		}

		mcpJson.mcpServers[config.name] = entry;
	}

	const filePath = path.join(sessionFolder, ".mcp.json");
	fs.writeFileSync(filePath, JSON.stringify(mcpJson, null, "\t"), "utf-8");
}
