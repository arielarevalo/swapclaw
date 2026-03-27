import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../src/db.js";
import {
	type PromptTarget,
	type TaskSchedule,
	TaskScheduler,
	computeNextRunAt,
} from "../src/task-scheduler.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockPromptTarget(): PromptTarget & {
	loadSession: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
} {
	return {
		loadSession: vi.fn((sessionId: string) => ({ sessionId })),
		prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
	} as PromptTarget & {
		loadSession: ReturnType<typeof vi.fn>;
		prompt: ReturnType<typeof vi.fn>;
	};
}

// ── Tests ────────────────────────────────────────────────────────────

describe("TaskScheduler", () => {
	let db: Database;
	let target: ReturnType<typeof createMockPromptTarget>;
	let scheduler: TaskScheduler;

	beforeEach(() => {
		db = Database.inMemory();
		target = createMockPromptTarget();
		scheduler = new TaskScheduler(target, db);

		// Create a session in the DB so foreign key-like checks pass.
		db.createSession("sess-1", "/project");
	});

	afterEach(() => {
		scheduler.stop();
		db.close();
		vi.restoreAllMocks();
	});

	// ── createTask ──────────────────────────────────────────────────

	describe("createTask", () => {
		it("stores task and returns it", () => {
			const schedule: TaskSchedule = { type: "once", at: "2026-06-01T12:00:00.000Z" };
			const task = scheduler.createTask("sess-1", "do something", schedule);

			expect(task.id).toBeTruthy();
			expect(task.sessionId).toBe("sess-1");
			expect(task.prompt).toBe("do something");
			expect(task.schedule).toEqual(schedule);
			expect(task.status).toBe("pending");
			expect(task.createdAt).toBeTruthy();
			expect(task.nextRunAt).toBe("2026-06-01T12:00:00.000Z");

			// Verify persistence.
			const row = db.getScheduledTask(task.id);
			expect(row).not.toBeNull();
			expect(row?.session_id).toBe("sess-1");
			expect(row?.prompt).toBe("do something");
			expect(row?.schedule_type).toBe("once");
		});

		it("creates interval task with computed next run time", () => {
			const schedule: TaskSchedule = { type: "interval", intervalMs: 60_000 };
			const task = scheduler.createTask("sess-1", "repeat me", schedule);

			expect(task.nextRunAt).toBeTruthy();
			// next_run_at should be approximately now + 60s.
			const nextRun = new Date(task.nextRunAt as string).getTime();
			const now = Date.now();
			expect(nextRun - now).toBeLessThan(62_000);
			expect(nextRun - now).toBeGreaterThan(58_000);
		});

		it("throws for nonexistent session", () => {
			target.loadSession.mockImplementation(() => {
				throw new Error("Session not found: bad-id");
			});

			expect(() => {
				scheduler.createTask("bad-id", "prompt", { type: "once", at: "2026-06-01T00:00:00Z" });
			}).toThrow("Session not found: bad-id");
		});
	});

	// ── listTasks ───────────────────────────────────────────────────

	describe("listTasks", () => {
		it("returns tasks for a specific session", () => {
			db.createSession("sess-2", "/project2");
			target.loadSession.mockImplementation((id: string) => ({
				sessionId: id,
			}));

			scheduler.createTask("sess-1", "task A", { type: "once", at: "2026-06-01T00:00:00Z" });
			scheduler.createTask("sess-2", "task B", { type: "once", at: "2026-06-02T00:00:00Z" });
			scheduler.createTask("sess-1", "task C", { type: "interval", intervalMs: 30_000 });

			const sess1Tasks = scheduler.listTasks("sess-1");
			expect(sess1Tasks).toHaveLength(2);
			expect(sess1Tasks[0].prompt).toBe("task A");
			expect(sess1Tasks[1].prompt).toBe("task C");

			const sess2Tasks = scheduler.listTasks("sess-2");
			expect(sess2Tasks).toHaveLength(1);
			expect(sess2Tasks[0].prompt).toBe("task B");
		});

		it("returns all tasks when no sessionId specified", () => {
			scheduler.createTask("sess-1", "task A", { type: "once", at: "2026-06-01T00:00:00Z" });
			scheduler.createTask("sess-1", "task B", { type: "interval", intervalMs: 5000 });

			const all = scheduler.listTasks();
			expect(all).toHaveLength(2);
		});

		it("returns empty array when no tasks exist", () => {
			expect(scheduler.listTasks()).toHaveLength(0);
		});
	});

	// ── cancelTask ──────────────────────────────────────────────────

	describe("cancelTask", () => {
		it("marks task as cancelled", () => {
			const task = scheduler.createTask("sess-1", "cancel me", {
				type: "once",
				at: "2026-06-01T00:00:00Z",
			});

			scheduler.cancelTask(task.id);

			const row = db.getScheduledTask(task.id);
			expect(row?.status).toBe("cancelled");
		});

		it("throws for nonexistent task", () => {
			expect(() => {
				scheduler.cancelTask("nonexistent-id");
			}).toThrow("Scheduled task not found: nonexistent-id");
		});

		it("cancelled task is not picked up by processDueTasks", async () => {
			// Create a task due in the past.
			const task = scheduler.createTask("sess-1", "past task", {
				type: "once",
				at: "2020-01-01T00:00:00Z",
			});
			scheduler.cancelTask(task.id);

			await scheduler.processDueTasks();

			expect(target.prompt).not.toHaveBeenCalled();
		});
	});

	// ── processDueTasks ─────────────────────────────────────────────

	describe("processDueTasks", () => {
		it("due task triggers target.prompt", async () => {
			// Create a task due in the past so it fires immediately.
			scheduler.createTask("sess-1", "run me now", {
				type: "once",
				at: "2020-01-01T00:00:00Z",
			});

			await scheduler.processDueTasks();

			expect(target.prompt).toHaveBeenCalledWith("sess-1", [{ type: "text", text: "run me now" }]);
		});

		it("once task runs once then is marked complete", async () => {
			const task = scheduler.createTask("sess-1", "one-shot", {
				type: "once",
				at: "2020-01-01T00:00:00Z",
			});

			await scheduler.processDueTasks();

			const row = db.getScheduledTask(task.id);
			expect(row?.status).toBe("completed");
			expect(row?.last_run_at).toBeTruthy();
			expect(row?.next_run_at).toBeNull();
		});

		it("interval task reschedules after run", async () => {
			const task = scheduler.createTask("sess-1", "repeat", {
				type: "interval",
				intervalMs: 60_000,
			});

			// Force the task to be due by updating next_run_at to the past.
			db.updateScheduledTask(task.id, { next_run_at: "2020-01-01T00:00:00.000Z" });

			await scheduler.processDueTasks();

			const row = db.getScheduledTask(task.id);
			expect(row?.status).toBe("pending");
			expect(row?.last_run_at).toBeTruthy();
			expect(row?.next_run_at).toBeTruthy();
			// next_run_at should be in the future (roughly now + 60s).
			const nextRun = new Date(row?.next_run_at as string).getTime();
			expect(nextRun).toBeGreaterThan(Date.now() - 5_000);
		});

		it("does not run tasks that are not yet due", async () => {
			scheduler.createTask("sess-1", "future task", {
				type: "once",
				at: "2099-12-31T23:59:59.000Z",
			});

			await scheduler.processDueTasks();

			expect(target.prompt).not.toHaveBeenCalled();
		});

		it("handles prompt failure gracefully", async () => {
			target.prompt.mockRejectedValueOnce(new Error("container exploded"));

			const task = scheduler.createTask("sess-1", "failing task", {
				type: "once",
				at: "2020-01-01T00:00:00Z",
			});

			// Should not throw.
			await scheduler.processDueTasks();

			// Task should still be marked completed (not retried forever).
			const row = db.getScheduledTask(task.id);
			expect(row?.status).toBe("completed");
		});
	});

	// ── start/stop ──────────────────────────────────────────────────

	describe("start/stop", () => {
		it("start begins polling and stop ends it", () => {
			const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
			const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

			scheduler.start();
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);

			scheduler.stop();
			expect(clearIntervalSpy).toHaveBeenCalled();
		});

		it("start is idempotent", () => {
			const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

			scheduler.start();
			scheduler.start();
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		});

		it("stop without start is a no-op", () => {
			// Should not throw.
			scheduler.stop();
		});
	});
});

// ── computeNextRunAt ────────────────────────────────────────────────

describe("computeNextRunAt", () => {
	const baseTime = new Date("2026-06-01T12:00:00.000Z");

	it("returns the at field for once schedules", () => {
		const result = computeNextRunAt({ type: "once", at: "2026-06-15T00:00:00.000Z" }, baseTime);
		expect(result).toBe("2026-06-15T00:00:00.000Z");
	});

	it("returns null for once schedule without at", () => {
		const result = computeNextRunAt({ type: "once" }, baseTime);
		expect(result).toBeNull();
	});

	it("computes baseTime + intervalMs for interval schedules", () => {
		const result = computeNextRunAt({ type: "interval", intervalMs: 30_000 }, baseTime);
		expect(result).toBe("2026-06-01T12:00:30.000Z");
	});

	it("returns null for interval without intervalMs", () => {
		const result = computeNextRunAt({ type: "interval" }, baseTime);
		expect(result).toBeNull();
	});

	it("returns null for cron schedules (not implemented)", () => {
		const result = computeNextRunAt({ type: "cron", cron: "0 * * * *" }, baseTime);
		expect(result).toBeNull();
	});
});
