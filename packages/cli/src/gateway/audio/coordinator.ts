/**
 * AudioCoordinator — detached transcribe → summary pipeline.
 *
 * Flow per audio message:
 *   enabled gate → apiKey gate → find audio file → claimAudio →
 *   ack post → streamToTemp → probe (actual duration) →
 *   too-long gate → reserveQuota (actual minutes) → transcribeAudio →
 *   appendAttachment (raw transcript) → finalizeAudio →
 *   summarizeMeeting → post summary;
 *   on any failure: releaseAudio + post error;
 *   always: inFlight.delete + rmSync tempDir.
 *
 * Mirrors ReviewCoordinator (slack/review.ts) for the detached pattern:
 *   inFlight Set, AbortController, drainOnShutdown, reply via postMessage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { resolveAudioConfig, resolveOpenAiKey } from "../config";
import type { LlmProvider } from "../../llm/provider";
import { appendGatewayEvent } from "../events";
import { appendAttachment } from "../attachments/store";
import { categoryFor } from "../attachments/registry";
import {
  type SlackFile,
  type ThreadKey,
  MAX_AUDIO_FILES_PER_MESSAGE,
  MAX_AUDIO_DURATION_SEC,
} from "../attachments/types";
import { streamSlackFileToTemp } from "./download-stream";
import { transcribeAudio, type TranscribeResult } from "./transcribe";
import { summarizeMeeting } from "./summarize";
import { reserveAudioQuota, releaseAudioQuota } from "./quota";
import { probeAudio } from "./probe";
import { makeJobTempDir } from "./temp";
import { claimAudio, releaseAudio, finalizeAudio } from "./claim";
import { redactSecrets, countHighEntropyTokens } from "../redact";
import { writeAtomMarker, readAtomMarker, acquireAtomMarker, deleteAtomMarker, restoreAtomMarker } from "./atom-marker";
import { saveAtom, findAtomByThreadKey, generateAtomId, type KnowledgeAtom } from "../knowledge";
import { scanAtomFields } from "../atom-sanitizer";

const USD_PER_MINUTE = 0.006; // whisper-1 list price ($0.006/min); for estimatedUsd only

/** True when any file in the array is classified as audio. */
export function isAudioMessage(files: SlackFile[]): boolean {
  return files.some((f) => categoryFor(f) === "audio");
}

interface InFlightJob {
  controller: AbortController;
  fileId: string;
  channelId: string;
  threadTs: string;
  tempDir: string;
}

export interface AudioCoordinatorDeps {
  streamToTemp?: typeof streamSlackFileToTemp;
  transcribe?: (
    input: string,
    cfg: { apiKey: string; model: string; language: string; maxDurationSec: number },
    deps?: unknown,
  ) => Promise<TranscribeResult>;
  summarize?: typeof summarizeMeeting;
  reserveQuota?: typeof reserveAudioQuota;
  releaseQuota?: typeof releaseAudioQuota;
  probe?: typeof probeAudio;
  makeTempDir?: (jobId: string) => string;
  now?: () => number;
  saveAtom?: typeof saveAtom;
}

export interface AudioCoordinatorOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (m: string) => void;
  llm: LlmProvider;
  deps?: AudioCoordinatorDeps;
}

export interface AudioRunArgs {
  threadKey: ThreadKey;
  channelId: string;
  threadTs: string;
  userId: string;
  botToken: string;
  files: SlackFile[];
  userText?: string;
  tier: string;
  scope: string;
}

export class AudioCoordinator {
  private readonly inFlight = new Set<InFlightJob>();

  constructor(private readonly opts: AudioCoordinatorOptions) {}

  /** Whether the audio transcription flow is enabled (config-gated). */
  isEnabled(): boolean {
    return resolveAudioConfig(this.opts.config.audio).enabled;
  }

  /**
   * On gateway shutdown: abort every in-flight job, release its claim so the
   * file is immediately re-processable, clean up temp dir, and post a retry
   * notice in its thread. Returns the number of jobs drained.
   */
  drainOnShutdown(log: (m: string) => void): number {
    const entries = [...this.inFlight];
    for (const e of entries) {
      try {
        e.controller.abort();
      } catch {
        /* best-effort */
      }
      releaseAudio(e.fileId);
      try {
        fs.rmSync(e.tempDir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
      log(
        `audio: interrupted ${e.fileId} by shutdown — released + temp cleaned`,
      );
      // Fire-and-forget: drainOnShutdown is sync; the stop() 90s queue drain
      // that follows gives these posts time to land. reply() swallows its own
      // errors, so this can never block shutdown.
      void this.reply(
        e.channelId,
        e.threadTs,
        ":warning: 音訊轉錄因服務重新啟動中斷,上線後在本 thread 回 `retry` 重跑。",
      );
    }
    this.inFlight.clear();
    return entries.length;
  }

  private async reply(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<{ ts?: string }> {
    try {
      return (await this.opts.web.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
      })) as { ts?: string };
    } catch (err) {
      this.opts.onLog(
        `audio: reply failed: ${redactSecrets((err as Error).message)}`,
      );
      return {};
    }
  }

  private async update(
    channel: string,
    ts: string,
    text: string,
  ): Promise<void> {
    try {
      await this.opts.web.chat.update({ channel, ts, text });
    } catch (err) {
      this.opts.onLog(
        `audio: update failed: ${redactSecrets((err as Error).message)}`,
      );
    }
  }

  private async fetchRootFiles(
    channel: string,
    ts: string,
  ): Promise<SlackFile[]> {
    try {
      const res = (await this.opts.web.conversations.history({
        channel,
        latest: ts,
        oldest: ts,
        inclusive: true,
        limit: 1,
      } as never)) as { messages?: Array<{ files?: SlackFile[] }> };
      return res.messages?.[0]?.files ?? [];
    } catch (err) {
      this.opts.onLog(
        `audio: fetch root files failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Re-run the audio pipeline for the thread whose root message contained
   * audio files. Called when a user sends `retry` in an audio thread.
   * Returns true if the thread was recognised as an audio thread and the
   * pipeline was re-queued; false if not an audio thread (so the caller
   * can fall through to free-chat).
   */
  async retryInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    botToken: string;
    tier: string;
    scope?: string;
  }): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const files = await this.fetchRootFiles(args.channelId, args.threadTs);
    if (!isAudioMessage(files)) return false;
    const audioFiles = files.filter((f) => categoryFor(f) === "audio");
    for (const a of audioFiles) releaseAudio(a.id);
    const threadKey: ThreadKey = args.channelId.startsWith("D")
      ? { kind: "dm", userId: args.userId, threadTs: args.threadTs }
      : { kind: "channel", channelId: args.channelId, threadTs: args.threadTs };
    // Detach: return true immediately so the turn slot is released.
    // The pipeline runs in the background; errors are logged.
    void this.run({
      threadKey,
      channelId: args.channelId,
      threadTs: args.threadTs,
      userId: args.userId,
      botToken: args.botToken,
      files,
      tier: args.tier,
      scope: args.scope ?? "general",
    }).catch((e) =>
      this.opts.onLog(`audio retry run: ${redactSecrets((e as Error).message)}`),
    );
    return true;
  }

  async run(args: AudioRunArgs): Promise<void> {
    const d = this.opts.deps ?? {};
    const streamToTemp = d.streamToTemp ?? streamSlackFileToTemp;
    const transcribe: (
      input: string,
      cfg: { apiKey: string; model: string; language: string; maxDurationSec: number },
      deps?: unknown,
    ) => Promise<TranscribeResult> =
      d.transcribe ?? (transcribeAudio as never);
    const summarize = d.summarize ?? summarizeMeeting;
    const reserveQuota = d.reserveQuota ?? reserveAudioQuota;
    const releaseQuota = d.releaseQuota ?? releaseAudioQuota;
    const probe = d.probe ?? probeAudio;
    const makeTempDir = d.makeTempDir ?? makeJobTempDir;
    const now = d.now ?? (() => Date.now());

    const ac = resolveAudioConfig(this.opts.config.audio);
    if (!ac.enabled) return;

    const apiKey = resolveOpenAiKey(this.opts.config.audio);
    if (!apiKey) {
      appendGatewayEvent({ type: "audio.failed", actor: args.userId, reason: "no-key" });
      await this.reply(
        args.channelId,
        args.threadTs,
        ":warning: 音訊功能未設定（缺 OPENAI_API_KEY）。",
      );
      return;
    }

    // Process first audio file only (cap fan-out hard).
    const audioFiles = args.files
      .filter((f) => categoryFor(f) === "audio")
      .slice(0, MAX_AUDIO_FILES_PER_MESSAGE);
    const file = audioFiles[0];
    if (!file) return;

    if (!claimAudio(file.id)) {
      this.opts.onLog(`audio: ${file.id} already claimed`);
      await this.reply(
        args.channelId,
        args.threadTs,
        "這個音訊已在處理或處理過,如需重跑請在原 thread 回 `retry`",
      );
      return;
    }

    const ack = await this.reply(
      args.channelId,
      args.threadTs,
      ":headphones: 轉錄中…（長錄音可能要幾分鐘,完成會在本 thread 通知,你可以先離開）",
    );
    const ackTs = ack.ts;

    const controller = new AbortController();
    const tempDir = makeTempDir(file.id);
    const job: InFlightJob = {
      controller,
      fileId: file.id,
      channelId: args.channelId,
      threadTs: args.threadTs,
      tempDir,
    };
    this.inFlight.add(job);

    const t0 = now();
    // Hoisted so the catch block can refund quota if it was reserved.
    let minutes = 0;
    let quotaReserved = false;
    // Timestamp the quota is reserved at, so refunds target the same day/month
    // bucket even if the job (or its failure) crosses a period boundary.
    let reservedAtMs = 0;
    // True once transcription has incurred real API cost; catch must not refund then.
    let transcribeSucceeded = false;

    /** Update the ack message if we have its ts; otherwise post a new reply. */
    const post = async (text: string): Promise<void> => {
      if (ackTs) {
        await this.update(args.channelId, ackTs, text);
      } else {
        await this.reply(args.channelId, args.threadTs, text);
      }
    };

    try {
      const dest = path.join(tempDir, "input");
      await streamToTemp(file, args.botToken, dest);

      // 1. Probe for actual duration before any API cost is incurred.
      let probedDuration: number;
      try {
        ({ durationSec: probedDuration } = await probe(dest, {}));
      } catch {
        appendGatewayEvent({ type: "audio.failed", actor: args.userId, reason: "ffmpeg-failed" });
        releaseAudio(file.id);
        await post(":warning: 音訊無法讀取（ffmpeg 失敗）,請確認檔案格式後回 `retry` 重跑。");
        return;
      }

      // 2. Too-long gate (before quota).
      const cap = Math.min(ac.maxDurationSec, MAX_AUDIO_DURATION_SEC);
      if (probedDuration > cap) {
        appendGatewayEvent({ type: "audio.failed", actor: args.userId, reason: "too-long" });
        releaseAudio(file.id);
        await post(`:warning: 錄音超過 ${Math.round(cap / 60)} 分鐘上限,請切段後再上傳。`);
        return;
      }

      // 3. Quota gate with ACTUAL minutes (before transcription).
      minutes = Math.ceil(probedDuration / 60);
      reservedAtMs = now();
      const q = reserveQuota({
        userId: args.userId,
        minutes,
        perUserDailyMinutes: ac.perUserDailyMinutes,
        globalDailyMinutes: ac.globalDailyMinutes,
        globalMonthlyMinutes: ac.globalMonthlyMinutes,
        now,
      });
      if (!q.ok) {
        appendGatewayEvent({ type: "audio.failed", actor: args.userId, reason: "quota-exceeded" });
        releaseAudio(file.id);
        await post(`:no_entry: ${q.reason}。`);
        return;
      }
      quotaReserved = true;

      // 4. Transcribe (only now, after quota is confirmed).
      const result = await transcribe(
        dest,
        {
          apiKey,
          model: ac.model,
          language: ac.language,
          maxDurationSec: ac.maxDurationSec,
        },
        { outDir: tempDir, signal: controller.signal, knownDurationSec: probedDuration },
      );

      if (!result.ok) {
        const reason = result.reason;
        // Surface the underlying cause (e.g. "400 input_too_large") in the event
        // so failures are diagnosable from the event log without re-instrumenting.
        const eventReason = result.detail ? `${reason}: ${result.detail}` : reason;
        appendGatewayEvent({ type: "audio.failed", actor: args.userId, reason: eventReason });
        if (reason === "too-long") {
          // FIX 4a: claim was never finalized → release it so a retry is possible.
          // FIX 2: no usable output → refund the reserved quota.
          releaseAudio(file.id);
          releaseQuota({ userId: args.userId, minutes, now: () => now(), reservedAt: reservedAtMs });
          await post(
            `:warning: 錄音超過 ${Math.round(ac.maxDurationSec / 60)} 分鐘上限,請切段後再上傳。`,
          );
        } else if (result.partialTranscript) {
          // Partial output was produced; real API cost incurred — do not refund quota.
          transcribeSucceeded = true;
          appendAttachment(args.threadKey, {
            fileId: file.id,
            name: file.name ?? file.id,
            mimetype: file.mimetype ?? "audio",
            text: result.partialTranscript,
            at: now(),
          });
          await post(
            `:warning: 部分段落轉錄失敗（第 ${(result.failedSegment ?? 0) + 1} 段）。逐字稿（含缺漏標記）已留在本 thread;在此回 \`retry\` 重跑。`,
          );
        } else {
          // Total failure, no usable output → release claim and refund quota.
          releaseAudio(file.id);
          releaseQuota({ userId: args.userId, minutes, now: () => now(), reservedAt: reservedAtMs });
          await post(":warning: 轉錄失敗,請在本 thread 回 `retry` 重跑。");
        }
        return;
      }

      const durationSec = result.durationSec;
      const estimatedUsd = Number(
        (Math.ceil(durationSec / 60) * USD_PER_MINUTE).toFixed(4),
      );
      appendGatewayEvent({
        type: "audio.transcribed",
        actor: args.userId,
        durationSec,
        chunks: result.chunks,
        ms: now() - t0,
        estimatedUsd,
      });

      // Transcription cost was incurred; mark so catch block does not refund.
      transcribeSucceeded = true;

      // Store raw transcript (no frame header — that is added at inference time).
      appendAttachment(args.threadKey, {
        fileId: file.id,
        name: file.name ?? file.id,
        mimetype: file.mimetype ?? "audio",
        text: result.transcript,
        at: now(),
      });
      finalizeAudio(file.id);

      const summary = await summarize({
        transcript: result.transcript,
        durationSec,
        userInstruction: args.userText,
        tier: args.tier,
        llm: this.opts.llm,
        actor: args.userId,
      });

      appendGatewayEvent({
        type: "audio.summarized",
        actor: args.userId,
        mode: summary.mode,
      });

      // Note whether extra audio files were skipped (fan-out is capped at 1).
      const totalAudio = args.files.filter((f) => categoryFor(f) === "audio").length;
      const extra =
        totalAudio > 1
          ? "\n_（本則多個音訊只處理了第一個,其餘請另開訊息）_"
          : "";

      if (ackTs) {
        writeAtomMarker({
          threadKey: `${args.channelId}:${args.threadTs}`,
          channelId: args.channelId,
          summaryTs: ackTs,
          uploaderId: args.userId,
          scope: args.scope,
          title: summary.title,
          tags: summary.tags,
          summaryText: summary.text,
          at: now(),
        });
        await this.update(
          args.channelId,
          ackTs,
          summary.text + extra + "\n_對此摘要按 📚 即可加進知識庫(之後 mra-ask 找得到;7 天內有效)_",
        );
      } else {
        await this.reply(args.channelId, args.threadTs, summary.text + extra);
      }
    } catch (err) {
      releaseAudio(file.id);
      // Refund quota only if transcription never incurred real cost.
      // If transcribeSucceeded is true the OpenAI charge was already spent,
      // so the daily cap must NOT be refunded regardless of what failed later.
      if (quotaReserved && minutes > 0 && !transcribeSucceeded) {
        releaseQuota({ userId: args.userId, minutes, now: () => now(), reservedAt: reservedAtMs });
      }
      appendGatewayEvent({
        type: "audio.failed",
        actor: args.userId,
        reason: "exception",
      });
      await post(
        `:warning: 音訊處理例外:${redactSecrets((err as Error).message)}。回 \`retry\` 重跑。`,
      );
    } finally {
      this.inFlight.delete(job);
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  }

  /**
   * 📚 reaction on an audio summary → save it as an approved knowledge atom.
   * Returns false if the reacted message isn't a known audio summary (so the
   * caller falls through to other reaction handling).
   */
  async fromApproval(args: { channelId: string; messageTs: string; reactorUserId: string }): Promise<boolean> {
    const now = this.opts.deps?.now ?? (() => Date.now());
    const marker = readAtomMarker(args.channelId, args.messageTs);
    if (!marker) return false;

    const admins = this.opts.config.admins ?? [];
    if (args.reactorUserId !== marker.uploaderId && !admins.includes(args.reactorUserId)) {
      try {
        await this.opts.web.chat.postEphemeral({ channel: args.channelId, user: args.reactorUserId, text: "只有上傳者或管理員能把這份摘要存入知識庫。" } as never);
      } catch { /* best-effort */ }
      return true;
    }

    const existing = findAtomByThreadKey(marker.threadKey);
    if (existing) {
      await this.reply(args.channelId, marker.summaryTs, `已在知識庫了 (id: \`${existing.id}\`)`);
      deleteAtomMarker(args.channelId, args.messageTs);
      return true;
    }

    const claimed = acquireAtomMarker(args.channelId, args.messageTs);
    if (!claimed) return true; // another reaction is mid-save (mutex)

    let permalink: string | undefined;
    try {
      const r = (await this.opts.web.chat.getPermalink({ channel: args.channelId, message_ts: marker.summaryTs } as never)) as { permalink?: string };
      permalink = r.permalink;
    } catch (err) {
      this.opts.onLog(`audio atom: getPermalink failed: ${redactSecrets((err as Error).message)}`);
    }

    const answer = redactSecrets(marker.summaryText);
    const question = redactSecrets(marker.title);
    // Scan BOTH the title (question) and the body — the title is injected into
    // retrieval context just like the answer, so it needs the same defence.
    const scan = scanAtomFields({ question, answer });
    if (scan.flagged) this.opts.onLog(`audio atom flagged for injection: ${scan.reasons.join("; ")}`);
    const ent = countHighEntropyTokens(answer);
    if (ent > 0) this.opts.onLog(`audio atom: ${ent} high-entropy token(s) — possible secret in summary`);

    const firstLine = answer.split("\n").map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 200);
    const atom: KnowledgeAtom = {
      id: generateAtomId(marker.title), createdAt: now(), scope: marker.scope,
      question, answer, summary: firstLine, tags: marker.tags,
      source: { threadKey: marker.threadKey, contributorUserId: marker.uploaderId, permalink },
      status: "approved", flagged: scan.flagged || undefined,
    };
    const saveAtomFn = this.opts.deps?.saveAtom ?? saveAtom;
    try {
      saveAtomFn(atom);
      await this.reply(args.channelId, marker.summaryTs, `已加進知識庫 🔎 (id: \`${atom.id}\`)`);
      deleteAtomMarker(args.channelId, args.messageTs);
    } catch (err) {
      this.opts.onLog(`audio atom save failed: ${redactSecrets((err as Error).message)}`);
      restoreAtomMarker(args.channelId, args.messageTs);
      await this.reply(args.channelId, marker.summaryTs, ":warning: 存入知識庫失敗,稍後再按一次 📚 重試。");
    }
    return true;
  }
}
