import type { ContainerRuntime } from "./container-runtime.js";
import type { Database } from "./db.js";
import { Logger } from "./logger.js";

const log = new Logger("crash-recovery");

/**
 * Recover stale container states left behind by a previous crash.
 *
 * Two recovery passes:
 *
 * 1. **Dead containers**: Queries all container_state rows marked as "running"
 *    and checks whether the container actually exists via the runtime. Stale
 *    entries (container gone) are cleared from the database and the associated
 *    session is closed, since it can no longer function without a container.
 *
 * 2. **Orphaned containers**: Checks for containers that are still alive but
 *    whose session is "closed" in the database. This handles the case where
 *    swapclaw crashed after closing a session but before stopping its container.
 *    These containers are stopped, removed, and their state is cleared.
 *
 * @returns The number of stale sessions that were recovered.
 */
export async function recoverStaleContainers(
	db: Database,
	runtime: ContainerRuntime,
): Promise<number> {
	const running = db.listRunningContainers();

	let recovered = 0;

	// Pass 1: Clear stale container states for dead containers and close their sessions.
	for (const row of running) {
		const alive = await runtime.isRunning(row.container_id);

		if (!alive) {
			db.clearContainerState(row.session_id);
			db.closeSession(row.session_id);
			log.info("Cleared stale container state", {
				sessionId: row.session_id,
				containerId: row.container_id,
			});
			recovered++;
		}
	}

	// Pass 2: Stop orphaned running containers whose session is already closed.
	for (const row of running) {
		const alive = await runtime.isRunning(row.container_id);
		if (!alive) continue;

		const session = db.getSession(row.session_id);
		if (session && session.state === "closed") {
			await runtime.stop(row.container_id);
			await runtime.remove(row.container_id);
			db.clearContainerState(row.session_id);
			log.info("Stopped orphaned container", {
				sessionId: row.session_id,
				containerId: row.container_id,
			});
			recovered++;
		}
	}

	if (recovered > 0) {
		log.info("Recovery complete", { recovered });
	}

	return recovered;
}
