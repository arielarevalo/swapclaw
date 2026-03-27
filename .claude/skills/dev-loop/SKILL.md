---
name: dev-loop
description: Orchestrates an agent team to implement tasks from PLAN.md — spawns workers in parallel worktrees, reviews their output, and marshals commits on main.
---

# /dev-loop — Agent Team Orchestrator

Reads `PLAN.md`, identifies unblocked tasks, dispatches them to worker agents
running in isolated worktrees, reviews their output, merges changes back to
main, validates, commits, and pushes. The orchestrator never implements — it
only coordinates.

## Prerequisites

Before starting, verify all three. Fix any that fail.

1. **Branch**: must be on `main`.
   ```bash
   git branch --show-current   # must print "main"
   ```
   If not on main: `git checkout main`.

2. **Clean tree**: no uncommitted changes.
   ```bash
   git status --porcelain      # must be empty
   ```
   If dirty: ask the user what to do.

3. **Toolchain**: bun and tools available.
   ```bash
   bun --version && bun run build 2>&1 | tail -1 && bun test --run 2>&1 | tail -1
   ```
   If any fail: stop and report.

## Configuration

Parse optional arguments:

- `/dev-loop` — default: max 10 iterations, all tasks
- `/dev-loop 5` or `/dev-loop max=5` — override max iterations
- `/dev-loop T-03` — single task mode (skip PICK, go straight to that task)

Set `MAX_ITERATIONS` (default 10) and `TASK_FILTER` (default none).

---

## The Loop

Set `iteration = 0`, `completed_tasks = []`.

Repeat until a **stop condition** is met:

---

### Step 1: PICK (orchestrator)

1. Read `PLAN.md` from the project root.
2. Parse tasks by checkbox status:
   - `[~]` — in progress (highest priority)
   - `[ ]` — not started
   - `[x]` — done (skip)
   - `[BLOCKED by T-XX]` — blocked (skip unless T-XX is `[x]`)
3. **Selection**: gather ALL unblocked `[ ]` tasks in the current phase (plus
   any `[~]` tasks). These are the **batch** for this iteration.
   - Cross phase boundaries: if all tasks in the current phase are `[x]`, move
     to the next phase — but first run the **Phase Boundary Check** (step 3a).
   - If `TASK_FILTER` is set, only pick the matching task.

   **3a. Phase Boundary Check** (when crossing into a new phase):

   Before picking any task in the new phase, review every task and its
   sub-bullets. For each task, ask:

   > Could a worker agent — given ONLY this task description plus the project
   > conventions — produce exactly the right implementation without guessing?

   A task is **granular enough** when it specifies:
   - **What to create/change**: concrete file paths, class/function names, method
     signatures, or clear "extract from X" references.
   - **Behaviour**: what the code does, key edge cases, error handling strategy.
   - **Inputs and outputs**: what the module takes, what it returns, how it
     integrates with adjacent modules.
   - **Tests expected**: what to test, which tier (unit/integration/e2e), rough
     coverage (e.g. "happy path + 2 error cases").
   - **Reference files**: which existing files to read for context.

   A task is **too vague** if the worker would need to make significant design
   decisions, invent interfaces, or guess at scope. Examples of vague tasks:
   - "Add crash recovery" (recover from what? how? which modules?)
   - "Wire entry point" (what gets wired? what's the startup sequence?)
   - "Add session persistence" (persist what? where? replay strategy?)

   **If any task fails the check:**
   1. Expand it in PLAN.md — add sub-bullets with the missing specifics. Read
      relevant source files, ADRs, and prior spike code to fill in details.
   2. If a task is too large, split it into 2–3 smaller tasks with their own
      IDs and dependency annotations.
   3. Re-read the expanded tasks to confirm they pass the check.
   4. Commit the PLAN.md update before proceeding.

4. Mark each picked task `[~]` in PLAN.md. Do NOT commit yet.
5. **If no task can be picked** → STOP with appropriate reason.

---

### Step 2: DISPATCH (orchestrator → workers)

For each task in the batch, spawn a **worker agent** using the Agent tool:

```
Agent(
  subagent_type: "general-purpose",
  isolation: "worktree",
  mode: "auto",
  prompt: <see Worker Prompt below>,
  description: "T-XX: <short task name>",
  name: "worker-T-XX",
)
```

**Parallelism rules:**
- Tasks within the same phase that have NO dependency on each other → spawn in
  parallel (single message, multiple Agent tool calls).
- Tasks that depend on each other (one's output is another's input) → spawn
  sequentially, waiting for the dependency to complete first.
- Max 3 concurrent workers to avoid resource exhaustion.

**Worker Prompt template:**

```
You are a worker agent implementing a single task for the swapclaw project.

## Task
{paste the full task spec from PLAN.md, including all sub-bullets}

## Project conventions (from CLAUDE.md)
- TypeScript, strict mode, ESM
- Biome for lint/format, tsc for type checking, vitest for tests
- Test tiers:
  - Unit: `tests/<module>.test.ts` — single class, all deps mocked
  - Integration: `tests/integration_<flow>.test.ts` — multi-class, external deps mocked
  - E2E: `tests/e2e_<scenario>.test.ts` — full app, no mocks

## Instructions
1. Read ALL input files listed in the task.
2. Implement the changes described.
3. Run validation:
   a. `bun run lint:fix` (auto-fix + format)
   b. `bun run build` (tsc type check)
   c. `bun test --run` (vitest)
4. If validation fails, fix and retry (max 3 attempts).
5. Do NOT commit. Leave changes in the working tree.
6. When done, report:
   - Files changed (list)
   - Tests added (list)
   - Validation status (pass/fail + output if fail)
   - Any issues or blockers encountered
```

---

### Step 3: COLLECT + REVIEW (orchestrator)

As each worker completes:

1. **Check the worker result.** If the worker reports failure after 3 retries,
   mark the task `[BLOCKED]` in PLAN.md with reason, skip it, continue with
   other workers.

2. **If the worker made changes** (worktree has modifications):
   The Agent tool returns the worktree path and branch. The orchestrator must
   integrate these changes into main.

3. **Review the diff:**
   ```bash
   git diff main..<worker-branch> -- . ':!PLAN.md' ':!CHANGELOG.md'
   ```
   Check:
   - Changes match the task spec (all items addressed)
   - No secrets, credentials, or `.env` files
   - No out-of-scope modifications
   - No commented-out code
   - Test names follow conventions

4. **If issues found**: note them. The orchestrator fixes minor issues itself
   after merge. For major issues, discard the worktree and re-dispatch.

---

### Step 4: MERGE + VALIDATE (orchestrator, one task at a time)

Process completed workers **one at a time** to keep main stable:

#### 4a. Merge worker changes into main

```bash
git merge <worker-branch> --no-ff -m "merge: worker T-XX"
```

If merge conflicts: resolve them (the orchestrator has full context of all
tasks). If unresolvable, skip this task and move on.

#### 4b. Validate on main

Run the full validation suite on main after the merge:

```bash
bun run lint:fix
bun run build
bun test --run
```

If any check fails:
- Increment `merge_failures` for this task.
- If `merge_failures >= 2`: revert the merge (`git reset --hard HEAD~1`),
  mark task as blocked, move on.
- Otherwise: fix the issue on main, re-run validation.

#### 4c. Clean up worktree

The worktree is auto-cleaned if no changes remain. If it persists:
```bash
git worktree remove <path> --force
git branch -D <worker-branch>
```

---

### Step 5: COMMIT + PUSH (orchestrator)

After all workers for this iteration are merged and validated:

#### 5a. Update plan and changelog

1. Edit `PLAN.md`: change each completed task from `[~]` to `[x]`. Update
   "Last updated" date.
2. Edit `CHANGELOG.md`: add entries under `## [Unreleased]` for each task.

#### 5b. Determine commit message

One commit per task. Infer conventional commit type:
- Feature → `feat`, Bug fix → `fix`, Tests → `test`, Docs → `docs`,
  Refactor → `refactor`, Default → `chore`

Infer scope from primary file or module name.

#### 5c. Verify GitHub user

```bash
gh auth status
```
If not `arielarevalo`: `gh auth switch -u arielarevalo`

#### 5d. Stage, commit, push

For each merged task, create a separate commit:

```bash
git add <changed files> PLAN.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
<type>(<scope>): <summary>

Task: <task-id>

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

After all commits:
```bash
git push origin main
```

If push fails due to remote changes:
```bash
git pull --rebase origin main
git push origin main
```

If push fails twice: STOP. Never force-push.

---

### Step 6: REPEAT

1. Append completed task IDs to `completed_tasks`.
2. Increment `iteration`.
3. Check stop conditions:
   - `iteration >= MAX_ITERATIONS` → STOP
   - All tasks `[x]` → STOP
   - Only blocked tasks remain → STOP
   - `TASK_FILTER` was set → STOP after that task
4. If no stop condition: go to **Step 1**.

---

## Stop Conditions

1. All tasks `[x]` (success)
2. Only blocked tasks remain
3. `iteration >= MAX_ITERATIONS`
4. `PLAN.md` cannot be parsed
5. `TASK_FILTER` task completed
6. Push fails twice

## Key Principles

- **The orchestrator never implements.** It reads, picks, dispatches, reviews,
  merges, commits. All implementation happens in worker agents.
- **Workers never commit.** They leave changes in their worktree. The
  orchestrator decides when and how to commit.
- **One commit per task.** Even if multiple workers ran in parallel, their
  changes are committed separately in sequence on main.
- **Main stays stable.** Every commit on main passes the full validation suite.
  If a merge breaks validation, it gets reverted.
- **Parallel where possible.** Independent tasks in the same phase run
  concurrently. Dependent tasks run sequentially.

## Summary Output

When the loop stops:

```
## Dev Loop Summary
- Iterations: {N}
- Workers spawned: {N}
- Tasks completed: {list}
- Tasks remaining: {list}
- Tasks blocked: {list with reasons}
- Stop reason: {reason}
- Commits pushed: {N}
```
