# ADR 004: Security Model — Container Isolation

## Status

Accepted

## Context

swapclaw routes terminal commands and file operations from an external ACP agent
into containers. The agent has full control over what commands run and what files
are accessed. We need a security model that prevents the agent from affecting the
host system while allowing unrestricted operation inside the sandbox.

## Decision

Container isolation is the primary security boundary.

### Container configuration

- Each session gets a dedicated Docker or Apple Container
- The project directory is mounted **read-only** at `/project`
- A session-specific scratch directory is mounted **read-write** at `/session`
- No host networking, no privileged mode, no additional capabilities

### Permission model

`SwapClawClient.requestPermission()` auto-approves all requests because the
execution environment is already sandboxed. There is no meaningful permission
to deny — the agent can only affect the container's filesystem and processes.

### Command execution

All commands execute via `docker exec` with Node.js `spawn()` using array
arguments (no shell interpretation). The one exception is `FilesystemManager.write()`,
which pipes content through `sh -c 'cat > <path>'` — the path is escaped using
the standard POSIX single-quote technique (`'` → `'\''`), which prevents all
shell metacharacter interpretation.

### Input validation

Validation happens at the ACP boundary in `SwapClawAgent.extMethod()`:
- Extension method parameters are type-checked before use
- Invalid types produce `RequestError(-32602)` (invalid params)
- Unknown methods produce `RequestError(-32601)` (method not found)

## Consequences

- Agents have unrestricted access **within** containers — this is by design
- Host security depends on Docker/container runtime isolation
- No defense-in-depth for container escape vulnerabilities (accepted risk)
- MCP servers forwarded into containers inherit the sandbox boundary
