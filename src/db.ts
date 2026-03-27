import { Database as SQLiteDB } from "bun:sqlite";

// ── Row types ────────────────────────────────────────────────────────

export interface SessionRow {
	id: string;
	cwd: string;
	title: string | null;
	state: string;
	mode: string;
	created_at: string;
	updated_at: string;
}

export interface MessageRow {
	id: number;
	session_id: string;
	role: string;
	content: string;
	created_at: string;
}

export interface ContainerStateRow {
	session_id: string;
	container_id: string;
	runtime: string;
	status: string;
	started_at: string;
	stopped_at: string | null;
}

// ── Session update fields ────────────────────────────────────────────

export interface SessionUpdate {
	title?: string;
	state?: string;
	cwd?: string;
	mode?: string;
}

// ── Container state input ────────────────────────────────────────────

export interface ContainerStateInput {
	container_id: string;
	runtime: string;
	status: string;
	started_at: string;
	stopped_at?: string | null;
}

// ── Scheduled task row type ──────────────────────────────────────────

export interface ScheduledTaskRow {
	id: string;
	session_id: string;
	prompt: string;
	schedule_type: string;
	schedule_value: string;
	status: string;
	created_at: string;
	last_run_at: string | null;
	next_run_at: string | null;
}

// ── Schema migrations ───────────────────────────────────────────────

const MIGRATION_V1 = `
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  cwd         TEXT NOT NULL,
  title       TEXT,
  state       TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

CREATE TABLE container_state (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id),
  container_id TEXT NOT NULL,
  runtime     TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  stopped_at  TEXT
);
`;

const MIGRATION_V2 = `
ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'code';

CREATE TABLE scheduled_tasks (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  schedule_type   TEXT NOT NULL,
  schedule_value  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL,
  last_run_at     TEXT,
  next_run_at     TEXT
);

CREATE INDEX idx_scheduled_tasks_session ON scheduled_tasks(session_id);
CREATE INDEX idx_scheduled_tasks_status ON scheduled_tasks(status, next_run_at);
`;

// ── Database wrapper ────────────────────────────────────────────────

export class Database {
	private db: SQLiteDB;

	constructor(dbPath: string) {
		this.db = new SQLiteDB(dbPath);
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	/** Create an in-memory database (useful for tests). */
	static inMemory(): Database {
		return new Database(":memory:");
	}

	/** Close the underlying connection. */
	close(): void {
		this.db.close();
	}

	// ── Migrations ──────────────────────────────────────────────────

	private migrate(): void {
		const version = this.getUserVersion();
		if (version < 1) {
			this.db.exec(MIGRATION_V1);
			this.setUserVersion(1);
		}
		if (version < 2) {
			this.db.exec(MIGRATION_V2);
			this.setUserVersion(2);
		}
	}

	private getUserVersion(): number {
		const row = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
		return row?.user_version ?? 0;
	}

	private setUserVersion(v: number): void {
		this.db.run(`PRAGMA user_version = ${v}`);
	}

	// ── Sessions ────────────────────────────────────────────────────

	createSession(id: string, cwd: string): void {
		const now = new Date().toISOString();
		this.db
			.query(
				"INSERT INTO sessions (id, cwd, state, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?4)",
			)
			.run(id, cwd, now, now);
	}

	getSession(id: string): SessionRow | null {
		return (
			this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?1").get(id) ?? null
		);
	}

	listSessions(cwd?: string): SessionRow[] {
		if (cwd !== undefined) {
			return this.db
				.query<SessionRow, [string]>(
					"SELECT * FROM sessions WHERE cwd = ?1 ORDER BY updated_at DESC",
				)
				.all(cwd);
		}
		return this.db.query<SessionRow, []>("SELECT * FROM sessions ORDER BY updated_at DESC").all();
	}

	updateSession(id: string, updates: SessionUpdate): void {
		const fields: string[] = [];
		const values: string[] = [];
		let idx = 1;

		if (updates.title !== undefined) {
			fields.push(`title = ?${idx}`);
			values.push(updates.title);
			idx++;
		}
		if (updates.state !== undefined) {
			fields.push(`state = ?${idx}`);
			values.push(updates.state);
			idx++;
		}
		if (updates.cwd !== undefined) {
			fields.push(`cwd = ?${idx}`);
			values.push(updates.cwd);
			idx++;
		}
		if (updates.mode !== undefined) {
			fields.push(`mode = ?${idx}`);
			values.push(updates.mode);
			idx++;
		}

		if (fields.length === 0) return;

		fields.push(`updated_at = ?${idx}`);
		values.push(new Date().toISOString());
		idx++;

		values.push(id);
		const sql = `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?${idx}`;
		this.db.query(sql).run(...values);
	}

	closeSession(id: string): void {
		const now = new Date().toISOString();
		this.db
			.query("UPDATE sessions SET state = 'closed', updated_at = ?1 WHERE id = ?2")
			.run(now, id);
	}

	// ── Messages ────────────────────────────────────────────────────

	addMessage(sessionId: string, role: string, content: string): void {
		const now = new Date().toISOString();
		this.db
			.query("INSERT INTO messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)")
			.run(sessionId, role, content, now);
	}

	getMessages(sessionId: string, limit?: number): MessageRow[] {
		if (limit !== undefined) {
			return this.db
				.query<MessageRow, [string, number]>(
					"SELECT * FROM messages WHERE session_id = ?1 ORDER BY created_at ASC LIMIT ?2",
				)
				.all(sessionId, limit);
		}
		return this.db
			.query<MessageRow, [string]>(
				"SELECT * FROM messages WHERE session_id = ?1 ORDER BY created_at ASC",
			)
			.all(sessionId);
	}

	// ── Container state ─────────────────────────────────────────────

	setContainerState(sessionId: string, state: ContainerStateInput): void {
		this.db
			.query(
				`INSERT INTO container_state (session_id, container_id, runtime, status, started_at, stopped_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(session_id) DO UPDATE SET
         container_id = excluded.container_id,
         runtime      = excluded.runtime,
         status       = excluded.status,
         started_at   = excluded.started_at,
         stopped_at   = excluded.stopped_at`,
			)
			.run(
				sessionId,
				state.container_id,
				state.runtime,
				state.status,
				state.started_at,
				state.stopped_at ?? null,
			);
	}

	getContainerState(sessionId: string): ContainerStateRow | null {
		return (
			this.db
				.query<ContainerStateRow, [string]>("SELECT * FROM container_state WHERE session_id = ?1")
				.get(sessionId) ?? null
		);
	}

	/** Return all container_state rows where status = 'running'. */
	listRunningContainers(): ContainerStateRow[] {
		return this.db
			.query<ContainerStateRow, []>("SELECT * FROM container_state WHERE status = 'running'")
			.all();
	}

	clearContainerState(sessionId: string): void {
		this.db.query("DELETE FROM container_state WHERE session_id = ?1").run(sessionId);
	}

	// ── Scheduled tasks ─────────────────────────────────────────────

	createScheduledTask(task: ScheduledTaskRow): void {
		this.db
			.query(
				`INSERT INTO scheduled_tasks (id, session_id, prompt, schedule_type, schedule_value, status, created_at, last_run_at, next_run_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
			)
			.run(
				task.id,
				task.session_id,
				task.prompt,
				task.schedule_type,
				task.schedule_value,
				task.status,
				task.created_at,
				task.last_run_at,
				task.next_run_at,
			);
	}

	listScheduledTasks(sessionId?: string): ScheduledTaskRow[] {
		if (sessionId !== undefined) {
			return this.db
				.query<ScheduledTaskRow, [string]>(
					"SELECT * FROM scheduled_tasks WHERE session_id = ?1 ORDER BY created_at ASC",
				)
				.all(sessionId);
		}
		return this.db
			.query<ScheduledTaskRow, []>("SELECT * FROM scheduled_tasks ORDER BY created_at ASC")
			.all();
	}

	updateScheduledTask(
		id: string,
		updates: Partial<Pick<ScheduledTaskRow, "status" | "last_run_at" | "next_run_at">>,
	): void {
		const fields: string[] = [];
		const values: (string | null)[] = [];
		let idx = 1;

		if (updates.status !== undefined) {
			fields.push(`status = ?${idx}`);
			values.push(updates.status);
			idx++;
		}
		if (updates.last_run_at !== undefined) {
			fields.push(`last_run_at = ?${idx}`);
			values.push(updates.last_run_at);
			idx++;
		}
		if (updates.next_run_at !== undefined) {
			fields.push(`next_run_at = ?${idx}`);
			values.push(updates.next_run_at);
			idx++;
		}

		if (fields.length === 0) return;

		values.push(id);
		const sql = `UPDATE scheduled_tasks SET ${fields.join(", ")} WHERE id = ?${idx}`;
		this.db.query(sql).run(...values);
	}

	deleteScheduledTask(id: string): void {
		this.db.query("DELETE FROM scheduled_tasks WHERE id = ?1").run(id);
	}

	getScheduledTask(id: string): ScheduledTaskRow | null {
		return (
			this.db
				.query<ScheduledTaskRow, [string]>("SELECT * FROM scheduled_tasks WHERE id = ?1")
				.get(id) ?? null
		);
	}

	/** Return all pending tasks whose next_run_at is at or before the given time. */
	getDueTasks(now: string): ScheduledTaskRow[] {
		return this.db
			.query<ScheduledTaskRow, [string]>(
				"SELECT * FROM scheduled_tasks WHERE status = 'pending' AND next_run_at IS NOT NULL AND next_run_at <= ?1 ORDER BY next_run_at ASC",
			)
			.all(now);
	}
}
