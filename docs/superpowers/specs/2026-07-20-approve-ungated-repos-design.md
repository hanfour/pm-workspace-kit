# Auto-allow approve on repos with no required-review gate

**Date:** 2026-07-20
**Status:** Approved, pending implementation
**Builds on:** `2026-07-17-approve-protection-exemption-design.md` (v0.33.0), `packages/cli/src/adapters/github.ts` `approvalProtectionReady`, `packages/cli/src/gateway/slack/review.ts` `publishApprovalReservation`

## Problem

v0.33.0 shipped a per-repo branch-protection exemption so `:a:` approve could run on
`onead/oss-ui-v2` (a repo that gates merge on one review but leaves `dismiss_stale` +
`require_last_push` off, and whose ruleset the pinned identity can't change). The exemption is
deliberate, per-repo, and reason-required.

But the real reviewer reviews across **many** onead repos and performs an approve on each as a
code-review sign-off — a meaningful, visible record even where GitHub does not gate the merge on
it. Most of those repos have **no required-review gate at all** (empty rulesets: no
`required_approving_review_count`). On those, the approve preflight still refuses
(`approvalProtectionReady` returns false → `repository protection is not approval-ready`),
because the branch lacks the two controls. A per-repo exemption for each of them would be a
standing maintenance burden and would carry a mandatory-reason ceremony that isn't warranted.

The branch-protection preflight exists to prevent one harm: a stale or unreviewed approval
enabling a merge **through a required-review gate**. If a repo has no required-review gate, the
preflight is protecting against nothing — the repo already permits unreviewed merges without any
approval. So on ungated repos the approve is harmless and should be allowed.

## Decision

Add an opt-in config flag `review.approval.allowWhenNoReviewGate` (default **false**). When on,
the approve preflight allows an approve — without a per-repo exemption — on any repo whose
ruleset **positively shows no required-review gate**. Repos that *do* gate on review but lack the
two protection controls (like `oss-ui-v2`) still require a deliberate per-repo exemption; nothing
about that path changes.

### Rejected alternatives

- **Org-wide wildcard exemption (`onead/*`).** Simplest for the operator, but it exempts every
  repo including the genuinely gated ones (oss-ui-v2 and any future gated repo), letting the bot
  approve past protection anywhere. This is exactly the blast radius the v0.33.0 design refused
  to allow, and it conflates "no gate to protect" with "gate deliberately waived". Rejected.
- **Keep per-repo exemptions, add-on-demand.** Safe and maximally deliberate, but it makes the
  operator file a reason-required entry for every ungated repo they review — the friction the
  reviewer is asking to remove. Rejected as the primary path (per-repo exemptions remain for the
  gated case).

## Risk accepted

Stated plainly, because this bypasses the same preflight the exemption does — but the residual
risk is strictly smaller:

> On a repo whose ruleset requires **no** approving review, the bot's approve gates nothing. A
> stale approval enabling an unreviewed merge is impossible there, because unreviewed merges are
> *already* possible without any approval. The approve is a review record, not a merge gate.

**The only residual risk is the classic-protection blind spot.** `approvalProtectionReady` (and
this feature's gate probe) read the **Rules API**, which is readable by the pinned read-only
identity; GitHub's *classic* branch-protection settings are ADMIN-only and 404 for that identity
(this is exactly why #90 moved to the Rules API). So a repo that gates reviews via *classic*
protection would read as "no ruleset gate" and be wrongly auto-allowed.

**This blind spot is confirmed non-existent for the target org:** onead manages branch protection
exclusively via rulesets (verified — `oss-ui-v2` uses ruleset `8015695`; repos with no gate
return an empty Rules API result). An empty ruleset therefore genuinely means no gate. The flag
is an explicit, org-level opt-in that records this risk acceptance; it defaults off.

**Fail-closed on uncertainty.** The auto-allow fires only when the gate probe *positively
confirms* no gate. If the Rules API is unreadable (error, timeout, plan limits), the probe
returns "unknown" and the approve is **refused**, not allowed — the same conservative direction
`approvalProtectionReady` already takes.

## Design

### 1. Config

```json
"review": {
  "approval": {
    "enabled": true,
    "allowWhenNoReviewGate": true,
    "protectionExemptions": [
      { "repo": "onead/oss-ui-v2", "reason": "ruleset 8015695 未開 dismiss_stale/require_last_push" }
    ]
  }
}
```

`allowWhenNoReviewGate: boolean`, default `false`. Added to `ApprovalConfig`
(`config.ts`), normalised and resolved beside `enabled` and `protectionExemptions`. It is a
plain boolean — no per-repo list — because the whole point is to cover the many ungated repos
without per-repo entries.

### 2. Gate detection — a three-state probe

New pure argv builder + async probe in `packages/cli/src/adapters/github.ts`, a sibling of
`approvalProtectionReady`, which stays **untouched**:

```ts
// argv: read the required-review count from the active ruleset
export function buildGhArgs_getReviewGate(slug, branch): string[]  // Rules API, extracts required_approving_review_count

// returns: true = gated (count>=1), false = ungated (no rule / count 0), undefined = unreadable
export async function reviewGateStatus(args: {slug, branch, token?}, deps?): Promise<boolean | undefined>
```

Semantics of `reviewGateStatus`:

- No `gh` binary, or the Rules API call throws → `undefined` (unknown).
- Rules API returns no `pull_request` rule, or a rule with `required_approving_review_count`
  absent or `0` → `false` (ungated).
- Any `pull_request` rule with `required_approving_review_count >= 1` → `true` (gated).

Returning `boolean | undefined` (not a bare boolean) is load-bearing: the caller must
distinguish "confirmed ungated" from "couldn't tell", because only the former may auto-allow.

### 3. Preflight integration

In `publishApprovalReservation` (`review.ts`), the current preflight is:

```ts
const exemption = findProtectionExemption(review.approval, slug);
const protectionReady = await gateway.approvalProtectionReady({ slug, branch: ref.baseRef, token });
if (!protectionReady && !exemption)
  throw new Error("repository protection is not approval-ready");
const exemptionInEffect = !protectionReady && !!exemption;
```

It becomes (one added branch; the exemption and protectionReady paths are unchanged):

```ts
const exemption = findProtectionExemption(review.approval, slug);
const protectionReady = await gateway.approvalProtectionReady({ slug, branch: ref.baseRef, token });
// Only probe the review gate when it could change the outcome: flag on, not
// already protected, not exempt. The probe distinguishes ungated (false) from
// unreadable (undefined) — only a POSITIVE "ungated" may auto-allow.
let ungatedAllow = false;
if (review.approval.allowWhenNoReviewGate && !protectionReady && !exemption) {
  ungatedAllow = (await gateway.reviewGateStatus({ slug, branch: ref.baseRef, token })) === false;
}
if (!protectionReady && !exemption && !ungatedAllow)
  throw new Error("repository protection is not approval-ready");
const exemptionInEffect = !protectionReady && !!exemption;
```

The gate probe runs at most once, and only on the ungated-candidate path — the existing
protected and exempt approvals make no extra API call. `approvalProtectionReady` is not touched,
so its five tests stay green.

**The approval basis** (for disclosure and audit) is derived once:

- `protectionReady` → `"protected"`
- else `exemptionInEffect` → `"exempt"`
- else `ungatedAllow` → `"ungated"`
- (else the preflight already threw)

### 4. Disclosure

Consistent with the v0.33.0 honesty rule: the message asserts only what the probe measured. When
the basis is `"ungated"`, the approve success line adds:

```
:information_source: 此 repo 的 ruleset 未要求任何核准，approve 僅為 review 簽核紀錄，不影響 merge 條件。
```

No stale-approval risk warning (that harm is moot with no gate). The classic-protection caveat is
**not** repeated per-message — it lives in the flag's config docs and the doctor report, so the
common case stays uncluttered.

The `"exempt"` basis keeps its existing v0.33.0 warning; `"protected"` keeps its plain success
line.

### 5. Audit

`review.approved` (`events.ts`) replaces the `protectionExempt: boolean` field with an enum:

```ts
approvalBasis: "protected" | "exempt" | "ungated";
exemptionReason?: string;   // unchanged, present only when basis === "exempt"
```

The enum states the exact basis of every real approve on one field, which is what an auditor
needs. v0.33.0 shipped `protectionExempt` only days earlier and — because the positive
live-verify was deferred — **no real `review.approved` event with a non-default basis exists on
disk yet**, so replacing the boolean is a zero-migration change. The JSONL reader is tolerant of
the shape change (unknown/missing fields don't reject a record).

The existing v0.33.0 audit test ("records every real approval in the audit log, flagging the
accepted risk", `review-coordinator.test.ts`) asserts `protectionExempt === true`; it migrates to
`approvalBasis === "exempt"`. This is an in-repo test update, not a compatibility break — the
event type is internal.

### 6. Doctor

`doctor-checks/review.ts` reports the flag state, config-only (no live gh call, honouring the
check's contract). Extend the `detail` line with `allowWhenNoReviewGate=on|off`, and when it is
on, add a warning noting the org-level risk acceptance and the classic-protection blind spot
(one line, since this is where the caveat belongs).

### 7. Interaction summary (the full preflight truth table, flag on)

| Repo ruleset state | Exemption? | Outcome | Basis |
| --- | --- | --- | --- |
| Both controls on | — | approve | protected |
| Gated (count≥1), controls off | yes | approve | exempt |
| Gated (count≥1), controls off | no | **refuse** | — |
| Ungated (no rule / count 0) | — | approve | ungated |
| Rules API unreadable | no | **refuse** (fail closed) | — |

With the flag **off**, the "ungated → approve" row instead refuses — behaviour is identical to
v0.33.0.

## Testing

New coverage:

- `reviewGateStatus`: gated ruleset (count≥1) → `true`; empty ruleset → `false`; rule with count
  `0`/absent → `false`; unreadable (throw) → `undefined`; no gh → `undefined`.
- `buildGhArgs_getReviewGate`: argv shape (unit).
- Coordinator, flag **on**: ungated repo (probe `false`) approves with basis `"ungated"` and the
  no-gate disclosure; unreadable repo (probe `undefined`) is **refused** (fail closed); a gated
  repo with controls off and no exemption is still **refused** (the ungated path must not fire).
- Coordinator, flag **off**: an ungated repo is refused (v0.33.0 parity) — the probe is never
  called.
- Exemption precedence: an exempt gated repo still approves as `"exempt"` (not `"ungated"`), and
  the gate probe is not consulted for it.
- Disclosure: ungated success line carries the no-gate note and NOT the stale-approval warning.
- Audit: `approvalBasis` is `"protected"` / `"exempt"` / `"ungated"` on the three success paths.
- `approvalProtectionReady` and its five tests are untouched.

## Out of scope

- Any change to `approvalProtectionReady`'s own logic or its Rules-API-first probe order.
- Reading classic branch protection (still admin-only / unreadable — the fail-closed default and
  the rulesets-only org assumption cover it).
- Per-repo granularity for the flag (it is deliberately global — YAGNI; the gated case already
  has per-repo exemptions).
- A "known-gated, never auto-allow" denylist (unnecessary given onead is rulesets-only and the
  probe reads the real gate).

## Rollout

Code first, tests green, merged, tagged. Then the ops step, separately: set
`review.approval.allowWhenNoReviewGate: true` in `~/.pmk/gateway.json`, restart the gateway, and
confirm via `pmk gateway doctor`. The existing `onead/oss-ui-v2` exemption stays (it is gated, so
the flag does not cover it). Live-verify opportunistically on the next genuine ungated-repo
approval — the bot should approve and post the no-gate note.
