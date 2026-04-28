/**
 * Gateway message builders + small text utilities. Extracted from the
 * Slack adapter so they can be unit-tested in isolation and reused by
 * other adapters (LINE etc.) when those land.
 */

import {
  listMraWorkspaceReposWithPkb,
  loadPkbBase,
  mraDoctor,
  resolveMraRepo,
} from "../adapters/mra";

/**
 * Trim a string to `max` characters, appending a one-line "(truncated
 * N chars)" marker so consumers can see something was clipped. Strings
 * shorter than `max` are returned verbatim.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)`;
}

/**
 * Build a one-shot seed message containing PKB content for the
 * configured ingest spec. Returns undefined when no PKB is found
 * (mra workspace missing, no repos with PKB, etc.).
 *
 * Pattern: same as the case command's buildSeedMessage — we package
 * the four base docs per repo so the model can ground answers in real
 * module names / API endpoints from turn one.
 *
 * `mraWorkspace` overrides the cwd-walk in mraDoctor; pass through
 * `cfg.mraWorkspace` so the seed can be built from any launch
 * directory.
 */
export function buildIngestSeed(
  ingestSpec: string,
  mraWorkspace?: string,
): string | undefined {
  const doctor = mraDoctor({ workspace: mraWorkspace });
  if (!doctor.ok) return undefined;
  const tail = ingestSpec.startsWith("mra:") ? ingestSpec.slice(4) : ingestSpec;
  const repos =
    tail === "--all"
      ? listMraWorkspaceReposWithPkb(doctor.workspace!)
      : tail
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);

  const blocks: string[] = [];
  for (const repo of repos) {
    const repoPath = resolveMraRepo(doctor.workspace!, repo);
    if (!repoPath) continue;
    const docs = loadPkbBase(repoPath);
    if (docs.length === 0) continue;
    blocks.push(
      [
        `## repo: ${repo}`,
        ...docs.map(
          (d) => `### ${d.name}\n\n\`\`\`markdown\n${d.content.trim()}\n\`\`\``,
        ),
      ].join("\n\n"),
    );
  }
  if (blocks.length === 0) return undefined;
  return [
    "我先把 workspace 的 PKB context 給你（後續對話請用這些事實作答；缺的就老實說沒有，不要編造）：",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

/**
 * Compose the user-message that flows back to the LLM after `mra ask`
 * failed. Includes stderr / stdout excerpts when present so the model
 * can apologise with a specific cause ("mra reported missing PKB",
 * "mra timed out") instead of a generic "unknown" — which is all
 * Node's err.message gives us by default.
 */
export function buildMraFailureMessage(
  repo: string,
  result: { stdout: string; stderr: string; reason?: string },
): string {
  const lines = [`\`mra ask ${repo}\` 失敗：${result.reason ?? "unknown"}`];
  if (result.stderr.trim()) {
    lines.push(
      "",
      "```mra-stderr",
      truncate(result.stderr.trim(), 4_000),
      "```",
    );
  }
  if (result.stdout.trim()) {
    lines.push(
      "",
      "```mra-partial-stdout",
      truncate(result.stdout.trim(), 2_000),
      "```",
    );
  }
  lines.push(
    "",
    "請以目前已載入的 PKB context 直接回答；若 PKB 也不足，請老實說「目前資料不夠」並引用上面 stderr 提到的具體原因（如有），不要編造。",
  );
  return lines.join("\n");
}

/**
 * Compose the user-message that flows back to the LLM after `mra ask`
 * succeeded — wraps stdout in a fenced `mra-result` block with
 * priority instructions for synthesis.
 */
export function buildMraSuccessMessage(repo: string, stdout: string): string {
  return [
    `這是 \`mra ask ${repo}\` 的回傳結果（請依此 synthesise 最終答案；若這份結果不足，可再 emit 一次 mra-ask，但仍以 PKB + 這份結果優先）：`,
    "",
    "```mra-result",
    truncate(stdout.trim(), 24_000),
    "```",
  ].join("\n");
}
