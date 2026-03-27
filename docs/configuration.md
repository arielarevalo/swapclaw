# Configuration

All configuration is via environment variables. No config files needed.

## Environment Variables

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

## Examples

Minimal:

```bash
SWAPCLAW_AGENT_COMMAND=claude swapclaw
```

Full configuration:

```bash
SWAPCLAW_AGENT_COMMAND=claude \
SWAPCLAW_AGENT_ARGS="--model opus" \
SWAPCLAW_DATA_DIR=/var/lib/swapclaw \
SWAPCLAW_CONTAINER_IMAGE=node:22-slim \
SWAPCLAW_CONTAINER_TIMEOUT=600000 \
SWAPCLAW_IDLE_TIMEOUT=120000 \
SWAPCLAW_MAX_CONCURRENT=5 \
SWAPCLAW_TIMEZONE=America/New_York \
swapclaw
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "No container runtime available" | Docker not installed or daemon not running | Install Docker Desktop or start the daemon |
| "At capacity: N/N concurrent sessions" | Too many active sessions | Close idle sessions or increase `SWAPCLAW_MAX_CONCURRENT` |
| "Failed to get agent process stdio" | Agent command not found | Check `SWAPCLAW_AGENT_COMMAND` points to a valid executable |
| Stale containers after crash | Previous swapclaw instance crashed | swapclaw auto-recovers on next startup; verify with `docker ps` |
