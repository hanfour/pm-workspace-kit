---
sidebar_position: 3
---

# ADR-0002: Dev Harness 約定

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** Architect、Engineering Lead
- **Tags:** tooling, harness, methodology

## Context

「Dev harness」指開發者與程式之間的工具集：Claude Code skills、slash commands、pre-commit / pre-tool-use hooks、subagents、MCP server config。多 app + 多 package 的 monorepo 中有三個失敗模式：

1. **Drift**：各 workspace 累積自己的 `.claude/`；無共享
2. **Silent regression**：擋敏感檔的 hook 在一個 package 配置、另一個沒
3. **Discovery cost**：新成員分不清團隊實際用的 skill vs 實驗版

## Decision

採混合 layout — **共享層在 `packages/harness`** + **逐 workspace `.claude/` override** — 嚴格命名慣例。

### 共享層（`packages/harness/`）

```
packages/harness/
├── dev/
│   ├── skills/
│   ├── commands/
│   ├── hooks/
│   ├── subagents/
│   └── mcp/
├── runtime/
└── shared/
```

### 逐 workspace（`.claude/`）

僅放該 workspace 獨有 skill / command。必須 `extends` 或 `imports` 共享層。

### 命名慣例

- Skills：`<namespace>:<skill>`，namespace 為 `shared`（跨 repo）、`pm`（PM workspace 專用）或 workspace id
- Commands：`/<namespace>:<verb>`
- Hooks：YAML + JS/shell，放 `hooks/*.{yml,js}`
- Frontmatter：每個 skill / command 必填 `name`、`description`、`namespace`、`owner`

### Hook 政策

- Workspace 層不可 override 核心 hook（typecheck、secret scan、ontology validate）
- 新 hook 需 PR + ADR（若影響核心 workflow）

## Consequences

### Positive
- 共享 skill 單一 source of truth；單點升級
- 新 repo 消費 `packages/harness` 自動得最佳實踐 hook
- Skill 可被發現；新成員先看 `shared:*` 清單

### Negative
- 初期抽取成本（搬現有 `.claude/skills/*.md` 到共享層）
- Monorepo 綁定 — 多 repo 組織需 `packages/harness` 當 npm package 或 git submodule
- Claude Code harness 本身快速演進；共享層需版本紀律

### Neutral
- Skill 可從 workspace 升為共享
- Deprecate 共享 skill 走標準 ADR 流程

## Alternatives Considered

### Alternative A: 全部在各 workspace `.claude/`
- Pros：最大自治
- Cons：drift；無升級路徑；新成員困惑
- Rejected：就是此 ADR 要解的失敗模式

### Alternative B: 純共享（無 workspace override）
- Pros：最乾淨
- Cons：真實 workspace 有真實例外；純共享會官僚
- Rejected：需要 workspace 覆寫閥

### Alternative C: Skill 在 sibling repo
- Pros：跨組織可重用
- Cons：跨 repo 依賴解析增加摩擦；早期版本成本高於價值
- Rejected for now：2–3 專案採用 kit 後再 revisit

## References

- Claude Code skills / hooks / subagents / MCP 文件
