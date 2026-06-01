# `pmk demo` driver — design (P5b)

**Date:** 2026-06-01
**Status:** Approved (design); implementation pending
**Source:** priorities-plan P5 — 垂直案例 demo bundle. Builds on P5a (AcmeAds seed atoms, merged) and the P2a `turn.processed` event extension.

## Context

P5 ships an AcmeAds vertical demo. P5a (merged) authored the content: five
AcmeAds-themed seed atoms (`seedAcmeAdsAtoms()` in
`packages/cli/src/gateway/acme-ads-seed.ts`) + two example PRDs. **P5b (this
spec)** is the driver: a top-level `pmk demo` command that seeds the workspace
and **drives a real Slack conversation** through the running gateway — posting a
guided question sequence as a real user and reading the bot's real replies back
into a printed transcript.

**Decisions locked during brainstorming:**

- **Drive real Slack (C1):** `pmk demo run` posts the guided questions as a real
  user via a Slack **user OAuth token** (`xoxp-…`), so the running bot processes
  each through the full retrieval → LLM → (escalate) loop. The bot token alone
  cannot do this — the gateway ignores `bot_id` / self messages
  (`slack/index.ts:324-327`), so a real user identity is required.
- **Read replies back (B):** the runner polls for each bot reply and prints the
  full Q&A transcript (which doubles as raw material for P5c's walkthrough).

## Goals

- `pmk demo run` against a running gateway produces a real Slack conversation:
  five AcmeAds questions asked as a user, the bot's real grounded answers, all
  captured into a terminal transcript.
- Reuse P5a's seed atoms; reuse the gateway's real turn pipeline (no
  re-implementation of retrieval/LLM).
- Be safe: posting to Slack is outward-facing — explicit target, dry-run preview,
  preflight checks that fail *before* posting, not mid-run.

## Non-goals

- **No P5c walkthrough doc / video** — `run` produces the transcript; the polished
  30-minute guide + record is P5c.
- **No user-token persistence** — env-only (`PMK_DEMO_USER_TOKEN`), never written
  to config.
- **No auto-unseed** — `pmk demo unseed` is a separate explicit step.
- **No change to the gateway runtime** — the driver is an external client; it does
  not modify `SlackAdapter` / handlers.

## Command surface

Top-level `pmk demo <subcommand>`:

- `pmk demo seed` → `seedAcmeAdsAtoms()` (idempotent; prints the 5 atom ids).
- `pmk demo unseed` → `unseedAcmeAdsAtoms()` (removes only `acme-ads-demo` atoms).
- `pmk demo run [--channel <id>] [--dry-run] [--timeout <sec>]`:
  1. **Preflight** (all must pass before any post — see below).
  2. `seedAcmeAdsAtoms()` (idempotent).
  3. For each scripted question: post as the user → wait for that turn to complete
     → read the final answer text → append to the transcript.
  4. Print the transcript.
  - `--dry-run`: run preflight + print the script and exactly what *would* be
    posted (channel, mention-prefixed text), then stop — **no posting, no polling**.

## Preflight (fail before posting)

1. **Gateway running:** `gatewayRunningPid()` is non-null (the bot must be online
   to answer). Otherwise abort with a clear hint to `pmk gateway start`.
2. **User token:** `PMK_DEMO_USER_TOKEN` is set and starts with `xoxp-`. Call
   `auth.test` with it; require the result to be a **user** identity (not a bot)
   and capture `demoUserId` (the poster's Slack user id) for reply correlation.
3. **Channel resolved:** `--channel <id>` or `PMK_DEMO_CHANNEL`. Call
   `conversations.info` to learn the channel **type** (`im` / public / private)
   and confirm the gateway **bot** is a member (for non-DM) — and surface which
   history scope the user token needs (`im:history` for a DM, `channels:history`
   for public, `groups:history` for private). If `conversations.info` /
   membership fails, abort with the specific missing scope/permission, not a
   mid-run error.
4. **Bot identity:** resolve `botUserId` via the gateway **bot** token
   (`auth.test`) — needed to @-mention in non-DM channels (see below).

## Channel vs DM (finding: channel messages need a mention)

The gateway only processes **plain messages in DMs** (`slack/index.ts:330`:
`if (!isDm) return; // app_mention covers channel/non-DM cases`). In a public or
private channel, a plain message is ignored — only an `app_mention` triggers a
turn. Therefore:

- **DM channel (`im`):** post the question text as-is.
- **Non-DM channel:** post `<@${botUserId}> ${question}` so the gateway's
  `app_mention` path fires.

The runner decides this from the `conversations.info` channel type captured in
preflight.

## Turn-completion detection (finding: placeholder text is unreliable)

The bot posts a `:hourglass_flowing_sand: thinking…` placeholder and then
`chat.update`s it — first possibly with `[ask] …` mra-ask progress lines, finally
with the answer. So "text is no longer the placeholder" can fire on a *progress*
update and capture an unfinished answer. Completion is therefore **two-phase**:

**Phase 1 — the turn-done event.** After posting question *i* at wall-clock
`postedAt_i`, poll the local `readGatewayEvents()` for the first `turn.processed`
event with `channelId === <channel>` **and** `actor === demoUserId` **and**
`at > postedAt_i` — and, for a **non-DM channel**, also `threadTs === postedTs_i`
(the gateway threads its reply under the posted message's ts, so this pins the
exact turn; for a DM, threading is looser, so fall back to actor/channel/time).
That event carries the `replyTs`.

**Phase 2 — wait for the final Slack text.** `turn.processed` is emitted
*before* the gateway's final `chat.update`
(`free-chat-turn.ts:302` emit → `:314` final update), so the event alone does
**not** guarantee Slack has the answer yet — it may still hold the placeholder or
an `[ask] …` progress line. So after matching the event, **poll the `replyTs`
message text** until it is (a) not the `:hourglass…:` placeholder, (b) not an
`[ask] …` progress line, and (c) unchanged across a short stabilization window
(~3s), or a short post-event timeout (~10s) elapses — then take that text as the
final answer.

**Timeout** (`--timeout`, default 120s per question): if no matching
`turn.processed` appears within the window, record `(no reply within Ns)` for that
question and continue — never hang.

This correlation is **sufficient for the intended use** — a one-at-a-time demo
(each question waits for its turn to complete before the next is posted) in a
**dedicated, quiet demo channel**. It is *not* robust against other users posting
in the same channel concurrently; the spec mandates the one-at-a-time sequencing
above and recommends a private demo channel rather than claiming general
robustness.

## File structure

| Path | Responsibility |
|---|---|
| `packages/cli/src/gateway/demo/acme-ads-script.ts` (new) | the guided question sequence (data) + `DemoTranscript` / `DemoTurn` types |
| `packages/cli/src/gateway/demo/demo-runner.ts` (new) | pure orchestration `runDemo(opts)` → transcript; all Slack/event I/O passed in as injectable functions (fakeable) |
| `packages/cli/src/commands/demo.ts` (new) | `pmk demo` command: subcommand dispatch, preflight, wires real Slack `WebClient`s (user + bot) + event polling, renders |
| `packages/cli/src/index.ts` (modify) | register the `demo` command |
| `packages/cli/test/demo-runner.test.ts` (new) | `runDemo` orchestration: happy path, dry-run, per-question timeout, transcript shape — all with fakes |

> `acme-ads-seed.ts` lives one level up (`gateway/acme-ads-seed.ts`); the new
> `gateway/demo/` folder is for the *driver* (script + runner). This is the first
> use of `gateway/demo/`; the P5a seed stays where it is (no move).

## `runDemo` interface (the testable seam)

```ts
interface DemoTurn { question: string; posted: boolean; answer: string | null; replyTs: string | null; }
interface DemoTranscript { channelId: string; dryRun: boolean; turns: DemoTurn[]; }

interface RunDemoDeps {
  script: readonly string[];
  channelId: string;
  isDm: boolean;
  botUserId: string;        // for non-DM mention prefixing
  dryRun: boolean;
  timeoutMs: number;
  // injected I/O — real impls in the command; fakes in tests:
  post: (text: string) => Promise<{ ts: string }>;                 // user-token chat.postMessage
  // Phase 1: poll the events log for this turn's turn.processed (matching
  // channelId + actor + at>postedAtMs, and threadTs===postedTs for non-DM).
  awaitTurn: (postedTs: string, postedAtMs: number, timeoutMs: number)
    => Promise<{ replyTs: string } | null>;
  // Phase 2: read replyTs and poll until the text is final-stable (not the
  // placeholder, not an `[ask] …` progress line, unchanged for ~3s) or a short
  // post-event timeout; returns the final answer text.
  readReply: (replyTs: string) => Promise<string>;
  now: () => number;                                               // injectable clock for tests
}

export async function runDemo(deps: RunDemoDeps): Promise<DemoTranscript>;
```

`runDemo` is pure orchestration: for each question it (mention-prefixes with
`<@${botUserId}>` if `!isDm`), `post`s, records `postedAt = now()`, `awaitTurn`s
(Phase 1), `readReply`s on success (Phase 2), and builds the transcript. On
`dryRun` it records the to-be-posted text and skips post/await/read. Tests drive
it with fake `post`/`awaitTurn`/`readReply` and a fake `now` — no Slack, no real
time. The two-phase completion logic lives behind `awaitTurn` (event match) and
`readReply` (text stabilization), so each is independently fakeable.

## Guided script (hits all 5 atoms + the escalation boundary)

`acme-ads-script.ts`:

1. `AcmeAds 的 AdFormat 跟 placement 有什麼差別？` → atom `adformat-vs-placement`
2. `某個 placement 的 vCPM 怎麼算？資料在哪看？` → atom `placement-vcpm`
3. `self-service onboarding 上線後，舊客戶的資料怎麼遷？` → atom `onboarding-customer-migration`
4. `PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？` → atom `placementrevenue-vs-accountpayable`
5. `customer onboarding 的客戶去重規則寫在哪個 module 的哪個函式？` → atom `onboarding-dedup-module` (PKB answers to the module boundary; "which function" demonstrates the mra-ask / escalation edge)

## Correctness / safety

- **Outward-facing:** `run` posts real messages. It requires an explicit channel
  (no default), prints a confirmation banner naming the channel + message count
  before posting, and offers `--dry-run` to preview. The operator chooses a demo
  channel; the tool never guesses one.
- **One-at-a-time sequencing (load-bearing for correlation):** the runner posts
  question *i+1* only after question *i*'s turn has completed (or timed out). This
  guarantees at most one in-flight demo turn, which is what makes the
  actor+channel+time(+threadTs) correlation safe. The banner recommends a
  **dedicated, quiet demo channel** so no concurrent third-party message can be
  mis-correlated.
- **Retrieval scope:** unchanged — the gateway's `searchAtoms` is unscoped, so the
  `acme-ads`-scoped atoms are found (per the P5a retrieval-scope note).
- **Failure isolation:** a per-question timeout records `(no reply within Ns)` and
  continues; one slow/failed turn doesn't abort the whole run.
- **No secret leakage:** the user token is read from env, never logged or written
  to config; only `demoUserId` (a public Slack id) is retained.

## Testing

- `runDemo` happy path: 5 questions → 5 transcript turns with answers, posts
  recorded, DM vs non-DM mention-prefixing correct (fake `post` asserts the text
  it received).
- `runDemo` dry-run: no `post`/`awaitTurn`/`readReply` calls; transcript shows the
  to-be-posted (mention-prefixed where non-DM) text, `posted: false`.
- `runDemo` timeout: `awaitTurn` returns null for one question → that turn's
  `answer` is the `(no reply…)` sentinel, the run still completes the rest.
- `runDemo` non-DM prefixing: `isDm:false` → posted text starts with `<@bot>`.
- **Final-text predicate** (extracted as a pure function, e.g. `isFinalAnswerText(text)`):
  returns false for the `:hourglass_flowing_sand: thinking…` placeholder and for
  `[ask] …` mra-ask progress lines, true for a real answer. Unit-tested directly so
  the Phase-2 stabilization can't regress (this is the crux of finding #1).
- (Command-level preflight is exercised manually / lightly — the heavy logic is in
  the injectable seam + the predicate, tested above.)

## Out of scope / future (P5c, etc.)

- P5c: the polished 30-minute walkthrough doc + text/video record.
- Reading/printing per-message mra-ask progress (the transcript captures final
  answers only).
- A non-Slack offline replay mode (explicitly rejected in favour of C1).
