# Changelog

## [0.1.1](https://github.com/arielarevalo/swapclaw/compare/v0.1.0...v0.1.1) (2026-03-27)

### Bug Fixes

* **ci:** increase integration test timeouts for GitHub Actions runners ([b1d090d](https://github.com/arielarevalo/swapclaw/commit/b1d090d))
* **ci:** skip E2E tests in CI via process.env.CI check ([b1d090d](https://github.com/arielarevalo/swapclaw/commit/b1d090d))
* **ci:** move mock test agent to tracked tests/ directory ([b3d3ad3](https://github.com/arielarevalo/swapclaw/commit/b3d3ad3))

## [0.1.0](https://github.com/arielarevalo/swapclaw/releases/tag/v0.1.0) (2026-03-27)

### Features

* **acp:** ACP client bridge with terminal I/O and filesystem access routing into containers
* **containers:** Docker and Apple Container runtime abstraction with per-session sandboxing
* **orchestrator:** session lifecycle coordinator wiring sessions, containers, and ACP agent connections
* **db:** SQLite persistence with migration system for sessions, messages, and container state
* **config:** Zod-validated environment variable configuration
* **recovery:** crash recovery with stale container cleanup on startup
* **scheduler:** task scheduling with once/interval execution via ACP extensions
* **modes:** session modes (code/ask/architect) with CLAUDE.md marker injection
* **mcp:** MCP server config passthrough to agent sessions
* **ci:** GitHub Actions CI pipeline with lint, typecheck, and test
