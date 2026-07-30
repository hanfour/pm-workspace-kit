---
doc_id: ADR-2026-0009
title: brace-expansion advisory — accept the audit noise, do not override
owner: "@hanfour"
status: Accepted
date: 2026-07-30
related:
  prd: []
  module:
    - packages.cli
  confluence_page_id: null
---

# ADR-0009: brace-expansion advisory — accept the audit noise, do not override

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** @hanfour
- **Tags:** security, dependencies, supply-chain, npm-audit

## Context

`npm audit` reports **33 high severity vulnerabilities**. All 33 trace to a single
advisory: *brace-expansion: DoS via unbounded expansion length causing an
out-of-memory process crash*, with the affected range declared as `<=5.0.7`.

The repo previously ran at 0 audit findings (v0.30.0). The regression is not ours —
the advisory range widened to cover the `1.x` and `2.x` maintenance lines, which
retroactively flagged versions that were already in the tree. The
`serve-handler → minimatch → brace-expansion: 1.1.17` override in the root
`package.json` is the earlier fix attempt, and it no longer clears the audit.

Three versions resolve in the tree, all via **build-time transitive dependencies**
(electron-builder and the Docusaurus toolchain) — none reach the production runtime:

| Version | Reached through |
|---|---|
| 1.1.17 | `glob`, `serve-handler`, `@electron/asar`, `dir-compare` → `minimatch@3` |
| 2.1.3 | `@electron/universal`, `filelist` → `minimatch@5`/`@9` |
| 5.0.8 | top-level (already the patched release) |

Two questions decided this: can we upgrade, and do we need to?

**Can we upgrade?** No. `brace-expansion@5.0.8` changed its CommonJS export shape:

```js
require("brace-expansion")            // 1.1.17 → function
require("brace-expansion")            // 5.0.8  → { expand, EXPANSION_MAX, ... }
```

`minimatch@3` calls the module as a function. A global `"brace-expansion": "^5.0.8"`
override therefore breaks every `minimatch@3` consumer at runtime — `glob`,
`serve-handler`, `@electron/asar`, `dir-compare`. The only `fixAvailable` npm offers
is downgrading electron-builder to 22.14.13 (semver-major, and the wrong direction —
we are on 26.15.3).

**Do we need to?** No. The maintenance releases already carry the backported fix.
Expanding `{0..100000000}` was measured on each resolved version:

| Version | Result |
|---|---|
| 1.1.17 (`maintenance-v1`) | truncated at 100,000 |
| 2.1.3 (`maintenance-v2`) | truncated at 100,000 |
| 5.0.8 (patched release) | truncated at 100,000 (`EXPANSION_MAX = 100000`) |

Identical behaviour. The guard the advisory asks for is present in all three.

## Decision

**Change nothing in the dependency tree, and treat the 33 findings as a known false
positive.** The advisory expresses its affected range as one semver interval
(`<=5.0.7`), which cannot express "fixed in 1.1.17 and 2.1.3 as well". Every
brace-expansion instance we resolve is patched; upgrading is both unnecessary and
breaking.

The pre-commit security checklist item "no known vulnerabilities" is satisfied by
this ADR rather than by a clean `npm audit` run, until the advisory range is
corrected upstream.

## Consequences

- `npm audit` stays red at 33 high. CI must not gate on a clean audit, or it blocks
  on a finding that cannot be fixed.
- **Do not** add a global `brace-expansion` override. It breaks `minimatch@3`
  consumers at runtime, and the failure surfaces at build/packaging time rather
  than in unit tests.
- The existing `serve-handler` override is now redundant — `minimatch@3`'s
  `^1.1.7` range already resolves to 1.1.17. It is left in place because removing
  it changes the lockfile for no security gain.
- Re-verify with the measurement above (not by reading the advisory range) when
  the dependency tree moves, or when the advisory is amended upstream. If a
  resolved version ever expands past 100,000 entries, the finding is real.
