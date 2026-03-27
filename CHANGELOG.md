# Changelog

## [0.2.0](https://github.com/arielarevalo/swapclaw/compare/swapclaw-v0.1.1...swapclaw-v0.2.0) (2026-03-27)


### Features

* initial release v0.1.0 ([f89c67c](https://github.com/arielarevalo/swapclaw/commit/f89c67c1749cbe07239bbd3bc3014e5f7237daa3))


### Bug Fixes

* **cd:** detect releases by git tag instead of commit diff ([3c76b39](https://github.com/arielarevalo/swapclaw/commit/3c76b39aa2c974a7d97261bfeb29e292b9b4ad05))
* **ci:** increase integration timeouts and exclude E2E tests ([303cd94](https://github.com/arielarevalo/swapclaw/commit/303cd94dfb35f1b94d541e4ae2e166c6733e727b))
* **ci:** increase integration timeouts and skip E2E in CI ([b1d090d](https://github.com/arielarevalo/swapclaw/commit/b1d090d9b272ff0d09c8aed4275ee180f97ea368))
* **ci:** move mock agent to tests/ for CI availability ([b3d3ad3](https://github.com/arielarevalo/swapclaw/commit/b3d3ad31dbbc8e51136b3825d2adc27c1d80ab4d))
* **ci:** revert to plain bun test command ([442b075](https://github.com/arielarevalo/swapclaw/commit/442b07515085edf223600cfd5080178c1267c80f))
* propagate cancel to inner agent ([#4](https://github.com/arielarevalo/swapclaw/issues/4)) ([29b2fa1](https://github.com/arielarevalo/swapclaw/commit/29b2fa1c826c66b54274174c7d4c0cef37d31613))

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
