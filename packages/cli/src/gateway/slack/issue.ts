/**
 * The 🎫 → GitHub issue coordinator. Loads the durable issue-candidate
 * snapshot, authorizes the reactor against the snapshot pool, claims it
 * atomically, then resolves repo/token/visibility and opens the issue —
 * all from the snapshot (no Slack history reads). Lock-then-finalize:
 * the releasable phase auto-releases on early-return; createIssue/finalize
 * run OUTSIDE it so a post-create failure leaves .claiming for doctor.
 */
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { resolveGithubToken } from "../config";
import { appendGatewayEvent } from "../events";
import {
  loadIssueCandidate, claimIssueCandidate, releaseIssueCandidate,
  finalizeIssueCandidate, type IssueCandidate,
} from "../issue-candidate";
import {
  resolveRepoSlug as resolveRepoSlugImpl, repoVisibility as repoVisibilityImpl,
  createIssue as createIssueImpl, findGhBinary as findGhBinaryImpl,
} from "../../adapters/github";

export interface GithubGateway {
  findGhBinary: typeof findGhBinaryImpl;
  resolveRepoSlug: typeof resolveRepoSlugImpl;
  repoVisibility: typeof repoVisibilityImpl;
  createIssue: typeof createIssueImpl;
}

export const realGithubGateway: GithubGateway = {
  findGhBinary: findGhBinaryImpl, resolveRepoSlug: resolveRepoSlugImpl,
  repoVisibility: repoVisibilityImpl, createIssue: createIssueImpl,
};

export interface IssueCoordinatorOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (msg: string) => void;
  github: GithubGateway;
}

export class IssueCoordinator {
  constructor(private readonly opts: IssueCoordinatorOptions) {}

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err) {
      this.opts.onLog(`issue: reply failed (non-fatal): ${(err as Error).message}`);
    }
  }

  async fromCandidate(args: { channelId: string; anchorTs: string; reactorUserId: string }): Promise<void> {
    const { channelId, anchorTs, reactorUserId } = args;
    const { config, github, onLog } = this.opts;

    const candidate = loadIssueCandidate(channelId, anchorTs, onLog);
    if (!candidate) return;

    if (candidate.issuedUrl) {
      await this.reply(channelId, candidate.threadTs, `已開過 issue：${candidate.issuedUrl}`);
      return;
    }

    const authorized =
      candidate.mentionedUserIds.includes(reactorUserId) &&
      !config.blocklist.includes(reactorUserId);
    if (!authorized) {
      onLog(`issue: unauthorized 🎫 from ${reactorUserId} on ${channelId}__${anchorTs}`);
      return;
    }

    const claimed = claimIssueCandidate(channelId, anchorTs);
    if (!claimed) return;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (!releaseIssueCandidate(channelId, anchorTs)) {
        onLog(`issue: FAILED to release claim ${channelId}__${anchorTs}`);
      }
    };
    const failAudit = (reason: string, repo?: string) =>
      appendGatewayEvent({ type: "github.issue.failed", actor: reactorUserId, repo, reason });

    let slug: string;
    let token: string;
    try {
      if (!github.findGhBinary()) {
        await this.reply(channelId, candidate.threadTs, "host 需要安裝 gh CLI，未開 issue");
        failAudit("no-gh"); release(); return;
      }
      const maybeSlug = await github.resolveRepoSlug(config.mraWorkspace ?? "", candidate.scope);
      if (!maybeSlug) {
        await this.reply(channelId, candidate.threadTs, "無法從該 repo 的 git origin 推出 GitHub slug，未開 issue");
        failAudit("slug"); release(); return;
      }
      slug = maybeSlug;

      const maybeToken = resolveGithubToken(config.github);
      if (!maybeToken) {
        await this.reply(channelId, candidate.threadTs, "GitHub token 未設定 / 指令失敗，未開 issue");
        failAudit("token", slug); release(); return;
      }
      token = maybeToken;

      if (config.github?.allowPublicRepos !== true) {
        const vis = await github.repoVisibility({ slug, token });
        if (vis !== "private") {
          await this.reply(channelId, candidate.threadTs,
            "目標 repo 為 public（或無法判定），已停止以免內部資訊外洩。請改用 private repo 或開啟 allowPublicRepos");
          failAudit("public-repo", slug); release(); return;
        }
      }
    } catch (err) {
      onLog(`issue: pre-create error, releasing: ${(err as Error).message}`);
      failAudit("gh-create-failed"); release(); return;
    }

    let url: string;
    try {
      url = await github.createIssue({ slug, title: buildTitle(candidate), body: buildBody(candidate, slug), token });
    } catch (err) {
      onLog(`issue: createIssue failed (claim left for doctor): ${(err as Error).message}`);
      await this.reply(channelId, candidate.threadTs, "開 issue 失敗，請稍後重試或由 host 檢查");
      failAudit("gh-create-failed", slug);
      return; // NOTE: no release()
    }

    finalizeIssueCandidate(channelId, anchorTs, url);
    appendGatewayEvent({ type: "github.issue.created", actor: reactorUserId, repo: slug, url });
    await this.reply(channelId, candidate.threadTs, `已開 issue：${url}`);
  }
}

function buildTitle(c: IssueCandidate): string {
  const firstLine = c.question.split("\n")[0].slice(0, 80);
  return `[pmk] ${firstLine}`;
}

function buildBody(c: IssueCandidate, slug: string): string {
  const source = c.permalink
    ? `- Slack thread: ${c.permalink}`
    : `- Slack: channel ${c.channelId} thread ${c.threadTs}`;
  return [
    "## 問題（使用者回報）", c.question, "",
    "## 診斷（pmk grounded）", c.diagnosis, "",
    "## 來源", source, `- 提問者：<@${c.askerUserId}>`, `- repo: ${slug}`,
  ].join("\n");
}
