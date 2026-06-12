# Confirmed Problem → GitHub Issue — Design

**Date:** 2026-06-12
**Status:** Draft v4 — v2 (6 user findings) + v3 (3-agent review) + v4 (5 follow-up findings: release-boundary, diagnosis plumbing, snapshot-only consistency, permalink source, affordance ordering); awaiting user review
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
src/adapters/github.ts        — gh-CLI wrapper (all via execFile, arg-array, NO shell):
  resolveRepoSlug(workspace, repo) → "owner/repo" (execFile git, validated path segment)
  repoVisibility({ slug, token }) → "public" | "private" | "unknown" (gh repo view)
  createIssue({ slug, title, body, token }) → issue URL (gh issue create, GH_TOKEN env, 30s timeout, no-leak)
  githubDoctor({ token }) → { ok, reason } (gh installed + token resolves; discards gh stdout/stderr)
src/gateway/config.ts         — RawGatewayConfig.github?: { token: SecretSource; allowPublicRepos?: boolean };
  resolveGithubToken (mirrors resolveGatewayApiKey)
src/gateway/issue-candidate.ts — DURABLE issue-candidate record (NEW; NOT the consumable
  escalation marker). Persisted at escalation time with everything the issue needs (snapshot),
  mode 0600. Storage key = `<channelId>__<anchorTs>.json` (anchorTs, NOT threadTs — so
  re-escalation in one thread never overwrites). saveIssueCandidate / loadIssueCandidate
  (logs on corrupt-vs-missing) / claimIssueCandidate / releaseIssueCandidate / finalizeIssueCandidate.
  See "Atomic claim lifecycle" below — this is LOCK-THEN-FINALIZE, not consume-on-claim.
src/gateway/slack/issue.ts    — IssueFromCandidate: load record → authorize → atomic claim →
  resolve slug + token + visibility → build issue title/body from the SNAPSHOT → createIssue →
  finalize (write issuedUrl, rename-commit) → reply; release on every early-return
src/gateway/slack/index.ts    — reaction_added: WIDEN the existing early-return gate (currently
  `if (!isApprove && !isReject && !isCitationFeedback) return`, ~line 783) so 🎫 (`ticket`)
  reaches IssueFromCandidate. Match a candidate whose anchorTs == reaction.item.ts.
src/gateway/slack/escalation.ts — at escalate() time, ALSO write the issue-candidate record
  (capturing the escalation message ts as anchorTs + mentionedUserIds snapshot). The
  saveIssueCandidate call is wrapped in try/catch (fail-soft): a write failure logs and is
  swallowed — it must NEVER disrupt the primary escalation (the @-mention, the escalation
  marker, the escalate audit event). Field names mirror ThreadEscalation: askerUserId
  (NOT `asker`); the repo comes from `request.repo` and is stored as `scope`.
  **Call-boundary change (required):** `escalate()` today takes only
  `{ channelId, threadTs, askerUserId, request:{repo?,question,reason?} }`
  (escalation.ts:75). The issue body's diagnosis is NOT in that shape. So add a
  `diagnosis: string` arg = the **stripped visible assistant text** — in
  free-chat-turn.ts:356 this is `stripEscalateBlock(stripMraAskBlock(stripCaseUpdateBlock(full)))`,
  which currently is computed AFTER the escalate() call (line 356, call at line 338);
  hoist that computation above the call and pass it through. `question` continues to
  come from `request.question`.
src/gateway/events.ts         — add github.issue.created / github.issue.failed to the
  GatewayEvent union + VALID_TYPES whitelist (the isStoredGatewayEvent guard delegates to
  VALID_TYPES, so no third edit). Event payload carries actor/repo/url — NEVER the token.
src/gateway/doctor.ts         — add a `github-token` check; also surface stale `.claiming`
  locks (older than N min, or with issuedUrl already set → finalize) and warn on any
  configured escalation repo that resolves to a PUBLIC GitHub repo.
```

### Why a separate durable record (not the escalation marker) — resolves review findings

The existing pending-escalation marker is **consumed/claimed** when a tagged tech
replies (the absorb path atomically renames it away, session-store.ts ~356/368).
So if a tech replies `@pmk …` FIRST and reacts 🎫 second, the marker is already
gone → the issue flow would no-op. Therefore the 🎫 flow uses a SEPARATE, durable
`issue-candidate` record that the absorb path does NOT touch. The record is a
**snapshot taken at escalation time** carrying: `repo` (the escalate scope),
`channelId`, `threadTs`, `anchorTs` (the bot's escalation message ts — the exact
react target), `askerUserId`, `mentionedUserIds` (the tech pool actually tagged for THIS
thread), the user's `question`, and the bot's `diagnosis` text. Because the issue
body is built from this snapshot, the 🎫 handler does NOT call
`conversations.replies` — so **no new Slack history scope is needed** (only the
existing `reactions:read`). (Pulling the tech's later discussion into the issue
would need `channels:history`/`groups:history`; that is deferred to sub-project 2.)

The issue body is ALWAYS built from the escalation-time snapshot: any bot reply or
diagnosis refinement posted to the thread AFTER the escalation message is
intentionally NOT reflected in the filed issue (this is a deliberate choice, not a
bug — sub-project 2 may incorporate live thread history).

### Atomic claim lifecycle (LOCK-THEN-FINALIZE — differs from claimThreadEscalation)

`claimThreadEscalation` (session-store.ts:368–389) is **consume-on-claim**: it
renames to `.claiming`, reads, and deletes in a `finally` — the lock never
outlives the call. The issue flow is different: the lock MUST survive an async,
non-idempotent network call (`gh issue create` has no dedup). So `issue-candidate`
uses an explicit **lock-then-finalize** state machine:

- **CLAIM** (`claimIssueCandidate`): `fs.renameSync(<key>.json → <key>.claiming)`.
  If the rename throws (ENOENT — another event/pool user already holds it, or it
  was finalized) → this caller stops. This rename is the **only** true
  serialization barrier; the earlier `issuedUrl` pre-check is just an optimisation
  to skip a doomed claim, not a guard against concurrency.
- **createIssue** runs with a **30 s timeout** (so a hung `gh` can't pin the lock).
- **The release boundary is the createIssue launch.** This is the crux: a timeout
  or error from `gh issue create` does NOT mean GitHub rejected the request — the
  issue may already have been created server-side. So once createIssue is INVOKED,
  no failure (timeout, non-zero exit, throw, or a finalize-write failure) may
  release the lock; the `.claiming` file is LEFT IN PLACE for doctor recovery.
  Releasing here would let the next 🎫 open a **duplicate**. RELEASE is therefore
  allowed ONLY for early-returns that happen strictly BEFORE createIssue is called.
- **RELEASE** (`releaseIssueCandidate`): only on the pre-createIssue early-returns
  (slug underivable, token fail, repo-visibility blocked, or any throw in steps
  d–h) → `fs.renameSync(.claiming → .json)` so a later 🎫 can retry. Structure the
  handler so the try/finally that auto-releases wraps ONLY steps d–h; createIssue
  (step i) and finalize (step j) run AFTER that guarded block, where failures
  deliberately leave `.claiming`. If release itself throws, log high-severity and
  proceed.
- **FINALIZE** (`finalizeIssueCandidate`): write `issuedUrl` INTO the `.claiming`
  file FIRST, then `fs.renameSync(.claiming → .json)` as the commit. Ordering
  matters: a failure/crash after createIssue but before the write leaves a
  `.claiming` with NO url (doctor surfaces it as "orphan — an issue may already
  exist; verify on GitHub"); a crash after the write but before the rename leaves a
  `.claiming` WITH a url (doctor finalizes it by renaming, NEVER re-creating the issue).
- **Recovery (doctor):** a `.claiming` with `issuedUrl` set → finalize (rename to
  `.json`). A `.claiming` older than N minutes with NO url → warn ("possible
  orphaned issue; verify on GitHub, then delete or restore the record"). We accept
  this narrow at-most-once window (orphan possible, duplicate avoided) because a
  duplicate public issue is worse than a doctor-surfaced orphan.

### Config

```ts
// RawGatewayConfig (raw, secrets unresolved)
github?: {
  token: SecretSource;          // SecretSource = string | {cmd} | {env}
  allowPublicRepos?: boolean;   // default false — block opening issues on a PUBLIC repo
};
```
`resolveGithubToken(rawGithub)` mirrors `resolveGatewayApiKey`: returns the
resolved token string (via `resolveSecret`) or undefined if unset. All gateway.json
mutators already load/save RAW (no materialisation) — `github.token` inherits that.

## Trigger & authorization

- The bot's escalation message (the one that @-mentions the tech pool with the
  diagnosis) gains a one-line affordance: `_確認是問題的話,在這則訊息上 react 🎫 我就開 issue_`.
  Its `ts` is saved as the issue-candidate's `anchorTs`. The affordance is appended
  (via `chat.update`) ONLY after the candidate is saved (data-flow step 1a), so a
  visible 🎫 control never advertises a missing record.
- A `reaction_added` for `🎫` (`:ticket:` — verify the exact Slack reaction name at
  implementation) is handled ONLY when **`reaction.item.ts === candidate.anchorTs`**
  for an existing issue-candidate record (Medium-4 fix: anchor-exact, not
  any-bot-message-in-the-thread). Other 🎫 reactions are ignored. **Integration note:**
  the existing `reaction_added` handler (`slack/index.ts` ~line 783) has an early-return
  gate `if (!isApprove && !isReject && !isCitationFeedback) return` that drops every
  non-approve/reject/feedback reaction BEFORE any lookup — it MUST be widened so a
  `ticket` reaction reaches `IssueFromCandidate`, or the flow silently no-ops. The
  handler's existing `item_user === botUserId` guard is kept (the anchor is a bot message).
- **Authorization (Medium-5 fix — snapshot, not live pool):** the reactor MUST be in
  the saved `candidate.mentionedUserIds` (the tech pool actually tagged for THIS
  thread at escalation time) AND not in the blocklist. Authorizing against the LIVE
  pool would let a later config change authorize someone never tagged here, or
  de-authorize the tagged tech. Non-listed / blocklisted reactors are ignored silently.

## Data flow

1. Bot escalates (existing path, extended): in `escalate()`, AFTER posting the
   @-mention diagnosis message, capture that message's `ts` and write a durable
   `issue-candidate` record `{ channelId, threadTs, anchorTs, scope (= request.repo),
   askerUserId, mentionedUserIds, question, diagnosis, permalink?, issuedUrl? }`
   (mode 0600, key `<channelId>__<anchorTs>.json`; `diagnosis` = the stripped visible
   assistant text passed in via the call-boundary change; `permalink` = best-effort
   `chat.getPermalink` of anchorTs). The 🎫 affordance is appended to the message ONLY
   after the candidate is saved (see step 1a) so a visible 🎫 never points at a missing
   record. The `saveIssueCandidate` call is **fail-soft** (try/catch): a write error logs
   and is swallowed so the primary escalation is never disrupted. This record is
   independent of the consumable escalation marker and is NOT cleared by the absorb path.
1a. **Affordance ordering (fail-soft, no dead control):** post the @-mention diagnosis
   message FIRST (its `ts` becomes `anchorTs`), THEN `saveIssueCandidate`. On save
   SUCCESS → `chat.update` to append the 🎫 affordance line. On save FAILURE → leave the
   message as-is WITHOUT the affordance (escalation still fully works; there is just no
   🎫 control advertised). This guarantees the 🎫 affordance is shown only when a
   loadable candidate exists.
2. Tech reacts 🎫 on that exact message.
3. `reaction_added` handler (after the widened early-return gate lets `ticket` through):
   a. Ignore unless reaction == 🎫 AND an issue-candidate exists whose
      `anchorTs == reaction.item.ts`. (`loadIssueCandidate` distinguishes corrupt
      from missing — a parse/guard failure logs high-severity, not a silent no-op.)
   b. If `candidate.issuedUrl` already set → reply with the existing URL (idempotent), stop.
   c. Authorize: reactor ∈ `candidate.mentionedUserIds` ∧ not blocklisted. Else ignore
      silently (and write one host-log line so repeated unauthorized attempts are visible).
   d. **Atomic claim:** `claimIssueCandidate` (rename `.json → .claiming`). If it throws →
      stop (someone else holds/finalized it). This rename is the true serializer (step b is
      only an optimisation). See "Atomic claim lifecycle". Steps e–h run inside a
      try/finally that RELEASES the claim on any early-return or throw — but that guarded
      block ENDS before step i. createIssue (i) and finalize (j) are OUTSIDE it, so a
      createIssue failure does NOT release (see the release-boundary rule).
   e. Resolve the repo slug: `resolveRepoSlug(mraWorkspace, candidate.scope)` → git
      origin → `owner/repo`. If underivable → reply asking the tech to specify the
      repo, release the claim, stop.
   f. Resolve the work token via `resolveGithubToken` (`{cmd}`). On failure → reply
      "GitHub token 未設定 / 指令失敗" (NO `{cmd}` output leak), release claim, audit
      `github.issue.failed`, stop.
   g. **Public-repo guard:** unless `github.allowPublicRepos === true`, call
      `repoVisibility({ slug, token })`. If `public` → reply 「目標 repo 為 public,已停止
      （內部資訊不外洩）。請改用 private repo 或開啟 allowPublicRepos」, release claim,
      audit `github.issue.failed` (reason=public-repo), stop. `unknown` → treat as blocked too.
   h. Build the issue title + body (structure below) from the SNAPSHOT
      (`candidate.question` + `candidate.diagnosis`) — NO `conversations.replies`,
      so no new Slack history scope is needed.
   i. `createIssue({ slug, title, body, token })` (30 s timeout) → issue URL. On
      failure/timeout: do NOT release (GitHub may have accepted it) — reply a friendly
      error, audit `github.issue.failed`, leave `.claiming` for doctor; stop.
   j. **Finalize:** write `issuedUrl = url` into the `.claiming` file, THEN rename
      `.claiming → .json` (commit order — see lifecycle). Post the URL back to the
      thread. Emit `github.issue.created` (actor = reactor, repo = slug, issue url — NO token).

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
- Slack thread: <permalink (snapshot.permalink) — falls back to channel/thread IDs if unavailable>
- 提問者：<@askerUserId> · 確認者（tech）：<@reactor>
- repo: owner/repo
```
The title/問題/診斷/建議方向 are composed by ONE LLM call over the **snapshot only**
(`candidate.question` + `candidate.diagnosis`) — NOT the live thread. This is the same
no-`conversations.replies`, snapshot-only rule as the data flow; the issue body never
reads Slack history (keeps the scope surface unchanged). Output is audience-neutral,
technical — this is for engineers. 確認者 is the 🎫 reactor (resolved at confirm time);
提問者 is `askerUserId` from the snapshot.

**Permalink source:** capture it at escalate() time via `chat.getPermalink({ channel,
message_ts: anchorTs })` and store it as `candidate.permalink` in the snapshot. If that
call fails (network / scope), fall back to storing the raw `channelId`/`threadTs` and
render the 來源 line with those IDs — the permalink is best-effort, never blocks issue
creation.

## `github.ts` (gh CLI wrapper)

- `resolveRepoSlug(workspace, repo)`: **`execFile("git", ["-C", path.join(workspace,
  repo), "remote", "get-url", "origin"])`** — arg-array, NO shell, so no command
  injection even if config values are hostile. `repo` (from `candidate.scope`, which
  derives from a model directive over user Slack input) is **validated as a single
  path segment first** — `/^[A-Za-z0-9._-]+$/`, reject `..` / separators — before
  `path.join`. Parse both `git@github.com:owner/repo.git` and
  `https://github.com/owner/repo(.git)` → `owner/repo`. Undefined if no origin / non-github.
- `repoVisibility({ slug, token }, deps?)`: `execFile("gh", ["repo", "view", slug,
  "--json", "visibility", "-q", ".visibility"], { env: { ...process.env, GH_TOKEN: token } })`
  → `"public"` | `"private"`; any error / unrecognised → `"unknown"`. No-leak on error.
- `createIssue({ slug, title, body, token }, deps?)`: `execFile("gh", ["issue",
  "create", "-R", slug, "--title", title, "--body", body], { env: { ...process.env,
  GH_TOKEN: token }, timeout: 30_000 })`. Returns the printed issue URL (gh prints it
  to stdout). Injectable `exec` for tests. **No-leak:** on error, the thrown/returned
  message is `gh issue create failed (<code>)` — never the token, never raw stderr
  (which could echo the token or a URL with auth). Detailed stderr → host-side log, token-redacted.
- `githubDoctor({ token })`: gh installed (`findGhBinary`) + token non-empty +
  (optionally) `gh auth status --hostname github.com` with the token — run with
  `stdio` capturing discarded (check exit code ONLY; never log the authed
  username/scopes). Returns `{ ok, reason }` for the doctor check. Never prints the token.

## Error handling (fail-soft, no-leak)

| Situation | Behaviour |
|-----------|-----------|
| `gh` not installed | reply: host needs the `gh` CLI; audit `github.issue.failed` (reason=no-gh). |
| `github.token` unset / `{cmd}` fails | reply: GitHub token 未設定 / 指令失敗 — NO `{cmd}` output leak; release claim. |
| repo slug underivable | reply: 請 tech 指定 repo（無法從 git origin 推出）; release claim; stop. |
| target repo is PUBLIC (and `allowPublicRepos` ≠ true) | reply: 已停止（內部資訊不外洩，repo 為 public）; release claim; audit `github.issue.failed` (reason=public-repo). |
| `gh issue create` fails / times out (30 s) | reply friendly error, NO token/stderr leak; audit `github.issue.failed`; **do NOT release** — leave `.claiming` for doctor (GitHub may have accepted it). |
| createIssue OK but finalize write/rename fails | `.claiming` persists (with or without url); doctor recovers it; NEVER re-create the issue on retry. |
| stale `.claiming` lock (crash mid-flow) | doctor surfaces it: finalize if url present, else warn (possible orphan — verify on GitHub). |
| `saveIssueCandidate` fails at escalate() time | fail-soft: log + swallow; primary escalation unaffected; 🎫 will no-op (no record). |
| duplicate 🎫 (`candidate.issuedUrl` set) | reply the existing issue URL; no duplicate. |
| lost the atomic claim (concurrent 🎫) | the loser stops; only the claim winner creates the issue. |
| reactor not in `candidate.mentionedUserIds` / blocklisted | ignore silently + one host-log line. |

**No-leak (mandatory):** the work GitHub token never appears in a Slack reply, an
audit event, or a host log line. `createIssue` and `resolveGithubToken` errors are
sanitised. `gh`'s env-passed `GH_TOKEN` is not logged.

## Testing (TDD)

**Unit (`github.ts`, injected exec):**
- `resolveRepoSlug`: `git@github.com:onead/erp.git` → `onead/erp`; `https://github.com/onead/erp.git` → `onead/erp`; non-github / no origin → undefined. Uses `execFile` (arg-array), and a `repo` with `..` / `/` / shell metacharacters is REJECTED before any exec (path-segment validation).
- `repoVisibility`: stubbed `private` → `"private"`; `public` → `"public"`; gh error → `"unknown"`; no token leak in any error path.
- `createIssue`: builds the exact `gh issue create -R … --title … --body …` argv with `GH_TOKEN` in env and a 30 s timeout; returns the URL from stubbed stdout; on non-zero exit / timeout → error WITHOUT the token/stderr (assert the token string never appears in the thrown message).
- `githubDoctor`: gh-missing → not ok; token-empty → not ok; `gh auth status` output is never surfaced in the result.

**Config:** `github.token` `{cmd}`/`{env}`/literal resolution via `resolveGithubToken`; a failing `{cmd}` → error with NO command-output leak (mirror the secret-source tests). `allowPublicRepos` defaults to false.

**`issue-candidate.ts` unit:**
- save/load round-trip; saved file is mode 0600; storage key is `<channelId>__<anchorTs>.json` (two escalations in one thread → two distinct files, no overwrite).
- `loadIssueCandidate`: missing → undefined (silent); corrupt/guard-fail → undefined BUT logs high-severity (distinguishable from missing).
- `claimIssueCandidate` is atomic: second concurrent claim throws / returns false — the loser does NOT proceed.
- `releaseIssueCandidate` renames `.claiming` → `.json` so a retry can re-claim.
- `finalizeIssueCandidate`: writes `issuedUrl` then renames-commit; a record left `.claiming` WITH `issuedUrl` is finalised by recovery WITHOUT calling createIssue; a `.claiming` with no url is surfaced as a possible orphan.

**`events.ts` unit:** `github.issue.created` / `github.issue.failed` typecheck as
`GatewayEvent`, are in `VALID_TYPES`, and round-trip through the reader/guard.

**Integration (slack-adapter harness; fake exec + reactionAddedPayload):**
- tech (∈ `candidate.mentionedUserIds`) reacts 🎫 on the **anchor** message → `createIssue` called with the right slug + a body containing the snapshot diagnosis + the URL posted + `github.issue.created` event.
- **High-1:** tech replies `@pmk …` FIRST (absorb consumes the escalation marker), THEN reacts 🎫 → issue STILL created (the durable candidate survived).
- **High-3:** two 🎫 reaction events for the same anchor (or two pool users) → `createIssue` called exactly ONCE (atomic claim); the loser reposts the existing URL or no-ops.
- duplicate 🎫 after issued → existing URL reposted, `createIssue` NOT called again.
- **Medium-4:** 🎫 on a DIFFERENT bot message in the same pending thread (not the anchor) → ignored.
- **Medium-5:** a reactor NOT in `candidate.mentionedUserIds` (even if newly added to the live pool) → ignored; a blocklisted reactor → ignored.
- token `{cmd}` fails → friendly error posted, NO leak; `github.issue.failed` event; claim RELEASED (a later 🎫 with a working token succeeds).
- **Public-repo guard:** target repo resolves to `public` and `allowPublicRepos` false → issue NOT created, friendly stop reply, `github.issue.failed` (reason=public-repo), claim released; with `allowPublicRepos: true` → issue IS created.
- **Finalize crash recovery:** createIssue succeeds but the finalize rename is stubbed to fail → record stays `.claiming` with `issuedUrl`; a subsequent recovery pass finalises it and does NOT call createIssue again (no duplicate).
- **createIssue failure does NOT release (no duplicate):** createIssue stubbed to throw/timeout → record stays `.claiming` (NOT released); a second 🎫 then fails to claim (rename throws) and does NOT call createIssue a second time. Regression guard for the orphan-window duplicate.
- **Gate widening:** a 🎫 reaction is actually delivered to `IssueFromCandidate` (regression guard against the `slack/index.ts` early-return gate dropping `ticket`).
- **Diagnosis plumbed through:** `escalate()` is called with the stripped visible assistant text as `diagnosis`; the filed issue body's 診斷 section contains it (proves the call-boundary change is wired, not just the snapshot field existing).
- **Affordance ordering:** save OK → `chat.update` appends the 🎫 affordance; `saveIssueCandidate` throws → message is left WITHOUT the affordance (no dead 🎫 control) AND the primary escalation (@-mention, marker, escalate audit event) is intact.
- **Permalink best-effort:** `chat.getPermalink` OK → snapshot stores it and the 來源 line renders the permalink; `getPermalink` throws → snapshot falls back to channel/thread IDs, issue is STILL created with the ID-based 來源 line.
- 🎫 with no matching candidate → ignored; 🎫 on a candidate file that exists but is corrupt → ignored BUT logged (not a silent swallow).

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
