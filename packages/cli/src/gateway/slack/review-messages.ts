/**
 * Slack result-line formatting for review / approve outcomes, plus the mra
 * failure describer. Pure functions extracted from review.ts (re-exported there
 * for back-compat) so the coordinator holds orchestration, not copy.
 */
import type { PrRef } from "../pr-ref";
import type { FinalizedReview } from "../review-claim";

/** Fields of an mra review result that shape the Slack result line. */
export interface ReviewOutcome {
  status?: string;
  commentCount?: number;
  blockerCount?: number;
  /** mra posted a neutral REVIEW_INCOMPLETE placeholder — the review never evaluated the PR. */
  incomplete?: boolean;
  protocolVersion?: "1.0";
  artifactSha256?: string;
  analyzedHeadSha?: string;
}

export function canConfirmApproveFromReview(res: ReviewOutcome): boolean {
  if (res.incomplete === true) return false;
  return res.protocolVersion === "1.0" && typeof res.artifactSha256 === "string" &&
    typeof res.analyzedHeadSha === "string" && res.blockerCount === 0 &&
    (res.status === "COMMENT" || res.status === "COMMENTED");
}

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
  /**
   * Which command the user actually typed. An `:a:` with no offer yet runs a
   * review FIRST and delegates here, so without this the reply lectured the
   * user about `:cr:` not auto-approving when they had typed `:a:` — advice
   * about a command they did not use.
   */
  origin: "cr" | "a" = "cr",
): string {
  if (res.incomplete)
    return `:warning: ${slug}#${ref.number} review 未完成（mra 回報 REVIEW_INCOMPLETE，未真正評估此 PR — 可能 max-turns 截斷或 provider 呼叫失敗）；已貼中性佔位，claim 已釋放，請重試 :cr:：${ref.url}`;
  const status = res.status ?? "COMMENT";
  const count = res.commentCount ?? 0;
  if (approvalEnabled && canConfirmApproveFromReview(res)) {
    const exemptNote = protectionExempted
      ? "（此 repo 已列入 protection 豁免清單，approve 時會略過 branch-protection 檢查）"
      : "";
    return `:mag: 已完成 ${slug}#${ref.number} review（GitHub action: ${status}；${count} 則）。這個結果沒有 HIGH/CRITICAL blocker，可進一步 approve，但 \`:${origin}:\` 不會主動 approve；請由 PMK admin 在此 channel thread @PMK 回覆 \`approve\` 授權（DM 可直接回覆）${exemptNote}：${ref.url}`;
  }
  return `:mag: 已完成 ${slug}#${ref.number} review（GitHub action: ${status}；${count} 則；未執行 GitHub approve）：${ref.url}`;
}

/**
 * Result line for a `:a:` approve. Incomplete first (a REVIEW_INCOMPLETE run posts a
 * neutral placeholder whose GitHub event reads COMMENT — without this branch it would
 * fall through to the misleading "請至 PR 確認是否已 approve"). Then three-way on the
 * mra status: the batch-fallback path (review.sh) posts individual comments and prints
 * NO `status:` line, so `status` is undefined there — we must NOT claim "發現重大問題 /
 * 未 approve" then, because GitHub may in fact have recorded an APPROVE. Point the user
 * to the PR instead of asserting a verdict we can't read.
 */
export function approveResultText(slug: string, ref: PrRef, res: ReviewOutcome): string {
  const cc = res.commentCount ?? 0;
  if (res.incomplete)
    return `:warning: 未 approve ${slug}#${ref.number} — review 未完成（mra 回報 REVIEW_INCOMPLETE，可能 max-turns 截斷或 provider 呼叫失敗），未做任何 approve；請重試 :a: 或手動 review：${ref.url}`;
  if (res.status === "APPROVED")
    return `:white_check_mark: 已 approve ${slug}#${ref.number}（無重大問題；${cc} 則 minor 建議）：${ref.url}`;
  if (res.status === "CHANGES_REQUESTED")
    return `:no_entry: 未 approve ${slug}#${ref.number} — 發現重大問題，已請求修改（${cc} 則）：${ref.url}`;
  return `:information_source: 已完成 ${slug}#${ref.number} review（GitHub 未回報 approve 狀態，${cc} 則；請至 PR 確認是否已 approve）：${ref.url}`;
}

/** Taipei-local `MM/DD HH:mm` — the zone everyone reading the thread is in. */
function taipeiStamp(iso?: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * The note posted when a trigger names a commit that was already reviewed.
 *
 * It has to answer the question the user actually has — "so what happened to my
 * push?" — because the person hitting it has almost always just pushed a fix.
 * The 2026-08-12 incident (finance-system#363) was the whole failure mode: the
 * note reported only the skip, so a user whose fix HAD been reviewed clean, and
 * for whom an approve offer was sitting in the thread, was told to go push a
 * commit. State the prior verdict, then the ONE next step that is actually open
 * to this user — the waiting offer, or `rerun` if they may force one.
 */
export function alreadyReviewedMessage(input: {
  slug: string;
  pr: number;
  headSha: string;
  intent: "review" | "approve";
  /** Which command was typed; `:a:` delegates a review first, so it lands here too. */
  origin?: "cr" | "a";
  /** Outcome of the review that claimed this commit; absent for pre-upgrade claims. */
  prior?: FinalizedReview;
  /** An unconsumed, unexpired approve offer exists in this thread. */
  approveOfferPending?: boolean;
  isAdmin?: boolean;
}): string {
  const { slug, pr, headSha, intent, prior } = input;
  const isApprove = intent === "approve";
  const what = isApprove ? "approve check" : "review";
  const when = taipeiStamp(prior?.finalizedAt);

  const lede = when
    ? `已在 ${when} 完成 ${what}`
    : prior
      ? `已完成 ${what}`
      : isApprove
        ? "已經執行過 approve check"
        : "已經 review 過了";

  const facts = [
    prior?.status,
    typeof prior?.blockerCount === "number" ? `${prior.blockerCount} 個 blocker` : undefined,
    typeof prior?.commentCount === "number" ? `${prior.commentCount} 則建議` : undefined,
  ].filter(Boolean);
  const verdict = facts.length > 0 ? `：${facts.join("、")}` : "";
  const link = prior?.reviewUrl ? ` → ${prior.reviewUrl}` : "";

  // The next step, in the order that matters: a waiting offer beats any advice
  // to push, because the work it is waiting on is already done.
  const next =
    input.approveOfferPending && !isApprove
      ? "這個結果可以 approve — 要核准請在這個 thread 回覆 `approve`。"
      : isApprove
        ? "同一 commit 不重複 approve；要重新判斷請推新 commit 後再發 `:a:`。"
        : "同一 commit 不重複審；有新的修改請 push 後再發 `:cr:`。";
  const adminHint = input.isAdmin
    ? "（要對同一 commit 強制重跑：在這個 thread 回覆 `rerun`）"
    : "";

  return `:information_source: ${slug}#${pr} 這個 commit（\`${headSha.slice(0, 7)}\`）${lede}${verdict}${link}\n${next}${adminHint}`;
}

/** Last non-empty line of `s`, with ANSI colour escapes stripped and trimmed. */
function lastNonEmptyLine(s?: string): string | undefined {
  if (!s) return undefined;
  const lines = s
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

/**
 * Turn an mra failure into something actionable. Older mra review paths ran
 * providers under `set -euo pipefail` with `2>/dev/null`, so a non-zero provider
 * exit can become a silent `mra exited with code=1` with no stderr — `detail`
 * then falls back to the last stdout phase so the Slack message says WHERE it
 * died; `logDump` records the full picture for the operator's gateway log.
 */
export function describeMraFailure(res: {
  reason?: string;
  stderr?: string;
  stdout?: string;
}): { detail: string; logDump: string } {
  const errTail = lastNonEmptyLine(res.stderr);
  const outTail = lastNonEmptyLine(res.stdout);
  const detail = errTail
    ? errTail.slice(0, 200)
    : outTail
      ? `最後階段：${outTail.slice(0, 140)}`
      : "";
  const logDump = [
    `reason=${res.reason ?? "unknown"}`,
    errTail
      ? `stderr=${errTail}`
      : "stderr=(empty — mra likely swallowed the provider error via 2>/dev/null)",
    outTail ? `stdout(last)=${outTail}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return { detail, logDump };
}
