import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../src/logger.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Logger", () => {
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------
	// info()
	// -----------------------------------------------------------

	describe("info()", () => {
		it("writes JSON line to stderr with correct level, component, msg, ts fields", () => {
			const logger = new Logger("test-component");

			logger.info("hello world");

			expect(spy).toHaveBeenCalledOnce();
			const raw = spy.mock.calls[0][0] as string;
			const entry = JSON.parse(raw);
			expect(entry.level).toBe("info");
			expect(entry.component).toBe("test-component");
			expect(entry.msg).toBe("hello world");
			expect(entry.ts).toBeDefined();
		});
	});

	// -----------------------------------------------------------
	// warn()
	// -----------------------------------------------------------

	describe("warn()", () => {
		it("writes with level warn", () => {
			const logger = new Logger("my-module");

			logger.warn("something suspicious");

			expect(spy).toHaveBeenCalledOnce();
			const entry = JSON.parse(spy.mock.calls[0][0] as string);
			expect(entry.level).toBe("warn");
			expect(entry.component).toBe("my-module");
			expect(entry.msg).toBe("something suspicious");
		});
	});

	// -----------------------------------------------------------
	// error()
	// -----------------------------------------------------------

	describe("error()", () => {
		it("writes with level error", () => {
			const logger = new Logger("my-module");

			logger.error("something broke");

			expect(spy).toHaveBeenCalledOnce();
			const entry = JSON.parse(spy.mock.calls[0][0] as string);
			expect(entry.level).toBe("error");
			expect(entry.component).toBe("my-module");
			expect(entry.msg).toBe("something broke");
		});
	});

	// -----------------------------------------------------------
	// Extra fields
	// -----------------------------------------------------------

	describe("extra fields", () => {
		it("merges additional fields into the output", () => {
			const logger = new Logger("db");

			logger.info("query executed", { duration: 42, table: "users" });

			expect(spy).toHaveBeenCalledOnce();
			const entry = JSON.parse(spy.mock.calls[0][0] as string);
			expect(entry.level).toBe("info");
			expect(entry.component).toBe("db");
			expect(entry.msg).toBe("query executed");
			expect(entry.duration).toBe(42);
			expect(entry.table).toBe("users");
		});
	});

	// -----------------------------------------------------------
	// Timestamp format
	// -----------------------------------------------------------

	describe("timestamp", () => {
		it("ts field is a valid ISO 8601 timestamp", () => {
			const logger = new Logger("ts-check");

			logger.info("check ts");

			const entry = JSON.parse(spy.mock.calls[0][0] as string);
			const parsed = new Date(entry.ts);
			expect(parsed.toISOString()).toBe(entry.ts);
		});
	});

	// -----------------------------------------------------------
	// Multiple calls
	// -----------------------------------------------------------

	describe("multiple calls", () => {
		it("produce separate JSON lines", () => {
			const logger = new Logger("multi");

			logger.info("first");
			logger.warn("second");
			logger.error("third");

			expect(spy).toHaveBeenCalledTimes(3);

			const entries = spy.mock.calls.map((call) => JSON.parse(call[0] as string));
			expect(entries[0].level).toBe("info");
			expect(entries[0].msg).toBe("first");
			expect(entries[1].level).toBe("warn");
			expect(entries[1].msg).toBe("second");
			expect(entries[2].level).toBe("error");
			expect(entries[2].msg).toBe("third");

			// Each write ends with a newline — valid JSON lines format.
			for (const call of spy.mock.calls) {
				expect((call[0] as string).endsWith("\n")).toBe(true);
			}
		});
	});
});
