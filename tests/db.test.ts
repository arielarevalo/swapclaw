import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContainerStateInput } from "../src/db.js";
import { Database } from "../src/db.js";

describe("Database", () => {
	let db: Database;

	beforeEach(() => {
		db = Database.inMemory();
	});

	afterEach(() => {
		db.close();
	});

	// ── Migration ──────────────────────────────────────────────────

	describe("migration", () => {
		it("creates all tables from version 0", () => {
			// The constructor already ran migrations, so tables should exist.
			// Verify by inserting into each table without error.
			db.createSession("aaa", "/tmp");
			db.addMessage("aaa", "user", "hello");
			db.setContainerState("aaa", {
				container_id: "ctr1",
				runtime: "docker",
				status: "running",
				started_at: new Date().toISOString(),
			});

			expect(db.getSession("aaa")).not.toBeNull();
			expect(db.getMessages("aaa")).toHaveLength(1);
			expect(db.getContainerState("aaa")).not.toBeNull();
		});
	});

	// ── Sessions CRUD ──────────────────────────────────────────────

	describe("sessions", () => {
		it("createSession and getSession round-trip", () => {
			db.createSession("s1", "/home/user/project");

			const row = db.getSession("s1");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("s1");
			expect(row?.cwd).toBe("/home/user/project");
			expect(row?.state).toBe("active");
			expect(row?.title).toBeNull();
			expect(row?.created_at).toBeTruthy();
			expect(row?.updated_at).toBeTruthy();
		});

		it("getSession returns null for missing id", () => {
			expect(db.getSession("nonexistent")).toBeNull();
		});

		it("updateSession sets title", () => {
			db.createSession("s1", "/tmp");
			db.updateSession("s1", { title: "My Session" });

			const row = db.getSession("s1");
			expect(row?.title).toBe("My Session");
		});

		it("updateSession sets state", () => {
			db.createSession("s1", "/tmp");
			db.updateSession("s1", { state: "closed" });

			const row = db.getSession("s1");
			expect(row?.state).toBe("closed");
		});

		it("updateSession bumps updated_at", () => {
			db.createSession("s1", "/tmp");
			const beforeRow = db.getSession("s1");
			const before = beforeRow?.updated_at ?? "";

			db.updateSession("s1", { title: "updated" });

			const afterRow = db.getSession("s1");
			const after = afterRow?.updated_at ?? "";
			expect(after >= before).toBe(true);
		});

		it("updateSession with empty updates is a no-op", () => {
			db.createSession("s1", "/tmp");
			const before = db.getSession("s1");
			db.updateSession("s1", {});
			const after = db.getSession("s1");
			expect(after?.updated_at).toBe(before?.updated_at);
		});

		it("closeSession sets state to closed and updates timestamp", () => {
			db.createSession("s1", "/tmp");
			const beforeClose = db.getSession("s1");
			expect(beforeClose?.state).toBe("active");

			db.closeSession("s1");

			const afterClose = db.getSession("s1");
			expect(afterClose?.state).toBe("closed");
			expect((afterClose?.updated_at ?? "") >= (beforeClose?.updated_at ?? "")).toBe(true);
		});

		it("listSessions returns all sessions ordered by updated_at desc", () => {
			db.createSession("s1", "/a");
			db.createSession("s2", "/b");
			db.createSession("s3", "/a");

			// Touch s1 so it becomes most recent
			db.updateSession("s1", { title: "bumped" });

			const all = db.listSessions();
			expect(all.length).toBe(3);
			// s1 was updated last, so it should be first
			expect(all[0].id).toBe("s1");
		});

		it("listSessions filters by cwd", () => {
			db.createSession("s1", "/project-a");
			db.createSession("s2", "/project-b");
			db.createSession("s3", "/project-a");

			const filtered = db.listSessions("/project-a");
			expect(filtered).toHaveLength(2);
			for (const row of filtered) {
				expect(row.cwd).toBe("/project-a");
			}
		});

		it("listSessions with cwd returns empty array when no match", () => {
			db.createSession("s1", "/project-a");
			const filtered = db.listSessions("/nonexistent");
			expect(filtered).toHaveLength(0);
		});
	});

	// ── Messages CRUD ──────────────────────────────────────────────

	describe("messages", () => {
		it("addMessage and getMessages round-trip", () => {
			db.createSession("s1", "/tmp");
			db.addMessage("s1", "user", "hello");
			db.addMessage("s1", "assistant", "hi there");

			const msgs = db.getMessages("s1");
			expect(msgs).toHaveLength(2);
			expect(msgs[0].role).toBe("user");
			expect(msgs[0].content).toBe("hello");
			expect(msgs[1].role).toBe("assistant");
			expect(msgs[1].content).toBe("hi there");
		});

		it("messages are ordered by created_at ascending", () => {
			db.createSession("s1", "/tmp");
			db.addMessage("s1", "user", "first");
			db.addMessage("s1", "assistant", "second");
			db.addMessage("s1", "user", "third");

			const msgs = db.getMessages("s1");
			for (let i = 1; i < msgs.length; i++) {
				expect(msgs[i].created_at >= msgs[i - 1].created_at).toBe(true);
			}
		});

		it("getMessages respects limit", () => {
			db.createSession("s1", "/tmp");
			db.addMessage("s1", "user", "one");
			db.addMessage("s1", "assistant", "two");
			db.addMessage("s1", "user", "three");

			const msgs = db.getMessages("s1", 2);
			expect(msgs).toHaveLength(2);
			expect(msgs[0].content).toBe("one");
			expect(msgs[1].content).toBe("two");
		});

		it("getMessages returns empty array for session with no messages", () => {
			db.createSession("s1", "/tmp");
			expect(db.getMessages("s1")).toHaveLength(0);
		});

		it("messages have auto-incrementing ids", () => {
			db.createSession("s1", "/tmp");
			db.addMessage("s1", "user", "a");
			db.addMessage("s1", "user", "b");

			const msgs = db.getMessages("s1");
			expect(msgs[1].id).toBeGreaterThan(msgs[0].id);
		});
	});

	// ── Container state CRUD ───────────────────────────────────────

	describe("container_state", () => {
		const baseState: ContainerStateInput = {
			container_id: "ctr-abc123",
			runtime: "docker",
			status: "running",
			started_at: "2026-01-01T00:00:00.000Z",
		};

		it("setContainerState and getContainerState round-trip", () => {
			db.createSession("s1", "/tmp");
			db.setContainerState("s1", baseState);

			const row = db.getContainerState("s1");
			expect(row).not.toBeNull();
			expect(row?.session_id).toBe("s1");
			expect(row?.container_id).toBe("ctr-abc123");
			expect(row?.runtime).toBe("docker");
			expect(row?.status).toBe("running");
			expect(row?.started_at).toBe("2026-01-01T00:00:00.000Z");
			expect(row?.stopped_at).toBeNull();
		});

		it("setContainerState upserts on conflict", () => {
			db.createSession("s1", "/tmp");
			db.setContainerState("s1", baseState);
			db.setContainerState("s1", {
				...baseState,
				status: "stopped",
				stopped_at: "2026-01-01T01:00:00.000Z",
			});

			const row = db.getContainerState("s1");
			expect(row?.status).toBe("stopped");
			expect(row?.stopped_at).toBe("2026-01-01T01:00:00.000Z");
		});

		it("getContainerState returns null for missing session", () => {
			expect(db.getContainerState("nonexistent")).toBeNull();
		});

		it("clearContainerState removes the row", () => {
			db.createSession("s1", "/tmp");
			db.setContainerState("s1", baseState);
			expect(db.getContainerState("s1")).not.toBeNull();

			db.clearContainerState("s1");
			expect(db.getContainerState("s1")).toBeNull();
		});

		it("clearContainerState is safe on missing row", () => {
			db.createSession("s1", "/tmp");
			// Should not throw
			db.clearContainerState("s1");
		});

		it("listRunningContainers returns only rows with status running", () => {
			db.createSession("s1", "/tmp");
			db.createSession("s2", "/tmp");
			db.createSession("s3", "/tmp");

			db.setContainerState("s1", { ...baseState, container_id: "ctr-1" });
			db.setContainerState("s2", {
				...baseState,
				container_id: "ctr-2",
				status: "stopped",
				stopped_at: "2026-01-01T01:00:00.000Z",
			});
			db.setContainerState("s3", { ...baseState, container_id: "ctr-3" });

			const running = db.listRunningContainers();
			expect(running).toHaveLength(2);
			const ids = running.map((r) => r.session_id).sort();
			expect(ids).toEqual(["s1", "s3"]);
		});

		it("listRunningContainers returns empty array when no running containers", () => {
			expect(db.listRunningContainers()).toHaveLength(0);
		});

		it("supports apple runtime", () => {
			db.createSession("s1", "/tmp");
			db.setContainerState("s1", {
				...baseState,
				runtime: "apple",
				container_id: "apple-xyz",
			});

			const row = db.getContainerState("s1");
			expect(row?.runtime).toBe("apple");
			expect(row?.container_id).toBe("apple-xyz");
		});
	});
});
