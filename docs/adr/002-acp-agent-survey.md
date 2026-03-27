# ADR 002: ACP Agent Ecosystem Survey

## Status

Accepted

## Date

2026-03-26

## Context

swapclaw manages containers and sessions while an external ACP agent provides the
brain. Before building the ACP client integration, we surveyed the ecosystem to
understand which agents exist, which ones use the Client callbacks swapclaw must
implement (`createTerminal`, `readTextFile`, `writeTextFile`,
`requestPermission`), and whether we can test against real agents or need a
dedicated test agent.

## Research Findings

### The ACP Ecosystem (as of March 2026)

The Agent Client Protocol has grown significantly since Zed introduced it. The
ACP spec is at v0.11.3 with 90+ contributors and official SDKs in TypeScript,
Rust, Python, Java, and Kotlin.

#### ACP Agents (30+ registered)

Major agents with ACP support:

| Agent | Maintainer | Uses Terminal | Uses FS | Notes |
|-------|-----------|:---:|:---:|-------|
| **Claude Code** | Zed (adapter) | Yes | Yes | Via `@zed-industries/claude-agent-acp`. Bridges Claude Agent SDK to ACP. Exposes terminal/fs as MCP tools that delegate to Client callbacks. |
| **Gemini CLI** | Google | No* | Yes | Reference ACP implementation. Uses `connection.readTextFile()` / `connection.writeTextFile()` via `AcpFileSystemService`. Falls back to local FS when client lacks capability. |
| **Codex CLI** | OpenAI (adapter) | No* | Yes | Via `cola-io/codex-acp`. Launches internal MCP filesystem server. Reads/writes files through ACP tools. Falls back to local disk I/O without client FS support. |
| **Cline** | Cline | Yes | Yes | Full ACP support via `--acp` flag. Has `AcpTerminalManager` that calls `connection.createTerminal()`. Also delegates file operations to client. |
| **Goose** | Block | No* | No* | Supports ACP but primarily uses MCP extensions for tool access. |
| **OpenClaw** | OpenClaw | Varies | Varies | Platform that orchestrates other ACP agents. |

\* "No" means the agent does not call the Client's terminal/fs callbacks
directly. It may still execute commands and access files through its own
mechanisms (internal shell execution, MCP servers, etc.).

Other registered ACP agents include: Augment Code, AutoDev, Blackbox AI,
Cursor, Docker's cagent, fast-agent, Factory Droid, fount, Junie (JetBrains),
Kimi CLI, Kiro CLI, Minion Code, Mistral Vibe, OpenCode, OpenHands, Pi, Qoder
CLI, Qwen Code, Stakpak, and VT Code.

#### ACP Clients (editors/tools that implement the Client interface)

| Client | Terminal | FS | Notes |
|--------|:---:|:---:|-------|
| **Zed** | Yes | Yes | Primary ACP client. Full terminal and FS support. |
| **acpx** | Yes | Yes | Headless CLI client by OpenClaw. Full terminal lifecycle. File ops sandboxed to cwd. |
| **VS Code** (extension) | Yes | Yes | Via community extension. |
| **JetBrains IDEs** | Coming | Coming | ACP integration announced for IntelliJ, PyCharm, etc. |
| **Neovim** | Partial | Partial | Two plugins: CodeCompanion, avante.nvim. |
| **Emacs** | Partial | Partial | Via agent-shell plugin. |
| **Obsidian** | No | No | Agent Client plugin for note-taking. |

### How Agents Use Client Callbacks

1. **`session/request_permission`** — All agents use this. Required for
   sensitive tool operations (file edits, command execution). The client
   presents options to the user and returns the selected outcome.

2. **`fs/read_text_file`** / **`fs/write_text_file`** — Used by Claude Code,
   Gemini CLI, Codex, and Cline. The agent reads from / writes to files in the
   client's environment. Guarded by `fs.readTextFile` / `fs.writeTextFile`
   client capabilities.

3. **`terminal/create`** + lifecycle methods — Used by Claude Code and Cline.
   The agent requests command execution in the client's environment. The client
   manages the actual process. Full lifecycle: create -> output ->
   wait_for_exit -> kill -> release. Guarded by the `terminal: true` client
   capability.

4. **`session/update`** (notification) — All agents use this. Streams messages,
   tool calls, and plans back to the client.

Key pattern: agents that want maximum portability (Gemini CLI, Codex) delegate
file I/O to the client when capable but fall back to local filesystem access
when not. Terminal delegation is less common — most agents run their own
commands internally rather than asking the client.

### Architecture of Key Agents

**Claude Code via ACP** (`@zed-industries/claude-agent-acp`):
- `ClaudeAcpAgent` implements the ACP `Agent` interface
- Bridges to Claude Agent SDK internally
- Built-in MCP server exposes `mcp__acp__Read`, `mcp__acp__Write`,
  `mcp__acp__BashOutput` tools that delegate to Client callbacks
- Sessions persisted as JSONL files

**Gemini CLI ACP**:
- `GeminiAgent` class implements ACP `Agent` interface
- `AcpFileSystemService` wraps `connection.readTextFile()` / `writeTextFile()`
  with fallback to local filesystem for files outside the project root
- Does NOT use `createTerminal` — runs commands internally

**acpx mock agent** (test reference):
- Simple command-based agent that exercises all Client callbacks
- `echo <text>` — returns text directly
- `read <path>` — calls `connection.readTextFile()`
- `write <path> <content>` — calls `connection.writeTextFile()`
- `terminal <command>` — calls `connection.createTerminal()`, polls output,
  waits for exit, releases
- This served as the reference design for swapclaw's own test agent

## Decision

### Testing Strategy

Three-tier approach:

1. **Unit tests with a mock agent**: A minimal deterministic test agent that
   exercises all Client callbacks based on prompt text commands. No AI, no
   randomness.

2. **Integration tests over stdio**: Spawn the mock agent as a child process,
   connect via `ClientSideConnection` + `ndJsonStream`, verify the full ACP
   round-trip including container operations.

3. **E2E tests with real containers**: Full stack with Docker, validating the
   complete prompt-to-container-to-response loop.

### Client Implementation Requirements

Based on the survey, swapclaw's Client must implement:

| Method | Priority | Notes |
|--------|----------|-------|
| `sessionUpdate` | P0 | All agents send these. Core output streaming. |
| `requestPermission` | P0 | All agents request this for tool operations. |
| `readTextFile` | P0 | Most agents use this. Read from container volumes. |
| `writeTextFile` | P0 | Most agents use this. Write to container volumes. |
| `createTerminal` | P0 | Claude Code and Cline use this. Execute in container. |
| `terminalOutput` | P0 | Required for terminal lifecycle. |
| `waitForTerminalExit` | P0 | Required for terminal lifecycle. |
| `killTerminal` | P1 | For timeout/cancellation scenarios. |
| `releaseTerminal` | P0 | Required cleanup for terminal lifecycle. |

### Capability Advertisement

swapclaw advertises these capabilities during initialization:

```typescript
{
  clientCapabilities: {
    fs: {
      readTextFile: true,
      writeTextFile: true,
    },
    terminal: true,
  }
}
```

## Consequences

- swapclaw does not need to build or maintain a real AI agent. The external
  agent is the brain; swapclaw is the body.
- A mock test agent (based on the acpx pattern) provides reliable, deterministic
  testing of all Client callbacks.
- Claude Code is the primary real-world test target since it exercises both
  terminal and filesystem Client callbacks.
- The Client implementation must handle all terminal lifecycle methods, not
  just `createTerminal`.
- Agents that fall back to local FS (Gemini CLI, Codex) still work — they just
  won't use the Client FS callbacks if they detect local access is available.
  This is fine since swapclaw containers provide the local environment.

## References

- ACP spec: https://agentclientprotocol.com/protocol/overview
- ACP TypeScript SDK: `@agentclientprotocol/sdk` v0.17.0
- acpx: https://github.com/openclaw/acpx
