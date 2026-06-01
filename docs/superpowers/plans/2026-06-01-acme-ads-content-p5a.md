# AcmeAds Demo Content Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author the AcmeAds demo content foundation — a 5-atom seed module (tagged, idempotent, saveAtom-backed) plus two new example PRDs — that the future `pmk demo` driver (P5b) and walkthrough (P5c) will consume.

**Architecture:** `packages/cli/src/gateway/acme-ads-seed.ts` mirrors the existing `demo-seed.ts` (one directory up from a would-be `demo/` folder): five `KnowledgeAtom`s authored as data, written via the existing `saveAtom()` (which owns the on-disk markdown format), tagged `acme-ads-demo`, scope `acme-ads`, status `approved`; `seedAcmeAdsAtoms()`/`unseedAcmeAdsAtoms()` are idempotent and tag-targeted. Two PRDs are markdown under `examples/acme-ads/docs/prds/` extending the existing CRM-migration narrative; the example's README gets the two PRDs listed and its stale `--cwd` note fixed.

**Tech Stack:** TypeScript (Node ESM), `node:test`, `node:fs`. Spec: `docs/superpowers/specs/2026-06-01-acme-ads-content-p5a-design.md`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/cli/src/gateway/acme-ads-seed.ts` (new) | 5 AcmeAds atoms (data) + `seedAcmeAdsAtoms` / `unseedAcmeAdsAtoms` / `findAcmeAdsAtoms` + `ACME_ADS_SEED_TAG` |
| `packages/cli/test/acme-ads-seed.test.ts` (new) | seed / unseed / idempotency / isolation tests |
| `examples/acme-ads/docs/prds/2026-Q2-placement-dashboard-prd.md` (new) | PRD-2026-0002 |
| `examples/acme-ads/docs/prds/2026-Q2-onboarding-dedup-prd.md` (new) | PRD-2026-0003 |
| `examples/acme-ads/README.md` (modify) | list the 2 new PRDs; note atoms live in the CLI seed module; fix the stale `--cwd` line |

---

## Task 1: AcmeAds seed module

**Files:**
- Create: `packages/cli/src/gateway/acme-ads-seed.ts`
- Test: `packages/cli/test/acme-ads-seed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/acme-ads-seed.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

describe("acme-ads-seed", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-acme-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("seeds exactly 5 approved atoms tagged acme-ads-demo, scope acme-ads", async () => {
    const { seedAcmeAdsAtoms, ACME_ADS_SEED_TAG } = await import("../src/gateway/acme-ads-seed");
    const { loadAtoms } = await import("../src/gateway/knowledge");
    const res = seedAcmeAdsAtoms();
    assert.equal(res.atomIds.length, 5);
    assert.equal(res.alreadyPresent, false);
    const atoms = loadAtoms({ scope: "acme-ads", promote: false });
    assert.equal(atoms.length, 5);
    for (const a of atoms) {
      assert.equal(a.status, "approved");
      assert.equal(a.scope, "acme-ads");
      assert.ok(a.tags.includes(ACME_ADS_SEED_TAG));
    }
  });

  it("re-seeding is idempotent (still 5, alreadyPresent true)", async () => {
    const { seedAcmeAdsAtoms } = await import("../src/gateway/acme-ads-seed");
    const { loadAtoms } = await import("../src/gateway/knowledge");
    seedAcmeAdsAtoms();
    const second = seedAcmeAdsAtoms();
    assert.equal(second.alreadyPresent, true);
    assert.equal(loadAtoms({ scope: "acme-ads", promote: false }).length, 5);
  });

  it("unseed removes only acme-ads-demo atoms, leaves others", async () => {
    const { seedAcmeAdsAtoms, unseedAcmeAdsAtoms } = await import("../src/gateway/acme-ads-seed");
    const { saveAtom, loadAtoms } = await import("../src/gateway/knowledge");
    // an unrelated atom that must survive
    saveAtom({
      id: "keep-me-1", createdAt: 1, scope: "general", question: "q", answer: "a",
      tags: ["something-else"], source: { threadKey: "t", contributorUserId: "U" }, status: "approved",
    });
    seedAcmeAdsAtoms();
    const removed = unseedAcmeAdsAtoms();
    assert.equal(removed.removedIds.length, 5);
    const left = loadAtoms({ promote: false });
    assert.equal(left.length, 1);
    assert.equal(left[0].id, "keep-me-1");
  });

  it("each atom has a non-empty question/answer/summary", async () => {
    const { seedAcmeAdsAtoms } = await import("../src/gateway/acme-ads-seed");
    const { loadAtoms } = await import("../src/gateway/knowledge");
    seedAcmeAdsAtoms();
    for (const a of loadAtoms({ scope: "acme-ads", promote: false })) {
      assert.ok(a.question.length > 0);
      assert.ok(a.answer.length > 0);
      assert.ok((a.summary ?? "").length > 0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/acme-ads-seed.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/acme-ads-seed'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/gateway/acme-ads-seed.ts`:

```ts
// AcmeAds vertical demo seed (P5a). Writes five AcmeAds-themed
// KnowledgeAtoms so the future `pmk demo` (P5b) + walkthrough (P5c) have
// a coherent, retrievable knowledge set. Mirrors demo-seed.ts: data-
// driven atoms written via saveAtom (format-safe), all tagged with
// ACME_ADS_SEED_TAG so unseed cleans exactly this bundle and never a
// real atom. Distinct from M4's generic "demo-seed" smoke atom.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  type KnowledgeAtom,
  knowledgeRoot,
  loadAtoms,
  safeScope,
  saveAtom,
} from "./knowledge";

export const ACME_ADS_SEED_TAG = "acme-ads-demo";
const ACME_ADS_SCOPE = "acme-ads";

interface AtomSeed {
  /** Stable id suffix → deterministic atom id (idempotency-friendly). */
  key: string;
  question: string;
  answer: string;
  summary: string;
  extraTags: string[];
}

const ATOM_SEEDS: readonly AtomSeed[] = [
  {
    key: "adformat-vs-placement",
    question: "AcmeAds 的 AdFormat 跟 placement 有什麼差別？",
    answer: [
      "AdFormat（廣告版型）指的是廣告的呈現規格——例如橫幅、原生、影音、插頁；它決定素材尺寸、可用的互動元件與計價單位。",
      "placement（版位）則是這個版型實際被放到哪個位置——某個 App 的首頁頂部、文章列表第 3 則、影片前貼。",
      "",
      "一句話：AdFormat 是「長什麼樣」，placement 是「放在哪」。同一個 AdFormat 可以投到很多不同 placement；同一個 placement 也可能支援多種 AdFormat。報表通常以 placement 為最小計量單位，AdFormat 用來分群分析。",
    ].join("\n"),
    summary:
      "AdFormat=廣告版型（規格／計價單位），placement=版位（放在哪）；一對多，報表以 placement 為最小單位。",
    extraTags: ["adformat", "placement", "biz"],
  },
  {
    key: "placement-vcpm",
    question: "某個 placement 的 vCPM 怎麼算？資料在哪看？",
    answer: [
      "vCPM（viewable CPM，可視千次曝光成本）= 該 placement 的營收 ÷ 可視曝光數 × 1000。",
      "",
      "- 分子：placement 在統計區間內的 PlacementRevenue。",
      "- 分母：可視曝光數（viewable impressions，要扣掉未進入可視區、提早關閉的，不是總曝光）。",
      "",
      "資料來源：報表系統的 placement 日彙總表 `placement_daily`，欄位 `revenue` 與 `viewable_impressions`。注意 vCPM 與 CPM 不同——CPM 用總曝光、vCPM 用可視曝光，廣告主結算多半看 vCPM。",
    ].join("\n"),
    summary:
      "vCPM = PlacementRevenue ÷ 可視曝光 × 1000；資料在 placement_daily 的 revenue／viewable_impressions；與 CPM（用總曝光）不同。",
    extraTags: ["vcpm", "placement", "metrics"],
  },
  {
    key: "onboarding-customer-migration",
    question: "self-service onboarding 上線後，舊客戶的資料怎麼遷？",
    answer: [
      "現有客戶不會被自動丟進 self-service 流程。依 onboarding PRD（PRD-2026-0001）與 crm-customer-migration module 的設計，遷移是分批、可回滾的：",
      "",
      "1. 既有客戶資料維持在舊 CRM 表，self-service 只接新註冊；",
      "2. 背景 job 依 batch 把舊客戶 profile 對映到新 schema（Strangler Fig，見 ADR-0004 的 go-monolith 脈絡）；",
      "3. 每批遷移後跑對帳，異常的留在舊表、不阻擋新流程。",
      "",
      "所以「上線」對舊客戶是無感的——他們不會突然被要求重新 onboard。",
    ].join("\n"),
    summary:
      "舊客戶不自動進 self-service；依 PRD-2026-0001 + crm-customer-migration module 分批可回滾遷移（Strangler Fig），對帳異常留舊表、不阻擋新流程。",
    extraTags: ["onboarding", "migration", "crm"],
  },
  {
    key: "placementrevenue-vs-accountpayable",
    question: "PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？",
    answer: [
      "兩個是不同方向的錢：",
      "",
      "- PlacementRevenue：AcmeAds 從廣告主那邊「收進來」的版位營收（收入端）。",
      "- AccountPayable：AcmeAds 要「付出去」的——主要是付給 media／publisher 的分潤與供應商應付帳款（支出端）。",
      "",
      "損益表（P&L）上，PlacementRevenue 計入營收（top line）；publisher 分潤是成本，其未付部分落在資產負債表的 AccountPayable。看「賺多少」用 PlacementRevenue，看「欠多少待付」用 AccountPayable，兩者不能互相替代。",
    ].join("\n"),
    summary:
      "PlacementRevenue=收入端（廣告主版位營收，P&L top line）；AccountPayable=支出端應付（付 publisher 分潤等，落資產負債表）。方向相反、不可互換。",
    extraTags: ["placementrevenue", "accountpayable", "finance", "biz"],
  },
  {
    key: "onboarding-dedup-module",
    question: "customer onboarding 的客戶去重（dedup）規則寫在哪個 module？",
    answer: [
      "去重邏輯在 `crm.customer` module——具體在 customer-migration 的 playbook（`docs/architecture/modules/crm-customer-migration.md`）描述的 dedup 規則：以 normalized email + 公司統編為主鍵比對，命中視為同一客戶、合併 profile，衝突欄位以最近一次 self-service 提交為準。",
      "",
      "如果你要的是實作層的確切函式／檔案位置，這條 PKB 只到 module 邊界；再深一層要問 IT（gateway 會自動 mra-ask 對應 repo，必要時 escalate 給負責 crm.customer 的工程師）。",
    ].join("\n"),
    summary:
      "dedup 規則在 crm.customer module（crm-customer-migration playbook）：normalized email + 統編為主鍵，命中合併、衝突取最近 self-service 提交；更深的實作位置需 mra-ask／escalate。",
    extraTags: ["dedup", "onboarding", "crm", "code"],
  },
];

export interface AcmeAdsSeedResult {
  atomIds: string[];
  /** True iff the atoms already existed (idempotent no-op). */
  alreadyPresent: boolean;
}

export interface AcmeAdsUnseedResult {
  removedIds: string[];
}

function atomFromSeed(seed: AtomSeed): KnowledgeAtom {
  return {
    id: `acme-ads-${seed.key}`,
    createdAt: Date.now(),
    scope: ACME_ADS_SCOPE,
    question: seed.question,
    answer: seed.answer,
    summary: seed.summary,
    tags: [ACME_ADS_SEED_TAG, ...seed.extraTags],
    source: { threadKey: "acme-ads:demo", contributorUserId: "ACME_ADS_DEMO" },
    status: "approved",
  };
}

/** Atoms currently tagged acme-ads-demo (exposed for tests + audit). */
export function findAcmeAdsAtoms(): KnowledgeAtom[] {
  return loadAtoms({ promote: false }).filter((a) =>
    a.tags.includes(ACME_ADS_SEED_TAG),
  );
}

function atomFilePath(atom: KnowledgeAtom): string {
  return path.join(knowledgeRoot(), safeScope(atom.scope), `${atom.id}.md`);
}

/**
 * Ensure the five AcmeAds demo atoms exist. Idempotent: if any are
 * already present, writes nothing and returns alreadyPresent=true.
 */
export function seedAcmeAdsAtoms(): AcmeAdsSeedResult {
  const existing = findAcmeAdsAtoms();
  if (existing.length > 0) {
    return { atomIds: existing.map((a) => a.id), alreadyPresent: true };
  }
  const ids: string[] = [];
  for (const seed of ATOM_SEEDS) {
    const atom = atomFromSeed(seed);
    saveAtom(atom);
    ids.push(atom.id);
  }
  return { atomIds: ids, alreadyPresent: false };
}

/** Remove exactly the acme-ads-demo atoms; never touches other atoms. */
export function unseedAcmeAdsAtoms(): AcmeAdsUnseedResult {
  const removedIds: string[] = [];
  for (const atom of findAcmeAdsAtoms()) {
    try {
      fs.unlinkSync(atomFilePath(atom));
      removedIds.push(atom.id);
    } catch {
      // best-effort: file may have vanished between load and unlink
    }
  }
  return { removedIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/acme-ads-seed.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (4 tests); tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/acme-ads-seed.ts packages/cli/test/acme-ads-seed.test.ts
git commit -m "feat(gateway): AcmeAds demo seed — 5 themed atoms (P5a)"
```

---

## Task 2: Two example PRDs + README

**Files:**
- Create: `examples/acme-ads/docs/prds/2026-Q2-placement-dashboard-prd.md`
- Create: `examples/acme-ads/docs/prds/2026-Q2-onboarding-dedup-prd.md`
- Modify: `examples/acme-ads/README.md`

> No TDD here — these are docs. The "test" is the traceability check over the example (Step 4). The new PRDs reference virtual REQ ids the same way the existing PRD-2026-0001 references `REQ-2026-0042` (not a file in the example) — the check tolerates virtual references, so this passes.

- [ ] **Step 1: Create PRD-2026-0002**

Create `examples/acme-ads/docs/prds/2026-Q2-placement-dashboard-prd.md`:

```markdown
---
doc_id: PRD-2026-0002
title: Ad placement performance dashboard (AcmeAds example)
owner: "@jane-pm"
status: Draft
date: 2026-05-20
related:
  requirement: [REQ-2026-0051]
  plan: []
  spec: []
  architecture: []
  adr: [ADR-0004]
  module: [crm.customer]
  confluence_page_id: null
---

# Ad placement performance dashboard

## Problem

Account managers answer "how is my placement performing?" by hand-pulling the
`placement_daily` table and computing vCPM in a spreadsheet — slow, and easy to
get wrong (people divide revenue by *total* impressions instead of *viewable*).

## Goals

- One dashboard showing each placement's `PlacementRevenue`, viewable impressions,
  and vCPM, groupable by AdFormat.
- Number definitions match the PKB exactly — vCPM uses **viewable** impressions,
  not total.

## Non-goals

- No advertiser self-service login (that's the self-service onboarding scope —
  see [PRD-2026-0001](./2026-Q2-customer-onboarding-prd.md)).
- No historical recompute; read existing `placement_daily` rollups only.

## Success metrics

- Time for an AM to answer "what's this placement's vCPM" drops from minutes to
  seconds.
- Zero vCPM definition mismatches reported between the dashboard and finance.

## Open questions

- Which AdFormat groupings does sales actually use day-to-day?
```

- [ ] **Step 2: Create PRD-2026-0003**

Create `examples/acme-ads/docs/prds/2026-Q2-onboarding-dedup-prd.md`:

```markdown
---
doc_id: PRD-2026-0003
title: Customer data dedup for onboarding (AcmeAds example)
owner: "@jane-pm"
status: Draft
date: 2026-05-22
related:
  requirement: [REQ-2026-0052]
  plan: []
  spec: []
  architecture: []
  adr: [ADR-0004]
  module: [crm.customer]
  confluence_page_id: null
---

# Customer data dedup for onboarding

## Problem

Self-service onboarding ([PRD-2026-0001](./2026-Q2-customer-onboarding-prd.md))
lets new advertisers register themselves — but some are already customers under a
slightly different name or email, creating duplicate CRM profiles that split
spend history and break revenue attribution.

## Goals

- Detect a duplicate at registration: normalized email + company tax id as the
  match key.
- On a match, merge into the existing `crm.customer` profile rather than creating
  a new one; conflicting fields take the most recent self-service submission.

## Non-goals

- No retroactive de-dup of the historical CRM (that's the batch migration job in
  the `crm.customer` module playbook).
- No fuzzy/ML matching in v1 — exact normalized key only.

## Success metrics

- Duplicate-profile rate among self-service signups < 1%.
- No revenue-attribution tickets caused by split profiles after launch.

## Open questions

- Tax id is optional for some regions — what's the fallback match key there?
```

- [ ] **Step 3: Update the README**

In `examples/acme-ads/README.md`, in the `## Files` table add two rows for the new PRDs, and **replace the stale `--cwd` sentence**. Find the line under "Running traceability against this example" that says the `--cwd` flag is "coming in a future release" and replace that paragraph with:

```markdown
## Running traceability against this example

`--cwd` ships today, so you can check this example directly:

```bash
node packages/core/src/traceability.js check --cwd=examples/acme-ads
```

The repo's `npm run traceability:check` still targets `apps/docs` only, so the
example is validated via the explicit `--cwd` invocation above.

> Gateway demo atoms for this example are **not** files here — they live in the
> CLI seed module `packages/cli/src/gateway/acme-ads-seed.ts` (`seedAcmeAdsAtoms()`).
```

And add to the `## Files` table:

```markdown
| `docs/prds/2026-Q2-placement-dashboard-prd.md` | PRD-2026-0002 — placement performance dashboard (vCPM / PlacementRevenue) |
| `docs/prds/2026-Q2-onboarding-dedup-prd.md` | PRD-2026-0003 — customer dedup for self-service onboarding |
```

- [ ] **Step 4: Verify traceability over the example**

Run (from repo root): `node packages/core/src/traceability.js check --cwd=examples/acme-ads`
Expected: passes (now 3/3 primary PRDs). If it errors on a missing `related` id, the existing PRD-2026-0001 uses the same virtual-reference style — match its `related` block shape exactly (lists, `confluence_page_id: null`). Do not invent new doc *types*; reuse `requirement` / `adr` / `module` only.

- [ ] **Step 5: Commit**

```bash
git add examples/acme-ads/docs/prds/2026-Q2-placement-dashboard-prd.md examples/acme-ads/docs/prds/2026-Q2-onboarding-dedup-prd.md examples/acme-ads/README.md
git commit -m "docs(examples): AcmeAds +2 PRDs + README --cwd fix (P5a)"
```

---

## Task 3: Full-suite green

- [ ] **Step 1: Run the whole CLI suite**

Run: `npm --workspace packages/cli test`
Expected: all pass (prior 470 + the 4 acme-ads-seed tests), `typecheck:test` clean.

- [ ] **Step 2: Typecheck src**

Run: `cd packages/cli && npx tsc -p tsconfig.json --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Example traceability (final confirm)**

Run (repo root): `node packages/core/src/traceability.js check --cwd=examples/acme-ads`
Expected: passes (3/3).

- [ ] **Step 4: Commit any fixups** (only if Steps 1–3 surfaced issues)

```bash
git add -A && git commit -m "test(gateway): acme-ads seed suite green"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** 5 atoms via TS seed module + tag + status approved + scope acme-ads + idempotent seed/unseed → Task 1; 2 PRDs (PRD-2026-0002/0003) extending the narrative + README list + stale `--cwd` fix → Task 2; testing (seed/unseed/idempotency/isolation, traceability via `--cwd`) → Tasks 1 & 2. Module path is `gateway/acme-ads-seed.ts` (sibling of demo-seed.ts), per the corrected spec.
- **Placeholder scan:** all atom + PRD content is written in full; no "TBD". Task 2 is docs (no test code, by design — the verification is the traceability run, shown).
- **Type consistency:** `ACME_ADS_SEED_TAG`, `seedAcmeAdsAtoms` (→ `{atomIds, alreadyPresent}`), `unseedAcmeAdsAtoms` (→ `{removedIds}`), `findAcmeAdsAtoms` used identically in module + tests; `KnowledgeAtom` shape matches `demo-seed.ts` (id/createdAt/scope/question/answer/summary/tags/source/status).

## Out of scope (P5b / P5c)

`pmk demo` driver (seed + guided messages; must keep atom search unscoped or scope to `acme-ads`), the 30-minute walkthrough doc + record, and wiring the example into the default CI traceability gate.
