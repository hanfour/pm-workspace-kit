/**
 * `/pmk admin review …` handler — read/mutate the gateway review config
 * (enable/disable, provider mode, strategy, automatic-approval gate).
 * Extracted from admin.ts; dispatched by handleAdminSlash.
 */
import {
  loadRawGatewayConfig,
  resolveReviewConfig,
  saveGatewayConfig,
  type RawGatewayConfig,
} from "../config";
import { AUTOMATIC_APPROVAL_RELEASE_READY, reviewStrategySummary } from "../review-policy";
import { logAdmin, type AdminSlashResult } from "./admin-shared";

const REVIEW_PROVIDER_MODES = ["codex", "claude", "fallback", "dual"] as const;
type ReviewProviderMode = (typeof REVIEW_PROVIDER_MODES)[number];
function isReviewProviderMode(v: string | undefined): v is ReviewProviderMode {
  return !!v && (REVIEW_PROVIDER_MODES as readonly string[]).includes(v);
}

const REVIEW_STRATEGIES = ["standard", "debate", "personas"] as const;
type ReviewStrategySetting = (typeof REVIEW_STRATEGIES)[number];
function isReviewStrategySetting(v: string | undefined): v is ReviewStrategySetting {
  return !!v && (REVIEW_STRATEGIES as readonly string[]).includes(v);
}

export function reviewStatusText(cfg: RawGatewayConfig): string {
  const review = resolveReviewConfig(cfg.review);
  return [
    "*review config*",
    `• enabled: \`${review.enabled}\``,
    `• provider: \`${review.providerMode}\``,
    `• ${reviewStrategySummary(review.strategy, review.providerMode)}`,
    `• automatic approval: \`${review.approval.enabled}\` (PMK admin confirmation required; branch protection required unless the repo is exempt)`,
    `• protection exemptions: ${review.approval.protectionExemptions?.length ? review.approval.protectionExemptions.map((e) => `\`${e.repo}\``).join(", ") : "`none`"}`,
    `• concurrency: global \`${review.maxConcurrent}\` · per user \`${review.maxConcurrentPerUser}\``,
    `• allow public repos: \`${review.allowPublicRepos}\``,
  ].join("\n");
}

export function adminReview(actor: string, tokens: string[]): AdminSlashResult {
  const [sub, value] = tokens;
  const cfg = loadRawGatewayConfig();
  switch (sub) {
    case undefined:
    case "status":
      logAdmin(actor, "review.status", true);
      return { text: reviewStatusText(cfg) };
    case "provider": {
      if (!isReviewProviderMode(value)) {
        logAdmin(actor, "review.provider", false, value, "invalid provider");
        return {
          text: ":x: usage: `/pmk admin review provider <codex|claude|fallback|dual>`",
        };
      }
      cfg.review = { ...(cfg.review ?? {}), providerMode: value };
      saveGatewayConfig(cfg);
      logAdmin(actor, "review.provider", true, value);
      return {
        text: `:white_check_mark: review provider set to \`${value}\`（下一次 :cr: / :a: 立即套用）`,
      };
    }
    case "enable":
    case "disable": {
      const enabled = sub === "enable";
      cfg.review = { ...(cfg.review ?? {}), enabled };
      saveGatewayConfig(cfg);
      logAdmin(actor, `review.${sub}`, true);
      return { text: `:white_check_mark: review ${enabled ? "enabled" : "disabled"}` };
    }
    case "approval": {
      if (value !== "enable" && value !== "disable") {
        return { text: ":x: usage: `/pmk admin review approval <enable|disable>`" };
      }
      const enabled = value === "enable";
      if (enabled && !AUTOMATIC_APPROVAL_RELEASE_READY) {
        logAdmin(actor, "review.approval.enable", false, undefined, "release veto active");
        return { text: ":lock: automatic approval 尚未 release；`:cr:` review 可正常使用，但目前不能開啟 GitHub APPROVE。" };
      }
      // Merge, never replace: `approval` also holds protectionExemptions, and
      // a bare `{ enabled }` would silently wipe them on every toggle.
      cfg.review = {
        ...(cfg.review ?? {}),
        approval: { ...(cfg.review?.approval ?? {}), enabled },
      };
      saveGatewayConfig(cfg);
      logAdmin(actor, `review.approval.${value}`, true);
      return {
        text: enabled
          ? ":warning: automatic approval enabled; each repo must still pass protocol, identity, head-SHA, and allowlist checks, plus branch-protection readiness unless it is listed in `review.approval.protectionExemptions`"
          : ":white_check_mark: automatic approval disabled; `:cr:` review remains available",
      };
    }
    case "strategy": {
      if (!isReviewStrategySetting(value)) {
        logAdmin(actor, "review.strategy", false, value, "invalid strategy");
        return {
          text: ":x: usage: `/pmk admin review strategy <standard|debate|personas>`",
        };
      }
      cfg.review = { ...(cfg.review ?? {}), strategy: value };
      saveGatewayConfig(cfg);
      logAdmin(actor, "review.strategy", true, value);
      return {
        text: `:white_check_mark: review strategy set to \`${value}\`（下一次 :cr: 立即套用；:a: 固定使用 \`standard\`）`,
      };
    }
    default:
      logAdmin(actor, "review", false, tokens.join(" "), "bad args");
      return {
        text: ":x: usage: `/pmk admin review status|enable|disable|provider|strategy|approval ...`",
      };
  }
}
