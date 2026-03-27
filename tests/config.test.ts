import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** All SWAPCLAW_ env var keys that loadConfig reads. */
const ENV_KEYS = [
	"SWAPCLAW_DATA_DIR",
	"SWAPCLAW_CONTAINER_IMAGE",
	"SWAPCLAW_CONTAINER_TIMEOUT",
	"SWAPCLAW_IDLE_TIMEOUT",
	"SWAPCLAW_MAX_CONCURRENT",
	"SWAPCLAW_TIMEZONE",
	"SWAPCLAW_AGENT_COMMAND",
	"SWAPCLAW_AGENT_ARGS",
] as const;

describe("loadConfig", () => {
	/** Snapshot env vars before each test and restore after. */
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	// -----------------------------------------------------------
	// Defaults
	// -----------------------------------------------------------

	describe("defaults", () => {
		it("returns sane defaults when no env vars are set (except required agentCommand)", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
			const config = loadConfig();

			expect(config.dataDir).toBe(path.join(os.homedir(), ".swapclaw"));
			expect(config.containerImage).toBe("alpine:latest");
			expect(config.containerTimeout).toBe(300_000);
			expect(config.idleTimeout).toBe(60_000);
			expect(config.maxConcurrent).toBe(3);
			expect(config.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
			expect(config.agentArgs).toEqual([]);
		});

		it("returns a frozen object", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
			const config = loadConfig();
			expect(Object.isFrozen(config)).toBe(true);
		});
	});

	// -----------------------------------------------------------
	// Env var overrides
	// -----------------------------------------------------------

	describe("env var overrides", () => {
		beforeEach(() => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
		});

		it("SWAPCLAW_DATA_DIR overrides dataDir", () => {
			process.env.SWAPCLAW_DATA_DIR = "/tmp/swapclaw-test";
			const config = loadConfig();
			expect(config.dataDir).toBe("/tmp/swapclaw-test");
		});

		it("SWAPCLAW_CONTAINER_IMAGE overrides containerImage", () => {
			process.env.SWAPCLAW_CONTAINER_IMAGE = "my-image:v2";
			const config = loadConfig();
			expect(config.containerImage).toBe("my-image:v2");
		});

		it("SWAPCLAW_CONTAINER_TIMEOUT overrides containerTimeout", () => {
			process.env.SWAPCLAW_CONTAINER_TIMEOUT = "600000";
			const config = loadConfig();
			expect(config.containerTimeout).toBe(600_000);
		});

		it("SWAPCLAW_IDLE_TIMEOUT overrides idleTimeout", () => {
			process.env.SWAPCLAW_IDLE_TIMEOUT = "120000";
			const config = loadConfig();
			expect(config.idleTimeout).toBe(120_000);
		});

		it("SWAPCLAW_MAX_CONCURRENT overrides maxConcurrent", () => {
			process.env.SWAPCLAW_MAX_CONCURRENT = "10";
			const config = loadConfig();
			expect(config.maxConcurrent).toBe(10);
		});

		it("SWAPCLAW_TIMEZONE overrides timezone", () => {
			process.env.SWAPCLAW_TIMEZONE = "Europe/Berlin";
			const config = loadConfig();
			expect(config.timezone).toBe("Europe/Berlin");
		});
	});

	// -----------------------------------------------------------
	// Derived paths
	// -----------------------------------------------------------

	describe("derived paths", () => {
		beforeEach(() => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
		});

		it("sessionsDir is $dataDir/sessions", () => {
			process.env.SWAPCLAW_DATA_DIR = "/tmp/swapclaw-test";
			const config = loadConfig();
			expect(config.sessionsDir).toBe("/tmp/swapclaw-test/sessions");
		});

		it("dbPath is $dataDir/swapclaw.db", () => {
			process.env.SWAPCLAW_DATA_DIR = "/tmp/swapclaw-test";
			const config = loadConfig();
			expect(config.dbPath).toBe("/tmp/swapclaw-test/swapclaw.db");
		});

		it("derived paths use default dataDir when not overridden", () => {
			const config = loadConfig();
			const expectedBase = path.join(os.homedir(), ".swapclaw");
			expect(config.sessionsDir).toBe(path.join(expectedBase, "sessions"));
			expect(config.dbPath).toBe(path.join(expectedBase, "swapclaw.db"));
		});
	});

	// -----------------------------------------------------------
	// Validation (invalid values rejected by Zod)
	// -----------------------------------------------------------

	describe("validation", () => {
		beforeEach(() => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
		});

		it("rejects negative containerTimeout", () => {
			process.env.SWAPCLAW_CONTAINER_TIMEOUT = "-1";
			expect(() => loadConfig()).toThrow();
		});

		it("rejects zero containerTimeout", () => {
			process.env.SWAPCLAW_CONTAINER_TIMEOUT = "0";
			expect(() => loadConfig()).toThrow();
		});

		it("rejects non-integer containerTimeout", () => {
			process.env.SWAPCLAW_CONTAINER_TIMEOUT = "1.5";
			expect(() => loadConfig()).toThrow();
		});

		it("rejects non-numeric containerTimeout", () => {
			process.env.SWAPCLAW_CONTAINER_TIMEOUT = "abc";
			expect(() => loadConfig()).toThrow();
		});

		it("rejects negative idleTimeout", () => {
			process.env.SWAPCLAW_IDLE_TIMEOUT = "-500";
			expect(() => loadConfig()).toThrow();
		});

		it("rejects negative maxConcurrent", () => {
			process.env.SWAPCLAW_MAX_CONCURRENT = "-1";
			expect(() => loadConfig()).toThrow();
		});

		it("rejects zero maxConcurrent", () => {
			process.env.SWAPCLAW_MAX_CONCURRENT = "0";
			expect(() => loadConfig()).toThrow();
		});

		it("rejects non-integer maxConcurrent", () => {
			process.env.SWAPCLAW_MAX_CONCURRENT = "2.7";
			expect(() => loadConfig()).toThrow();
		});
	});

	// -----------------------------------------------------------
	// Agent config (agentCommand, agentArgs)
	// -----------------------------------------------------------

	describe("agent config", () => {
		it("throws when SWAPCLAW_AGENT_COMMAND is missing", () => {
			expect(() => loadConfig()).toThrow();
		});

		it("throws when SWAPCLAW_AGENT_COMMAND is empty string", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "";
			expect(() => loadConfig()).toThrow();
		});

		it("parses SWAPCLAW_AGENT_COMMAND as agentCommand", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "claude-code";
			const config = loadConfig();
			expect(config.agentCommand).toBe("claude-code");
		});

		it("defaults agentArgs to empty array when SWAPCLAW_AGENT_ARGS is not set", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
			const config = loadConfig();
			expect(config.agentArgs).toEqual([]);
		});

		it("splits SWAPCLAW_AGENT_ARGS on whitespace", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
			process.env.SWAPCLAW_AGENT_ARGS = "--acp --verbose --port 8080";
			const config = loadConfig();
			expect(config.agentArgs).toEqual(["--acp", "--verbose", "--port", "8080"]);
		});

		it("handles SWAPCLAW_AGENT_ARGS with extra whitespace", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
			process.env.SWAPCLAW_AGENT_ARGS = "  --flag1   --flag2  ";
			const config = loadConfig();
			expect(config.agentArgs).toEqual(["--flag1", "--flag2"]);
		});

		it("handles single-arg SWAPCLAW_AGENT_ARGS", () => {
			process.env.SWAPCLAW_AGENT_COMMAND = "my-agent";
			process.env.SWAPCLAW_AGENT_ARGS = "--acp";
			const config = loadConfig();
			expect(config.agentArgs).toEqual(["--acp"]);
		});
	});
});
