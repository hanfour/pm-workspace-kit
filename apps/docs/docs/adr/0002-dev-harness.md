---
sidebar_position: 3
---

# ADR-0002: Dev Harness Conventions

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** Architect, Engineering Lead
- **Tags:** tooling, harness, methodology

## Context

"Dev harness" means the set of tools that sit between the developer and the code: Claude Code skills, slash commands, pre-commit / pre-tool-use hooks, reusable subagents, MCP server configs. In a monorepo with multiple apps and packages, three failure modes show up:

1. **Drift**: each workspace accumulates its own `.claude/` contents; no sharing of common patterns.
2. **Silent regression**: a hook that catches sensitive file creation is configured in one package but not another.
3. **Discovery cost**: new contributors can't tell which skills the team actually uses vs experimental ones.

## Decision

Adopt a hybrid layout — **shared layer in `packages/harness`** + **per-workspace override in `.claude/`** — with strict naming conventions.

### Shared layer (`packages/harness/`)

```
packages/harness/
├── dev/
│   ├── skills/       common skills (ontology-lookup, migration-checklist, ...)
│   ├── commands/     common slash commands
│   ├── hooks/        common hooks (yaml + js/shell)
│   ├── subagents/    shared subagent definitions
│   └── mcp/          MCP server allowlist
├── runtime/          runtime harness (agent, memory, guardrails, eval)
└── shared/           telemetry wrappers, error types
```

### Per-workspace (`.claude/`)

Only the skills and commands unique to that workspace. Must `extends` or `imports` from the shared layer.

### Naming conventions

- Skills: `<namespace>:<skill>` where namespace is `shared` (cross-repo), `pm` (PM workspace specific), or the workspace id
- Commands: `/<namespace>:<verb>` (e.g. `/shared:ontology-validate`, `/pm:create-prd`)
- Hooks: YAML + JS/shell, in `hooks/*.{yml,js}`
- Frontmatter: `name`, `description`, `namespace`, `owner` are required on every skill / command

### Hook policy

- Workspace layer may not override core hooks (typecheck, secret-scan, ontology-validate)
- Adding new hooks requires a PR + an ADR if the hook affects core workflow

## Consequences

### Positive
- Single source of truth for shared skills; one place to upgrade.
- New repos get best-practice hooks automatically by consuming `packages/harness`.
- Skills become discoverable; new contributors find the `shared:*` list first.

### Negative
- Initial extraction cost (moving existing `.claude/skills/*.md` into the shared layer).
- Monorepo-coupled — multi-repo orgs need `packages/harness` as an npm package or git submodule.
- Claude Code harness itself evolves quickly; shared layer needs versioning discipline.

### Neutral
- Skills can be promoted from workspace-level to shared after proven useful.
- Deprecating a shared skill requires the standard ADR dance.

## Alternatives Considered

### Alternative A: Everything in each workspace's `.claude/`
- **Pros**: maximum autonomy.
- **Cons**: drift; no upgrade path; new contributors confused.
- **Rejected**: the failure modes this ADR addresses.

### Alternative B: Pure shared (no per-workspace overrides)
- **Pros**: cleanest possible.
- **Cons**: real workspaces have real exceptions; shared-only becomes bureaucratic.
- **Rejected**: workspace override valve needed.

### Alternative C: Skills in a sibling repo (separate git)
- **Pros**: reusable across orgs.
- **Cons**: cross-repo dependency resolution adds friction; versioning cost higher than value early on.
- **Rejected for now**: revisit after 2–3 projects adopt the kit.

## References

- Claude Code docs on skills / hooks / subagents / MCP
- [Templates: Claude skill frontmatter](../templates/prd-frontmatter) (frontmatter pattern reused)
