# swapclaw

Container-isolated agent runtime over the Agent Client Protocol (ACP). The ACP
client connects to any external ACP agent, and that agent becomes the brain
driving container sandboxes managed by swapclaw.

## Architecture

```
External ACP Agent
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

`src/index.ts` bootstraps all components and connects via ACP stdio transport.
`src/server.ts` is a thin adapter — it delegates everything to
`SessionOrchestrator`, which wires sessions to containers to ACP agent
connections.

## Security Model

Container isolation is the primary security boundary.

- Each session gets a dedicated Docker or Apple Container sandbox
- The project mount (`/project`) is read-only; only `/session` is writable
- `requestPermission()` auto-approves because all operations execute inside the sandbox
- Shell commands (`docker exec`) use `spawn()` with array arguments — no shell interpretation
- The one `sh -c` usage in filesystem writes uses correct POSIX single-quote escaping
- Input validation happens at the ACP boundary (`server.ts` extension methods)

See [docs/adr/004-security-model.md](docs/adr/004-security-model.md) for the
full architectural decision record.

## Operations

- **Crash recovery** — on startup, `recoverStaleContainers()` runs two passes:
  clears dead container state and stops orphaned containers whose sessions are
  already closed
- **Idle timeout** — containers auto-teardown after `SWAPCLAW_IDLE_TIMEOUT` ms
  of inactivity (default 60s)
- **Capacity** — `newSession()` rejects with "At capacity" when `maxConcurrent`
  is reached; no queuing
- **Logging** — structured JSON to stderr with fields: level, component, msg, ts
- **Session modes** — code / ask / architect — set via
  `swapclaw/setSessionMode` ACP extension
- **Task scheduling** — once / interval via `swapclaw/createTask` — cron type is
  defined but not yet implemented

## Configuration Reference

All configuration is via environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SWAPCLAW_AGENT_COMMAND` | Yes | — | Command to spawn the ACP agent process |
| `SWAPCLAW_AGENT_ARGS` | No | (empty) | Space-separated arguments for the agent command |
| `SWAPCLAW_DATA_DIR` | No | `~/.swapclaw` | Directory for session data, DB, and session folders |
| `SWAPCLAW_CONTAINER_IMAGE` | No | `alpine:latest` | Docker image for sandbox containers |
| `SWAPCLAW_CONTAINER_TIMEOUT` | No | `300000` | Maximum prompt execution time in ms |
| `SWAPCLAW_IDLE_TIMEOUT` | No | `60000` | Container idle timeout before teardown in ms |
| `SWAPCLAW_MAX_CONCURRENT` | No | `3` | Maximum number of concurrent sessions |
| `SWAPCLAW_TIMEZONE` | No | (system) | Timezone for session message formatting |

## Troubleshooting

- **"No container runtime available"** — Install Docker Desktop or ensure the
  daemon is running
- **"At capacity: N/N concurrent sessions"** — Close idle sessions or increase
  `SWAPCLAW_MAX_CONCURRENT`
- **"Failed to get agent process stdio"** — Check `SWAPCLAW_AGENT_COMMAND`
  points to a valid executable
- **Stale containers after crash** — swapclaw auto-recovers on next startup;
  manually run `docker ps` to verify

## Conventions

### Code

- TypeScript, strict mode, ESM
- Biome for linting and formatting
- No secrets in source — use environment variables

### Testing

- vitest as test runner
- All tests in `tests/`
- Three tiers:
  - **Unit** (`<module>.test.ts`): single class/function, deps mocked
  - **Integration** (`integration_<flow>.test.ts`): multiple real classes,
    external deps mocked
  - **E2E** (`e2e_<scenario>.test.ts`): full application, no mocks
    (requires Docker)
- Run `bun test` before committing

### Git

- Conventional commits: `<type>(<scope>): <summary>`

## Reference

- [ACP spec](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [NanoClaw](https://github.com/qwibitai/nanoclaw)
