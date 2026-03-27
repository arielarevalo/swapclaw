# Architecture

## Overview

```
External ACP Agent (the brain — any ACP-compatible agent)
  ↕ ACP (ClientSideConnection / AgentSideConnection)
swapclaw
  ├── index.ts               Bootstrap + ACP stdio transport
  ├── server.ts              ACP agent adapter (AgentSideConnection)
  ├── session-orchestrator.ts Central coordinator
  ├── acp-client.ts          ACP client (ClientSideConnection to agent)
  ├── container-runner.ts    Per-session container lifecycle
  ├── container-runtime.ts   Docker / Apple Container abstraction
  ├── terminal-manager.ts    Routes terminal I/O into containers
  ├── filesystem-manager.ts  Routes file I/O into containers
  ├── session-manager.ts     Session creation and metadata
  ├── db.ts                  SQLite persistence
  ├── config.ts              Environment-based configuration (Zod)
  ├── crash-recovery.ts      Stale container cleanup on startup
  ├── task-scheduler.ts      Scheduled task execution
  ├── session-modes.ts       code / ask / architect modes
  └── mcp-passthrough.ts     MCP server config forwarding
```

`index.ts` bootstraps all components and connects via ACP stdio transport. `server.ts` is a thin adapter — it delegates everything to `SessionOrchestrator`, which wires sessions to containers to ACP agent connections.

## Request Flow

1. An external ACP client sends a prompt to swapclaw (acting as an ACP agent)
2. `SessionOrchestrator` routes the prompt to the internal ACP agent connection
3. The agent processes the prompt and makes client callbacks (terminal, filesystem, permissions)
4. `SwapClawClient` routes callbacks into the container via `docker exec`
5. Results flow back through ACP to the agent
6. Session updates stream back to the external client in real time

## Security Model

Container isolation is the primary security boundary.

- Each session gets a dedicated Docker or Apple Container sandbox
- The project mount (`/project`) is read-only; only `/session` is writable
- `requestPermission()` auto-approves because all operations execute inside the sandbox
- Shell commands use `spawn()` with array arguments — no shell interpretation

## Container Runtimes

swapclaw supports two container runtimes:

- **Docker** — the default, works on Linux and macOS
- **Apple Containers** — native macOS containers, auto-detected on macOS when available

The runtime is detected automatically at startup. Both implement the same `ContainerRuntime` interface, and the `ContainerExec` abstraction ensures terminal and filesystem I/O works identically regardless of runtime.

## Persistence

Sessions and messages are persisted to SQLite (`~/.swapclaw/swapclaw.db` by default). This enables:

- Session history replay on reconnect
- Crash recovery (stale container state is cleaned up on startup)
- Task scheduling state survives restarts
