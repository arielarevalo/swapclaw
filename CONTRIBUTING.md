# Contributing to swapclaw

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/arielarevalo/swapclaw.git
cd swapclaw
bun install
```

## Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run the checks:

```bash
bun run lint        # Lint + format check
bun run build       # Type check
bun test            # Run tests
```

4. Open a pull request against `main`

## Conventions

- **TypeScript** — strict mode, ESM
- **Formatting** — Biome (runs in CI)
- **Commits** — [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
- **Tests** — three tiers:
  - Unit: `tests/<module>.test.ts`
  - Integration: `tests/integration_<flow>.test.ts`
  - E2E: `tests/e2e_<scenario>.test.ts` (requires Docker)

## Reporting Issues

Use [GitHub Issues](https://github.com/arielarevalo/swapclaw/issues). Include
steps to reproduce, expected behavior, and actual behavior.
