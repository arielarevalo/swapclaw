# ADR 003: End-to-End Architecture Validation

## Status

Accepted

## Date

2026-03-26

## Context

swapclaw's architecture has the ACP client as the "body" (managing containers
and sessions) while an external ACP agent serves as the "brain." Prior work
proved individual pieces:

- ACP `ClientSideConnection` + `ndJsonStream` work for connecting to an agent
  over stdio. Session updates flow correctly. (See ADR 001.)
- Claude Code and Cline use terminal and filesystem Client callbacks. A mock
  test agent based on the acpx pattern is needed for deterministic testing.
  (See ADR 002.)
- Terminal requests (`createTerminal`, `waitForTerminalExit`, `terminalOutput`,
  `releaseTerminal`) route successfully into Docker containers via `docker exec`.

What remained unproven was the **full end-to-end loop** with ALL Client
callbacks, including filesystem operations (`readTextFile`, `writeTextFile`),
and the combined flow where multiple callback types interact in a single session.

## Decision

Validate the complete architecture by:

1. Creating a **mock test agent** that deterministically exercises all Client
   callbacks based on prompt text commands.
2. Extending the Client implementation with **filesystem routing** into Docker
   containers.
3. Running a **test suite** that verifies all callback types and their
   interactions.

### Mock Test Agent Design

The mock test agent implements the ACP `Agent` interface and parses prompt text
as commands:

| Command | Client Callbacks Exercised |
|---------|---------------------------|
| `echo <text>` | `sessionUpdate` only (no container interaction) |
| `terminal <command>` | `createTerminal` -> `waitForTerminalExit` -> `currentOutput` -> `release` |
| `read <path>` | `readTextFile` |
| `write <path> <content>` | `writeTextFile` |
| `combined <path> <content>` | `writeTextFile` -> `readTextFile` (round-trip verification) |

The agent is deterministic — no AI, no randomness — making it ideal for
automated testing.

### Filesystem Routing

File operations route into Docker containers using `docker exec`:

- **readTextFile**: `docker exec <container> cat '<path>'`
  - With `line`/`limit` parameters: uses `sed -n '<start>,<end>p'` or `head -n`
- **writeTextFile**: `docker exec -i <container> sh -c 'cat > <path>'` with
  content piped to stdin
  - Parent directories created automatically via `mkdir -p`

This approach was chosen over `docker cp` because:
- `docker exec` is already proven for terminal routing
- Simpler error handling (single command vs. temp file + copy + cleanup)
- Supports the `line`/`limit` parameters natively via sed/head
- Consistent with how terminal commands are routed

### Capability Advertisement

The client advertises all capabilities during initialization:

```typescript
clientCapabilities: {
  terminal: true,
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
}
```

## Findings

### What Was Proved

1. **Full ACP round-trip**: prompt -> agent thinks -> agent calls Client
   callbacks -> client routes to container -> results flow back to agent ->
   agent responds via sessionUpdate.

2. **Terminal lifecycle in containers**: The complete `createTerminal` ->
   `waitForTerminalExit` -> `currentOutput` -> `release` cycle works through
   Docker exec.

3. **Filesystem read/write in containers**: `readTextFile` and `writeTextFile`
   successfully read from and write to the container filesystem. File content
   survives the write-then-read round-trip, proving data integrity.

4. **Cross-callback interactions**: A file written via `writeTextFile` is
   visible to subsequent `terminal ls` commands, proving that terminal and
   filesystem operations share the same container filesystem state.

5. **Session continuity**: Multiple prompts in the same session all operate on
   the same container, and state (written files, etc.) persists across prompts.

6. **sessionUpdate streaming**: Agent message chunks flow correctly from agent
   to client for all command types.

7. **Capability negotiation**: The `initialize` handshake with `terminal: true`
   and `fs: { readTextFile: true, writeTextFile: true }` works correctly.

### Architecture Confirmed

```
MockTestAgent (commands -> Client callbacks)
  ↕ ACP (stdio, ndJsonStream, JSON-RPC 2.0)
SwapClawClient (implements full Client interface)
  ├─ TerminalManager → docker exec (command execution)
  ├─ FilesystemManager → docker exec cat/sh (file read/write)
  └─ requestPermission → auto-approve (sandbox isolation)
  ↕ docker exec
Container (execution sandbox)
```

This is exactly the target architecture for swapclaw, with the mock test agent
standing in for any real ACP agent (Claude Code, Cline, Gemini CLI, etc.).

### Key Implementation Details

**TerminalManager**:
- Each `createTerminal` spawns a `docker exec` child process
- stdout and stderr are captured into an output buffer
- `waitForTerminalExit` wraps the process exit event as a Promise
- `releaseTerminal` kills the process (if running) and frees the buffer
- Output byte limit enforcement with truncation from the beginning

**FilesystemManager**:
- `read(path, line?, limit?)` -> `docker exec cat` (or `sed -n`/`head -n`)
- `write(path, content)` -> `docker exec -i sh -c 'cat > path'`
- Parent directories auto-created via `mkdir -p`
- Path escaping for shell safety

### Risks Identified

- **Shell injection in file paths**: Path validation must reject special
  characters, enforce absolute paths, and check for path traversal.
- **Container startup latency**: Each test run starts a fresh container.
  Production containers should be pre-warmed or pooled.
- **Alpine-specific commands**: `cat`, `sed`, `head`, `mkdir -p` are
  POSIX-standard, but production containers may need to verify tool
  availability.

## Consequences

- The end-to-end spike validates the complete architecture: swapclaw sends a
  prompt to an ACP agent and the agent successfully executes commands and
  reads/writes files in a Docker container via the ACP Client interface.
- The spike code provides proven patterns extracted into production modules:
  `TerminalManager`, `FilesystemManager`, and `SwapClawClient`.
- The mock test agent is used in both integration and E2E test suites.

## References

- ADR 001: ACP Client Interface Analysis
- ADR 002: ACP Agent Ecosystem Survey
- ACP spec: https://agentclientprotocol.com/protocol/overview
- ACP TypeScript SDK: `@agentclientprotocol/sdk` v0.17.0
- acpx: https://github.com/openclaw/acpx
