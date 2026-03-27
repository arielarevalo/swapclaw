import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type McpServerConfig,
	buildMcpEnvVars,
	fromAcpMcpServers,
	readMcpConfigs,
	serializeMcpConfigs,
	writeMcpConfigFile,
} from "../src/mcp-passthrough.js";

// Ensure any leaked mocks from other test files are cleaned up.
beforeEach(() => {
	vi.restoreAllMocks();
});

// ── Fixtures ────────────────────────────────────────────────────────

const sampleConfig: McpServerConfig = {
	name: "test-server",
	command: "npx",
	args: ["-y", "test-mcp-server"],
	env: { API_KEY: "sk-123", DEBUG: "true" },
};

const minimalConfig: McpServerConfig = {
	name: "minimal",
	command: "/usr/bin/mcp-tool",
};

// ── Tests ───────────────────────────────────────────────────────────

describe("mcp-passthrough", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swapclaw-mcp-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── fromAcpMcpServers ───────────────────────────────────────────

	describe("fromAcpMcpServers()", () => {
		it("converts stdio MCP servers to internal format", () => {
			const acpServers: acp.McpServer[] = [
				{
					name: "my-tool",
					command: "npx",
					args: ["-y", "my-tool"],
					env: [
						{ name: "TOKEN", value: "abc" },
						{ name: "DEBUG", value: "1" },
					],
				},
			];

			const result = fromAcpMcpServers(acpServers);

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				name: "my-tool",
				command: "npx",
				args: ["-y", "my-tool"],
				env: { TOKEN: "abc", DEBUG: "1" },
			});
		});

		it("skips HTTP transport servers", () => {
			const acpServers: acp.McpServer[] = [
				{
					type: "http",
					name: "http-server",
					url: "https://example.com/mcp",
					headers: [],
				} as acp.McpServer,
			];

			const result = fromAcpMcpServers(acpServers);
			expect(result).toHaveLength(0);
		});

		it("skips SSE transport servers", () => {
			const acpServers: acp.McpServer[] = [
				{
					type: "sse",
					name: "sse-server",
					url: "https://example.com/mcp/sse",
					headers: [],
				} as acp.McpServer,
			];

			const result = fromAcpMcpServers(acpServers);
			expect(result).toHaveLength(0);
		});

		it("omits args when empty", () => {
			const acpServers: acp.McpServer[] = [
				{ name: "simple", command: "/usr/bin/tool", args: [], env: [] },
			];

			const result = fromAcpMcpServers(acpServers);
			expect(result[0]).toEqual({ name: "simple", command: "/usr/bin/tool" });
			expect(result[0].args).toBeUndefined();
			expect(result[0].env).toBeUndefined();
		});

		it("returns empty array for empty input", () => {
			expect(fromAcpMcpServers([])).toEqual([]);
		});

		it("filters mixed transport types, keeping only stdio", () => {
			const acpServers: acp.McpServer[] = [
				{
					type: "http",
					name: "http-one",
					url: "https://a.com",
					headers: [],
				} as acp.McpServer,
				{ name: "stdio-one", command: "tool-a", args: [], env: [] },
				{
					type: "sse",
					name: "sse-one",
					url: "https://b.com",
					headers: [],
				} as acp.McpServer,
				{
					name: "stdio-two",
					command: "tool-b",
					args: ["--flag"],
					env: [{ name: "X", value: "1" }],
				},
			];

			const result = fromAcpMcpServers(acpServers);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe("stdio-one");
			expect(result[1].name).toBe("stdio-two");
		});
	});

	// ── serializeMcpConfigs ─────────────────────────────────────────

	describe("serializeMcpConfigs()", () => {
		it("produces valid JSON from configs", () => {
			const json = serializeMcpConfigs([sampleConfig, minimalConfig]);
			const parsed = JSON.parse(json);

			expect(parsed).toHaveLength(2);
			expect(parsed[0].name).toBe("test-server");
			expect(parsed[0].command).toBe("npx");
			expect(parsed[0].args).toEqual(["-y", "test-mcp-server"]);
			expect(parsed[0].env).toEqual({ API_KEY: "sk-123", DEBUG: "true" });
			expect(parsed[1].name).toBe("minimal");
			expect(parsed[1].command).toBe("/usr/bin/mcp-tool");
		});

		it("returns empty string for empty config list", () => {
			expect(serializeMcpConfigs([])).toBe("");
		});

		it("round-trips through JSON.parse", () => {
			const configs = [sampleConfig];
			const serialized = serializeMcpConfigs(configs);
			const deserialized = JSON.parse(serialized);
			expect(deserialized).toEqual(configs);
		});
	});

	// ── buildMcpEnvVars ─────────────────────────────────────────────

	describe("buildMcpEnvVars()", () => {
		it("sets SWAPCLAW_MCP_SERVERS env var with serialized config", () => {
			const env = buildMcpEnvVars([sampleConfig]);

			expect(env).toHaveProperty("SWAPCLAW_MCP_SERVERS");
			const parsed = JSON.parse(env.SWAPCLAW_MCP_SERVERS);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].name).toBe("test-server");
		});

		it("returns empty object for empty config list", () => {
			expect(buildMcpEnvVars([])).toEqual({});
		});

		it("includes all configs in the env var", () => {
			const env = buildMcpEnvVars([sampleConfig, minimalConfig]);
			const parsed = JSON.parse(env.SWAPCLAW_MCP_SERVERS);
			expect(parsed).toHaveLength(2);
		});
	});

	// ── writeMcpConfigFile ──────────────────────────────────────────

	describe("writeMcpConfigFile()", () => {
		it("creates .mcp.json in the session folder", () => {
			writeMcpConfigFile(tmpDir, [sampleConfig]);

			const filePath = path.join(tmpDir, ".mcp.json");
			expect(fs.existsSync(filePath)).toBe(true);

			const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			expect(content.mcpServers).toBeDefined();
			expect(content.mcpServers["test-server"]).toBeDefined();
			expect(content.mcpServers["test-server"].command).toBe("npx");
			expect(content.mcpServers["test-server"].args).toEqual(["-y", "test-mcp-server"]);
			expect(content.mcpServers["test-server"].env).toEqual({
				API_KEY: "sk-123",
				DEBUG: "true",
			});
		});

		it("is a no-op for empty config list", () => {
			writeMcpConfigFile(tmpDir, []);

			const filePath = path.join(tmpDir, ".mcp.json");
			expect(fs.existsSync(filePath)).toBe(false);
		});

		it("handles minimal configs without args or env", () => {
			writeMcpConfigFile(tmpDir, [minimalConfig]);

			const filePath = path.join(tmpDir, ".mcp.json");
			const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			const entry = content.mcpServers.minimal;

			expect(entry.command).toBe("/usr/bin/mcp-tool");
			expect(entry.args).toBeUndefined();
			expect(entry.env).toBeUndefined();
		});

		it("writes multiple servers to the same file", () => {
			writeMcpConfigFile(tmpDir, [sampleConfig, minimalConfig]);

			const filePath = path.join(tmpDir, ".mcp.json");
			const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

			expect(Object.keys(content.mcpServers)).toHaveLength(2);
			expect(content.mcpServers["test-server"]).toBeDefined();
			expect(content.mcpServers.minimal).toBeDefined();
		});
	});

	// ── readMcpConfigs ──────────────────────────────────────────────

	describe("readMcpConfigs()", () => {
		it("reads configs from .mcp.json", () => {
			writeMcpConfigFile(tmpDir, [sampleConfig, minimalConfig]);

			const configs = readMcpConfigs(tmpDir);
			expect(configs).toHaveLength(2);

			const testServer = configs.find((c) => c.name === "test-server");
			expect(testServer).toBeDefined();
			expect(testServer?.command).toBe("npx");
			expect(testServer?.args).toEqual(["-y", "test-mcp-server"]);
			expect(testServer?.env).toEqual({ API_KEY: "sk-123", DEBUG: "true" });

			const minimal = configs.find((c) => c.name === "minimal");
			expect(minimal).toBeDefined();
			expect(minimal?.command).toBe("/usr/bin/mcp-tool");
		});

		it("returns empty array when .mcp.json does not exist", () => {
			expect(readMcpConfigs(tmpDir)).toEqual([]);
		});

		it("returns empty array for empty mcpServers object", () => {
			const filePath = path.join(tmpDir, ".mcp.json");
			fs.writeFileSync(filePath, JSON.stringify({ mcpServers: {} }), "utf-8");

			expect(readMcpConfigs(tmpDir)).toEqual([]);
		});

		it("round-trips through write and read", () => {
			const original = [sampleConfig, minimalConfig];
			writeMcpConfigFile(tmpDir, original);
			const restored = readMcpConfigs(tmpDir);

			expect(restored).toEqual(original);
		});
	});
});
