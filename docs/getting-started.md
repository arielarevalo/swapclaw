# Getting Started

## Prerequisites

- [Bun](https://bun.sh) or Node.js >= 22
- [Docker](https://www.docker.com) or Apple Containers (macOS)
- An ACP-compatible agent (e.g., [Claude Code](https://claude.ai/code))

## Installation

```bash
npm install swapclaw
```

Or from source:

```bash
git clone https://github.com/arielarevalo/swapclaw.git
cd swapclaw
bun install
bun run build
```

## Running

swapclaw runs as an ACP agent on stdio. Point it at an external agent:

```bash
SWAPCLAW_AGENT_COMMAND=claude swapclaw
```

With arguments:

```bash
SWAPCLAW_AGENT_COMMAND=claude SWAPCLAW_AGENT_ARGS="--model opus" swapclaw
```

## ACP Extensions

Custom functionality exposed via ACP `extMethod`:

| Method | Description |
|--------|-------------|
| `swapclaw/getSessionMode` | Get current session mode |
| `swapclaw/setSessionMode` | Set mode (code / ask / architect) |
| `swapclaw/createTask` | Schedule a task (once / interval / cron) |
| `swapclaw/listTasks` | List scheduled tasks |
| `swapclaw/cancelTask` | Cancel a scheduled task |

## Operations

- **Crash recovery** — on startup, stale containers from previous crashes are automatically cleaned up
- **Idle timeout** — containers tear down after 60 seconds of inactivity (configurable)
- **Capacity** — new sessions are rejected when at `SWAPCLAW_MAX_CONCURRENT`; no queuing
- **Logging** — structured JSON to stderr

## Development

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript
bun test             # Run tests
bun run lint         # Check lint + formatting
bun run lint:fix     # Auto-fix
```

Tests are organized in three tiers:

- **Unit** (`tests/<module>.test.ts`) — single class, deps mocked
- **Integration** (`tests/integration_<flow>.test.ts`) — multiple real classes
- **E2E** (`tests/e2e_<scenario>.test.ts`) — full application with Docker
