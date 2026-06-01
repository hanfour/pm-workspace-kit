# `pmk demo` Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-level `pmk demo <seed|unseed|run>` command whose `run` posts the AcmeAds guided questions into Slack as a real user (xoxp env token), lets the running gateway answer through its real loop, reads the replies back, and prints a transcript.

**Architecture:** A pure `runDemo(deps)` orchestrator with all Slack/event I/O injected (testable with fakes). Two-phase per-question completion: Phase 1 matches the turn's `turn.processed` event in the local events log (`matchTurnEvent`, pure); Phase 2 polls the reply's Slack text until it's a real answer (`isFinalAnswerText`, pure) — because the gateway emits `turn.processed` *before* its final `chat.update`. The command (`demo.ts`) does preflight (daemon up, user token, channel type/membership) and wires the real Slack `WebClient`s + events-log polling.

**Tech Stack:** TypeScript (Node ESM), `@slack/web-api`, `node:test`. Spec: `docs/superpowers/specs/2026-06-01-demo-driver-p5b-design.md`. Builds on P5a `acme-ads-seed.ts` (`seedAcmeAdsAtoms`/`unseedAcmeAdsAtoms`) and the P2a `turn.processed` event (`actor`/`channelId`/`threadTs`/`replyTs`).

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/cli/src/gateway/demo/acme-ads-script.ts` (new) | guided question list, `DemoTurn`/`DemoTranscript` types, `isFinalAnswerText` predicate |
| `packages/cli/src/gateway/demo/demo-runner.ts` (new) | pure `runDemo(deps)` orchestration + pure `matchTurnEvent(events, criteria)` |
| `packages/cli/src/commands/demo.ts` (new) | `pmk demo` command: preflight + real Slack/event I/O + render |
| `packages/cli/src/index.ts` (modify) | register the `demo` command |
| `packages/cli/test/demo-runner.test.ts` (new) | `isFinalAnswerText`, `matchTurnEvent`, `runDemo` (fakes) |

---

## Task 1: Script + final-answer predicate

**Files:**
- Create: `packages/cli/src/gateway/demo/acme-ads-script.ts`
- Test: `packages/cli/test/demo-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/demo-runner.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

describe("isFinalAnswerText", () => {
  it("rejects placeholder, progress lines, empty; accepts a real answer", async () => {
    const { isFinalAnswerText } = await import("../src/gateway/demo/acme-ads-script");
    assert.equal(isFinalAnswerText(":hourglass_flowing_sand: thinking…"), false);
    assert.equal(isFinalAnswerText("[ask] searching repos…"), false);
    assert.equal(isFinalAnswerText("[1;37m[ask][0m running"), false);
    assert.equal(isFinalAnswerText("   "), false);
    assert.equal(isFinalAnswerText("AdFormat 是廣告版型，placement 是版位。"), true);
  });
});

describe("ACME_ADS_DEMO_SCRIPT", () => {
  it("has 5 questions", async () => {
    const { ACME_ADS_DEMO_SCRIPT } = await import("../src/gateway/demo/acme-ads-script");
    assert.equal(ACME_ADS_DEMO_SCRIPT.length, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/demo-runner.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/demo/acme-ads-script'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/gateway/demo/acme-ads-script.ts`:

```ts
// Guided demo script + transcript types for `pmk demo run` (P5b). The
// five questions are chosen to hit the five AcmeAds seed atoms and to
// demonstrate the escalation boundary (Q5 asks for a function-level
// answer the PKB intentionally doesn't hold).

export interface DemoTurn {
  /** The text actually posted (mention-prefixed for non-DM channels). */
  question: string;
  posted: boolean;
  /** Final answer text, the "(no reply…)" sentinel, or null (dry-run). */
  answer: string | null;
  replyTs: string | null;
}

export interface DemoTranscript {
  channelId: string;
  dryRun: boolean;
  turns: DemoTurn[];
}

export const ACME_ADS_DEMO_SCRIPT: readonly string[] = [
  "AcmeAds 的 AdFormat 跟 placement 有什麼差別？",
  "某個 placement 的 vCPM 怎麼算？資料在哪看？",
  "self-service onboarding 上線後，舊客戶的資料怎麼遷？",
  "PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？",
  "customer onboarding 的客戶去重規則寫在哪個 module 的哪個函式？",
];

const PLACEHOLDER_MARK = "hourglass_flowing_sand";
// Gateway mra-ask progress lines render as bracketed tags (see
// gateway/slack/progress.ts), optionally ANSI-wrapped, at the start of
// the updated placeholder text.
const PROGRESS_RE = /^\s*(?:\[[0-9;]*m)?\[(?:ask|pkb|err|case|escalate)\]/i;

/**
 * True when Slack message text is a real final answer — not the
 * `:hourglass…:` placeholder and not an mra-ask progress line. Used in
 * Phase 2 of completion detection, because the gateway emits
 * turn.processed BEFORE its final chat.update (free-chat-turn.ts:302
 * vs :314), so the event firing doesn't mean the final text has landed.
 */
export function isFinalAnswerText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (t.includes(PLACEHOLDER_MARK)) return false;
  if (PROGRESS_RE.test(t)) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/demo-runner.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (2 tests); tsc 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/demo/acme-ads-script.ts packages/cli/test/demo-runner.test.ts
git commit -m "feat(demo): AcmeAds guided script + final-answer predicate (P5b)"
```

---

## Task 2: `runDemo` orchestration + `matchTurnEvent`

**Files:**
- Create: `packages/cli/src/gateway/demo/demo-runner.ts`
- Test: `packages/cli/test/demo-runner.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/demo-runner.test.ts`:

```ts
import type { StoredGatewayEvent } from "../src/gateway/events";

describe("matchTurnEvent", () => {
  it("matches the turn.processed for this channel/actor after postedAt; threadTs for non-DM", async () => {
    const { matchTurnEvent } = await import("../src/gateway/demo/demo-runner");
    const events: StoredGatewayEvent[] = [
      { at: "2026-06-01T00:00:01.000Z", type: "turn.processed", actor: "U_OTHER", audience: "biz", hadMraAsk: false, atomsInjected: 0, channelId: "C1", threadTs: "100.1", replyTs: "100.2" },
      { at: "2026-06-01T00:00:03.000Z", type: "turn.processed", actor: "U_DEMO", audience: "biz", hadMraAsk: false, atomsInjected: 1, channelId: "C1", threadTs: "200.1", replyTs: "200.2" },
    ] as StoredGatewayEvent[];
    const m = matchTurnEvent(events, { channelId: "C1", actor: "U_DEMO", sincePostedAtMs: Date.parse("2026-06-01T00:00:02.000Z"), threadTs: "200.1" });
    assert.equal(m?.replyTs, "200.2");
    // wrong threadTs (non-DM strict) → no match
    assert.equal(matchTurnEvent(events, { channelId: "C1", actor: "U_DEMO", sincePostedAtMs: 0, threadTs: "999" }), null);
    // DM (no threadTs filter) → matches on channel+actor+time
    assert.equal(matchTurnEvent(events, { channelId: "C1", actor: "U_DEMO", sincePostedAtMs: 0 })?.replyTs, "200.2");
  });
});

describe("runDemo", () => {
  const script = ["q1", "q2"] as const;
  function fakes(over: Partial<Parameters<typeof import("../src/gateway/demo/demo-runner")["runDemo"]>[0]> = {}) {
    const posted: string[] = [];
    return {
      posted,
      deps: {
        script, channelId: "C1", isDm: true, botUserId: "BOT", dryRun: false, timeoutMs: 1000,
        post: async (text: string) => { posted.push(text); return { ts: `ts-${posted.length}` }; },
        awaitTurn: async (postedTs: string) => ({ replyTs: `reply-${postedTs}` }),
        readReply: async (replyTs: string) => `answer for ${replyTs}`,
        now: () => 1000,
        ...over,
      },
    };
  }

  it("happy path: posts each question, reads each answer into the transcript", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps, posted } = fakes();
    const t = await runDemo(deps);
    assert.deepEqual(posted, ["q1", "q2"]);
    assert.equal(t.turns.length, 2);
    assert.equal(t.turns[0].answer, "answer for reply-ts-1");
    assert.equal(t.turns[0].posted, true);
  });

  it("non-DM prefixes each question with the bot mention", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps, posted } = fakes({ isDm: false });
    await runDemo(deps);
    assert.equal(posted[0], "<@BOT> q1");
  });

  it("dry-run posts nothing and records the to-be-posted text", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps, posted } = fakes({ isDm: false, dryRun: true });
    const t = await runDemo(deps);
    assert.equal(posted.length, 0);
    assert.equal(t.turns[0].posted, false);
    assert.equal(t.turns[0].question, "<@BOT> q1");
  });

  it("timeout: awaitTurn null → no-reply sentinel, run continues", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps } = fakes({ awaitTurn: async () => null });
    const t = await runDemo(deps);
    assert.match(t.turns[0].answer ?? "", /no reply within/);
    assert.equal(t.turns.length, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/demo-runner.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/demo/demo-runner'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/gateway/demo/demo-runner.ts`:

```ts
import type { StoredGatewayEvent } from "../events";
import type { DemoTranscript, DemoTurn } from "./acme-ads-script";

export interface MatchTurnCriteria {
  channelId: string;
  actor: string;
  sincePostedAtMs: number;
  /** Non-DM: pin the exact turn by the thread anchored at the posted ts. */
  threadTs?: string;
}

/**
 * The first turn.processed event for this demo turn: same channel + actor,
 * emitted after the question was posted, and (for non-DM) threaded under
 * the posted ts. Pure — operates on an already-read event slice.
 */
export function matchTurnEvent(
  events: StoredGatewayEvent[],
  c: MatchTurnCriteria,
): { replyTs: string } | null {
  for (const e of events) {
    if (e.type !== "turn.processed") continue;
    if (e.channelId !== c.channelId) continue;
    if (e.actor !== c.actor) continue;
    if (Date.parse(e.at) <= c.sincePostedAtMs) continue;
    if (c.threadTs !== undefined && e.threadTs !== c.threadTs) continue;
    if (!e.replyTs) continue;
    return { replyTs: e.replyTs };
  }
  return null;
}

export interface RunDemoDeps {
  script: readonly string[];
  channelId: string;
  isDm: boolean;
  botUserId: string;
  dryRun: boolean;
  timeoutMs: number;
  post: (text: string) => Promise<{ ts: string }>;
  awaitTurn: (postedTs: string, postedAtMs: number, timeoutMs: number) => Promise<{ replyTs: string } | null>;
  readReply: (replyTs: string) => Promise<string>;
  now: () => number;
}

export async function runDemo(deps: RunDemoDeps): Promise<DemoTranscript> {
  const turns: DemoTurn[] = [];
  for (const q of deps.script) {
    const text = deps.isDm ? q : `<@${deps.botUserId}> ${q}`;
    if (deps.dryRun) {
      turns.push({ question: text, posted: false, answer: null, replyTs: null });
      continue;
    }
    const postedAtMs = deps.now();
    const { ts } = await deps.post(text);
    const matched = await deps.awaitTurn(ts, postedAtMs, deps.timeoutMs);
    if (!matched) {
      turns.push({
        question: text,
        posted: true,
        answer: `(no reply within ${Math.round(deps.timeoutMs / 1000)}s)`,
        replyTs: null,
      });
      continue;
    }
    const answer = await deps.readReply(matched.replyTs);
    turns.push({ question: text, posted: true, answer, replyTs: matched.replyTs });
  }
  return { channelId: deps.channelId, dryRun: deps.dryRun, turns };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/demo-runner.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (predicate + script + matchTurnEvent + 4 runDemo cases); tsc 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/demo/demo-runner.ts packages/cli/test/demo-runner.test.ts
git commit -m "feat(demo): runDemo orchestration + matchTurnEvent (P5b)"
```

---

## Task 3: `pmk demo` command (preflight + real I/O) + registration

**Files:**
- Create: `packages/cli/src/commands/demo.ts`
- Modify: `packages/cli/src/index.ts`

> The heavy logic is already tested (Task 1 predicate, Task 2 orchestration + matching). This task wires the real Slack `WebClient`s + events-log polling and does preflight. Its automated coverage is the `renderTranscript` function (Step 1); the full Slack path is verified by a manual `--dry-run` smoke (Step 4) since posting needs a real user token.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/demo-runner.test.ts`:

```ts
describe("renderTranscript", () => {
  it("renders each Q with its answer and the no-reply sentinel", async () => {
    const { renderTranscript } = await import("../src/commands/demo");
    const text = renderTranscript({
      channelId: "C1", dryRun: false,
      turns: [
        { question: "q1", posted: true, answer: "a1", replyTs: "r1" },
        { question: "q2", posted: true, answer: "(no reply within 120s)", replyTs: null },
      ],
    });
    assert.match(text, /q1/);
    assert.match(text, /a1/);
    assert.match(text, /no reply within 120s/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/demo-runner.test.ts`
Expected: FAIL — `renderTranscript` not exported from `../src/commands/demo`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/commands/demo.ts`:

```ts
import chalk from "chalk";
import { WebClient } from "@slack/web-api";
import { seedAcmeAdsAtoms, unseedAcmeAdsAtoms } from "../gateway/acme-ads-seed";
import { gatewayRunningPid } from "../gateway/index";
import { loadGatewayConfig } from "../gateway/config";
import { readGatewayEvents } from "../gateway/events";
import { ACME_ADS_DEMO_SCRIPT, isFinalAnswerText, type DemoTranscript } from "../gateway/demo/acme-ads-script";
import { matchTurnEvent, runDemo } from "../gateway/demo/demo-runner";

function println(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function renderTranscript(t: DemoTranscript): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`\npmk demo transcript — channel ${t.channelId}${t.dryRun ? " (dry-run)" : ""}`));
  t.turns.forEach((turn, i) => {
    lines.push("");
    lines.push(chalk.cyan(`Q${i + 1}: ${turn.question}`));
    lines.push(turn.answer ? `A${i + 1}: ${turn.answer}` : chalk.dim("(dry-run — not posted)"));
  });
  return lines.join("\n");
}

export async function demoCommand(
  sub: string | undefined,
  opts: { channel?: string; dryRun?: boolean; timeout?: string },
): Promise<void> {
  if (sub === "seed") {
    const r = seedAcmeAdsAtoms();
    println(chalk.green(r.alreadyPresent ? "✓ AcmeAds atoms already present" : `✓ seeded ${r.atomIds.length} AcmeAds atoms`));
    return;
  }
  if (sub === "unseed") {
    const r = unseedAcmeAdsAtoms();
    println(chalk.green(`✓ removed ${r.removedIds.length} AcmeAds atoms`));
    return;
  }
  if (sub !== "run") {
    println(chalk.yellow("usage: pmk demo <seed|unseed|run [--channel <id>] [--dry-run] [--timeout <sec>]>"));
    process.exit(1);
  }

  // ---- preflight ----
  if (gatewayRunningPid() === undefined) {
    println(chalk.red("gateway is not running — start it first: pmk gateway start"));
    process.exit(1);
  }
  const channelId = opts.channel ?? process.env.PMK_DEMO_CHANNEL;
  if (!channelId) {
    println(chalk.red("no channel — pass --channel <id> or set PMK_DEMO_CHANNEL"));
    process.exit(1);
  }
  const userToken = process.env.PMK_DEMO_USER_TOKEN;
  if (!userToken || !userToken.startsWith("xoxp-")) {
    println(chalk.red("set PMK_DEMO_USER_TOKEN to a Slack user OAuth token (xoxp-…)"));
    process.exit(1);
  }
  const timeoutMs = Math.max(1, Number.parseInt(opts.timeout ?? "120", 10) || 120) * 1000;

  const userWeb = new WebClient(userToken);
  const userAuth = await userWeb.auth.test().catch(() => null);
  if (!userAuth?.ok || (userAuth as { bot_id?: string }).bot_id) {
    println(chalk.red("PMK_DEMO_USER_TOKEN did not auth as a user (a user token, not a bot token, is required)"));
    process.exit(1);
  }
  const demoUserId = String(userAuth.user_id);

  const cfg = loadGatewayConfig();
  const botWeb = new WebClient(cfg.slack.botToken);
  const botAuth = await botWeb.auth.test().catch(() => null);
  if (!botAuth?.ok) {
    println(chalk.red("gateway bot token failed auth.test — run pmk gateway doctor"));
    process.exit(1);
  }
  const botUserId = String(botAuth.user_id);

  const info = await botWeb.conversations.info({ channel: channelId }).catch(() => null);
  const isDm = (info?.channel as { is_im?: boolean } | undefined)?.is_im === true;
  if (info && !isDm && (info.channel as { is_member?: boolean }).is_member === false) {
    println(chalk.red(`the bot is not a member of ${channelId} — invite it, or use a DM channel`));
    process.exit(1);
  }

  println(chalk.bold(`\npmk demo run`));
  println(chalk.dim(`  channel: ${channelId}${isDm ? " (DM)" : ""}; posting ${ACME_ADS_DEMO_SCRIPT.length} questions as <@${demoUserId}>${opts.dryRun ? " [dry-run]" : ""}`));

  seedAcmeAdsAtoms();

  const transcript = await runDemo({
    script: ACME_ADS_DEMO_SCRIPT,
    channelId, isDm, botUserId,
    dryRun: opts.dryRun === true,
    timeoutMs,
    now: () => Date.now(),
    post: async (text) => {
      const res = await userWeb.chat.postMessage({ channel: channelId, text });
      return { ts: String(res.ts) };
    },
    awaitTurn: async (postedTs, postedAtMs, tMs) => {
      const deadline = Date.now() + tMs;
      while (Date.now() < deadline) {
        const events = readGatewayEvents({ sinceMs: postedAtMs - 1000 });
        const m = matchTurnEvent(events, {
          channelId, actor: demoUserId, sincePostedAtMs: postedAtMs,
          threadTs: isDm ? undefined : postedTs,
        });
        if (m) return m;
        await sleep(2000);
      }
      return null;
    },
    readReply: async (replyTs) => {
      // Phase 2: poll the reply text until it's a real (stabilised) answer.
      const deadline = Date.now() + 12000;
      let last = "";
      let stableSince = 0;
      while (Date.now() < deadline) {
        const res = await botWeb.conversations.history({ channel: channelId, latest: replyTs, inclusive: true, limit: 1 }).catch(() => null);
        const text = String((res?.messages?.[0] as { text?: string } | undefined)?.text ?? "");
        if (isFinalAnswerText(text)) {
          if (text === last) {
            if (stableSince && Date.now() - stableSince >= 3000) return text;
            if (!stableSince) stableSince = Date.now();
          } else {
            last = text; stableSince = Date.now();
          }
        } else {
          last = ""; stableSince = 0;
        }
        await sleep(1500);
      }
      return last || "(answer did not stabilise)";
    },
  });

  println(renderTranscript(transcript));
}
```

In `packages/cli/src/index.ts`, add the import near the other command imports:

```ts
import { demoCommand } from "./commands/demo";
```

And register the command near the other `program.command(...)` blocks:

```ts
program
  .command("demo [subcommand]")
  .description("AcmeAds vertical demo — seed | unseed | run")
  .option("--channel <id>", "Slack channel/DM id for `run`")
  .option("--dry-run", "preview what `run` would post, without posting")
  .option("--timeout <sec>", "per-question reply timeout (default 120)")
  .action(async (subcommand: string | undefined, opts: { channel?: string; dryRun?: boolean; timeout?: string }) => {
    await demoCommand(subcommand, opts);
  });
```

- [ ] **Step 4: Run tests + typecheck + manual dry-run smoke**

Run: `cd packages/cli && node --import tsx --test test/demo-runner.test.ts && npm run typecheck:test && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; both tsc 0.
Manual (no token needed for these): `npx tsx src/index.ts demo seed` then `npx tsx src/index.ts demo unseed` print the seed/unseed lines and exit 0. `npx tsx src/index.ts demo run` (no env) exits 1 with a clear preflight message (gateway / channel / token). Do NOT attempt a real posting run here (needs a real xoxp token + a demo channel).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/demo.ts packages/cli/src/index.ts packages/cli/test/demo-runner.test.ts
git commit -m "feat(cli): pmk demo command — seed/unseed/run with preflight + transcript (P5b)"
```

---

## Task 4: Full-suite green

- [ ] **Step 1: Run the whole CLI suite**

Run: `npm --workspace packages/cli test`
Expected: all pass (prior 474 + the demo-runner tests), `typecheck:test` clean.

- [ ] **Step 2: Typecheck src**

Run: `cd packages/cli && npx tsc -p tsconfig.json --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit any fixups** (only if Steps 1–2 surfaced issues)

```bash
git add -A && git commit -m "test(demo): pmk demo suite green"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** command surface (seed/unseed/run + flags) → Task 3; guided script + `isFinalAnswerText` → Task 1; `runDemo` injectable seam + `matchTurnEvent` (event-driven Phase 1) → Task 2; Phase-2 text stabilisation (poll until `isFinalAnswerText` + stable 3s / 12s cap) → Task 3 `readReply`; preflight (daemon, xoxp user token, channel type/membership, botUserId) → Task 3; non-DM `<@bot>` prefix → Task 2 `runDemo`; one-at-a-time sequencing → `runDemo`'s sequential loop; dry-run → Task 2/3. All covered.
- **Placeholder scan:** every code step is complete; Task 3's automated coverage is `renderTranscript` + the Task 1/2 pure pieces, with the real Slack path verified by `--dry-run`/preflight smoke (explicitly noted, not a hidden gap).
- **Type consistency:** `DemoTurn`/`DemoTranscript` (acme-ads-script) used by `runDemo` (demo-runner) and `renderTranscript` (demo.ts); `RunDemoDeps`/`MatchTurnCriteria` consistent; `isFinalAnswerText`/`matchTurnEvent`/`runDemo`/`seedAcmeAdsAtoms` names match across tasks; `StoredGatewayEvent.turn.processed` fields (`actor`/`channelId`/`threadTs`/`replyTs`/`at`) match the P2a event.

## Out of scope (P5c)

The polished 30-minute walkthrough doc + text/video record; per-message progress capture; offline replay.
