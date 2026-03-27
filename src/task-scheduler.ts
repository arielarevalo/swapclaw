import * as crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { Database } from "./db.js";
import { Logger } from "./logger.js";

const log = new Logger("task-scheduler");

// ── Types ───────────────────────────────────────────────────────────

/** Narrow interface — only what TaskScheduler actually needs. */
export interface PromptTarget {
	loadSession(sessionId: string): { sessionId: string };
	prompt(sessionId: string, content: acp.ContentBlock[]): Promise<{ stopReason: string }>;
}

/** Schedule definition for a task. */
export interface TaskSchedule {
	type: "once" | "interval" | "cron";
	/** ISO 8601 timestamp for "once" tasks. */
	at?: string;
	/** Interval in milliseconds for "interval" tasks. */
	intervalMs?: number;
	/** Cron expression for "cron" tasks (not implemented yet). */
	cron?: string;
}

/** A scheduled task record. */
export interface ScheduledTask {
	id: string;
	sessionId: string;
	prompt: string;
	schedule: TaskSchedule;
	status: "pending" | "running" | "completed" | "cancelled";
	createdAt: string;
	lastRunAt: string | null;
	nextRunAt: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute the next run time from a schedule, relative to a base time. */
export function computeNextRunAt(schedule: TaskSchedule, baseTime: Date): string | null {
	switch (schedule.type) {
		case "once": {
			if (!schedule.at) return null;
			return schedule.at;
		}
		case "interval": {
			if (!schedule.intervalMs || schedule.intervalMs <= 0) return null;
			return new Date(baseTime.getTime() + schedule.intervalMs).toISOString();
		}
		case "cron": {
			// Cron parsing is not implemented. Tasks with cron schedules
			// will be created but never become due until cron support is added.
			return null;
		}
		default:
			return null;
	}
}

/** Serialize a TaskSchedule to a schedule_value string for DB storage. */
function serializeScheduleValue(schedule: TaskSchedule): string {
	switch (schedule.type) {
		case "once":
			return schedule.at ?? "";
		case "interval":
			return String(schedule.intervalMs ?? 0);
		case "cron":
			return schedule.cron ?? "";
	}
}

/** Deserialize schedule_type + schedule_value back to a TaskSchedule. */
function deserializeSchedule(type: string, value: string): TaskSchedule {
	switch (type) {
		case "once":
			return { type: "once", at: value || undefined };
		case "interval":
			return { type: "interval", intervalMs: Number(value) || undefined };
		case "cron":
			return { type: "cron", cron: value || undefined };
		default:
			return { type: "once" };
	}
}

// ── TaskScheduler ───────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;

/**
 * Manages scheduled tasks: creation, listing, cancellation, and
 * periodic polling for due tasks that need to be executed.
 */
export class TaskScheduler {
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private processing = false;

	constructor(
		private readonly target: PromptTarget,
		private readonly db: Database,
	) {}

	/**
	 * Create a new scheduled task.
	 *
	 * Validates the session exists, computes the next run time from the
	 * schedule, persists to DB, and returns the task.
	 */
	createTask(sessionId: string, prompt: string, schedule: TaskSchedule): ScheduledTask {
		// Validate session exists.
		this.target.loadSession(sessionId);

		const id = crypto.randomBytes(16).toString("hex");
		const now = new Date();
		const createdAt = now.toISOString();
		const nextRunAt = computeNextRunAt(schedule, now);

		this.db.createScheduledTask({
			id,
			session_id: sessionId,
			prompt,
			schedule_type: schedule.type,
			schedule_value: serializeScheduleValue(schedule),
			status: "pending",
			created_at: createdAt,
			last_run_at: null,
			next_run_at: nextRunAt,
		});

		return {
			id,
			sessionId,
			prompt,
			schedule,
			status: "pending",
			createdAt,
			lastRunAt: null,
			nextRunAt,
		};
	}

	/**
	 * List scheduled tasks, optionally filtered by session.
	 */
	listTasks(sessionId?: string): ScheduledTask[] {
		const rows = this.db.listScheduledTasks(sessionId);
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			prompt: row.prompt,
			schedule: deserializeSchedule(row.schedule_type, row.schedule_value),
			status: row.status as ScheduledTask["status"],
			createdAt: row.created_at,
			lastRunAt: row.last_run_at,
			nextRunAt: row.next_run_at,
		}));
	}

	/**
	 * Cancel a scheduled task by ID.
	 *
	 * Marks it as "cancelled" in the DB so it is no longer picked up by
	 * the poll loop.
	 */
	cancelTask(taskId: string): void {
		const task = this.db.getScheduledTask(taskId);
		if (!task) {
			throw new Error(`Scheduled task not found: ${taskId}`);
		}
		this.db.updateScheduledTask(taskId, { status: "cancelled" });
	}

	/**
	 * Start the poll loop that checks for due tasks every 10 seconds.
	 */
	start(): void {
		if (this.pollTimer !== null) return;
		this.pollTimer = setInterval(() => {
			void this.processDueTasks();
		}, POLL_INTERVAL_MS);
	}

	/**
	 * Stop the poll loop.
	 */
	stop(): void {
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/**
	 * Check for and execute due tasks. Exposed for testing.
	 */
	async processDueTasks(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			const now = new Date().toISOString();
			const dueTasks = this.db.getDueTasks(now);

			for (const row of dueTasks) {
				await this.executeTask(row.id);
			}
		} finally {
			this.processing = false;
		}
	}

	// ── Private ─────────────────────────────────────────────────────

	/**
	 * Execute a single task: enqueue it, then update status based on
	 * schedule type.
	 */
	private async executeTask(taskId: string): Promise<void> {
		const row = this.db.getScheduledTask(taskId);
		if (!row || row.status !== "pending") return;

		// Mark as running.
		this.db.updateScheduledTask(taskId, { status: "running" });

		const schedule = deserializeSchedule(row.schedule_type, row.schedule_value);
		const runTime = new Date();

		try {
			await this.target.prompt(row.session_id, [{ type: "text", text: row.prompt }]);
		} catch (err) {
			// Task execution failed — log and proceed with reschedule logic
			// so we don't get stuck retrying.
			log.error("Task execution failed", {
				taskId,
				sessionId: row.session_id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		const lastRunAt = runTime.toISOString();

		if (schedule.type === "once") {
			// One-shot task: mark as completed.
			this.db.updateScheduledTask(taskId, {
				status: "completed",
				last_run_at: lastRunAt,
				next_run_at: null,
			});
		} else if (schedule.type === "interval") {
			// Interval task: reschedule.
			const nextRunAt = computeNextRunAt(schedule, runTime);
			this.db.updateScheduledTask(taskId, {
				status: "pending",
				last_run_at: lastRunAt,
				next_run_at: nextRunAt,
			});
		} else {
			// Cron (not yet fully supported) — mark completed for now.
			this.db.updateScheduledTask(taskId, {
				status: "completed",
				last_run_at: lastRunAt,
				next_run_at: null,
			});
		}
	}
}
