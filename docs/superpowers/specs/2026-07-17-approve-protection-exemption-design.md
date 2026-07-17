# Approve protection exemption (per-repo)

**Date:** 2026-07-17
**Status:** Approved, pending implementation
**Amends:** `2026-07-03-review-approve-progress-design.md` (#90 approve), `packages/cli/src/gateway/review-policy.ts:3-10`

## Problem

`:a:` approve shipped in v0.32.0 and was live-verified against a real GitHub approve. It
does not work on the repo it was built for. On `onead/oss-ui-v2` — the real workload — every
`:cr:` review ends with:

```
:mag: 已完成 onead/oss-ui-v2#299 review（GitHub action: COMMENTED；0 則；未執行 GitHub approve）
```

That line is not a review verdict. It is `review-messages.ts:36`, the fallback branch, taken
unconditionally because `~/.pmk/gateway.json` has `review.approval.enabled: false`. A perfect
zero-blocker review prints the same string.

Turning the flag on is not sufficient. The approve preflight at `review.ts:573` calls
`approvalProtectionReady`, which requires the target branch to have **both**
`dismiss_stale_reviews_on_push` and `require_last_push_approval` enabled. Verified state of
`onead/oss-ui-v2` `main` (ruleset `8015695`) on 2026-07-17:

| Setting | Actual | Probe requires |
| --- | --- | --- |
| `dismiss_stale_reviews_on_push` | `false` | `true` |
| `require_last_push_approval` | `false` | `true` |
| `required_approving_review_count` | `1` | — |

The pinned review identity `HanfourHuangOneAD` has `push: true` but `admin: false` on that
repo, so it cannot change the ruleset. With the flag on, `:a:` → thread `approve` would fail
at the probe with `:no_entry: approve preflight 未通過…repository protection is not approval-ready`.

The blocker is org-side policy, not gateway code.

## Decision

Add a **per-repo, explicitly-reasoned exemption** to the branch-protection preflight, paired
with honest disclosure in Slack and a real audit trail. The `:cr:`/`:a:` two-step UX does not
change.

### Rejected alternatives

- **Ask onead admin to enable the two controls.** Correct and safest; the probe would pass
  legitimately with zero code change. Rejected as the *primary* path because it is outside the
  owner's control (`admin: false`), has an unknown timeline, and changes the whole team's
  workflow (every push would dismiss existing approvals). Still the right long-term end state.
- **Gateway self-enforces dismiss-stale semantics.** After approving, watch the PR head and
  auto-dismiss its own approval when a push lands. Closes the hole without org action, but
  reimplements branch protection in userspace: gateway downtime or a missed poll is an open
  window, and the failure mode is silent.
- **Auto-approve on zero blockers, or collapse `:a:` to one step.** Considered and declined.
  The two-step exists so that the admin authorizes *after* seeing the review result. Keeping it
  means the exemption changes the safety envelope only, not who decides.

## Risk accepted

Stated plainly, because this weakens one of the four preflights that `review-policy.ts:3-10`
cites as justification for lifting the release veto:

> On an exempt repo, PMK's approval satisfies `required_approving_review_count: 1`. Because
> `dismiss_stale_reviews_on_push` is `false`, a push landing **after** the approval does not
> invalidate it. Code that PMK never reviewed can therefore be merged on the strength of PMK's
> approval of an earlier commit.

This is not a race. It is a durable hole, and it is a realistic accident (author pushes "one
more fix" after approval, then merges), not only an insider attack.

**Context that makes it acceptable:** the identical hole already applies to every *human*
approval on that repo, because `dismiss_stale_reviews_on_push: false` is repo-wide. The probe
was holding PMK to a stricter standard than the repo holds its own engineers. The exemption
removes that asymmetry; it does not introduce a new class of risk.

**What still bounds the approve, unchanged:**

- `review.approval.enabled` runtime gate, admin-only, default `false`
- Admin identity check, blocklist, `repoAllowlist`
- A prior `:cr:` review producing a zero-blocker offer with a protocol-v1 artifact
- An explicit `approve` reply in-thread by an admin
- GitHub identity pinned to `expectedGhUser`
- Head SHA + baseRef pinned before the POST and re-verified after it
- Three revision fences and the cross-process authorization lock

The gateway will still never approve a commit that moved *during* the operation. The residual
hole is strictly what happens *after* a successful approve.

**What does not bound it:** nothing prevents a later push from riding the approval. That is the
accepted hole, and the reason disclosure and audit logging are part of this design rather than
nice-to-haves.

## Design

### 1. Config shape

```json
"review": {
  "approval": {
    "enabled": true,
    "protectionExemptions": [
      { "repo": "onead/oss-ui-v2",
        "reason": "ruleset 8015695 未開 dismiss_stale/require_last_push；admin 調整前的過渡豁免" }
    ]
  }
}
```

An array of objects rather than `string[]`, with **`reason` required**. The requirement is the
mechanism, not ceremony: it forces whoever adds a repo to record why, and the string is carried
into the Slack disclosure, the audit event, and `doctor`.

**Invalid-entry handling (explicit):** an entry that is not an object, or lacks a non-empty
string `repo`, or lacks a non-empty string `reason`, is **dropped individually**. The rest of
the config loads normally; the gateway does not refuse to start. Dropping is the fail-safe
direction — a dropped exemption means the probe is enforced and the approve is refused, which is
the current behaviour. It also matches the existing permissive pattern at `config.ts:380-383`.
Because a typo would otherwise present as a silent "why isn't approve working", `doctor` reports
dropped entries (see §5).

Touch points: type at `config.ts:112`, validation at `config.ts:380-383`, resolution at
`config.ts:497` (default `[]`).

### 2. Exemption applies at the call site, not inside the probe

`approvalProtectionReady` (`github.ts:221`) is **unchanged**. It continues to answer truthfully
whether the branch is protected. The exemption is policy layered on top of that fact:

```ts
const exempt = isProtectionExempt(review.approval, slug);
if (!exempt && !await gateway.approvalProtectionReady({ slug, branch: ref.baseRef, token }))
  throw new Error("repository protection is not approval-ready");
```

Two consequences worth naming:

- The probe's existing tests stay meaningful and untouched — the five that exercise
  `approvalProtectionReady` directly (`github-review-helpers.test.ts:35,56,70,84,95`) still
  assert real protection behaviour, including the `#90` Rules-API-first ordering.
- `policyRevision` (`review.ts:559`) already serialises the whole `review` object, so
  `protectionExemptions` is **automatically covered by the three revision fences** — an
  exemption cannot be introduced mid-approve. This falls out of the existing design for free.

`isProtectionExempt` is a pure function: exact slug match, no wildcards.

### 3. Disclosure

Two places. The offer message (`review-messages.ts:34`) gains a note. The load-bearing one is
the approve success message (`review.ts:610`), because that is the moment the risk goes live:

```
:white_check_mark: 已真實 approve onead/oss-ui-v2#301（commit `9236381`，GitHub review #12345）。
:warning: 此 repo 未啟用 dismiss-stale/require-last-push：後續新 push 不會讓這個 approval 失效，
   可能被用來 merge 未經 review 的 commit。豁免理由：ruleset 8015695 未開…
```

### 4. Audit event (new — closes an existing gap)

`publishApprovalReservation` (`review.ts:537-625`) currently emits **no** gateway events at all.
Real GitHub approvals leave no trace outside the Slack thread; the event log only has
`review.triggered`, `review.skipped`, `review.posted`. Approving under an accepted risk without
an audit record is not defensible, so:

```ts
appendGatewayEvent({
  type: "review.approved",
  actor: actorUserId, repo: slug, pr: ref.number,
  commit: ref.headSha, reviewId: posted.reviewId,
  protectionExempt: exempt,
});
```

### 5. Doctor

`doctor-checks/review.ts` already reports approval state. Extend it to:

- List exempt repos with their reasons.
- **Probe each exempt repo live.** If the branch now satisfies both controls, report that the
  exemption is no longer needed and can be removed. This prevents an exemption from silently
  outliving its justification — the main way a transitional risk acceptance becomes permanent.
- **Report dropped entries** (§1). Without this, a typo in `repo` or a missing `reason` silently
  degrades to "no exemption", and the only symptom is an approve that keeps failing the probe.

### 6. Policy comment

`review-policy.ts:3-10` lists `protection` among the preflights justifying the lifted veto.
Amend it to say the protection preflight is exemptible per-repo and point here. The code comment
must not overstate the guarantee.

## Testing

`github-review-helpers.test.ts` is untouched (12 tests, five of which exercise the probe
directly). New coverage:

- `isProtectionExempt`: exact slug match; non-listed repo not exempt; no wildcard behaviour
  (`onead/*` and `onead/oss-ui-v2-fork` must not match an `onead/oss-ui-v2` entry)
- Config validation: entry with missing/empty/whitespace `reason` dropped; entry with missing
  `repo` dropped; non-object entry dropped; a valid entry alongside an invalid one survives;
  the surrounding config still loads; default `[]`
- Coordinator: exempt repo approves even with `approvalProtectionReady: async () => false`;
  non-exempt repo still throws `repository protection is not approval-ready`
- Fence: an exemption added mid-approve is rejected by the revision fence
- Disclosure: offer and success text include the warning and reason when exempt; unchanged when not
- Event: `review.approved` emitted with correct `protectionExempt` on both exempt and non-exempt paths

## Out of scope

- Wildcard or org-level exemptions (`onead/*`) — precisely the blast radius a risk exemption
  must not have
- Any change to `approvalProtectionReady`'s own logic
- Auto-approve on zero blockers; collapsing the `:a:` two-step
- Pursuing the onead ruleset change (worth doing, tracked separately; the doctor hint in §5 is
  the cheap detector for when it lands)

## Rollout

Code first, tests green. Then the ops step, as a separate deliberate action: flip
`review.approval.enabled` to `true` in `~/.pmk/gateway.json` and add the `onead/oss-ui-v2`
exemption. Note `#299` is already closed and cannot serve as a live test; live verification
needs an open PR on that repo.
