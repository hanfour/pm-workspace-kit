# Atom Telemetry Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-atom usage measurable (reuse / last-retrieved / questioned) via a sidecar rollup, surfaced through a `gateway atoms telemetry` command, without touching the human-editable atom `.md` files or the BM25 mtime index.

**Architecture:** A sidecar `~/.pmk/gateway/atom-telemetry.json` is the authoritative counter store, updated by **synchronous** load-modify-save bump helpers (sync = race-free under the daemon's parallel turns; temp-file + rename = crash-safe). Citation linkage (which atoms a reply cited, and where it landed) rides on an extended `turn.processed` event. Reuse is bumped at LLM success; questioned is bumped from a 👎 reaction on a cited reply and from an escalation that fired in a turn which had injected atoms — both deduped.

**Tech Stack:** TypeScript (Node ESM), `node:test`, `node:fs`. Spec: `docs/superpowers/specs/2026-05-29-atom-telemetry-design.md`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/cli/src/gateway/atom-telemetry.ts` (new) | Sidecar load/save + `bumpReuse` / `bumpQuestioned` (sync, deduped, failure-isolated) + `loadTelemetry` for the read surface |
| `packages/cli/src/gateway/events.ts` (modify) | Add 4 optional fields to `TurnProcessedEvent` |
| `packages/cli/src/gateway/slack/free-chat-turn.ts` (modify) | Reuse bump + populate extended event at success site; escalate-in-place questioned bump |
| `packages/cli/src/gateway/slack/index.ts` (modify) | `handleReactionAdded` citation-feedback branch (👎 on a cited reply) |
| `packages/cli/src/commands/gateway.ts` (modify) | `atoms telemetry [--json]` subcommand |
| `packages/cli/test/gateway-atom-telemetry.test.ts` (new) | Module unit tests + command tests |

**Design note — escalate questioned is IN-PLACE, not cross-event.** The spec originally proposed a lookback at the `escalate.triggered` emit site. While planning we found `free-chat-turn.ts` emits `turn.processed` (line ~283) *after* it calls `escalation.escalate` (line ~267), so at escalate time the current turn's atoms are not yet on disk — a lookback would miss them and grab a prior turn. Instead we bump questioned in-place in the runner where `retrieved` (the cited atoms) and the reply ts are both in hand. This covers the dominant "cite + escalate in one turn" case correctly; user pushback in a later turn is covered by the 👎 path. The spec has been updated to match.

---

## Task 1: Telemetry sidecar module

**Files:**
- Create: `packages/cli/src/gateway/atom-telemetry.ts`
- Test: `packages/cli/test/gateway-atom-telemetry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/gateway-atom-telemetry.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

describe("atom-telemetry sidecar", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-atom-tel-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("missing sidecar reads as empty", async () => {
    const { loadTelemetry } = await import("../src/gateway/atom-telemetry");
    const store = loadTelemetry();
    assert.deepEqual(store, { version: 1, atoms: {}, questionedKeys: [] });
  });

  it("bumpReuse increments count and sets lastRetrievedAt", async () => {
    const { bumpReuse, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpReuse(["a1", "a2"], "2026-05-29T00:00:00.000Z");
    bumpReuse(["a1"], "2026-05-29T01:00:00.000Z");
    const s = loadTelemetry();
    assert.equal(s.atoms.a1.reuseCount, 2);
    assert.equal(s.atoms.a1.lastRetrievedAt, "2026-05-29T01:00:00.000Z");
    assert.equal(s.atoms.a2.reuseCount, 1);
  });

  it("bumpReuse with no ids is a no-op", async () => {
    const { bumpReuse, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpReuse([], "2026-05-29T00:00:00.000Z");
    assert.deepEqual(loadTelemetry().atoms, {});
  });

  it("bumpQuestioned increments and dedupes by key", async () => {
    const { bumpQuestioned, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpQuestioned(["a1"], "reaction:C:T:U:-1", "2026-05-29T00:00:00.000Z");
    bumpQuestioned(["a1"], "reaction:C:T:U:-1", "2026-05-29T02:00:00.000Z"); // dup → ignored
    const s = loadTelemetry();
    assert.equal(s.atoms.a1.questionedCount, 1);
    assert.equal(s.atoms.a1.lastQuestionedAt, "2026-05-29T00:00:00.000Z");
    assert.equal(s.questionedKeys.length, 1);
  });

  it("bumpQuestioned with a new key bumps again", async () => {
    const { bumpQuestioned, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpQuestioned(["a1"], "reaction:C:T:U:-1", "2026-05-29T00:00:00.000Z");
    bumpQuestioned(["a1"], "escalate:C:T:R", "2026-05-29T03:00:00.000Z");
    assert.equal(loadTelemetry().atoms.a1.questionedCount, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-atom-telemetry.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/atom-telemetry'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/gateway/atom-telemetry.ts`:

```ts
/**
 * Atom usage telemetry (P2a). Sidecar rollup at
 * `~/.pmk/gateway/atom-telemetry.json` — the authoritative per-atom
 * counter store. Bumps are SYNCHRONOUS on purpose: single-threaded
 * Node runs a sync load-modify-save to completion before any other
 * callback, so concurrent turns can't interleave and lose a count
 * (the same reason the v0.13 channel-log went append-only, solved here
 * by never awaiting mid-write). Writes go through temp-file + rename so
 * a crash can't leave a half-written sidecar. All bumps are
 * failure-isolated: telemetry must never break a turn or a reaction.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "./config";

export interface AtomTelemetryEntry {
  reuseCount: number;
  lastRetrievedAt: string | null;
  questionedCount: number;
  lastQuestionedAt: string | null;
}

export interface AtomTelemetryStore {
  version: 1;
  atoms: Record<string, AtomTelemetryEntry>;
  questionedKeys: string[];
}

function telemetryPath(): string {
  return path.join(gatewayDir(), "atom-telemetry.json");
}

function emptyEntry(): AtomTelemetryEntry {
  return {
    reuseCount: 0,
    lastRetrievedAt: null,
    questionedCount: 0,
    lastQuestionedAt: null,
  };
}

export function loadTelemetry(): AtomTelemetryStore {
  try {
    const raw = fs.readFileSync(telemetryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AtomTelemetryStore>;
    return {
      version: 1,
      atoms: parsed.atoms ?? {},
      questionedKeys: parsed.questionedKeys ?? [],
    };
  } catch {
    return { version: 1, atoms: {}, questionedKeys: [] };
  }
}

function saveTelemetry(store: AtomTelemetryStore): void {
  const dir = gatewayDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = telemetryPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function bumpReuse(
  atomIds: string[],
  at: string = new Date().toISOString(),
): void {
  if (atomIds.length === 0) return;
  try {
    const store = loadTelemetry();
    const atoms = { ...store.atoms };
    for (const id of atomIds) {
      const e = atoms[id] ?? emptyEntry();
      atoms[id] = { ...e, reuseCount: e.reuseCount + 1, lastRetrievedAt: at };
    }
    saveTelemetry({ ...store, atoms });
  } catch {
    /* telemetry must never break a turn */
  }
}

export function bumpQuestioned(
  atomIds: string[],
  dedupeKey: string,
  at: string = new Date().toISOString(),
): void {
  if (atomIds.length === 0) return;
  try {
    const store = loadTelemetry();
    if (store.questionedKeys.includes(dedupeKey)) return;
    const atoms = { ...store.atoms };
    for (const id of atomIds) {
      const e = atoms[id] ?? emptyEntry();
      atoms[id] = {
        ...e,
        questionedCount: e.questionedCount + 1,
        lastQuestionedAt: at,
      };
    }
    saveTelemetry({
      ...store,
      atoms,
      questionedKeys: [...store.questionedKeys, dedupeKey],
    });
  } catch {
    /* never break a reaction / escalation */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-atom-telemetry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/atom-telemetry.ts packages/cli/test/gateway-atom-telemetry.test.ts
git commit -m "feat(gateway): atom telemetry sidecar (reuse/questioned counters)"
```

---

## Task 2: Extend `TurnProcessedEvent` with citation linkage

**Files:**
- Modify: `packages/cli/src/gateway/events.ts:51-64`
- Test: `packages/cli/test/gateway-events.test.ts` (append a case)

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("gateway events log (#24)", ...)` block in `packages/cli/test/gateway-events.test.ts`:

```ts
it("turn.processed round-trips the optional citation fields", async () => {
  const { appendGatewayEvent, readGatewayEvents } =
    await import("../src/gateway/events");
  appendGatewayEvent({
    type: "turn.processed",
    actor: "U_X",
    audience: "tech",
    hadMraAsk: false,
    atomsInjected: 2,
    atomIds: ["a1", "a2"],
    channelId: "D1",
    threadTs: "171.1",
    replyTs: "172.2",
  });
  const e = readGatewayEvents().at(-1)!;
  assert.equal(e.type, "turn.processed");
  if (e.type === "turn.processed") {
    assert.deepEqual(e.atomIds, ["a1", "a2"]);
    assert.equal(e.replyTs, "172.2");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-events.test.ts`
Expected: FAIL — `typecheck:test` or the test errors because `atomIds` / `replyTs` are not on `TurnProcessedEvent`.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/gateway/events.ts`, replace the `TurnProcessedEvent` interface body (after `atomsInjected: number;`, before the closing brace at line ~64) by adding:

```ts
  /** Number of approved knowledge atoms injected via retrieval. */
  atomsInjected: number;
  /** IDs of the atoms injected this turn (citation linkage for telemetry). */
  atomIds?: string[];
  /** Slack channel/DM the turn ran in. */
  channelId?: string;
  /** Thread anchor, if the turn ran in a thread. */
  threadTs?: string;
  /** Slack ts of the bot reply this turn produced. */
  replyTs?: string;
```

(`VALID_TYPES` is unchanged — still `turn.processed`. Optional fields keep legacy events valid.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-events.test.ts`
Expected: PASS (all existing + the new case).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/events.ts packages/cli/test/gateway-events.test.ts
git commit -m "feat(gateway): carry atom citation linkage on turn.processed"
```

---

## Task 3: Wire `free-chat-turn` — reuse bump + event fields + escalate-in-place questioned

**Files:**
- Modify: `packages/cli/src/gateway/slack/free-chat-turn.ts` (escalate block ~266-273; event emit ~283-289)
- Test: `packages/cli/test/gateway-atom-telemetry.test.ts` (add a focused wiring assertion)

> The runner needs a real LLM + Slack fakes to drive end-to-end, which is heavy. We test the *telemetry effect* with a small assertion that the runner, given a fake that returns a known set of retrieved atoms and an escalate directive, bumps reuse for the injected atoms and questioned when it escalates. Use the existing fakes in `test/harness/slack-fakes.ts`. If wiring a full runner turn proves too costly in this harness, fall back to asserting the two call sites via the telemetry sidecar state after invoking `FreeChatTurnRunner.run` with a stub `llm.chat` returning a fixed string (and a `[[escalate]]`-bearing string for the questioned case). Keep the assertion at the sidecar level (`loadTelemetry()`), not on internal calls.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/gateway-atom-telemetry.test.ts` a `describe("free-chat-turn telemetry wiring", ...)` that constructs a `FreeChatTurnRunner` with fakes such that `searchAtoms` returns atoms `["seed-1"]` (seed one approved atom into the tmp-HOME knowledge dir so retrieval finds it) and `llm.chat` returns a plain answer. After `run(...)`, assert `loadTelemetry().atoms["<seed-1 id>"].reuseCount === 1`. Add a second case where `llm.chat` returns a string containing an `[[escalate ...]]` directive and assert `questionedCount === 1` with a `escalate:`-prefixed key present in `questionedKeys`.

(Model the runner construction + fakes on `test/slack-adapter.test.ts` and `test/harness/slack-fakes.ts`. Seed the atom via `saveAtom` from `../src/gateway/knowledge` with `status: "approved"` so `searchAtoms` returns it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-atom-telemetry.test.ts`
Expected: FAIL — `reuseCount` is `undefined` (atom entry absent) because the runner doesn't bump yet.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/gateway/slack/free-chat-turn.ts`:

1. Add import at the top with the other gateway imports:

```ts
import { bumpReuse, bumpQuestioned } from "../atom-telemetry";
```

2. Replace the escalate block (currently ~266-273):

```ts
    const escReq = parseEscalate(full);
    if (escReq) {
      await this.opts.escalation.escalate({
        channelId,
        threadTs,
        askerUserId: userId,
        request: escReq,
      });
      // Escalate-after-citation: the model still needed a human despite
      // the atoms we injected → mark those atoms questioned. Done
      // in-place (atomIds + replyTs in hand) to avoid the event-ordering
      // gap where turn.processed isn't on disk yet at escalate time.
      if (retrieved.length > 0) {
        bumpQuestioned(
          retrieved.map((a) => a.id),
          `escalate:${channelId}:${threadTs}:${String(placeholder.ts)}`,
        );
      }
    }
```

3. Replace the `turn.processed` emit (currently ~283-289):

```ts
    const atomIds = retrieved.map((a) => a.id);
    // Reuse bump at success (here, not right after searchAtoms) so a
    // failed LLM call never counts an atom as reused.
    bumpReuse(atomIds);
    appendGatewayEvent({
      type: "turn.processed",
      actor: userId,
      audience,
      hadMraAsk: askReq !== undefined,
      atomsInjected: retrieved.length,
      atomIds,
      channelId,
      threadTs,
      replyTs: String(placeholder.ts),
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-atom-telemetry.test.ts`
Expected: PASS (module + wiring cases).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/free-chat-turn.ts packages/cli/test/gateway-atom-telemetry.test.ts
git commit -m "feat(gateway): bump atom reuse + escalate-questioned in free-chat turn"
```

---

## Task 4: `handleReactionAdded` citation-feedback branch (👎 on a cited reply)

**Files:**
- Modify: `packages/cli/src/gateway/slack/index.ts:595-599` (the `!found` early-return)
- Test: `packages/cli/test/slack-adapter.test.ts` (extend the reaction tests)

- [ ] **Step 1: Write the failing test**

In `packages/cli/test/slack-adapter.test.ts`, add a case in the reaction-handling describe block: append a `turn.processed` event (via `appendGatewayEvent`) with `replyTs: "999.1"`, `channelId: "D1"`, `atomIds: ["a1"]`; deliver a `reaction_added` payload with `reaction: "-1"`, `item: { channel: "D1", ts: "999.1" }`, `item_user: <botUserId>`, `user: "U_any"`. Assert `loadTelemetry().atoms.a1.questionedCount === 1`. Add a second delivery of the same payload and assert it stays `1` (dedupe). Use tmp-HOME isolation as in the events test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/slack-adapter.test.ts`
Expected: FAIL — `questionedCount` is `undefined` (handler returns at the `!found` branch without bumping).

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/gateway/slack/index.ts`:

1. Add imports near the other gateway imports:

```ts
import { bumpQuestioned } from "../atom-telemetry";
import { readGatewayEvents } from "../events";
```

2. Replace the `!found` early-return (lines ~595-599):

```ts
    const found = findAtomByApprovalMessage(channelId, messageTs);
    if (!found) {
      // Not an approval anchor. If this is a 👎 on a cited bot reply,
      // mark the cited atoms questioned. `x` stays reserved for
      // approval-reject; only -1/thumbsdown means "citation questioned".
      if (reaction === "-1" || reaction === "thumbsdown") {
        const turn = readGatewayEvents()
          .filter(
            (e) =>
              e.type === "turn.processed" &&
              e.channelId === channelId &&
              e.replyTs === messageTs &&
              Array.isArray(e.atomIds) &&
              e.atomIds.length > 0,
          )
          .at(-1);
        if (turn && turn.type === "turn.processed" && turn.atomIds) {
          bumpQuestioned(
            turn.atomIds,
            `reaction:${channelId}:${messageTs}:${reactorUserId}:${reaction}`,
          );
        }
      }
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/slack-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/index.ts packages/cli/test/slack-adapter.test.ts
git commit -m "feat(gateway): 👎 on a cited reply marks atoms questioned"
```

---

## Task 5: `pmk gateway atoms telemetry [--json]` read surface

**Files:**
- Modify: `packages/cli/src/commands/gateway.ts` (`atomsCmd` switch ~840; `atomsUsage`)
- Test: `packages/cli/test/gateway-atom-telemetry.test.ts` (command render cases)

- [ ] **Step 1: Write the failing test**

Add a `describe("atoms telemetry command", ...)` to `packages/cli/test/gateway-atom-telemetry.test.ts`. Export a pure builder from `gateway.ts` for testability — `buildAtomTelemetryReport(atoms, store)` returning the sorted rows + flags — and test IT directly (avoids capturing CLI stdout):

```ts
it("buildAtomTelemetryReport sorts weakest-first and flags dead-weight", async () => {
  const { buildAtomTelemetryReport } = await import("../src/commands/gateway");
  const atoms = [
    { id: "hot", question: "q1", scope: "s", createdAt: 0, answer: "", tags: [], source: { threadKey: "", contributorUserId: "" } },
    { id: "cold", question: "q2", scope: "s", createdAt: 0, answer: "", tags: [], source: { threadKey: "", contributorUserId: "" } },
  ];
  const store = {
    version: 1 as const,
    atoms: {
      hot: { reuseCount: 9, lastRetrievedAt: "2026-05-29T00:00:00.000Z", questionedCount: 0, lastQuestionedAt: null },
    },
    questionedKeys: [],
  };
  const rows = buildAtomTelemetryReport(atoms, store);
  assert.equal(rows[0].id, "cold");        // reuseCount 0 sorts first
  assert.equal(rows[0].deadWeight, true);
  assert.equal(rows[1].id, "hot");
  assert.equal(rows[1].loadBearing, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-atom-telemetry.test.ts`
Expected: FAIL — `buildAtomTelemetryReport` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/commands/gateway.ts`:

1. Add imports:

```ts
import { loadTelemetry, type AtomTelemetryStore } from "../gateway/atom-telemetry";
import type { KnowledgeAtom } from "../gateway/knowledge";
```

2. Add the exported pure builder near `atomsCmd`:

```ts
export interface AtomTelemetryRow {
  id: string;
  question: string;
  scope: string;
  reuseCount: number;
  lastRetrievedAt: string | null;
  questionedCount: number;
  lastQuestionedAt: string | null;
  deadWeight: boolean;
  loadBearing: boolean;
}

const LOAD_BEARING_MIN_REUSE = 5;

export function buildAtomTelemetryReport(
  atoms: KnowledgeAtom[],
  store: AtomTelemetryStore,
): AtomTelemetryRow[] {
  const rows = atoms.map((a) => {
    const t = store.atoms[a.id];
    const reuseCount = t?.reuseCount ?? 0;
    const questionedCount = t?.questionedCount ?? 0;
    return {
      id: a.id,
      question: a.question,
      scope: a.scope,
      reuseCount,
      lastRetrievedAt: t?.lastRetrievedAt ?? null,
      questionedCount,
      lastQuestionedAt: t?.lastQuestionedAt ?? null,
      deadWeight: reuseCount === 0,
      loadBearing: reuseCount >= LOAD_BEARING_MIN_REUSE && questionedCount === 0,
    };
  });
  // Weakest first: lowest reuse, then oldest lastRetrievedAt.
  return rows.sort(
    (x, y) =>
      x.reuseCount - y.reuseCount ||
      (x.lastRetrievedAt ?? "").localeCompare(y.lastRetrievedAt ?? ""),
  );
}
```

3. Add the `telemetry` case in the `atomsCmd` switch (after `case "list"` block):

```ts
    case "telemetry": {
      const json = args.includes("--json");
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const atoms = loadAtoms({ scope }).filter(
        (a) => a.status === "approved" || a.status === undefined,
      );
      const rows = buildAtomTelemetryReport(atoms, loadTelemetry());
      if (json) {
        println(JSON.stringify(rows, null, 2));
        return;
      }
      println(chalk.bold("\npmk gateway atoms telemetry"));
      if (rows.length === 0) {
        println(chalk.dim("  (no approved atoms)"));
        return;
      }
      println(chalk.dim("  reuse  questioned  id-prefix             question"));
      for (const r of rows) {
        const flag = r.deadWeight
          ? chalk.yellow(" dead")
          : r.loadBearing
            ? chalk.green(" load")
            : "     ";
        println(
          `  ${String(r.reuseCount).padStart(5)}  ${String(r.questionedCount).padStart(10)} ${flag} ${r.id.slice(0, 20).padEnd(20)} ${r.question.slice(0, 50)}`,
        );
      }
      return;
    }
```

4. Add `telemetry` to `atomsUsage()` output (find the usage string and append `| telemetry [--json]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-atom-telemetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual smoke + Commit**

```bash
cd packages/cli && npx tsx src/index.ts gateway atoms telemetry
# Expect: header + rows (or "(no approved atoms)"); exits 0.
git add packages/cli/src/commands/gateway.ts packages/cli/test/gateway-atom-telemetry.test.ts
git commit -m "feat(gateway): add atoms telemetry read surface"
```

---

## Task 6: Full-suite green + spec sync

- [ ] **Step 1: Run the whole CLI suite**

Run: `npm --workspace packages/cli test`
Expected: all pass (446 prior + new telemetry/events/reaction cases), `typecheck:test` clean.

- [ ] **Step 2: Typecheck src**

Run: `cd packages/cli && npx tsc -p tsconfig.json --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit any fixups** (only if Steps 1–2 surfaced issues)

```bash
git add -A && git commit -m "test(gateway): atom telemetry suite green"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** sidecar schema → Task 1; turn.processed linkage → Task 2; reuse bump at success → Task 3; escalate-questioned → Task 3 (in-place, spec updated); 👎-questioned + dedupe → Task 4; `atoms telemetry` surface + dead-weight/load-bearing → Task 5; back-compat/atomicity → Task 1 (sync + temp-rename + try/catch) and Task 2 (optional fields). All covered.
- **Placeholder scan:** every code step has complete code; Task 3's test references the existing `slack-fakes.ts` harness with an explicit fallback strategy (no "TBD").
- **Type consistency:** `bumpReuse(atomIds, at?)`, `bumpQuestioned(atomIds, dedupeKey, at?)`, `loadTelemetry()`, `AtomTelemetryStore`, `buildAtomTelemetryReport(atoms, store)` used consistently across Tasks 1/3/4/5.

## Out of scope (P2b / future)

Approver rubric ADR, quarterly audit playbook, `questionedKeys` pruning, telemetry-as-ranking-input, a summary line inside `gateway audit`.
