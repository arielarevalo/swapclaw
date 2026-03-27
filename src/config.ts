import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

/**
 * Zod schema for swapclaw configuration.
 * Reads from environment variables with sensible defaults.
 */
const ConfigSchema = z.object({
	/** Directory where sessions and database live. */
	dataDir: z.string().min(1).default(path.join(os.homedir(), ".swapclaw")),

	/** Docker image name for sandbox containers. */
	containerImage: z.string().min(1).default("alpine:latest"),

	/** Max time per prompt in milliseconds. */
	containerTimeout: z.coerce.number().int().positive().default(300_000),

	/** Container idle time before teardown in milliseconds. */
	idleTimeout: z.coerce.number().int().positive().default(60_000),

	/** Max concurrent containers. */
	maxConcurrent: z.coerce.number().int().positive().default(3),

	/** Timezone for message formatting. */
	timezone: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone),

	/** Command to spawn the external ACP agent process. */
	agentCommand: z.string().min(1),

	/** Arguments passed to the agent command. */
	agentArgs: z.array(z.string()).default([]),
});

/** Fully resolved configuration with derived paths. */
export interface Config extends z.infer<typeof ConfigSchema> {
	/** Path to sessions directory: `$dataDir/sessions/` */
	readonly sessionsDir: string;
	/** Path to SQLite database: `$dataDir/swapclaw.db` */
	readonly dbPath: string;
	/** Command to spawn the external ACP agent process. */
	readonly agentCommand: string;
	/** Arguments passed to the agent command. */
	readonly agentArgs: string[];
}

/**
 * Load configuration from environment variables, validate via Zod,
 * compute derived paths, and return a frozen Config object.
 */
export function loadConfig(): Config {
	const rawArgs = process.env.SWAPCLAW_AGENT_ARGS;
	const parsed = ConfigSchema.parse({
		dataDir: process.env.SWAPCLAW_DATA_DIR || undefined,
		containerImage: process.env.SWAPCLAW_CONTAINER_IMAGE || undefined,
		containerTimeout: process.env.SWAPCLAW_CONTAINER_TIMEOUT || undefined,
		idleTimeout: process.env.SWAPCLAW_IDLE_TIMEOUT || undefined,
		maxConcurrent: process.env.SWAPCLAW_MAX_CONCURRENT || undefined,
		timezone: process.env.SWAPCLAW_TIMEZONE || undefined,
		agentCommand: process.env.SWAPCLAW_AGENT_COMMAND || undefined,
		agentArgs: rawArgs ? rawArgs.trim().split(/\s+/) : undefined,
	});

	const config: Config = {
		...parsed,
		sessionsDir: path.join(parsed.dataDir, "sessions"),
		dbPath: path.join(parsed.dataDir, "swapclaw.db"),
	};

	return Object.freeze(config);
}
