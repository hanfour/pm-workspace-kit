---
sidebar_position: 5
---

# ADR-0004: Desktop app framework — Electron

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** @hanfour
- **Tags:** frontend, desktop, distribution

## Context

The pmk desktop app (see [PRD-2026-0002](../prds/2026-04-24-desktop-app-prd)) needs a cross-platform shell. Two constraints shape the choice:

1. The renderer is React/TypeScript (same stack as the Docusaurus site); team has zero Rust experience.
2. v1.0 ships all 15 functional requirements including Git worktree integration, child process management, local file system access — all of which need a real Node (or Rust) runtime, not just a browser.

## Decision

**Adopt Electron** for v1.0.

Plan to re-evaluate Tauri in v2.0 once the product-market fit is proven and Rust investment becomes justifiable.

## Consequences

### Positive

- **Zero learning curve for renderer code** — same React/TS/Tailwind stack as Docusaurus site
- **Direct access to Node APIs** — `simple-git`, `execa`, `fs` all work as-is, no IPC-wrapping needed
- **Mature ecosystem**: `electron-builder`, `electron-store`, `electron-updater` solve the common problems (code sign, auto-update, settings persistence) out-of-the-box
- **Ship v1.0 in ~3 months** instead of 6+ with Tauri learning curve

### Negative

- **Bundle size: 80–150 MB** — significantly larger than Tauri's 5–15 MB
- **RAM usage: 150–300 MB idle** — two Chromium processes + V8
- **Security surface**: Chromium's attack surface is larger; needs context isolation, CSP discipline
- **Not as "native" feeling** on macOS — menu integration and window chrome are less polished by default

### Neutral

- macOS code signing still requires $99/yr Apple Developer Program — same regardless of framework
- Auto-update infrastructure (`electron-updater`) mirrors what Tauri provides

## Alternatives Considered

### Alternative A — Tauri 2.0

- **Pros**: 10× smaller bundle, 3× less RAM, Rust security properties, first-class mobile support in 2.0
- **Cons**: Team has zero Rust experience; ecosystem less mature (e.g., `simple-git` equivalent must be bridged); Windows MSI signing more manual; fewer worked examples for the Spec-editor + Mermaid + Monaco combo we want
- **Rejected for v1.0**: the 3-month timeline has no room for Rust onboarding. Revisit in v2.0.

### Alternative B — Web app only (Next.js + browser)

- **Pros**: No install friction; familiar stack; easy to iterate
- **Cons**: Can't run Git worktree / local file system / shell commands without a local daemon. Defeats the "local tool" value proposition. RAG index can't live purely in browser.
- **Rejected**: kills F10 (Park), F11 (Git worktree), F14 (TDD flow) by design.

### Alternative C — Hybrid: Web app + local companion daemon

- **Pros**: Browser UI with local capabilities via WebSocket bridge
- **Cons**: Two runtime artifacts to install, coordinate, and update. Worse UX than either pure option.
- **Rejected**: Spectra-style "one binary" UX is part of the product promise.

### Alternative D — Neutralinojs / NW.js

- **Pros**: Bundle sizes between Electron and Tauri; similar familiarity
- **Cons**: Smaller ecosystems, fewer production examples for complex IDE-like UIs
- **Rejected**: marginal bundle savings don't offset ecosystem risk

### Alternative E — Pure CLI (no GUI)

- **Pros**: Simplest possible; ships in a few weeks
- **Cons**: Fails F3–F8, F10–F15 — the GUI IS the product differentiator vs Claude Code's CLI
- **Rejected by user explicitly** — v1.0 is full app

## Implementation Notes

- Use Electron 33+ (Chromium 130) with Node 20 main process
- Context isolation ON, sandbox ON, no `nodeIntegration` in renderer
- Preload script exposes typed IPC surface only
- Renderer build: Vite (not webpack; faster HMR for our team's dev loop)
- Package via `electron-builder` with target matrix: `dmg` + `zip` (macOS), `nsis` + `msi` (Windows), `AppImage` + `deb` (Linux)
- Auto-update via `electron-updater` pointing at GitHub Releases

## Re-evaluation Trigger

Revisit this ADR when any of:
- Bundle size complaints from users become the #1 issue in feedback
- RAM usage becomes a blocker for a specific user segment
- Team hires / acquires Rust expertise
- Tauri 3.x matures with fewer edge cases for our stack

## References

- [Electron 33 release notes](https://www.electronjs.org/blog/electron-33-0)
- [Tauri 2.0 docs](https://v2.tauri.app/)
- [PRD-2026-0002](../prds/2026-04-24-desktop-app-prd) — source PRD
- Spectra (closed-source, Taiwan) — prior-art GUI for OpenSpec, framework unspecified
