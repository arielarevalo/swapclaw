# ADR 001: ACP Client Interface Analysis

## Status

Accepted

## Date

2026-03-26

## Context

swapclaw manages containers and sessions while an external ACP agent provides the
brain. To connect to that agent, swapclaw must act as an ACP **client**. The ACP
TypeScript SDK (`@agentclientprotocol/sdk` v0.17.0) provides two key constructs:

- **`Client` interface** — the callbacks an ACP client must implement to handle
  requests and notifications from the agent.
- **`ClientSideConnection` class** — the connection object a client uses to
  send requests to the agent (initialize, prompt, cancel, etc.) and to receive
  incoming agent requests via the `Client` callbacks.

This ADR documents the complete `Client` interface, the `ClientSideConnection`
API, the terminal lifecycle, and the session update flow, and maps these to what
swapclaw must implement.

## Decision

Implement the `Client` interface to handle agent callbacks by routing them into
container sandboxes, and use `ClientSideConnection` to drive the agent.

## Analysis

### 1. Two Sides of an ACP Connection

The ACP protocol is bidirectional over JSON-RPC 2.0 / NDJSON:

```
Client (swapclaw)                           Agent (external)
    |                                          |
    |-- initialize(InitializeRequest) -------->|
    |<--------- InitializeResponse ------------|
    |                                          |
    |-- session/new(NewSessionRequest) ------->|
    |<--------- NewSessionResponse ------------|
    |                                          |
    |-- session/prompt(PromptRequest) -------->|
    |          ... agent thinks ...            |
    |<--- session/update (notification) -------|  (repeated)
    |<--- terminal/create (request) -----------|  agent asks client
    |---------- CreateTerminalResponse ------->|
    |<--- terminal/output (request) -----------|
    |---------- TerminalOutputResponse ------->|
    |<--- session/request_permission (req) ----|
    |---------- RequestPermissionResponse ---->|
    |<--------- PromptResponse ----------------|
    |                                          |
    |-- session/cancel (notification) -------->|
```

- **Client sends to Agent** via `ClientSideConnection` methods: `initialize`,
  `newSession`, `loadSession`, `listSessions`, `prompt`, `cancel`,
  `setSessionMode`, `authenticate`, `extMethod`, etc.
- **Agent sends to Client** via the `Client` callbacks: `sessionUpdate`,
  `requestPermission`, `createTerminal`, `terminalOutput`, `releaseTerminal`,
  `waitForTerminalExit`, `killTerminal`, `readTextFile`, `writeTextFile`,
  `extMethod`, `extNotification`.

### 2. `Client` Interface — Complete Method Map

All methods in the `Client` interface (from `acp.d.ts`):

#### 2.1 Required Methods (always called)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `requestPermission` | `(params: RequestPermissionRequest) => Promise<RequestPermissionResponse>` | Agent asks user for permission before a sensitive tool call. Params include `toolCall` details and `options` (allow_once, allow_always, reject_once, reject_always). Response returns the selected `outcome`. |
| `sessionUpdate` | `(params: SessionNotification) => Promise<void>` | Agent streams real-time updates: message chunks, tool calls, plans, usage, mode changes. This is a **notification** (no return value expected). |

#### 2.2 Optional Methods (capability-gated)

| Method | Capability Gate | Signature | Purpose |
|--------|----------------|-----------|---------|
| `writeTextFile` | `fs.writeTextFile` | `(params: WriteTextFileRequest) => Promise<WriteTextFileResponse>` | Agent writes a file on the client's filesystem. Params: `path` (absolute), `content`, `sessionId`. |
| `readTextFile` | `fs.readTextFile` | `(params: ReadTextFileRequest) => Promise<ReadTextFileResponse>` | Agent reads a file from the client's filesystem. Params: `path`, optional `line` and `limit`, `sessionId`. Response: `content` string. |
| `createTerminal` | `terminal: true` | `(params: CreateTerminalRequest) => Promise<CreateTerminalResponse>` | Agent executes a command. Params: `command`, `args`, `cwd`, `env`, `outputByteLimit`, `sessionId`. Returns `terminalId`. |
| `terminalOutput` | `terminal: true` | `(params: TerminalOutputRequest) => Promise<TerminalOutputResponse>` | Agent reads current output of a terminal. Returns immediately (non-blocking). Response: `output` string, `truncated` boolean, optional `exitStatus`. |
| `waitForTerminalExit` | `terminal: true` | `(params: WaitForTerminalExitRequest) => Promise<WaitForTerminalExitResponse>` | Blocks until terminal command exits. Response: `exitCode`, `signal`. |
| `killTerminal` | `terminal: true` | `(params: KillTerminalRequest) => Promise<KillTerminalResponse>` | Kills a running terminal command without releasing the terminal ID. Terminal remains valid for subsequent `terminalOutput` calls. |
| `releaseTerminal` | `terminal: true` | `(params: ReleaseTerminalRequest) => Promise<ReleaseTerminalResponse>` | Releases terminal and frees resources. Kills command if still running. Terminal ID becomes invalid after this. |
| `extMethod` | none | `(method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>` | Catch-all for non-standard agent requests. |
| `extNotification` | none | `(method: string, params: Record<string, unknown>) => Promise<void>` | Catch-all for non-standard agent notifications. |

#### 2.3 Key Request/Response Types

**`RequestPermissionRequest`**:
```typescript
{
  sessionId: string;
  toolCall: ToolCallUpdate;       // { toolCallId, title, kind, status, ... }
  options: PermissionOption[];    // { optionId, name, kind }
}
// PermissionOptionKind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
```

**`RequestPermissionResponse`**:
```typescript
{
  outcome: { outcome: "cancelled" } | { outcome: "selected", optionId: string }
}
```

**`SessionNotification`**:
```typescript
{
  sessionId: string;
  update: SessionUpdate;
}
```

**`CreateTerminalRequest`**:
```typescript
{
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string | null;        // absolute path
  env?: EnvVariable[];         // { name, value }
  outputByteLimit?: number;
}
```

**`ReadTextFileRequest`**:
```typescript
{
  sessionId: string;
  path: string;           // absolute path
  line?: number | null;   // 1-based start line
  limit?: number | null;  // max lines to read
}
```

**`WriteTextFileRequest`**:
```typescript
{
  sessionId: string;
  path: string;       // absolute path
  content: string;
}
```

### 3. `SessionUpdate` Variants

The `SessionUpdate` discriminated union (field: `sessionUpdate`) covers all
real-time updates the agent can send:

| Variant | Payload Type | Description |
|---------|-------------|-------------|
| `user_message_chunk` | `ContentChunk` | Echoed user message content |
| `agent_message_chunk` | `ContentChunk` | Streamed agent response text |
| `agent_thought_chunk` | `ContentChunk` | Agent's reasoning/thinking |
| `tool_call` | `ToolCall` | New tool call started |
| `tool_call_update` | `ToolCallUpdate` | Progress update on existing tool call |
| `plan` | `Plan` | Agent's execution plan (list of `PlanEntry`) |
| `available_commands_update` | `AvailableCommandsUpdate` | Available slash commands changed |
| `current_mode_update` | `CurrentModeUpdate` | Session mode changed |
| `config_option_update` | `ConfigOptionUpdate` | Config options changed |
| `session_info_update` | `SessionInfoUpdate` | Session title/metadata changed |
| `usage_update` | `UsageUpdate` | Token usage and cost update |

**`ContentChunk`** wraps a `ContentBlock` (which is `TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource`, each tagged with `type`).

**`ToolCall`**:
```typescript
{
  toolCallId: string;
  title: string;
  kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: ToolCallContent[];   // { type: "content" | "diff" | "terminal" }
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}
```

**`ToolCallUpdate`** has the same fields as `ToolCall` but all optional except
`toolCallId`. Only changed fields need to be included.

### 4. Terminal Lifecycle

The terminal subsystem lets the agent execute commands in the client's
environment. The full lifecycle:

```
Agent                              Client (swapclaw)
  |                                    |
  |-- terminal/create --------------->|  spawn process in container
  |<-- { terminalId } ---------------|  return unique ID
  |                                    |
  |-- terminal/output --------------->|  read stdout+stderr captured so far
  |<-- { output, truncated, exit? } --|  non-blocking, returns immediately
  |                                    |
  |-- terminal/wait_for_exit -------->|  block until process exits
  |<-- { exitCode?, signal? } --------|
  |                                    |
  |-- terminal/kill ----------------->|  SIGTERM the process
  |<-- {} ----------------------------|  terminal ID stays valid
  |                                    |
  |-- terminal/release -------------->|  kill if running + free resources
  |<-- {} ----------------------------|  terminal ID now invalid
```

Key rules:
- `createTerminal` spawns a process and returns a `terminalId`.
- `terminalOutput` returns current accumulated output without blocking. If the
  process has exited, `exitStatus` is populated.
- `waitForTerminalExit` blocks until the process exits.
- `killTerminal` sends a kill signal but keeps the terminal valid (the agent can
  still read final output and check exit status).
- `releaseTerminal` frees all resources. If the process is still running, it is
  killed. The `terminalId` becomes invalid.
- Output truncation: If `outputByteLimit` was set in the create request, the
  client truncates from the beginning of the output to stay within limits,
  ensuring truncation happens at a character boundary.

### 5. `ClientSideConnection` — Outbound API

Methods swapclaw uses to **send** requests to the agent:

| Method | JSON-RPC Method | Purpose |
|--------|----------------|---------|
| `initialize(params)` | `initialize` | Negotiate protocol version and exchange capabilities |
| `newSession(params)` | `session/new` | Create a new session |
| `loadSession(params)` | `session/load` | Resume an existing session |
| `listSessions(params)` | `session/list` | List sessions |
| `prompt(params)` | `session/prompt` | Send a user prompt |
| `cancel(params)` | `session/cancel` | Cancel an ongoing prompt (notification) |
| `setSessionMode(params)` | `session/set_mode` | Switch session mode |
| `setSessionConfigOption(params)` | `session/set_config_option` | Set a config option |
| `authenticate(params)` | `authenticate` | Authenticate with the agent |
| `unstable_closeSession(params)` | `session/close` | Close and free a session |
| `unstable_forkSession(params)` | `session/fork` | Fork an existing session |
| `unstable_resumeSession(params)` | `session/resume` | Resume without replaying history |
| `unstable_setSessionModel(params)` | `session/set_model` | Select a model |
| `extMethod(method, params)` | (custom) | Send non-standard request |
| `extNotification(method, params)` | (custom) | Send non-standard notification |

Connection lifecycle properties:
- `signal: AbortSignal` — aborts when the connection closes.
- `closed: Promise<void>` — resolves when the connection closes.

### 6. Capability Negotiation

During `initialize`, the client sends `ClientCapabilities`:

```typescript
{
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
  auth?: AuthCapabilities;
  elicitation?: ElicitationCapabilities;
}
```

The agent responds with `AgentCapabilities`:

```typescript
{
  loadSession?: boolean;
  sessionCapabilities?: {
    close?: {};
    fork?: {};
    list?: {};
    resume?: {};
  };
  promptCapabilities?: {
    image?: boolean;
  };
  mcpCapabilities?: McpCapabilities;
}
```

### 7. What swapclaw Implements

#### 7.1 `Client` Implementation

swapclaw implements the `Client` interface, routing each callback into container
operations:

| Client Method | swapclaw Implementation |
|---------------|----------------------|
| `sessionUpdate` | Forward to the upstream ACP client. Store text chunks for persistence. |
| `requestPermission` | Auto-approve all requests. Container sandbox isolation makes this safe. |
| `createTerminal` | Execute `command` with `args` inside the session's container via `docker exec`. Allocate a `terminalId`. Respect `outputByteLimit`. |
| `terminalOutput` | Return captured stdout+stderr for the given `terminalId`. Include `exitStatus` if process has exited. |
| `waitForTerminalExit` | Block until the process for `terminalId` exits. Return `exitCode` and/or `signal`. |
| `killTerminal` | Send SIGTERM/SIGKILL to the process. Keep terminal metadata alive. |
| `releaseTerminal` | Kill if running, then free all resources for the terminal. |
| `readTextFile` | Read the file at `path` from within the container's filesystem via `docker exec`. |
| `writeTextFile` | Write `content` to `path` within the container's filesystem via `docker exec`. |
| `extMethod` | Handle swapclaw-specific extensions (task scheduler, mode changes, etc.). |
| `extNotification` | No-op. |

#### 7.2 `ClientSideConnection` Usage

swapclaw creates a `ClientSideConnection` per session and uses it to:

1. **`initialize`**: Send `ClientCapabilities` advertising `fs.readTextFile`,
   `fs.writeTextFile`, and `terminal: true`.
2. **`newSession`**: Create a container and session folder, then create the
   agent session.
3. **`prompt`**: Forward user prompts. The agent calls back via `sessionUpdate`
   and possibly `createTerminal`, `readTextFile`, `writeTextFile`.
4. **`cancel`**: Forward cancellation requests.

#### 7.3 Connection Setup

```typescript
import * as acp from "@agentclientprotocol/sdk";

const stream = acp.ndJsonStream(agentStdin, agentStdout);
const connection = new acp.ClientSideConnection(
  (agent) => new SwapClawClient(containerId),
  stream,
);
```

### 8. Protocol Version and Transport

- **Protocol version**: `PROTOCOL_VERSION = 1` (from `schema/index.d.ts`).
  Bumped only for breaking changes; non-breaking changes use capabilities.
- **Transport**: NDJSON over stdio (bidirectional). Created via
  `acp.ndJsonStream(writable, readable)` which returns a `Stream` object.
- **Message format**: JSON-RPC 2.0 with `jsonrpc: "2.0"`, typed `id`, `method`,
  and `params` or `result`/`error`.

### 9. Error Handling

The SDK provides `RequestError` with standard JSON-RPC error codes:

| Factory Method | Code | Meaning |
|---------------|------|---------|
| `parseError` | -32700 | Invalid JSON |
| `invalidRequest` | -32600 | Not a valid request |
| `methodNotFound` | -32601 | Method doesn't exist |
| `invalidParams` | -32602 | Invalid parameters |
| `internalError` | -32603 | Internal error |
| `authRequired` | -32000 | Authentication needed |
| `resourceNotFound` | -32001 | File/resource not found |

### 10. Stop Reasons

| Value | Meaning |
|-------|---------|
| `end_turn` | Agent completed normally |
| `max_tokens` | Hit token limit |
| `max_turn_requests` | Hit maximum tool call rounds |
| `refusal` | Agent refused the request |
| `cancelled` | Client cancelled via `session/cancel` |

## Consequences

- swapclaw acts as an ACP **client** (using `ClientSideConnection`), not an
  agent. It receives prompts from an upstream ACP client and forwards them to
  the external agent.
- The `Client` implementation routes all terminal and filesystem callbacks into
  Docker containers via `docker exec`.
- Container sandbox isolation justifies auto-approving all permission requests.
- The `TerminalManager` must handle the full terminal lifecycle (create, output,
  wait, kill, release) with output byte limit enforcement.
- The `FilesystemManager` routes reads/writes via `docker exec` with support
  for line/limit parameters and automatic parent directory creation.

## References

- ACP spec: https://agentclientprotocol.com/protocol/overview
- ACP TypeScript SDK: `@agentclientprotocol/sdk` v0.17.0
