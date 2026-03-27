// ---------------------------------------------------------------------------
// Logger — structured JSON logging to stderr
// ---------------------------------------------------------------------------

/** Log level. */
type LogLevel = "info" | "warn" | "error";

/** Additional fields to include in a log entry. */
type LogFields = Record<string, unknown>;

/**
 * Structured logger that writes JSON lines to stderr.
 *
 * Each log entry includes `level`, `component`, `msg`, `ts` (ISO 8601),
 * and any extra fields passed at the call site.
 */
export class Logger {
	constructor(private readonly component: string) {}

	info(msg: string, fields?: LogFields): void {
		this.write("info", msg, fields);
	}

	warn(msg: string, fields?: LogFields): void {
		this.write("warn", msg, fields);
	}

	error(msg: string, fields?: LogFields): void {
		this.write("error", msg, fields);
	}

	private write(level: LogLevel, msg: string, fields?: LogFields): void {
		const entry = {
			level,
			component: this.component,
			msg,
			ts: new Date().toISOString(),
			...fields,
		};
		process.stderr.write(`${JSON.stringify(entry)}\n`);
	}
}
