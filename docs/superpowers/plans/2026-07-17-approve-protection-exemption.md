# Approve Protection Exemption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `:a:` approve succeed on repos whose branch ruleset lacks `dismiss_stale_reviews_on_push` + `require_last_push_approval`, via a per-repo, explicitly-reasoned exemption, with honest Slack disclosure and a real audit trail.

**Architecture:** The branch-protection probe (`approvalProtectionReady`) is untouched and keeps running unconditionally — the exemption gates the *throw*, not the *check*. That keeps the probe result available so disclosure asserts only what was actually measured, and so an obsolete exemption is detected for free. Exemptions live in `review.approval.protectionExemptions`, are covered automatically by the existing revision fences (which serialise the whole `review` object), and each carries a mandatory `reason` that flows into Slack, the audit event, and doctor.

**Tech Stack:** TypeScript, Node's built-in test runner (`node --import tsx --test`), `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-17-approve-protection-exemption-design.md`

## Global Constraints

- Test command (from `packages/cli/`): `npm test` — runs `npm run typecheck:test && node --import tsx --test test/*.test.ts`. Single file: `node --import tsx --test test/<name>.test.ts`. Single test: add `--test-name-pattern "<substring>"`.
- Never mutate: build new objects/arrays (spread, `map`/`filter`), never modify in place.
- No `console.log` in production code.
- `approvalProtectionReady` in `packages/cli/src/adapters/github.ts` must not change. Its five existing tests (`test/github-review-helpers.test.ts:35,56,70,84,95`) must stay green and unmodified.
- Exact slug matching only. No wildcards, no org-level exemptions.
- Every dropped/invalid exemption entry must fail **safe**: no exemption means the probe is enforced and the approve is refused.
- Slack copy is 繁體中文台灣用語; technical identifiers stay in English.
- Commit message format: `<type>: <description>`. No attribution trailer (disabled globally).
- Work on branch `feat/approve-protection-exemption` (already created, spec already committed as `5cb360b`).

---

### Task 1: Config shape + `findProtectionExemption`

**Files:**
- Modify: `packages/cli/src/gateway/config.ts:110-118` (types), `:375-384` (normalise), `:494-497` (resolve)
- Modify: `packages/cli/src/gateway/review-policy.ts` (add the lookup)
- Test: `packages/cli/test/review-config.test.ts` (extend), `packages/cli/test/review-protection-exemption.test.ts` (create)

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `ProtectionExemption { repo: string; reason: string }` — exported from `config.ts`
  - `ApprovalConfig { enabled: boolean; protectionExemptions?: ProtectionExemption[] }` — exported from `config.ts`
  - `ReviewConfig.approval: ApprovalConfig`
  - `findProtectionExemption(approval: { protectionExemptions?: ProtectionExemption[] }, slug: string): ProtectionExemption | undefined` — exported from `review-policy.ts`
  - `resolveReviewConfig()` always fills `approval.protectionExemptions` to at least `[]`

**Why `protectionExemptions` is optional in the type:** `RawGatewayConfig.review` is `Partial<ReviewConfig>`, so `approval` must remain satisfiable by `{ enabled }` alone — several existing call sites construct it that way. `resolveReviewConfig` fills the default, mirroring how `repoAllowlist?: string[]` is already handled in this file.

- [ ] **Step 1: Write the failing tests for `findProtectionExemption`**

Create `packages/cli/test/review-protection-exemption.test.ts`:

```ts
// packages/cli/test/review-protection-exemption.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findProtectionExemption } from "../src/gateway/review-policy";

const approval = {
  enabled: true,
  protectionExemptions: [
    { repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" },
    { repo: "onead/other", reason: "second entry" },
  ],
};

describe("findProtectionExemption", () => {
  it("returns the matching entry with its reason", () => {
    const found = findProtectionExemption(approval, "onead/oss-ui-v2");
    assert.equal(found?.repo, "onead/oss-ui-v2");
    assert.equal(found?.reason, "ruleset 8015695 pending");
  });

  it("returns undefined for a repo that is not listed", () => {
    assert.equal(findProtectionExemption(approval, "onead/unlisted"), undefined);
  });

  it("never matches by wildcard or prefix — the blast radius stays exact", () => {
    assert.equal(findProtectionExemption(approval, "onead/*"), undefined);
    assert.equal(findProtectionExemption(approval, "onead/oss-ui-v2-fork"), undefined);
    assert.equal(findProtectionExemption(approval, "onead"), undefined);
    const wild = { enabled: true, protectionExemptions: [{ repo: "onead/*", reason: "nope" }] };
    assert.equal(findProtectionExemption(wild, "onead/oss-ui-v2"), undefined);
  });

  it("tolerates an approval block with no exemptions at all", () => {
    assert.equal(findProtectionExemption({ enabled: true }, "onead/oss-ui-v2"), undefined);
    assert.equal(findProtectionExemption({ enabled: true, protectionExemptions: [] }, "onead/oss-ui-v2"), undefined);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/cli/`): `node --import tsx --test test/review-protection-exemption.test.ts`
Expected: FAIL — `findProtectionExemption` is not exported from `review-policy.ts`.

- [ ] **Step 3: Add the types to `config.ts`**

Replace the `ReviewConfig` opening at `config.ts:110-112`:

```ts
/**
 * A deliberate, reasoned waiver of the branch-protection approve preflight
 * for one repo. Exact `owner/repo` only — no wildcards, because the whole
 * point of an exemption is a blast radius someone had to type out in full.
 */
export interface ProtectionExemption {
  repo: string;
  /** Why the waiver exists. Required; entries without one are dropped at load. */
  reason: string;
}

export interface ApprovalConfig {
  enabled: boolean;
  /**
   * Optional on the raw/partial side so `{ enabled }` alone still satisfies
   * `Partial<ReviewConfig>`; `resolveReviewConfig` always fills it to `[]`.
   */
  protectionExemptions?: ProtectionExemption[];
}

export interface ReviewConfig {
  enabled: boolean;
  approval: ApprovalConfig;
```

Leave `allowPublicRepos` and everything after it exactly as-is.

- [ ] **Step 4: Add the normaliser to `config.ts`**

Insert this helper immediately above `normaliseReviewConfig` (before `config.ts:375`):

```ts
/**
 * Keep only well-formed exemptions. A dropped entry fails safe: no exemption
 * means the branch-protection preflight is enforced and the approve is
 * refused. `doctor` reports the drop count so a typo is not silent.
 */
function asProtectionExemptions(raw: unknown[]): ProtectionExemption[] {
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((e) => ({
      repo: typeof e.repo === "string" ? e.repo.trim() : "",
      reason: typeof e.reason === "string" ? e.reason.trim() : "",
    }))
    .filter((e) => e.repo !== "" && e.reason !== "");
}
```

Then replace `config.ts:380-384` (the `if (o.approval …)` block) with:

```ts
  if (o.approval && typeof o.approval === "object") {
    const approval = o.approval as Record<string, unknown>;
    const normalised: ApprovalConfig = {
      enabled: typeof approval.enabled === "boolean" ? approval.enabled : false,
    };
    if (Array.isArray(approval.protectionExemptions))
      normalised.protectionExemptions = asProtectionExemptions(approval.protectionExemptions);
    out.approval = normalised;
  }
```

- [ ] **Step 5: Fill the default in `resolveReviewConfig`**

Replace `config.ts:497`:

```ts
    approval: {
      enabled: raw?.approval?.enabled ?? false,
      protectionExemptions: raw?.approval?.protectionExemptions ?? [],
    },
```

- [ ] **Step 6: Add `findProtectionExemption` to `review-policy.ts`**

Add to the top of `packages/cli/src/gateway/review-policy.ts` (after the existing `mra` import):

```ts
import type { ProtectionExemption } from "./config";
```

And append:

```ts
/**
 * The per-repo waiver of the branch-protection preflight, or undefined.
 *
 * Returns the entry rather than a boolean so callers get `reason` for the
 * Slack disclosure and the audit record. Exact slug match only: a stored
 * `onead/*` is a literal repo name that matches nothing, by design.
 */
export function findProtectionExemption(
  approval: { protectionExemptions?: ProtectionExemption[] },
  slug: string,
): ProtectionExemption | undefined {
  return approval.protectionExemptions?.find((e) => e.repo === slug);
}
```

`config.ts` does not import `review-policy.ts`, so this type-only import creates no cycle.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --import tsx --test test/review-protection-exemption.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 8: Write the failing config-validation tests**

Append to `packages/cli/test/review-config.test.ts` (inside the existing top-level `describe`; match the file's existing import of `resolveReviewConfig` from `../src/gateway/config`):

```ts
  it("defaults protectionExemptions to an empty array", () => {
    assert.deepEqual(resolveReviewConfig({}).approval.protectionExemptions, []);
    assert.deepEqual(resolveReviewConfig({ approval: { enabled: true } }).approval.protectionExemptions, []);
  });

  it("keeps well-formed protectionExemptions and trims them", () => {
    const c = resolveReviewConfig({
      approval: { enabled: true, protectionExemptions: [{ repo: "  onead/oss-ui-v2 ", reason: " ruleset pending " }] },
    });
    assert.deepEqual(c.approval.protectionExemptions, [{ repo: "onead/oss-ui-v2", reason: "ruleset pending" }]);
  });
```

- [ ] **Step 9: Write the failing drop-behaviour tests**

Append to the same file. These pin the fail-safe direction:

```ts
  it("drops exemptions that lack a non-empty reason — the waiver must be justified", () => {
    const c = resolveReviewConfig({
      approval: {
        enabled: true,
        protectionExemptions: [
          { repo: "onead/a" } as never,
          { repo: "onead/b", reason: "" } as never,
          { repo: "onead/c", reason: "   " } as never,
          { repo: "onead/d", reason: 42 } as never,
        ],
      },
    });
    assert.deepEqual(c.approval.protectionExemptions, [], "an unjustified waiver must never take effect");
  });

  it("drops malformed entries but keeps valid siblings and the surrounding config", () => {
    const c = resolveReviewConfig({
      enabled: true,
      approval: {
        enabled: true,
        protectionExemptions: [
          null as never,
          "onead/string-form" as never,
          { reason: "no repo" } as never,
          { repo: "onead/good", reason: "kept" },
        ],
      },
    });
    assert.deepEqual(c.approval.protectionExemptions, [{ repo: "onead/good", reason: "kept" }]);
    assert.equal(c.enabled, true, "one bad exemption must not take the config down");
    assert.equal(c.approval.enabled, true);
  });
```

- [ ] **Step 10: Run the config tests to verify they pass**

Run: `node --import tsx --test test/review-config.test.ts`
Expected: PASS — the four new tests plus every pre-existing test in the file.

- [ ] **Step 11: Typecheck and run the full suite**

Run: `npm test`
Expected: PASS. If `normaliseReviewConfig`'s `out.approval` assignment errors, confirm Step 3 declared `protectionExemptions` as **optional** (`?:`) on `ApprovalConfig`.

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src/gateway/config.ts packages/cli/src/gateway/review-policy.ts \
        packages/cli/test/review-config.test.ts packages/cli/test/review-protection-exemption.test.ts
git commit -m "feat: add per-repo approve protection exemption config

Exemptions carry a mandatory reason; malformed entries are dropped
individually and fail safe (no exemption = probe enforced = approve
refused). findProtectionExemption returns the entry, not a boolean, so
callers can surface the reason."
```

---

### Task 2: Fix the admin clobber (regression guard for Task 1)

**Files:**
- Modify: `packages/cli/src/gateway/slack/admin-review.ts:34`, `:79`, `:84`
- Test: `packages/cli/test/admin-review.test.ts` (create — confirmed absent; `gateway-admin-doctor.test.ts` covers `handleAdminSlash`, not `adminReview`)

**Interfaces:**
- Consumes: `ApprovalConfig.protectionExemptions` from Task 1.
- Produces: nothing new — behavioural fix only.

**Why this task exists:** not in the original design. `admin-review.ts:79` replaces the entire `approval` object, so once exemptions live inside it, any `/pmk admin review approval enable|disable` silently wipes them. The only symptom would be approve failing the probe again with a config file that looks hand-edited. Fix it before anything depends on the exemption surviving.

- [ ] **Step 1: Create the test file**

`admin-review.test.ts` does not exist (only `gateway-admin-doctor.test.ts`, which drives `handleAdminSlash`). Create it:

```ts
// packages/cli/test/admin-review.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { adminReview } from "../src/gateway/slack/admin-review";
import { loadRawGatewayConfig, saveGatewayConfig } from "../src/gateway/config";

const ORIG_HOME = process.env.HOME; // gatewayDir() is HOME-based
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ar-")); process.env.HOME = tmp; });
afterEach(() => { if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });
```

- [ ] **Step 2: Write the failing clobber test**

```ts
describe("adminReview approval toggle", () => {
  it("preserves protectionExemptions across an enable/disable cycle", () => {
    saveGatewayConfig({
      version: 1, admins: ["U1"], blocklist: [], slack: {},
      review: {
        enabled: true,
        approval: {
          enabled: true,
          protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
        },
      },
    } as never);

    adminReview("U1", ["approval", "disable"]);
    adminReview("U1", ["approval", "enable"]);

    const after = loadRawGatewayConfig();
    assert.deepEqual(
      after.review?.approval?.protectionExemptions,
      [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      "toggling the approval gate must not silently wipe the exemptions",
    );
    assert.equal(after.review?.approval?.enabled, true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test test/admin-review.test.ts --test-name-pattern "preserves protectionExemptions"`
Expected: FAIL — `protectionExemptions` is `undefined` after the cycle, because `:79` replaced the object.

- [ ] **Step 4: Fix the clobber**

Replace `admin-review.ts:79`:

```ts
      // Merge, never replace: `approval` also holds protectionExemptions, and
      // a bare `{ enabled }` would silently wipe them on every toggle.
      cfg.review = {
        ...(cfg.review ?? {}),
        approval: { ...(cfg.review?.approval ?? {}), enabled },
      };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/admin-review.test.ts --test-name-pattern "preserves protectionExemptions"`
Expected: PASS.

- [ ] **Step 6: Fix the two copy strings that now overstate the guarantee**

Replace `admin-review.ts:34`:

```ts
    `• automatic approval: \`${review.approval.enabled}\` (PMK admin confirmation required; branch protection required unless the repo is exempt)`,
    `• protection exemptions: ${review.approval.protectionExemptions?.length ? review.approval.protectionExemptions.map((e) => `\`${e.repo}\``).join(", ") : "`none`"}`,
```

Replace the `enabled` arm of `admin-review.ts:84`:

```ts
          ? ":warning: automatic approval enabled; each repo must still pass protocol, identity, head-SHA, and allowlist checks, plus branch-protection readiness unless it is listed in `review.approval.protectionExemptions`"
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. If an existing `reviewStatusText` snapshot/substring test breaks on the `:34` change, update that assertion to match the new copy — the copy change is intentional.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/gateway/slack/admin-review.ts packages/cli/test/admin-review.test.ts
git commit -m "fix: stop the admin approval toggle from wiping protectionExemptions

/pmk admin review approval enable|disable replaced the whole approval
object, so every toggle silently dropped the exemptions. Merge instead,
and stop claiming branch protection is unconditionally required."
```

---

### Task 3: Exempt the preflight throw (core behaviour change) + policy comment

**Files:**
- Modify: `packages/cli/src/gateway/slack/review.ts:573-574` (the preflight), `:609-610` (success reply)
- Modify: `packages/cli/src/gateway/review-policy.ts:3-10` (comment only)
- Test: `packages/cli/test/review-coordinator.test.ts` (extend)

**Interfaces:**
- Consumes: `findProtectionExemption` (Task 1), `ReviewConfig.approval.protectionExemptions` (Task 1).
- Produces: `exemptionInEffect: boolean` and `exemption: ProtectionExemption | undefined` as locals inside `publishApprovalReservation`, consumed by Task 4 (audit event). The success-reply text is finalised here; Task 4 only adds the event.

**The one idea that matters:** the probe still runs on every approve. The exemption gates the `throw`, not the check. Skipping the probe would (a) make §3's disclosure assert a fact never measured, and (b) throw away the obsolete-exemption signal. There is no added cost — today's code already probes unconditionally.

- [ ] **Step 1: Write the failing test — exempt repo approves through an unprotected branch**

Append inside the existing `describe("ReviewCoordinator.confirmApproveInThread", …)` block in `packages/cli/test/review-coordinator.test.ts`. Note `coord()`'s 4th parameter is `reviewOverrides`, merged into `config.review`:

```ts
  it("approves an exempt repo whose branch protection is not ready", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      resolveRepoSlug: async () => "onead/oss-ui-v2",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/oss-ui-v2/pull/301";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1, "an exempt repo must approve despite an unready probe");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已真實 approve/.test(t)));
    assert.ok(
      allTexts.some((t) => /不會讓這個 approval 失效/.test(t)),
      "the accepted risk must be disclosed at the moment it goes live",
    );
    assert.ok(allTexts.some((t) => /ruleset 8015695 pending/.test(t)), "the reason must be surfaced");
  });
```

- [ ] **Step 2: Write the failing test — a non-exempt repo still refuses**

```ts
  it("still refuses a non-exempt repo whose branch protection is not ready", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; throw new Error("must not be called"); },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/some-other-repo", reason: "unrelated" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 0, "an exemption for another repo must never leak across repos");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /protection is not approval-ready/.test(t)));
  });
```

- [ ] **Step 3: Write the failing test — exempt but actually protected reports the exemption obsolete**

```ts
  it("reports an exempt repo's waiver as obsolete once its branch is genuinely protected", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => true, // onead fixed the ruleset
      resolveRepoSlug: async () => "onead/oss-ui-v2",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/oss-ui-v2/pull/301";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1);
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /豁免已不再需要/.test(t)), "an obsolete waiver must announce itself");
    assert.ok(
      !allTexts.some((t) => /不會讓這個 approval 失效/.test(t)),
      "a protected branch must never carry the unprotected warning",
    );
  });
```

- [ ] **Step 4: Write the failing test — an exemption cannot be injected mid-approve**

This pins the property the architecture claims for free. Note what is actually being tested: the **authorization lock** refuses any `saveGatewayConfig` that lands inside the critical section, whatever field it touches — the three revision fences are defence-in-depth behind it and cannot be triggered in isolation through the public API. Model this on the existing lock test (`review-coordinator.test.ts:940-978`), which proves the same for `approval.enabled`:

```ts
  it("refuses a protectionExemptions write that lands inside the approve critical section", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    let writeError: Error | undefined;
    const gateway = gw({
      approvalProtectionReady: async () => true,
      runMraReview: async () => eligibleReviewResult(),
      // Slow preflight holds the authorization lock long enough for the
      // concurrent write below to land inside the critical section.
      getPrHead: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { sha: "headsha", baseRef: "main" };
      },
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    const confirming = c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    await new Promise((r) => setTimeout(r, 60)); // land inside the held section
    try {
      saveGatewayConfig({
        version: 1, admins: ["U1"], blocklist: [], audience: {}, escalation: {}, slack: {},
        mraWorkspace: path.join(tmp, "ws"),
        review: {
          enabled: true, expectedGhUser: "expected-bot",
          approval: {
            enabled: true,
            protectionExemptions: [{ repo: "onead/OnePixel", reason: "injected mid-approve" }],
          },
        },
      } as never);
    } catch (err) {
      writeError = err as Error;
    }
    await confirming;

    assert.ok(writeError, "an exemption must not be injectable mid-approve");
    assert.equal(writeError?.name, "AuthorizationLockBusyError");
    assert.equal(approved, 1, "the in-flight approve completes under the policy valid at its start");
  });
```

- [ ] **Step 5: Run the four tests to verify they fail**

Run: `node --import tsx --test test/review-coordinator.test.ts --test-name-pattern "exempt"`
Expected: FAIL — the first throws `repository protection is not approval-ready`; the third finds no `豁免已不再需要`. (The Step 4 lock test may already pass: the lock is field-agnostic and pre-existing. That is the point — it documents the property rather than adding it.)

- [ ] **Step 6: Import the lookup in `review.ts`**

Change `review.ts:49`:

```ts
import { AUTOMATIC_APPROVAL_RELEASE_READY, effectiveMraReviewStrategy, findProtectionExemption } from "../review-policy";
```

- [ ] **Step 7: Replace the preflight at `review.ts:573-574`**

```ts
        // The probe still runs on every approve; the exemption gates the THROW,
        // not the check. Keeping the measurement means the disclosure below
        // asserts only what we actually observed, and an obsolete waiver
        // announces itself. approvalProtectionReady never throws (false on
        // error), so a network blip degrades to "still unprotected".
        const exemption = findProtectionExemption(review.approval, slug);
        const protectionReady = await gateway.approvalProtectionReady({ slug, branch: ref.baseRef, token });
        if (!protectionReady && !exemption)
          throw new Error("repository protection is not approval-ready");
        const exemptionInEffect = !protectionReady && !!exemption;
```

- [ ] **Step 8: Replace the success reply at `review.ts:609-610`**

```ts
        const approvedLine = `:white_check_mark: 已真實 approve ${slug}#${ref.number}（commit \`${ref.headSha.slice(0, 7)}\`，GitHub review #${posted.reviewId}）。`;
        const riskLine = exemptionInEffect
          ? `\n:warning: 此 repo 未啟用 dismiss-stale/require-last-push：後續新 push 不會讓這個 approval 失效，可能被用來 merge 未經 review 的 commit。豁免理由：${exemption!.reason}`
          : "";
        const obsoleteLine = protectionReady && exemption
          ? `\n:information_source: ${slug} 的 protection 豁免已不再需要（branch 現已同時啟用 dismiss-stale 與 require-last-push），可以從 config 移除。`
          : "";
        await this.reply(reservation.channelId, reservation.threadTs, `${approvedLine}${riskLine}${obsoleteLine}`);
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --import tsx --test test/review-coordinator.test.ts`
Expected: PASS — the three new tests plus every pre-existing test, including "publishes a real approval end-to-end when policy allows (#90 veto lifted)" (its `gw()` default `approvalProtectionReady: async () => true` and empty exemption list keep it on the unchanged path).

- [ ] **Step 10: Amend the policy comment**

Replace `packages/cli/src/gateway/review-policy.ts:7-9` (the tail of the veto comment). The comment must not claim a guarantee the code no longer makes unconditionally:

```ts
// GitHub APPROVE additionally requires the runtime gate
// `review.approval.enabled` (admin-togglable, default false) plus the
// per-approve preflights (identity, head-SHA, protection, revision fences).
// The protection preflight is waivable per-repo via
// `review.approval.protectionExemptions` — a deliberate, reasoned risk
// acceptance for repos whose ruleset lacks dismiss-stale/require-last-push.
// See docs/superpowers/specs/2026-07-17-approve-protection-exemption-design.md.
```

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src/gateway/slack/review.ts packages/cli/src/gateway/review-policy.ts \
        packages/cli/test/review-coordinator.test.ts
git commit -m "feat: waive the approve protection preflight for exempt repos

The probe still runs on every approve -- the exemption gates the throw,
not the check -- so the Slack disclosure asserts only what was actually
measured, and a waiver that has outlived its ruleset says so."
```

---

### Task 4: `review.approved` audit event

**Files:**
- Modify: `packages/cli/src/gateway/events.ts` (add the interface, extend the union)
- Modify: `packages/cli/src/gateway/slack/review.ts` (emit inside `publishApprovalReservation`)
- Test: `packages/cli/test/review-coordinator.test.ts` (extend)

**Interfaces:**
- Consumes: `exemptionInEffect`, `protectionReady`, `exemption`, `posted.reviewId` — all locals established by Task 3 inside `publishApprovalReservation`.
- Produces: `ReviewApprovedEvent` exported from `events.ts` and added to the `GatewayEvent` union.

**Why this task exists:** `publishApprovalReservation` (`review.ts:537-625`) currently emits **zero** gateway events. Real GitHub approvals leave no trace outside the Slack thread — the log only has `review.triggered`, `review.skipped`, `review.posted`. Approving under a knowingly-accepted risk with no audit record is indefensible, so the risk flag rides on the event.

- [ ] **Step 1: Write the failing test**

Append inside `describe("ReviewCoordinator.confirmApproveInThread", …)` in `packages/cli/test/review-coordinator.test.ts`. `HOME` is already redirected to `tmp` by the file's `beforeEach`, so events land under the temp dir:

```ts
  it("records every real approval in the audit log, flagging the accepted risk", async () => {
    const { readGatewayEvents } = await import("../src/gateway/events");
    const web = new FakeWebClient();
    const gateway = gw({
      approvalProtectionReady: async () => false,
      resolveRepoSlug: async () => "onead/oss-ui-v2",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) =>
        ({ reviewId: 4242, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" }),
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/oss-ui-v2/pull/301";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    const approvals = readGatewayEvents().filter((e) => e.type === "review.approved");
    assert.equal(approvals.length, 1, "a real GitHub approval must never be unaudited");
    const ev = approvals[0] as never as { actor: string; repo: string; pr: number; reviewId: number; protectionExempt: boolean };
    assert.equal(ev.actor, "U1");
    assert.equal(ev.repo, "onead/oss-ui-v2");
    assert.equal(ev.pr, 301);
    assert.equal(ev.reviewId, 4242);
    assert.equal(ev.protectionExempt, true, "the accepted risk must be on the record");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/review-coordinator.test.ts --test-name-pattern "audit log"`
Expected: FAIL — `approvals.length` is `0`.

- [ ] **Step 3: Add the event interface to `events.ts`**

Insert immediately after `ReviewPostedEvent` (`events.ts:228`):

```ts
/**
 * A real GitHub APPROVE published by the gateway. Distinct from
 * `review.posted` (which covers COMMENT/REQUEST_CHANGES review bodies):
 * this is the mutation that can unblock a merge, so it is audited on its
 * own. `protectionExempt` records whether the approve rode a per-repo
 * waiver of the branch-protection preflight — i.e. whether GitHub will
 * dismiss it when new commits land.
 */
export interface ReviewApprovedEvent {
  type: "review.approved";
  actor: string;
  repo: string;      // owner/repo slug
  pr: number;
  commit: string;    // the exact head SHA that was approved
  reviewId: number;
  protectionExempt: boolean;
  /** The waiver's recorded justification, when one was in effect. */
  exemptionReason?: string;
}
```

Then add to the `GatewayEvent` union (`events.ts:288`, after `ReviewPostedEvent`):

```ts
  | ReviewApprovedEvent
```

- [ ] **Step 4: Emit the event in `review.ts`**

In `publishApprovalReservation`, insert between the post-POST staleness check and the `this.reply(...)` added by Task 3 — i.e. after `if (!after || after.sha !== ref.headSha) throw …` and before `const approvedLine = …`:

```ts
        appendGatewayEvent({
          type: "review.approved",
          actor: actorUserId,
          repo: slug,
          pr: ref.number,
          commit: ref.headSha,
          reviewId: posted.reviewId,
          protectionExempt: exemptionInEffect,
          exemptionReason: exemptionInEffect ? exemption!.reason : undefined,
        });
```

`appendGatewayEvent` is already imported at `review.ts:30`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/review-coordinator.test.ts --test-name-pattern "audit log"`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. A `GatewayEvent` union exhaustiveness error in an audit/reader switch means that consumer needs a `review.approved` arm — add one that counts it alongside `review.posted`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/events.ts packages/cli/src/gateway/slack/review.ts \
        packages/cli/test/review-coordinator.test.ts
git commit -m "feat: audit real GitHub approvals as review.approved

publishApprovalReservation emitted no events at all, so approves existed
only in the Slack thread. The event carries protectionExempt, putting the
accepted risk on the record rather than in a chat scrollback."
```

---

### Task 5: Doctor reports exemptions and dropped entries

**Files:**
- Modify: `packages/cli/src/gateway/doctor-checks/review.ts`
- Test: `packages/cli/test/gateway-doctor.test.ts` (extend — the review checks already live there at `:679-687`; there is no `doctor-review.test.ts`)

**Interfaces:**
- Consumes: `ReviewConfig.approval.protectionExemptions` (Task 1), `DoctorContext.configPath`.
- Produces: nothing consumed downstream — reporting only.

**Design constraint (do not violate):** this check documents itself as "Presence/config only — no live gh call (kept fast like github-token)", and `doctor.ts:6` states "checks themselves stay testable without network access" (network is injected via `DoctorRunners`). Doctor must **not** probe branch protection. Stale-exemption detection already lives on the approve path (Task 3), which probes anyway.

**Why the raw re-read:** `normaliseReviewConfig` discards malformed entries without a trace, so the resolved config cannot reveal a drop. Doctor re-reads the on-disk JSON and compares counts. Without this, a typo in `repo` silently degrades to "no exemption" and the only symptom is an approve that keeps failing the probe.

- [ ] **Step 1: Write the failing tests**

The tests live in `packages/cli/test/gateway-doctor.test.ts` — there is no `doctor-review.test.ts`. The existing harness (`:679-687`) just casts a bare object, so build the `DoctorContext` the same way. Append after the `describe("doctor — review readiness check", …)` block. Ensure `fs`, `os`, `path` are imported at the top of the file; add them if not.

**Do not assert `severity`.** With `review.enabled: true` the check calls the real `findMraBinary()` / `findGhBinary()`, so severity is `fail` wherever `mra`/`gh` are off PATH. Assert on `message`, which is deterministic.

```ts
describe("doctor — review protection exemptions", () => {
  it("lists protection exemptions so a standing waiver stays visible", async () => {
    const { reviewDoctorCheck } = await import("../src/gateway/doctor-checks/review");
    const res = await reviewDoctorCheck({
      configPath: "/nonexistent/gateway.json", // droppedExemptionCount must tolerate this
      config: {
        review: {
          enabled: true,
          approval: {
            enabled: true,
            protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
          },
        },
      },
    } as never);
    assert.match(res.message, /protection exemptions active/i);
    assert.match(res.message, /onead\/oss-ui-v2/);
    assert.match(res.message, /ruleset 8015695 pending/, "the recorded justification must be visible");
    assert.match(res.message, /exemptions=1/);
  });

  it("reports a malformed exemption that normalisation silently dropped", async () => {
    const { reviewDoctorCheck } = await import("../src/gateway/doctor-checks/review");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-doc-"));
    const configPath = path.join(dir, "gateway.json");
    // Two entries on disk; the second lacks `reason` and is dropped at load.
    fs.writeFileSync(configPath, JSON.stringify({
      review: {
        approval: {
          protectionExemptions: [
            { repo: "onead/oss-ui-v2", reason: "kept" },
            { repo: "onead/typo" },
          ],
        },
      },
    }));
    try {
      const res = await reviewDoctorCheck({
        configPath,
        config: {
          review: {
            enabled: true,
            approval: { enabled: true, protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "kept" }] },
          },
        },
      } as never);
      assert.match(res.message, /1 protectionExemption entry dropped/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no exemptions and no drops for a config that has none", async () => {
    const { reviewDoctorCheck } = await import("../src/gateway/doctor-checks/review");
    const res = await reviewDoctorCheck({
      configPath: "/nonexistent/gateway.json",
      config: { review: { enabled: true, approval: { enabled: true } } },
    } as never);
    assert.match(res.message, /exemptions=0/);
    assert.ok(!/dropped/.test(res.message));
    assert.ok(!/protection exemptions active/i.test(res.message));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test test/gateway-doctor.test.ts --test-name-pattern "exemption"`
Expected: FAIL — the message has no exemption text.

- [ ] **Step 3: Add the raw drop-count helper to `doctor-checks/review.ts`**

```ts
/**
 * Count exemption entries that normalisation threw away. The resolved
 * config keeps no record of a drop, so the raw file is the only source —
 * and a silently-dropped waiver presents as "approve keeps failing the
 * probe" with a config that looks correct to the eye.
 */
function droppedExemptionCount(configPath: string, keptCount: number): number {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as
      { review?: { approval?: { protectionExemptions?: unknown } } };
    const listed = raw.review?.approval?.protectionExemptions;
    if (!Array.isArray(listed)) return 0;
    return Math.max(0, listed.length - keptCount);
  } catch {
    return 0; // unreadable/absent config is another check's problem
  }
}
```

Add `import * as fs from "node:fs";` at the top of the file.

- [ ] **Step 4: Wire it into the check**

After the existing `warnings` block and before `detail` is built:

```ts
  const exemptions = review.approval.protectionExemptions ?? [];
  if (exemptions.length) {
    warnings.push(
      `protection exemptions active: ${exemptions.map((e) => `${e.repo} (${e.reason})`).join("; ")} — approve on these repos skips branch-protection readiness`,
    );
  }
  const dropped = droppedExemptionCount(ctx.configPath, exemptions.length);
  if (dropped > 0) {
    warnings.push(
      `${dropped} protectionExemption entr${dropped === 1 ? "y" : "ies"} dropped (each needs a non-empty repo and reason)`,
    );
  }
```

Then extend `detail` (`review.ts:43`) by appending:

```ts
`; exemptions=${exemptions.length}`
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --import tsx --test test/gateway-doctor.test.ts --test-name-pattern "exemption"`
Expected: PASS — 3 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/doctor-checks/review.ts packages/cli/test/gateway-doctor.test.ts
git commit -m "feat: surface protection exemptions and dropped entries in doctor

Config-only, honouring the check's no-live-gh-call constraint. Drop
counting needs the raw file: normalisation discards malformed entries
without a trace, so a typo would otherwise be invisible."
```

---

### Task 6: Offer-message note (spec §3, offer half)

**Files:**
- Modify: `packages/cli/src/gateway/slack/review-messages.ts:28-37`
- Modify: `packages/cli/src/gateway/slack/review.ts:1006` (pass the new argument)
- Test: `packages/cli/test/review-coordinator.test.ts` (extend — `reviewResultText` is re-exported from `review.ts` and already imported there at `:8`)

**Interfaces:**
- Consumes: `findProtectionExemption` (Task 1).
- Produces: `reviewResultText(slug, ref, res, approvalEnabled?, protectionExempted?)` — a fifth optional parameter, defaulting `false`.

**The honesty rule this task exists to obey:** the offer line is emitted on the `:cr:` path, which **never probes**. So it must state the *config* fact ("this repo is on the exemption list") and never the *branch* fact ("this branch is unprotected") — the latter is unmeasured there. Only the approve path (Task 3), which probes, may assert the branch fact. Do not add a probe here: that would put a network call on every review just to decorate a message.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("review/approve result text (pure)", …)` block at `packages/cli/test/review-coordinator.test.ts:1169`. It already declares a shared `ref` fixture and imports `reviewResultText` and `eligibleReviewResult` — reuse all three rather than redeclaring. `slug` is a separate parameter from `ref`, so the shared fixture works for any repo name:

```ts
  it("reviewResultText notes the exemption as a config fact, never a branch claim", () => {
    const t = reviewResultText("onead/oss-ui-v2", ref, eligibleReviewResult() as never, true, true);
    assert.match(t, /已列入 protection 豁免清單/);
    assert.doesNotMatch(
      t,
      /未啟用 dismiss-stale/,
      ":cr: never probes, so the offer line has no standing to describe the branch",
    );
  });

  it("reviewResultText leaves the offer line untouched for a non-exempt repo", () => {
    const t = reviewResultText("onead/OnePixel", ref, eligibleReviewResult() as never, true, false);
    assert.doesNotMatch(t, /豁免/);
    assert.match(t, /可進一步 approve/);
  });

  it("reviewResultText never mentions the exemption when approval is disabled", () => {
    const t = reviewResultText("onead/oss-ui-v2", ref, eligibleReviewResult() as never, false, true);
    assert.doesNotMatch(t, /豁免/, "the no-approve line must not advertise a waiver it cannot use");
    assert.match(t, /未執行 GitHub approve/);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test test/review-coordinator.test.ts --test-name-pattern "reviewResultText"`
Expected: FAIL — no `已列入 protection 豁免清單` in the output.

- [ ] **Step 3: Add the parameter in `review-messages.ts`**

Replace `reviewResultText` (`review-messages.ts:27-37`):

```ts
/**
 * Result line for a plain `:cr:` review. It never claims GitHub approval.
 *
 * `protectionExempted` is a CONFIG fact (the repo is on the exemption list),
 * not a branch fact. The `:cr:` path never probes branch protection, so this
 * line must not assert anything about dismiss-stale / require-last-push —
 * only the approve path, which probes, may do that.
 */
export function reviewResultText(
  slug: string,
  ref: PrRef,
  res: ReviewOutcome,
  approvalEnabled = true,
  protectionExempted = false,
): string {
  if (res.incomplete)
    return `:warning: ${slug}#${ref.number} review 未完成（mra 回報 REVIEW_INCOMPLETE，未真正評估此 PR — 可能 max-turns 截斷或 provider 呼叫失敗）；已貼中性佔位，claim 已釋放，請重試 :cr:：${ref.url}`;
  const status = res.status ?? "COMMENT";
  const count = res.commentCount ?? 0;
  if (approvalEnabled && canConfirmApproveFromReview(res)) {
    const exemptNote = protectionExempted
      ? "（此 repo 已列入 protection 豁免清單，approve 時會略過 branch-protection 檢查）"
      : "";
    return `:mag: 已完成 ${slug}#${ref.number} review（GitHub action: ${status}；${count} 則）。這個結果沒有 HIGH/CRITICAL blocker，可進一步 approve，但 :cr: 不會主動 approve；請由 PMK admin 在此 channel thread @PMK 回覆 \`approve\` 授權（DM 可直接回覆）${exemptNote}：${ref.url}`;
  }
  return `:mag: 已完成 ${slug}#${ref.number} review（GitHub action: ${status}；${count} 則；未執行 GitHub approve）：${ref.url}`;
}
```

- [ ] **Step 4: Pass it at the call site**

Replace `review.ts:1004-1006`:

```ts
      const resultText = isApprove
        ? approveResultText(slug, ref, res)
        : reviewResultText(slug, ref, res, ctx.review.approval.enabled,
            !!findProtectionExemption(ctx.review.approval, slug));
```

`findProtectionExemption` is already imported into `review.ts` by Task 3 Step 6.

- [ ] **Step 5: Run to verify they pass**

Run: `node --import tsx --test test/review-coordinator.test.ts`
Expected: PASS — the two new tests plus every pre-existing `reviewResultText` test (the new parameter defaults to `false`, so the old three- and four-argument calls are unaffected).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/slack/review-messages.ts packages/cli/src/gateway/slack/review.ts \
        packages/cli/test/review-coordinator.test.ts
git commit -m "feat: note the protection exemption on the :cr: offer line

Stated as a config fact, not a branch claim: :cr: never probes, so it has
no standing to say whether dismiss-stale is on. Only the approve path,
which probes, asserts that."
```

---

## Rollout (do NOT fold into the tasks above)

Only after every task is green and the branch is merged. This is a deliberate, separate act — it is the moment the risk goes live.

1. Edit `~/.pmk/gateway.json`: set `review.approval.enabled` to `true` and add the `onead/oss-ui-v2` exemption with its reason.
2. Restart: `launchctl kickstart -k gui/$(id -u)/com.pmk.gateway`
3. `pmk gateway doctor` — expect the review check to `warn` and name `onead/oss-ui-v2`.
4. Live-verify on an **open** PR in `onead/oss-ui-v2`. `#299` is closed and cannot serve.
   Expect: `:cr:` → offer → thread `approve` → real APPROVE + the `:warning:` disclosure.
5. Confirm the audit record: `pmk gateway audit` (or read `~/.pmk/events-2026-07.log`) shows
   `review.approved` with `protectionExempt: true`.
