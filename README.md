# swapclaw

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/arielarevalo/swapclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/arielarevalo/swapclaw/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

Container-isolated agent runtime over the
[Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol)
(ACP).

## Overview

A "claw" is an agent runtime that manages container sandboxes where work
happens. A typical claw bundles an embedded agent SDK — swapclaw replaces the
SDK with an ACP client. The client connects to any external ACP agent, and that
agent becomes the brain that drives the containers.

The agent doesn't know or care that it's driving a claw. It just sees a standard
ACP interface that happens to route terminal and filesystem requests into
isolated containers.

## Architecture

```
External ACP Agent (the brain — any ACP-compatible agent)
  ↕ ACP
swapclaw (the body — session + container management)
  ↕ manages
Docker or Apple Containers (execution sandboxes)
  ├── /project (working directory, read-only mount)
  └── /session (scratch space, read-write)
```

1. swapclaw connects to an ACP agent over stdio
2. Sends prompts to the agent via ACP
3. The agent requests terminal access, file reads/writes — swapclaw routes these
   into containers
4. Session updates stream back to the external ACP client in real time

## Features

- **Agent-agnostic** — works with any ACP-compatible agent
- **Container isolation** — each session gets its own Docker or Apple Container
- **Session persistence** — SQLite-backed sessions survive restarts
- **Crash recovery** — clears stale containers on startup
- **Idle timeout** — containers tear down automatically when unused
- **Concurrency control** — configurable maximum concurrent sessions
- **Session modes** — code / ask / architect modes via ACP extensions
- **Task scheduling** — once / interval / cron execution via ACP extensions
- **MCP passthrough** — stdio-transport MCP servers forwarded into containers
- **Streaming** — real-time session update forwarding to external clients

## Security Model

swapclaw relies on container isolation as its primary security boundary. Each
session runs in a dedicated Docker or Apple Container with the project directory
mounted read-only. All terminal commands and file operations execute inside the
sandbox — the host is never exposed. See [AGENTS.md](AGENTS.md) for details.

## Prerequisites

- [Bun](https://bun.sh) (or Node.js >= 22)
- [Docker](https://www.docker.com) or Apple Containers (macOS)
- An ACP-compatible agent

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

## Usage

swapclaw runs as an ACP agent on stdio. Point it at an external agent:

```bash
SWAPCLAW_AGENT_COMMAND=claude swapclaw
```

With arguments:

```bash
SWAPCLAW_AGENT_COMMAND=claude SWAPCLAW_AGENT_ARGS="--model opus" swapclaw
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SWAPCLAW_AGENT_COMMAND` | *(required)* | Command to spawn the ACP agent |
| `SWAPCLAW_AGENT_ARGS` | | Space-separated arguments for the agent |
| `SWAPCLAW_DATA_DIR` | `~/.swapclaw` | Session data and database directory |
| `SWAPCLAW_CONTAINER_IMAGE` | `alpine:latest` | Docker image for containers |
| `SWAPCLAW_CONTAINER_TIMEOUT` | `300000` | Prompt timeout (ms) |
| `SWAPCLAW_IDLE_TIMEOUT` | `60000` | Container idle timeout (ms) |
| `SWAPCLAW_MAX_CONCURRENT` | `3` | Maximum concurrent sessions |
| `SWAPCLAW_TIMEZONE` | *(system)* | Timezone for sessions |

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

- **Crash recovery** — on startup, stale containers from previous crashes are
  automatically cleaned up
- **Idle timeout** — containers tear down after 60 seconds of inactivity (configurable)
- **Capacity** — new sessions are rejected when at `SWAPCLAW_MAX_CONCURRENT`; no queuing
- **Logging** — structured JSON to stderr

See [AGENTS.md](AGENTS.md) for the full operations guide.

## Development

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript
bun test             # Run tests
bun run test:watch   # Watch mode
bun run lint         # Check lint + formatting
bun run lint:fix     # Auto-fix
bun run format       # Auto-format
```

Tests are organized in three tiers:
- **Unit** (`tests/<module>.test.ts`) — single class, deps mocked
- **Integration** (`tests/integration_<flow>.test.ts`) — multiple real classes
- **E2E** (`tests/e2e_<scenario>.test.ts`) — full application with Docker

## License

[MIT](LICENSE)
