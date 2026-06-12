# Confirmed Problem → GitHub Issue — Design

**Date:** 2026-06-12
**Status:** Draft (awaiting user review)
**Component:** `packages/cli` gateway (Slack adapter + a new GitHub adapter)

## Context & scope

Part of a larger vision: clarify a user's problem → diagnose it → notify a tech
expert → tech confirms → **open a GitHub issue** → (later) draft a PR. That whole
pipeline is too large for one spec, so it is decomposed into sub-projects:

- **Sub-project 1 (THIS spec):** a tech, after the bot escalates a diagnosed
  problem to them, confirms it with a 🎫 reaction → the bot opens a structured
  GitHub issue in the problem's repo.
- **Sub-project 2 (later):** an approved issue → a coding agent makes the change
  in the repo and opens a **draft** PR (human reviews/merges).

This spec covers ONLY sub-project 1. The end state is a well-formed issue; a human
(or sub-project 2) picks up development.

Building blocks that already exist (reused here): the escalation coordinator
(`slack/escalation.ts`) — the bot emits an `escalate` directive, @-mentions an
IT/domain pool, and persists a pending-escalation marker per thread; the
reaction handler (✅/❌ atom approval); the secret-reference system (v0.20.0 —
`{cmd}`/`{env}` in gateway.json, `resolveSecret` with no-leak); `pmk gateway doctor`.

## Goal

When the bot has escalated a diagnosed problem to a tech expert in a Slack thread,
let that tech open a structured GitHub issue in the problem's repo with a single
🎫 reaction — no leaving Slack, no copy-paste, using a **work** GitHub account
(not the host operator's personal `gh` login).

## Approach

A new `src/adapters/github.ts` (mirroring `adapters/mra.ts`) wraps the `gh` CLI.
Issue creation is triggered by a 🎫 reaction on the bot's escalation/diagnosis
message and authorized to the escalation pool for that repo. The work GitHub
token is provided via the existing `{cmd}` secret-reference mechanism and passed
per-command as `GH_TOKEN` — so the host's personal `gh` login is never touched.

## Module structure

```
src/adapters/github.ts        — gh-CLI wrapper:
  resolveRepoSlug(workspace, repo) → "owner/repo" (from the repo's git origin)
  createIssue({ slug, title, body, token }) → issue URL (gh issue create, GH_TOKEN env, no-leak)
  githubDoctor({ token }) → { ok, reason } (gh installed + token resolves)
src/gateway/config.ts         — RawGatewayConfig.github?: { token: SecretSource }; resolveGithubToken
src/gateway/issue-candidate.ts — DURABLE issue-candidate record (NEW; NOT the consumable
  escalation marker). Persisted at escalation time with everything the issue needs
  (snapshot). saveIssueCandidate / loadIssueCandidate / claimIssueCandidate (atomic).
src/gateway/slack/issue.ts    — IssueFromCandidate: load record → build issue title/body
  from the SNAPSHOT → atomic claim → createIssue → reply
src/gateway/slack/index.ts    — reaction_added: 🎫 whose item.ts == candidate.anchorTs → IssueFromCandidate
src/gateway/slack/escalation.ts — at escalate() time, ALSO write the issue-candidate record
  (capturing the escalation message ts as anchorTs + mentionedUserIds snapshot)
src/gateway/events.ts         — add github.issue.created / github.issue.failed to the
  GatewayEvent union + VALID_TYPES whitelist + the reader/guard
src/gateway/doctor.ts         — add a `github-token` check
```

### Why a separate durable record (not the escalation marker) — resolves review findings

The existing pending-escalation marker is **consumed/claimed** when a tagged tech
replies (the absorb path atomically renames it away, session-store.ts ~356/368).
So if a tech replies `@pmk …` FIRST and reacts 🎫 second, the marker is already
gone → the issue flow would no-op. Therefore the 🎫 flow uses a SEPARATE, durable
`issue-candidate` record that the absorb path does NOT touch. The record is a
**snapshot taken at escalation time** carrying: `repo` (the escalate scope),
`channelId`, `threadTs`, `anchorTs` (the bot's escalation message ts — the exact
react target), `asker`, `mentionedUserIds` (the tech pool actually tagged for THIS
thread), the user's `question`, and the bot's `diagnosis` text. Because the issue
body is built from this snapshot, the 🎫 handler does NOT call
`conversations.replies` — so **no new Slack history scope is needed** (only the
existing `reactions:read`). (Pulling the tech's later discussion into the issue
would need `channels:history`/`groups:history`; that is deferred to sub-project 2.)

### Config

```ts
// RawGatewayConfig (raw, secrets unresolved)
github?: { token: SecretSource };   // SecretSource = string | {cmd} | {env}
```
`resolveGithubToken(rawGithub)` mirrors `resolveGatewayApiKey`: returns the
resolved token string (via `resolveSecret`) or undefined if unset. All gateway.json
mutators already load/save RAW (no materialisation) — `github.token` inherits that.

## Trigger & authorization

- The bot's escalation message (the one that @-mentions the tech pool with the
  diagnosis) gains a one-line affordance: `_確認是問題的話,在這則訊息上 react 🎫 我就開 issue_`.
  Its `ts` is saved as the issue-candidate's `anchorTs`.
- A `reaction_added` for `🎫` (`:ticket:` — verify the exact Slack reaction name at
  implementation) is handled ONLY when **`reaction.item.ts === candidate.anchorTs`**
  for an existing issue-candidate record (Medium-4 fix: anchor-exact, not
  any-bot-message-in-the-thread). Other 🎫 reactions are ignored.
- **Authorization (Medium-5 fix — snapshot, not live pool):** the reactor MUST be in
  the saved `candidate.mentionedUserIds` (the tech pool actually tagged for THIS
  thread at escalation time) AND not in the blocklist. Authorizing against the LIVE
  pool would let a later config change authorize someone never tagged here, or
  de-authorize the tagged tech. Non-listed / blocklisted reactors are ignored silently.

## Data flow

1. Bot escalates (existing path, extended): in `escalate()`, AFTER posting the
   @-mention diagnosis message, capture that message's `ts` and write a durable
   `issue-candidate` record `{ channelId, threadTs, anchorTs, repo (escalate scope),
   asker, mentionedUserIds, question, diagnosis, issuedUrl? }`. Append the 🎫
   affordance to the message. This record is independent of the consumable
   escalation marker and is NOT cleared by the absorb path.
2. Tech reacts 🎫 on that exact message.
3. `reaction_added` handler:
   a. Ignore unless reaction == 🎫 AND an issue-candidate exists whose
      `anchorTs == reaction.item.ts`.
   b. If `candidate.issuedUrl` already set → reply with the existing URL (idempotent), stop.
   c. Authorize: reactor ∈ `candidate.mentionedUserIds` ∧ not blocklisted. Else ignore silently.
   d. **Atomic claim (idempotency/concurrency):** `claimIssueCandidate(candidate)` —
      `fs.renameSync` the record to a `.claiming` lock (same atomic-rename pattern as
      `claimThreadEscalation`, session-store.ts ~356). If the rename throws (another
      reaction event / pool user already claimed) → stop; only the claim winner
      proceeds. This prevents two events / two pool users from both creating an issue.
   e. Resolve the repo slug: `resolveRepoSlug(mraWorkspace, candidate.repo)` → git
      origin → `owner/repo`. If underivable → reply asking the tech to specify the
      repo, release the claim, stop.
   f. Resolve the work token via `resolveGithubToken` (`{cmd}`). On failure → reply
      "GitHub token 未設定 / 指令失敗" (NO `{cmd}` output leak), release claim, audit
      `github.issue.failed`, stop.
   g. Build the issue title + body (structure below) from the SNAPSHOT
      (`candidate.question` + `candidate.diagnosis`) — NO `conversations.replies`,
      so no new Slack history scope is needed.
   h. `createIssue({ slug, title, body, token })` → issue URL.
   i. Persist `candidate.issuedUrl = url` (finalise the claim). Post the URL back to
      the thread. Emit `github.issue.created` (actor = reactor, repo = slug, issue url).

### Issue content

```
Title: [pmk] <one-line problem summary>

## 問題（使用者回報）
<original question + the bot's one-line clarification>

## 診斷（pmk grounded）
<the bot's mra-grounded root cause, with file:line citations>

## 建議方向
<1–3 suggested directions>

## 來源
- Slack thread: <permalink>
- 提問者：@asker · 確認者（tech）：@confirmer
- repo: owner/repo
```
The title/問題/診斷/建議方向 come from the thread context (the user's question, the
bot's diagnosis message). The bot composes them with one LLM call summarising the
thread into the issue body (audience-neutral, technical — this is for engineers).

## `github.ts` (gh CLI wrapper)

- `resolveRepoSlug(workspace, repo)`: `git -C <workspace>/<repo> remote get-url origin`
  → parse both `git@github.com:owner/repo.git` and `https://github.com/owner/repo(.git)`
  → `owner/repo`. Returns undefined if no origin / non-github.
- `createIssue({ slug, title, body, token }, deps?)`: `execFile("gh", ["issue",
  "create", "-R", slug, "--title", title, "--body", body], { env: { ...process.env,
  GH_TOKEN: token } })`. Returns the printed issue URL (gh prints it to stdout).
  Injectable `exec` for tests. **No-leak:** on error, the thrown/returned message
  is `gh issue create failed (<code>)` — never the token, never raw stderr (which
  could echo the token or a URL with auth). Detailed stderr → host-side log, token-redacted.
- `githubDoctor({ token })`: gh installed (`findGhBinary`) + token non-empty +
  (optionally) `gh auth status --hostname github.com` with the token works. Returns
  `{ ok, reason }` for the doctor check. Never prints the token.

## Error handling (fail-soft, no-leak)

| Situation | Behaviour |
|-----------|-----------|
| `gh` not installed | reply: host needs the `gh` CLI; audit `github.issue.failed` (reason=no-gh). |
| `github.token` unset / `{cmd}` fails | reply: GitHub token 未設定 / 指令失敗 — NO `{cmd}` output leak. |
| repo slug underivable | reply: 請 tech 指定 repo（無法從 git origin 推出）; stop. |
| `gh issue create` fails (auth/perm/net) | reply friendly error, NO token/stderr leak; audit `github.issue.failed`. |
| duplicate 🎫 (`candidate.issuedUrl` set) | reply the existing issue URL; no duplicate. |
| lost the atomic claim (concurrent 🎫) | the loser stops; only the claim winner creates the issue. |
| reactor not in `candidate.mentionedUserIds` / blocklisted | ignore silently. |

**No-leak (mandatory):** the work GitHub token never appears in a Slack reply, an
audit event, or a host log line. `createIssue` and `resolveGithubToken` errors are
sanitised. `gh`'s env-passed `GH_TOKEN` is not logged.

## Testing (TDD)

**Unit (`github.ts`, injected exec):**
- `resolveRepoSlug`: `git@github.com:onead/erp.git` → `onead/erp`; `https://github.com/onead/erp.git` → `onead/erp`; non-github / no origin → undefined.
- `createIssue`: builds the exact `gh issue create -R … --title … --body …` argv with `GH_TOKEN` in env; returns the URL from stubbed stdout; on non-zero exit → error WITHOUT the token/stderr (assert the token string never appears in the thrown message).
- `githubDoctor`: gh-missing → not ok; token-empty → not ok.

**Config:** `github.token` `{cmd}`/`{env}`/literal resolution via `resolveGithubToken`; a failing `{cmd}` → error with NO command-output leak (mirror the secret-source tests).

**`issue-candidate.ts` unit:** save/load round-trip; `claimIssueCandidate` is atomic
(second concurrent claim throws / returns false — the loser does NOT proceed); a
claimed-then-finalised record carries `issuedUrl`.

**`events.ts` unit:** `github.issue.created` / `github.issue.failed` typecheck as
`GatewayEvent`, are in `VALID_TYPES`, and round-trip through the reader/guard.

**Integration (slack-adapter harness; fake exec + reactionAddedPayload):**
- tech (∈ `candidate.mentionedUserIds`) reacts 🎫 on the **anchor** message → `createIssue` called with the right slug + a body containing the snapshot diagnosis + the URL posted + `github.issue.created` event.
- **High-1:** tech replies `@pmk …` FIRST (absorb consumes the escalation marker), THEN reacts 🎫 → issue STILL created (the durable candidate survived).
- **High-3:** two 🎫 reaction events for the same anchor (or two pool users) → `createIssue` called exactly ONCE (atomic claim); the loser reposts the existing URL or no-ops.
- duplicate 🎫 after issued → existing URL reposted, `createIssue` NOT called again.
- **Medium-4:** 🎫 on a DIFFERENT bot message in the same pending thread (not the anchor) → ignored.
- **Medium-5:** a reactor NOT in `candidate.mentionedUserIds` (even if newly added to the live pool) → ignored; a blocklisted reactor → ignored.
- token `{cmd}` fails → friendly error posted, NO leak; `github.issue.failed` event.
- 🎫 with no matching candidate → ignored.

## Out of scope (sub-project 1)

- Development / PR creation (sub-project 2).
- Tech overriding the target repo at confirm time — the 🎫 reaction carries no repo
  argument; the core flow uses the auto-derived repo, and asks the tech to specify
  only when the slug is underivable. A `/pmk issue <repo>` override command is a
  later enhancement.
- Issue labels / assignee / severity — the body carries attribution; structured
  fields can be added later if a real need emerges (YAGNI).
- octokit / a GitHub App — `gh` CLI + a `{cmd}`-provided work token is sufficient
  and reuses the secret-reference infra; no new dependency.
