/**
 * Slack result-line formatting for review / approve outcomes, plus the mra
 * failure describer. Pure functions extracted from review.ts (re-exported there
 * for back-compat) so the coordinator holds orchestration, not copy.
 */
import type { PrRef } from "../pr-ref";

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
