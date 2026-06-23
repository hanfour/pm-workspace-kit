# `:cr:`-reaction → mra PR Review — Design

**Date:** 2026-06-23
**Status:** Draft v1 — brainstormed + multi-model adjudicated (Claude × codex, decide skill); 3 hard forks ratified by user; awaiting user review of this written spec
**Component:** `packages/cli` gateway (Slack adapter) + `adapters/mra.ts`, delegating to the local `mra review` (multi-repo-agent)

## Context & scope

Larger vision: let users drive code intelligence through the Slack gateway. The
original ask bundled two independent capabilities — (1) 透過服務做「指定專案的設定」
via mra, and (2) 「skills 的 code review」. These are separate subsystems and are
**decomposed**:

- **THIS spec:** a developer posts a Slack message that contains a GitHub PR link
  (their existing `:cr:` review-request convention); someone adds a `:cr:`
  **reaction** to that message → the gateway runs `mra review <project> --pr N`
  for each linked PR and mra posts an inline review onto the GitHub PR; the
  gateway replies a short status in the Slack thread.
- **Deferred — passive-watch (B):** bot passively watches channel messages and
  auto-fires on any inline `:cr:` + PR link (no reaction needed). Reuses this
  spec's `ReviewCoordinator` core; adds only a message-event scanner + stronger
  dedupe. **Out of scope for v1.**
- **Deferred — 「專案設定 via mra」:** its own spec, later.

This spec covers ONLY the reaction-triggered PR-review path (v1 = "A 先行，預留 B").

Building blocks reused: the `reaction_added` dispatch (`slack/index.ts`, today
routes 🎫→issue, ✅/❌→atom approval); the 🎫 issue-flow shapes (claim files,
`allowPublicRepos` guard, `doctor-checks/github-token.ts`, secret-references);
the `runMraAsk` subprocess pattern + progress throttle (`adapters/mra.ts`,
`slack/free-chat-turn.ts`); `pmk gateway doctor`.

## Goal

When a Slack message carries a GitHub PR link and a teammate reacts `:cr:`, the
gateway gets `mra review` to post a context-aware (PKB-grounded) inline review on
that PR — without anyone leaving Slack — safely, idempotently, and without
disturbing the operator's working clones.

## Multi-model decision record (decide: Claude × codex)

This design was adjudicated across two models against the **real mra source**
(`/Users/hanfourhuang/multi-repo-agent`). Both models independently converged on
the facts; they diverged on the isolation strategy, codex's vote (+ a hazard it
surfaced) flipped the recommendation. Recording it because the conclusions are
non-obvious and gate the implementation.

### Verified facts (mra source, cited)
- **mra `<project>` must be a plain name inside the workspace.**
  `validate_project_name` rejects `/`, `..`, leading dot/dash, absolute paths
  (`lib/project-path.sh:47-66`); `resolve_project_dir` then requires the resolved
  dir to be a strict descendant of the workspace (`lib/project-path.sh:89-112`).
  → an absolute-path or out-of-workspace worktree CANNOT be passed to mra.
- **`mra review --pr N` reviews the LOCAL clone's `base...HEAD` and trusts that
  HEAD == the PR head.** Diff is `git -C "$project_dir" diff "${resolved_base}...HEAD"`
  (`lib/review.sh:188-196`, `lib/review-diff.sh:7-13`); `--pr` only queries the
  PR base ref + head SHA + files via `gh api` (`lib/review.sh:161-164,523-539,563-566`);
  `--head`/`--range` cannot combine with `--pr` (`lib/review.sh:143-148`); mra does
  **not** fetch/checkout the PR head itself. → the gateway must make `project HEAD
  == PR head` before invoking.
- **PKB grounding keys off a file test that follows symlinks.** `pkb_exists` =
  `[[ -f "$project_dir/.mra/pkb/meta.json" ]]` (`lib/pkb.sh:40-43`). After review,
  mra **writes back** to PKB (`lib/review.sh:346,409,451-455`; `lib/pkb.sh` module
  + meta + conventions updates) → a symlinked PKB would pollute the source clone;
  a **physical copy** isolates it.
- **dep-graph / consumer context is workspace-level, keyed by project NAME**
  (`lib/review.sh:158,170-175,283-289`). A synthetic project name degrades to
  `type=unknown` / empty consumers — i.e. loses cross-project API-impact analysis.
- **Single-pass (light/standard) review lacks write-protection.**
  `lib/review.sh:368-378` invokes `claude` with NO `--disallowedTools`, unlike
  debate (`lib/review-debate.sh:264`) and personas (`lib/review-personas.sh:80`)
  which pass `--disallowedTools "Write,Edit,NotebookEdit"`. README claims "all
  review agents write-protected" — **false for single-pass**, and small diffs
  auto-select single-pass (`select_review_strategy`, `lib/review.sh:69-84`). Since
  PR content is potentially attacker-controlled, this is a real prompt-injection
  surface.
- **Scanner pollution hazard for in-workspace worktrees.** `run_all_scanners`
  enumerates the whole workspace (`lib/scan.sh:4-17`) and merges edges writing the
  source into a real target's `consumedBy` (`lib/scan.sh:66-73`); scanners don't
  require dep-graph membership. A worktree placed inside the workspace can be
  swept and pollute the real dep-graph if `mra scan` races the review.

### Ratified decisions (user)
1. **PR-head isolation = "B-便宜版".** A gateway-owned **parallel mra workspace**
   (`~/.pmk/review-workspace/`), NOT the operator's working workspace. Each
   reviewed repo is created **lazily** as a `git clone --reference <main-clone>`
   (borrow object store → near-zero disk, no re-download). `.collab/repos.json` +
   `dep-graph.json` are **copied** from the main workspace so reviews run under the
   **real project name** (consumer/API-impact analysis preserved — codex's reason
   for B), while staying fully isolated from the operator's clones and scanners
   (kills the A′ pollution hazard). PKB is **physically copied** into the review
   clone (not symlinked).
2. **Reviewer safety = force a write-protected strategy.** The gateway always
   invokes mra with a strategy whose code path passes `--disallowedTools`
   (debate/personas), never bare single-pass. Accepts higher cost/latency for v1.
   (If mra later gains `--disallowedTools` on single-pass, we can drop to cheaper
   strategies.)
3. **GitHub identity = host `gh` + labeled.** Reviews post via the host `gh`
   identity (mra's native behavior, `lib/review.sh:702`). Before posting, verify
   `gh api user` is the expected account; the review body is labeled "generated by
   pmk (on behalf of …)". (A dedicated bot token is a later upgrade.)

## Approach

`adapters/mra.ts` gains `runMraReview` (mirroring `runMraAsk`) and
`resolveProjectByRemote`. A new gateway-owned **review-workspace manager**
prepares an isolated, PR-head clone per (repo, PR) and tears it down after. A new
`ReviewCoordinator` (`slack/review.ts`, mirroring `slack/issue.ts`) orchestrates:
reaction → parse PR links → per-PR { authorize/guard → claim → prepare clone →
run mra review → status reply → release/finalize }. Wiring widens the existing
`reaction_added` gate to let `cr` through.

## Module structure

```
adapters/mra.ts (extend)
  resolveProjectByRemote(workspace, "owner/repo") → project name | undefined
    (match each repo's `git remote get-url origin` slug; reuse existing slug-parse)
  runMraReview({ workspace, project, pr, strategy, timeoutMs }, { onProgress })
    → { ok, status?, commentCount?, stdout, stderr, reason?, attempts }
    (spawn `mra review <project> --pr <N> --strategy <debate|personas-env>`, arg-array,
     NO shell; cwd = review-workspace; secrets stripped from env; 600s default;
     line-buffered progress like runMraAsk; parse status/comment-count from stdout)

gateway/pr-ref.ts (NEW, pure)
  parsePrRefs(message) → Array<{ owner, repo, number, url }>
    (read Slack message link entities / blocks; accept github.com/<o>/<r>/pull/<N>;
     dedupe; cap K=5; reject non-PR links; validate owner/repo/number shape)

gateway/review-workspace.ts (NEW)
  prepareReviewClone({ ownerRepo, project, pr }) → { dir, headSha, baseSha } | error
    1. resolve main clone path (mraWorkspace/<project>)
    2. ensure parallel workspace ~/.pmk/review-workspace/ has .collab/{repos.json,dep-graph.json}
       copied from main workspace (refresh if stale)
    3. lazily `git clone --reference <main-clone> <origin-url> <parallel>/<project>`
       (or reuse existing); `git fetch origin pull/<N>/head`
    4. `git checkout --detach FETCH_HEAD`; assert HEAD == gh PR headSha (abort on mismatch)
    5. copy <main-clone>/.mra/pkb → <parallel>/<project>/.mra/pkb (physical)
    6. assert `git diff <base>...HEAD` non-empty (else "nothing to review")
  teardownReviewClone(...) — reset/clean the review clone (keep for reuse or prune)

gateway/review-claim.ts (NEW, mirrors issue-candidate.ts)
  claim key = host/owner/repo/pr/headSha (+baseSha, mraVersion, configHash)
  atomic create (mode 0600); records GitHub review id + status; TTL; release/finalize
  → idempotent: same headSha never double-posts; new commits (new SHA) re-review

gateway/slack/review.ts (NEW — ReviewCoordinator, mirrors slack/issue.ts)
  on `:cr:` reaction → fetch reacted message → parsePrRefs → for each PR (≤K):
    guard(public-repo allowlist) → claim → prepareReviewClone → verify gh actor →
    runMraReview → post Slack thread status (status, comment count, PR link) →
    finalize/release; per-PR fail-soft (one PR's failure never sinks the others)

gateway/slack/index.ts (wire)
  widen the reaction_added early-return gate so `cr` reaches ReviewCoordinator
  (alongside 🎫/✅/❌). Map by reaction.item.ts → the reacted message.

gateway/config.ts (extend)
  review?: { enabled?: boolean; allowPublicRepos?: boolean;
             repoAllowlist?: string[]; maxPrsPerTrigger?: number (default 5);
             strategy?: "debate" | "personas" (default "debate");
             expectedGhUser?: string }

gateway/events.ts + audit.ts (extend)
  review.triggered / review.posted { repo, pr, status, commentCount, durationMs }
  / review.skipped { reason }

gateway/doctor-checks/ (extend)
  review readiness: gh installed + authed + `gh api user` == expectedGhUser +
  token has pull-request write scope; mraWorkspace + review-workspace writable
```

## Key flow (happy path)

1. `:cr:` reaction lands → `reaction_added` → `ReviewCoordinator`.
2. Fetch reacted message; `parsePrRefs` → e.g. `[{onead, OnePixel, 129}]` (≤5).
3. For each PR: public-repo/allowlist guard → `resolveProjectByRemote` →
   `claim(owner,repo,pr,headSha)` (skip if already reviewed this SHA).
4. `prepareReviewClone`: reference-clone in parallel workspace, fetch+detach PR
   head, assert HEAD==headSha, copy PKB, assert diff non-empty.
5. Verify `gh api user` == expectedGhUser.
6. `runMraReview` with forced write-protected strategy; drip progress into the
   Slack placeholder.
7. mra posts the inline review to GitHub (host gh identity, labeled).
8. Gateway replies thread status; `finalize` claim (records review id); emit
   `review.posted`. Teardown clone.

## Error handling
- Per-PR isolation; fail-soft throughout (mirror `escalation.ts`).
- repo not in workspace / not in allowlist / public-guard → skip + Slack note.
- `gh api user` mismatch → abort that PR + Slack note (never post as wrong actor).
- HEAD!=headSha / empty diff / fetch failure → skip + Slack note; teardown partial clone.
- mra missing/stale → reuse `mraDoctor`; mra non-zero / invalid JSON → mra already
  guards (won't post garbage); surface reason to Slack.
- Always release the claim on early-return; finalize only on a real post.

## Security notes
- Review subprocess env is **stripped of secrets / write tokens** (only what `gh`
  needs to POST). Forced write-protected strategy (decision 2) keeps the reviewer
  Claude read-only.
- Public PRs are an untrusted prompt source → guarded by `allowPublicRepos=false`
  + per-owner/repo allowlist + first-use authorization.
- Known mra-side gap to flag/upstream: the individual-comment fallback
  (`lib/review.sh:744-784`) iterates the UNfiltered `review_json`, re-introducing
  out-of-hunk comments the primary path filtered. Track as an upstream issue;
  gateway can't fully control it.

## Testing
- **Unit:** `pr-ref` (URLs, multiple PRs, non-PR links, malformed, cap);
  `resolveProjectByRemote` (match/no-match/nested); `review-claim` idempotency
  (same SHA skip, new SHA re-review, atomic-create race); Slack status formatting.
- **Integration:** `ReviewCoordinator` + fake Slack + fake mra (reuse
  `test/harness/slack-fakes` + the mra-ask test mold): happy path,
  repo-not-in-workspace, public-guard, duplicate-claim skip, gh-actor mismatch,
  HEAD-mismatch, mra failure.
- **Live-Slack verify (before tag, per release workflow):** real `:cr:` reaction →
  real `mra review` posts to a real **test** PR; verify isolation (operator clone
  untouched, no PKB pollution, no dep-graph pollution). Behind a flag until ready.

## Open items to verify during writing-plans
- `git clone --reference` robustness vs `--shared` (object-store dependency on the
  main clone; pick the safe variant, or fall back to a plain clone).
- Exact stdout shape of `mra review --pr` to parse status + comment count reliably
  (vs reading the posted GitHub review back).
- How to force "personas" (env `MRA_REVIEW_PERSONAS=true`) vs `--strategy debate`
  — pick one as the v1 write-protected default; confirm cost/latency.
- Refresh policy for the copied `repos.json` / `dep-graph.json` in the parallel
  workspace (copy-on-each-run vs TTL).

## Future extension (B — passive watch)
Reuses `ReviewCoordinator` core unchanged; adds a channel message-event scanner
that extracts inline `:cr:` + PR links and calls the same pipeline, with stronger
dedupe (the richer claim key already supports it). Deliberately deferred.
