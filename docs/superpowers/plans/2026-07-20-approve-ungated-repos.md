# Auto-allow approve on ungated repos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `:a:` approve succeed without a per-repo exemption on any repo whose ruleset positively shows no required-review gate, behind an opt-in `review.approval.allowWhenNoReviewGate` flag.

**Architecture:** A new three-state gate probe (`reviewGateStatus` → gated/ungated/unknown) reads the Rules API for `required_approving_review_count`. The approve preflight gains ONE branch: when the flag is on and the repo is neither protected nor exempt, a *positively-confirmed ungated* repo is allowed (unreadable → fail closed). The existing `approvalProtectionReady` is untouched. The `review.approved` audit field `protectionExempt: boolean` becomes an `approvalBasis: "protected" | "exempt" | "ungated"` enum that drives both audit and disclosure.

**Tech Stack:** TypeScript, Node's built-in test runner (`node --import tsx --test`), `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-20-approve-ungated-repos-design.md`

## Global Constraints

- Test command (from `packages/cli/`): `npm test` — runs `npm run typecheck:test && node --import tsx --test test/*.test.ts`. Single file: `node --import tsx --test test/<name>.test.ts`. Filter: add `--test-name-pattern "<substring>"`. Output uses `ℹ pass N` / `ℹ fail N`. Full suite takes >120s; if a tool backgrounds it, wait rather than assume failure.
- Baseline before this plan: **1048/1048** cli tests passing.
- Never mutate: build new objects/arrays (spread), never modify in place.
- No `console.log` in production code.
- **`approvalProtectionReady` in `packages/cli/src/adapters/github.ts` must not change**; its five tests (`test/github-review-helpers.test.ts:35,56,70,84,95`) stay green and unmodified.
- **Auto-allow fires ONLY on a positively-confirmed ungated repo.** `reviewGateStatus` returning `undefined` (unreadable) MUST fail closed (approve refused). Only a literal `false` may allow.
- The flag is a plain global boolean, default `false`. No per-repo list, no wildcards.
- Slack copy is 繁體中文台灣用語; technical identifiers stay English.
- Commit format `<type>: <description>`. NO attribution/Co-Authored-By trailer (disabled globally).
- Work on branch `feat/approve-ungated-repos` (already created; spec committed as `19a09d1`).
- **Line numbers are hints, not addresses** — measured against base `44a7ed2`; each task edits files earlier tasks touched. Locate every edit by the quoted surrounding code, never by the number. If a cited line does not contain what the plan says, search for the code.

---

### Task 1: Config flag `allowWhenNoReviewGate`

**Files:**
- Modify: `packages/cli/src/gateway/config.ts` — `ApprovalConfig` (~line 121), normalise approval block (~line 423-431), resolve approval block (~line 544-553)
- Test: `packages/cli/test/review-config.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `ApprovalConfig.allowWhenNoReviewGate?: boolean`; `resolveReviewConfig()` always fills `approval.allowWhenNoReviewGate` to a boolean (default `false`).

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` in `packages/cli/test/review-config.test.ts` (it already imports `resolveReviewConfig` from `../src/gateway/config`):

```ts
  it("defaults allowWhenNoReviewGate to false", () => {
    assert.equal(resolveReviewConfig({}).approval.allowWhenNoReviewGate, false);
    assert.equal(resolveReviewConfig({ approval: { enabled: true } }).approval.allowWhenNoReviewGate, false);
  });

  it("carries allowWhenNoReviewGate when set true, and ignores a non-boolean", () => {
    assert.equal(resolveReviewConfig({ approval: { enabled: true, allowWhenNoReviewGate: true } }).approval.allowWhenNoReviewGate, true);
    assert.equal(resolveReviewConfig({ approval: { enabled: true, allowWhenNoReviewGate: "yes" as never } }).approval.allowWhenNoReviewGate, false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/review-config.test.ts --test-name-pattern "allowWhenNoReviewGate"`
Expected: FAIL — `allowWhenNoReviewGate` is `undefined`, not `false`.

- [ ] **Step 3: Add the field to `ApprovalConfig`**

In `config.ts`, the `ApprovalConfig` interface currently is:

```ts
export interface ApprovalConfig {
  enabled: boolean;
  /**
   * Optional on the raw/partial side so `{ enabled }` alone still satisfies
   * `Partial<ReviewConfig>`; `resolveReviewConfig` always fills it to `[]`.
   */
  protectionExemptions?: ProtectionExemption[];
}
```

Add the field (optional on the partial side, same rationale):

```ts
export interface ApprovalConfig {
  enabled: boolean;
  /**
   * Optional on the raw/partial side so `{ enabled }` alone still satisfies
   * `Partial<ReviewConfig>`; `resolveReviewConfig` always fills it to `[]`.
   */
  protectionExemptions?: ProtectionExemption[];
  /**
   * Opt-in: allow approve without a per-repo exemption on any repo whose
   * ruleset positively shows no required-review gate (nothing to protect).
   * `resolveReviewConfig` always fills this to a boolean (default false).
   */
  allowWhenNoReviewGate?: boolean;
}
```

- [ ] **Step 4: Normalise the field**

In `normaliseReviewConfig`, the approval block currently is:

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

Add the boolean pass-through before `out.approval = normalised;`:

```ts
    if (Array.isArray(approval.protectionExemptions))
      normalised.protectionExemptions = asProtectionExemptions(approval.protectionExemptions);
    if (typeof approval.allowWhenNoReviewGate === "boolean")
      normalised.allowWhenNoReviewGate = approval.allowWhenNoReviewGate;
    out.approval = normalised;
```

- [ ] **Step 5: Resolve the default**

In `resolveReviewConfig`, the approval block currently ends with the `protectionExemptions:` line inside `approval: { ... }`. Add the resolved default as a sibling:

```ts
    approval: {
      enabled: raw?.approval?.enabled ?? false,
      // (existing protectionExemptions comment retained)
      protectionExemptions: asProtectionExemptions(raw?.approval?.protectionExemptions),
      allowWhenNoReviewGate: raw?.approval?.allowWhenNoReviewGate ?? false,
    },
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --import tsx --test test/review-config.test.ts`
Expected: PASS — the two new tests plus every pre-existing test in the file.

- [ ] **Step 7: Typecheck + commit**

Run: `npm test` → expect PASS (1050/1048+2).

```bash
git add packages/cli/src/gateway/config.ts packages/cli/test/review-config.test.ts
git commit -m "feat: add review.approval.allowWhenNoReviewGate config flag

Opt-in boolean (default false). resolveReviewConfig always fills it."
```

---

### Task 2: Three-state gate probe `reviewGateStatus`

**Files:**
- Modify: `packages/cli/src/adapters/github.ts` (add builder + probe near `approvalProtectionReady`, ~line 221)
- Modify: `packages/cli/src/gateway/slack/review.ts` — import (~line 57), `ReviewGateway` interface (~line 106), default gateway object (~line 124)
- Modify: `packages/cli/test/review-coordinator.test.ts` — `gw()` fake default (~line 22, alongside `approvalProtectionReady: async () => true`)
- Test: `packages/cli/test/github-review-helpers.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildGhArgs_getReviewGate(slug: string, branch: string): string[]`
  - `reviewGateStatus(args: {slug: string; branch: string; token?: string}, deps?: GithubDeps): Promise<boolean | undefined>` — `true`=gated (count≥1), `false`=ungated, `undefined`=unreadable
  - `ReviewGateway.reviewGateStatus: typeof reviewGateStatusImpl` (wired into the default gateway)

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/github-review-helpers.test.ts` (it imports helpers from `../src/adapters/github`; add `reviewGateStatus`, `buildGhArgs_getReviewGate` to that import):

```ts
describe("reviewGateStatus (three-state review-gate probe)", () => {
  const okExec = (stdout: string) => async () => ({ stdout, stderr: "" });
  const deps = (stdout: string) => ({ exec: okExec(stdout), findBinary: () => "/usr/bin/gh" });

  it("gated: a pull_request rule requiring >=1 review → true", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[1]") as never), true);
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[3]") as never), true);
  });

  it("ungated: empty ruleset → false", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[]") as never), false);
  });

  it("ungated: a rule with count 0 or absent (null) → false", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[0]") as never), false);
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[null]") as never), false);
  });

  it("unknown: an exec that throws → undefined (caller must fail closed)", async () => {
    const throwing = { exec: async () => { throw new Error("404"); }, findBinary: () => "/usr/bin/gh" };
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, throwing as never), undefined);
  });

  it("unknown: no gh binary → undefined", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, { findBinary: () => undefined } as never), undefined);
  });

  it("buildGhArgs_getReviewGate targets the Rules API and extracts the review count", () => {
    const args = buildGhArgs_getReviewGate("o/r", "main");
    assert.deepEqual(args.slice(0, 2), ["api", "repos/o/r/rules/branches/main"]);
    assert.ok(args.join(" ").includes("required_approving_review_count"));
    assert.ok(args.join(" ").includes("pull_request"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test test/github-review-helpers.test.ts --test-name-pattern "reviewGateStatus"`
Expected: FAIL — `reviewGateStatus`/`buildGhArgs_getReviewGate` are not exported.

- [ ] **Step 3: Add the builder + probe to `github.ts`**

Insert immediately AFTER the `approvalProtectionReady` function (do NOT modify `approvalProtectionReady` itself):

```ts
/**
 * Argv: read every active pull_request rule's required_approving_review_count
 * from the Rules API (same endpoint as buildGhArgs_getBranchRules, readable by
 * the read-only pinned identity). An empty array = no pull_request rule = no gate.
 */
export function buildGhArgs_getReviewGate(slug: string, branch: string): string[] {
  return ["api", `repos/${slug}/rules/branches/${branch}`, "--jq",
    '[.[] | select(.type == "pull_request") | .parameters.required_approving_review_count]'];
}

/**
 * Three-state review-gate probe for the ungated auto-allow path.
 *   true      → gated (some ruleset requires >=1 approving review)
 *   false     → ungated (no pull_request rule, or count 0/absent)
 *   undefined → unknown (no gh, or the Rules API is unreadable)
 * The undefined state is load-bearing: the caller allows ONLY on a literal
 * false, and fails closed on undefined. Classic (admin-only) branch protection
 * does not surface here — the org is rulesets-only, so an empty result is a
 * genuine "no gate" (see the design doc's accepted-risk section).
 */
export async function reviewGateStatus(
  args: { slug: string; branch: string; token?: string },
  deps: GithubDeps = {},
): Promise<boolean | undefined> {
  const exec = deps.exec ?? defaultExec;
  const gh = (deps.findBinary ?? findGhBinary)();
  if (!gh) return undefined;
  const env = args.token ? { ...process.env, GH_TOKEN: args.token } : process.env;
  try {
    const { stdout } = await exec(gh, buildGhArgs_getReviewGate(args.slug, args.branch), { env, timeoutMs: 15_000 });
    const counts = JSON.parse(stdout) as Array<number | null>;
    return counts.some((c) => typeof c === "number" && c >= 1);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Wire it into the `ReviewGateway` seam in `review.ts`**

In `review.ts`, the impl import block currently includes `approvalProtectionReady as approvalProtectionReadyImpl,`. Add alongside it:

```ts
  approvalProtectionReady as approvalProtectionReadyImpl,
  reviewGateStatus as reviewGateStatusImpl,
```

In the `ReviewGateway` interface, after `approvalProtectionReady: typeof approvalProtectionReadyImpl;` add:

```ts
  approvalProtectionReady: typeof approvalProtectionReadyImpl;
  reviewGateStatus: typeof reviewGateStatusImpl;
```

In the default gateway object, after `approvalProtectionReady: approvalProtectionReadyImpl,` add:

```ts
  approvalProtectionReady: approvalProtectionReadyImpl,
  reviewGateStatus: reviewGateStatusImpl,
```

- [ ] **Step 5: Give the test fake a safe default**

In `review-coordinator.test.ts`, the `gw()` helper defaults include `approvalProtectionReady: async () => true,`. Add a conservative default right after it (gated — so a test that reaches the probe without overriding does NOT silently auto-allow):

```ts
    approvalProtectionReady: async () => true,
    reviewGateStatus: async () => true,
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --import tsx --test test/github-review-helpers.test.ts`
Expected: PASS — the 6 new tests plus the pre-existing ones (the 5 `approvalProtectionReady` tests unchanged).

- [ ] **Step 7: Typecheck + commit**

Run: `npm test` → expect PASS.

```bash
git add packages/cli/src/adapters/github.ts packages/cli/src/gateway/slack/review.ts \
        packages/cli/test/github-review-helpers.test.ts packages/cli/test/review-coordinator.test.ts
git commit -m "feat: add three-state reviewGateStatus probe + gateway seam

Reads required_approving_review_count from the Rules API. true=gated,
false=ungated, undefined=unreadable (caller fails closed). Does not touch
approvalProtectionReady."
```

---

### Task 3: Preflight branch + `approvalBasis` audit enum + disclosure

**Files:**
- Modify: `packages/cli/src/gateway/events.ts` — `ReviewApprovedEvent` (~line 238-248)
- Modify: `packages/cli/src/gateway/slack/review.ts` — the preflight + audit + disclosure block (~line 578-634)
- Modify: `packages/cli/test/review-coordinator.test.ts` — migrate the existing audit test (~line 1118-1147); add new tests
- Test: `packages/cli/test/review-coordinator.test.ts`

**Interfaces:**
- Consumes: `review.approval.allowWhenNoReviewGate` (Task 1); `gateway.reviewGateStatus` (Task 2).
- Produces: `ReviewApprovedEvent.approvalBasis: "protected" | "exempt" | "ungated"` (replaces `protectionExempt`); the ungated Slack disclosure line.

**The core rule:** the gate probe runs at most once, only when the flag is on AND the repo is neither protected nor exempt. `undefined` (unreadable) must NOT allow. The `approvalBasis` is derived once and drives both the audit event and the disclosure.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("ReviewCoordinator.confirmApproveInThread", …)` block in `review-coordinator.test.ts`. `coord()`'s 4th arg is `reviewOverrides` merged into `config.review`. `readGatewayEvents` is imported dynamically in the existing audit test — reuse that pattern.

```ts
  it("approves an ungated repo when the flag is on, with basis 'ungated' and the no-gate note", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => false, // positively ungated
      resolveRepoSlug: async () => "onead/some-ungated-repo",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 555, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/some-ungated-repo/pull/7";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1, "an ungated repo must approve when the flag is on");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已真實 approve/.test(t)));
    assert.ok(allTexts.some((t) => /未要求任何核准/.test(t)), "the no-gate note must be shown");
    assert.ok(!allTexts.some((t) => /不會讓這個 approval 失效/.test(t)), "an ungated repo must NOT carry the stale-approval warning");
  });

  it("refuses an ungated-candidate when the gate probe is unreadable (fail closed)", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => undefined, // unreadable → must fail closed
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; throw new Error("must not be called"); },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 0, "an unreadable gate must never auto-allow");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /protection is not approval-ready/.test(t)));
  });

  it("still refuses a gated repo with the flag on (the ungated path must not fire)", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => true, // gated
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; throw new Error("must not be called"); },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 0, "a gated repo without an exemption must still be refused");
  });

  it("does not consult the gate probe when the flag is off (v0.33.0 parity)", async () => {
    const web = new FakeWebClient();
    let probed = 0, approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => { probed++; return false; },
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; return { reviewId: 1, state: "APPROVED", commitId: "x", actor: "expected-bot" }; },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true } }); // flag defaults off
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(probed, 0, "the gate probe must not run when the flag is off");
    assert.equal(approved, 0, "an ungated repo with the flag off is refused, as in v0.33.0");
  });

  it("records approvalBasis 'ungated' in the audit log", async () => {
    const { readGatewayEvents } = await import("../src/gateway/events");
    const web = new FakeWebClient();
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => false,
      resolveRepoSlug: async () => "onead/some-ungated-repo",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => ({ reviewId: 9, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" }),
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/some-ungated-repo/pull/7";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    const ev = readGatewayEvents().filter((e) => e.type === "review.approved")[0] as never as { approvalBasis: string; exemptionReason?: string };
    assert.equal(ev.approvalBasis, "ungated");
    assert.equal(ev.exemptionReason, undefined);
  });
```

- [ ] **Step 2: Migrate the existing v0.33.0 audit test**

The existing test "records every real approval in the audit log, flagging the accepted risk" casts to `{ …; protectionExempt: boolean }` and asserts `ev.protectionExempt === true`. Change BOTH: the cast type field to `approvalBasis: string`, and the final assertion:

```ts
    const ev = approvals[0] as never as { actor: string; repo: string; pr: number; reviewId: number; approvalBasis: string };
```
```ts
    assert.equal(ev.approvalBasis, "exempt", "the accepted risk must be on the record");
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test test/review-coordinator.test.ts --test-name-pattern "ungated|approvalBasis|audit log"`
Expected: FAIL — `allowWhenNoReviewGate` has no effect yet; `approvalBasis` is not on the event.

- [ ] **Step 4: Replace `protectionExempt` with `approvalBasis` in `events.ts`**

`ReviewApprovedEvent` currently has `protectionExempt: boolean;`. Replace that line:

```ts
export interface ReviewApprovedEvent {
  type: "review.approved";
  actor: string;
  repo: string;      // owner/repo slug
  pr: number;
  commit: string;    // the exact head SHA that was approved
  reviewId: number;
  /** How the branch-protection preflight was satisfied for this approve. */
  approvalBasis: "protected" | "exempt" | "ungated";
  /** The waiver's recorded justification, when the basis is "exempt". */
  exemptionReason?: string;
}
```

`"review.approved"` is already in `VALID_TYPES` (v0.33.0) — do not re-add it.

- [ ] **Step 5: Add the preflight branch + basis + audit + disclosure in `review.ts`**

The current block (from `const exemption = …` through the `this.reply(...)` with `approvedLine`/`riskLine`/`obsoleteLine`) changes as follows.

Replace the preflight head (`const exemption` … `const exemptionInEffect = !protectionReady && !!exemption;`) with:

```ts
        const exemption = findProtectionExemption(review.approval, slug);
        const protectionReady = await gateway.approvalProtectionReady({ slug, branch: ref.baseRef, token });
        // Ungated auto-allow: only when the flag is on and the repo is neither
        // protected nor exempt. The probe distinguishes ungated (false) from
        // unreadable (undefined) — only a positive false may allow; undefined
        // fails closed. Runs at most once, and never on the protected/exempt paths.
        let ungatedAllow = false;
        if (review.approval.allowWhenNoReviewGate && !protectionReady && !exemption) {
          ungatedAllow = (await gateway.reviewGateStatus({ slug, branch: ref.baseRef, token })) === false;
        }
        if (!protectionReady && !exemption && !ungatedAllow)
          throw new Error("repository protection is not approval-ready");
        const exemptionInEffect = !protectionReady && !!exemption;
        const approvalBasis: "protected" | "exempt" | "ungated" =
          protectionReady ? "protected" : exemptionInEffect ? "exempt" : "ungated";
```

Replace the `appendGatewayEvent({ type: "review.approved", … })` call's last two fields:

```ts
        appendGatewayEvent({
          type: "review.approved",
          actor: actorUserId,
          repo: slug,
          pr: ref.number,
          commit: ref.headSha,
          reviewId: posted.reviewId,
          approvalBasis,
          exemptionReason: approvalBasis === "exempt" ? exemption!.reason : undefined,
        });
```

Replace the disclosure block (`const approvedLine` through `await this.reply(...)`) to add the ungated line (keep `riskLine` and `obsoleteLine` exactly):

```ts
        const approvedLine = `:white_check_mark: 已真實 approve ${slug}#${ref.number}（commit \`${ref.headSha.slice(0, 7)}\`，GitHub review #${posted.reviewId}）。`;
        const riskLine = approvalBasis === "exempt"
          ? `\n:warning: 此 repo 未啟用 dismiss-stale/require-last-push：後續新 push 不會讓這個 approval 失效，可能被用來 merge 未經 review 的 commit。豁免理由：${exemption!.reason}`
          : "";
        const ungatedLine = approvalBasis === "ungated"
          ? `\n:information_source: 此 repo 的 ruleset 未要求任何核准，approve 僅為 review 簽核紀錄，不影響 merge 條件。`
          : "";
        const obsoleteLine = protectionReady && exemption
          ? `\n:information_source: ${slug} 的 protection 豁免已不再需要（branch 現已同時啟用 dismiss-stale 與 require-last-push），可以從 config 移除。`
          : "";
        await this.reply(reservation.channelId, reservation.threadTs, `${approvedLine}${riskLine}${ungatedLine}${obsoleteLine}`);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --import tsx --test test/review-coordinator.test.ts`
Expected: PASS — the 5 new tests, the migrated audit test, and every pre-existing test (the v0.33.0 exempt/obsolete/scoping tests still pass; `gw()`'s `approvalProtectionReady: async () => true` keeps them on the protected path where the probe never runs).

- [ ] **Step 7: Full suite + commit**

Run: `npm test` → expect PASS. A `GatewayEvent` exhaustiveness error would mean a consumer switches on `.type`; there is none for `review.*` today, so none is expected.

```bash
git add packages/cli/src/gateway/events.ts packages/cli/src/gateway/slack/review.ts \
        packages/cli/test/review-coordinator.test.ts
git commit -m "feat: auto-allow approve on ungated repos + approvalBasis audit enum

Preflight gains one branch: flag on + not-protected + not-exempt + probe
positively ungated -> allow (unreadable fails closed). review.approved
records approvalBasis protected|exempt|ungated; ungated approves carry a
no-gate note, not the stale-approval warning."
```

---

### Task 4: Doctor reports the flag

**Files:**
- Modify: `packages/cli/src/gateway/doctor-checks/review.ts` — the `detail` line + a warning when on
- Test: `packages/cli/test/gateway-doctor.test.ts` (extend)

**Interfaces:**
- Consumes: `review.approval.allowWhenNoReviewGate` (Task 1).
- Produces: nothing consumed downstream — reporting only.

**Constraint:** config-only, no live gh call (the check's documented contract).

- [ ] **Step 1: Write the failing tests**

Append a `describe` to `gateway-doctor.test.ts` (mirror the existing exemption tests; assert on `res.message`, never `severity` — mra/gh presence makes severity non-deterministic):

```ts
describe("doctor — allowWhenNoReviewGate", () => {
  it("reports the flag state in detail and warns when on", async () => {
    const { reviewDoctorCheck } = await import("../src/gateway/doctor-checks/review");
    const res = await reviewDoctorCheck({
      configPath: "/nonexistent/gateway.json",
      config: { review: { enabled: true, approval: { enabled: true, allowWhenNoReviewGate: true } } },
    } as never);
    assert.match(res.message, /allowWhenNoReviewGate=on/);
    assert.match(res.message, /no required-review gate/i);
  });

  it("shows the flag off by default", async () => {
    const { reviewDoctorCheck } = await import("../src/gateway/doctor-checks/review");
    const res = await reviewDoctorCheck({
      configPath: "/nonexistent/gateway.json",
      config: { review: { enabled: true, approval: { enabled: true } } },
    } as never);
    assert.match(res.message, /allowWhenNoReviewGate=off/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --import tsx --test test/gateway-doctor.test.ts --test-name-pattern "allowWhenNoReviewGate"`
Expected: FAIL — the message has no `allowWhenNoReviewGate=` text.

- [ ] **Step 3: Report the flag in `doctor-checks/review.ts`**

The `detail` line currently ends with `; exemptions=${exemptions.length}`. Append the flag state:

```ts
  const detail = `mra=${mraPresent ? "found" : "missing"}; protocol=${protocol ? "v1" : "legacy/unavailable"}; gh=${ghPresent ? "found" : "missing"}; provider=${review.providerMode}; strategy=${review.strategy}; approval=${review.approval.enabled ? "enabled" : "disabled"}; exemptions=${exemptions.length}; allowWhenNoReviewGate=${review.approval.allowWhenNoReviewGate ? "on" : "off"}`;
```

Add a warning where the exemption warnings are pushed (after the `dropped` warning block, before `detail` is built — move the `detail` line below this if needed, or push into `warnings` which `detail` does not depend on):

```ts
  if (review.approval.allowWhenNoReviewGate) {
    warnings.push(
      "allowWhenNoReviewGate=on — approve is auto-allowed on repos with no required-review gate (org-level risk acceptance; classic admin-only branch protection is not readable, so this assumes rulesets-only)",
    );
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --import tsx --test test/gateway-doctor.test.ts --test-name-pattern "allowWhenNoReviewGate"`
Expected: PASS — 2 tests.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → expect PASS.

```bash
git add packages/cli/src/gateway/doctor-checks/review.ts packages/cli/test/gateway-doctor.test.ts
git commit -m "feat: doctor reports allowWhenNoReviewGate + the org-level risk note"
```

---

## Rollout (do NOT fold into the tasks above)

After all tasks green and merged/tagged. A separate, deliberate act:
1. Set `review.approval.allowWhenNoReviewGate: true` in `~/.pmk/gateway.json` (immutable edit; back up first; preserve `enabled`, `protectionExemptions`, `expectedGhUser`, `ghToken`).
2. Rebuild cli + restart the gateway (verify slack.com reachable first): `launchctl kickstart -k gui/$(id -u)/com.pmk.gateway`.
3. `pmk gateway doctor` — expect `allowWhenNoReviewGate=on` and the risk warning.
4. Live-verify opportunistically on the next genuine ungated-repo approval — expect a real APPROVE + the no-gate note. The `onead/oss-ui-v2` exemption stays (it is gated, so the flag does not cover it).
