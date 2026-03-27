# swapclaw

**Container-isolated agent runtime over the [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) (ACP).**

---

A "claw" is an agent runtime that manages container sandboxes where work happens. A typical claw bundles an embedded agent SDK — swapclaw replaces the SDK with an ACP client. The client connects to any external ACP agent, and that agent becomes the brain that drives the containers.

The agent doesn't know or care that it's driving a claw. It just sees a standard ACP interface that happens to route terminal and filesystem requests into isolated containers.

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

## Quick Start

```bash
npm install swapclaw
```

Point swapclaw at any ACP agent:

```bash
SWAPCLAW_AGENT_COMMAND=claude swapclaw
```

See the [Getting Started](getting-started.md) guide for a full walkthrough.

## How It Works

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
3. The agent requests terminal access, file reads/writes — swapclaw routes these into containers
4. Session updates stream back to the external ACP client in real time

## Security

Container isolation is the primary security boundary. Each session runs in a dedicated sandbox with the project directory mounted read-only. All terminal commands and file operations execute inside the container — the host is never exposed.

## License

[MIT](https://github.com/arielarevalo/swapclaw/blob/main/LICENSE)
