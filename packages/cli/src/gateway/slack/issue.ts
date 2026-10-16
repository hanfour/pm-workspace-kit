/**
 * GitHub issue coordinator. The 🎫 path uses its durable escalation snapshot;
 * direct issue/bug commands first snapshot the current Slack thread. Both paths
 * share the same repo visibility, token, claim and issue creation safeguards.
 */
import { existsSync } from "node:fs";
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { resolveGithubToken, resolveReviewGhToken } from "../config";
import { appendGatewayEvent } from "../events";
import { redactSecrets } from "../redact";
import { createAutoFixPullRequest, type AutoFixRequest } from "./auto-fix";
import {
  loadIssueCandidate, saveIssueCandidate, claimIssueCandidate,
  releaseIssueCandidate, finalizeIssueCandidate, claimIssueRepair,
  releaseIssueRepair, finalizeIssueRepair, issueCandidatePath,
  recoverIssueClaims,
  type IssueCandidate,
} from "../issue-candidate";
import {
  resolveRepoSlug as resolveRepoSlugImpl,
  repoVisibility as repoVisibilityImpl, createIssue as createIssueImpl,
  findGhBinary as findGhBinaryImpl,
} from "../../adapters/github";

const MAX_CONCURRENT_AUTOFIXES = 1;

function resolveBugReportToken(config: GatewayConfig): string | undefined {
  return resolveGithubToken(config.github) ?? resolveReviewGhToken(config.review);
}

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
  autoFix?: (request: AutoFixRequest) => Promise<string>;
}

export interface BugReportCommand {
  repo?: string;
}

export function parseBugReportCommand(text: string): BugReportCommand | undefined {
  const normalized = text.trim().replace(/^\/pmk\s+/i, "");
  const match = /^(?:issue|bug)(?:\s+(\S+))?$/i.exec(normalized);
  if (!match) return undefined;
  return match[1] ? { repo: match[1] } : {};
}

export class IssueCoordinator {
  private shuttingDown = false;
  private readonly reportsInFlight = new Set<string>();
  private readonly autoFixControllers = new Map<
    string,
    { controller: AbortController; channelId: string; threadTs: string }
  >();

  constructor(private readonly opts: IssueCoordinatorOptions) {}

  drainOnShutdown(): number {
    if (this.shuttingDown) return 0;
    this.shuttingDown = true;
    const active = [...this.autoFixControllers.values()];
    for (const job of active) {
      job.controller.abort();
      void this.reply(
        job.channelId,
        job.threadTs,
        "服務正在重新啟動；GitHub issue 已保留，服務恢復後可在此輸入 `bug` 重試自動修復。",
      );
    }
    return active.length;
  }

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err) {
      this.opts.onLog(`issue: reply failed (non-fatal): ${(err as Error).message}`);
    }
  }

  async fromReport(args: {
    channelId: string;
    threadTs: string;
    reporterUserId: string;
    repo?: string;
    commandText: string;
  }): Promise<void> {
    if (this.shuttingDown) return;
    const key = `${args.channelId}__${args.threadTs}`;
    if (this.reportsInFlight.has(key)) {
      await this.reply(args.channelId, args.threadTs, "這個 thread 的 issue/修復流程已在處理中。");
      return;
    }
    this.reportsInFlight.add(key);
    try {
      await this.runReport(args);
    } finally {
      this.reportsInFlight.delete(key);
    }
  }

  private async runReport(args: {
    channelId: string;
    threadTs: string;
    reporterUserId: string;
    repo?: string;
    commandText: string;
  }): Promise<void> {
    const { channelId, threadTs, reporterUserId, commandText } = args;
    const { config, github, onLog } = this.opts;
    if (config.blocklist.includes(reporterUserId)) return;

    recoverIssueClaims(30 * 60_000, onLog);
    const path = issueCandidatePath(channelId, threadTs);
    if (existsSync(`${path}.claiming`)) {
      await this.reply(channelId, threadTs, "這個 thread 的 issue 正在建立或待 host 確認，請稍後查看 GitHub。");
      return;
    }
    if (existsSync(`${path}.repairing`)) {
      await this.reply(channelId, threadTs, "這個 thread 的自動修復仍在執行中。");
      return;
    }

    let candidate = loadIssueCandidate(channelId, threadTs, onLog);
    if (candidate && !candidate.autoFixRequested) {
      await this.reply(channelId, threadTs, "這個 thread 已有 escalation issue 流程；請在對應的 pmk 訊息上 react 🎫。");
      return;
    }
    if (!candidate) {
      const configuredRepo = config.github?.bugRepo;
      if (!configuredRepo) {
        await this.reply(
          channelId,
          threadTs,
          "錯誤回報尚未設定目標 repo；請 host 在 gateway.json 設定 `github.bugRepo`。",
        );
        return;
      }
      if (args.repo && args.repo.toLowerCase() !== configuredRepo.toLowerCase()) {
        await this.reply(channelId, threadTs, "issue/bug 只能回報到 host 設定的 repo。");
        return;
      }
      const slug = configuredRepo;

      const context = await this.collectThread(args);
      if (this.shuttingDown) return;
      if (!context) {
        await this.reply(
          channelId,
          threadTs,
          "請在發生錯誤的 thread 中輸入 `issue` 或 `bug`，讓我能蒐集該 thread 的錯誤內容。",
        );
        return;
      }

      let permalink: string | undefined;
      try {
        const result = await this.opts.web.chat.getPermalink({
          channel: channelId,
          message_ts: threadTs,
        });
        permalink = (result as { permalink?: string }).permalink;
      } catch {
        /* A missing permalink does not block the report. */
      }
      candidate = {
        channelId,
        threadTs,
        anchorTs: threadTs,
        scope: slug,
        repoSlug: slug,
        askerUserId: reporterUserId,
        mentionedUserIds: [reporterUserId],
        question: context.question,
        diagnosis: context.transcript,
        permalink,
        autoFixRequested: true,
      };
      try {
        saveIssueCandidate(candidate);
      } catch (err) {
        onLog(`issue: could not save report snapshot: ${(err as Error).message}`);
        await this.reply(channelId, threadTs, "無法保存錯誤摘要，尚未建立 GitHub issue。");
        return;
      }
    }

    if (this.shuttingDown) return;
    if (candidate.issuedUrl) {
      await this.reply(channelId, threadTs, `已開過 issue：${candidate.issuedUrl}`);
    } else {
      await this.fromCandidate({
        channelId,
        anchorTs: threadTs,
        reactorUserId: reporterUserId,
      });
      candidate = loadIssueCandidate(channelId, threadTs, onLog);
    }
    if (this.shuttingDown) return;
    if (!candidate?.issuedUrl || !candidate.autoFixRequested) return;

    if (candidate.repairUrl) {
      await this.reply(channelId, threadTs, `自動修復 PR：${candidate.repairUrl}`);
      return;
    }
    await this.runAutoFix(candidate, reporterUserId);
  }

  private async collectThread(args: {
    channelId: string;
    threadTs: string;
    reporterUserId: string;
    commandText: string;
  }): Promise<{ question: string; transcript: string } | undefined> {
    try {
      const response = await this.opts.web.conversations.replies({
        channel: args.channelId,
        ts: args.threadTs,
        limit: 100,
      } as never);
      const messages = (response as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      const entries = messages.flatMap((message) => {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text || text === args.commandText) return [];
        const clean = redactSecrets(text).slice(0, 2_000);
        const isReporter = message.user === args.reporterUserId;
        const isBot = Boolean(message.bot_id) || message.subtype === "bot_message";
        return [`${isBot ? "pmk" : isReporter ? "reporter" : "participant"}: ${clean}`];
      });
      if (entries.length === 0) return undefined;

      const transcript = capTranscript(entries.slice(-30).join("\n"), 12_000);
      const question =
        entries.find((entry) => entry.startsWith("reporter: "))?.slice("reporter: ".length) ??
        "Slack bug report";
      return { question: question.slice(0, 500), transcript };
    } catch (err) {
      this.opts.onLog(`issue: thread context read failed (${(err as Error).message})`);
      return undefined;
    }
  }

  private async runAutoFix(candidate: IssueCandidate, reporterUserId: string): Promise<void> {
    const { onLog } = this.opts;
    if (this.shuttingDown) return;
    if (this.autoFixControllers.size >= MAX_CONCURRENT_AUTOFIXES) {
      await this.reply(candidate.channelId, candidate.threadTs, "issue 已建立；目前有另一個 Codex 修復在執行，稍後再輸入 `bug` 重試。");
      return;
    }
    const claimed = claimIssueRepair(candidate.channelId, candidate.anchorTs);
    if (!claimed) {
      await this.reply(candidate.channelId, candidate.threadTs, "這個 thread 的 Codex 修復已在執行中。");
      return;
    }
    if (claimed.repairUrl) {
      releaseIssueRepair(candidate.channelId, candidate.anchorTs);
      await this.reply(candidate.channelId, candidate.threadTs, `自動修復 PR：${claimed.repairUrl}`);
      return;
    }
    candidate = claimed;
    let finalized = false;
    const controller = new AbortController();
    const key = `${candidate.channelId}__${candidate.anchorTs}`;
    this.autoFixControllers.set(key, {
      controller,
      channelId: candidate.channelId,
      threadTs: candidate.threadTs,
    });
    const release = () => {
      if (finalized) return;
      finalized = true;
      if (!releaseIssueRepair(candidate.channelId, candidate.anchorTs)) {
        onLog(`issue: FAILED to release auto-fix claim ${candidate.channelId}__${candidate.anchorTs}`);
      }
    };

    try {
      const token = resolveBugReportToken(this.opts.config);
      const issueNumber = issueNumberFromUrl(candidate.issuedUrl ?? "");
      const autoFix = this.opts.autoFix ?? createAutoFixPullRequest;
      if (!token || !issueNumber || !candidate.repoSlug) {
        throw new Error("auto-fix prerequisites are incomplete");
      }
      await this.reply(candidate.channelId, candidate.threadTs, "GitHub issue 已建立；Codex 正在隔離分支嘗試修復。");
      const prUrl = await autoFix({
        slug: candidate.repoSlug,
        issueNumber,
        issueUrl: candidate.issuedUrl!,
        title: buildTitle(candidate),
        report: `${candidate.question}\n\n${candidate.diagnosis}`,
        token,
        signal: controller.signal,
      });
      finalizeIssueRepair(candidate.channelId, candidate.anchorTs, prUrl);
      finalized = true;
      appendGatewayEvent({ type: "github.issue.autofix.created", actor: reporterUserId, repo: candidate.repoSlug, issue: issueNumber, url: prUrl });
      await this.reply(candidate.channelId, candidate.threadTs, `自動修復已建立 draft PR：${prUrl}（需人工審查與合併）`);
    } catch (err) {
      if (controller.signal.aborted) {
        release();
        return;
      }
      onLog(`issue: auto-fix failed: ${(err as Error).message}`);
      appendGatewayEvent({
        type: "github.issue.autofix.failed",
        actor: reporterUserId,
        ...(candidate.repoSlug ? { repo: candidate.repoSlug } : {}),
        reason: safeFailureReason(err),
      });
      await this.reply(
        candidate.channelId,
        candidate.threadTs,
        `issue 已建立：${candidate.issuedUrl}\n自動修復未完成；可稍後再輸入 issue 或 bug 重試。`,
      );
      release();
    } finally {
      this.autoFixControllers.delete(key);
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
    let visibility: "public" | "private" | "unknown" = "unknown";
    let token: string;
    try {
      if (!github.findGhBinary()) {
        await this.reply(channelId, candidate.threadTs, "host 需要安裝 gh CLI，未開 issue");
        failAudit("no-gh"); release(); return;
      }
      const workspace = config.mraWorkspace;
      const maybeSlug = candidate.repoSlug && isGithubSlug(candidate.repoSlug)
        ? candidate.repoSlug
        : workspace
          ? await github.resolveRepoSlug(workspace, candidate.scope)
          : undefined;
      if (!maybeSlug) {
        await this.reply(channelId, candidate.threadTs, "無法從該 repo 的 git origin 推出 GitHub slug，未開 issue");
        failAudit("slug"); release(); return;
      }
      slug = maybeSlug;

      const maybeToken = resolveBugReportToken(config);
      if (!maybeToken) {
        await this.reply(channelId, candidate.threadTs, "GitHub token 未設定 / 指令失敗，未開 issue");
        failAudit("token", slug); release(); return;
      }
      token = maybeToken;

      visibility = await github.repoVisibility({ slug, token });
      if (config.github?.allowPublicRepos !== true) {
        if (visibility !== "private") {
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
      url = await github.createIssue({
        slug,
        title: buildTitle(candidate),
        body: buildBody(candidate, slug, visibility !== "private"),
        token,
      });
    } catch (err) {
      onLog(`issue: createIssue failed (claim left for doctor): ${(err as Error).message}`);
      await this.reply(channelId, candidate.threadTs, "開 issue 失敗，請稍後重試或由 host 檢查");
      failAudit("gh-create-failed", slug);
      return; // NOTE: no release()
    }

    try {
      finalizeIssueCandidate(channelId, anchorTs, url);
    } catch (err) {
      onLog(
        `issue: finalize failed (issue ${url} already created; left for doctor): ${(err as Error).message}`,
      );
    }
    appendGatewayEvent({ type: "github.issue.created", actor: reactorUserId, repo: slug, url });
    await this.reply(channelId, candidate.threadTs, `已開 issue：${url}`);
  }
}

function buildTitle(c: IssueCandidate): string {
  const firstLine = redactPublicSlackRefs(c.question.split("\n")[0])
    .trim()
    .slice(0, 80);
  return `[pmk] ${firstLine || "(問題待補)"}`;
}

function buildBody(c: IssueCandidate, slug: string, publicOrUnknown: boolean): string {
  const question = publicOrUnknown ? redactPublicSlackRefs(c.question) : c.question;
  const diagnosis = publicOrUnknown ? redactPublicSlackRefs(c.diagnosis) : c.diagnosis;
  const source = publicOrUnknown
    ? "- Source: pmk Slack bug report"
    : c.permalink
      ? `- Slack thread: ${c.permalink}`
      : `- Slack: channel ${c.channelId} thread ${c.threadTs}`;
  return [
    "## 問題（使用者回報）", question, "",
    "## 診斷（pmk grounded）", diagnosis, "",
    "## 來源", source,
    ...(!publicOrUnknown ? [`- 提問者：<@${c.askerUserId}>`] : []),
    `- repo: ${slug}`,
  ].join("\n");
}

function redactPublicSlackRefs(text: string): string {
  return redactSecrets(text)
    .replace(/<@[A-Z0-9]+>/gi, "<@user>")
    .replace(/<#[A-Z0-9]+(?:\|[^>]+)?>/gi, "<#channel>")
    .replace(/\b(?:U|W|C|G|D|T|B)[A-Z0-9]{8,}\b/g, "[Slack ID]")
    .replace(/\b\d{10}\.\d{6}\b/g, "[Slack timestamp]")
    .replace(/https?:\/\/[^\s)<>]*slack\.com[^\s)<>]*/gi, "[Slack URL redacted]");
}

function isGithubSlug(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..");
}

function capTranscript(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n[內容已截斷]`;
}

function issueNumberFromUrl(url: string): number | undefined {
  const match = /\/issues\/(\d+)(?:$|[?#])/.exec(url);
  return match ? Number(match[1]) : undefined;
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  return redactSecrets(message).replace(/[\r\n]+/g, " ").slice(0, 240);
}
