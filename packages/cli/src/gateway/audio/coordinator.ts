/**
 * AudioCoordinator — detached transcribe → summary pipeline.
 *
 * Flow per audio message:
 *   enabled gate → apiKey gate → find audio file → claimAudio →
 *   reserveQuota (pre-transcription gate) →
 *   ack post → streamToTemp → transcribeAudio →
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
} from "../attachments/types";
import { streamSlackFileToTemp } from "./download-stream";
import { transcribeAudio, type TranscribeResult } from "./transcribe";
import { summarizeMeeting } from "./summarize";
import { reserveAudioQuota } from "./quota";
import { makeJobTempDir } from "./temp";
import { claimAudio, releaseAudio, finalizeAudio } from "./claim";
import { redactSecrets } from "./redact";

const USD_PER_MINUTE = 0.003; // gpt-4o-mini-transcribe est.; for estimatedUsd only

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
  makeTempDir?: (jobId: string) => string;
  now?: () => number;
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
      return;
    }

    // Pre-transcription quota gate: check capacity BEFORE burning compute on
    // transcription. We use minutes=1 as a minimum-capacity check — if the user
    // can't afford even one more minute they're blocked; otherwise we proceed and
    // reserve actual usage via the transcribed event.
    const q = reserveQuota({
      userId: args.userId,
      minutes: 1,
      perUserDailyMinutes: ac.perUserDailyMinutes,
      globalDailyMinutes: ac.globalDailyMinutes,
      now,
    });
    if (!q.ok) {
      releaseAudio(file.id);
      appendGatewayEvent({
        type: "audio.failed",
        actor: args.userId,
        reason: "quota-exceeded",
      });
      await this.reply(
        args.channelId,
        args.threadTs,
        `:no_entry: ${q.reason}。`,
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

      const result = await transcribe(
        dest,
        {
          apiKey,
          model: ac.model,
          language: ac.language,
          maxDurationSec: ac.maxDurationSec,
        },
        { outDir: tempDir, signal: controller.signal },
      );

      if (!result.ok) {
        const reason = result.reason;
        appendGatewayEvent({ type: "audio.failed", actor: args.userId, reason });
        if (reason === "too-long") {
          await post(
            `:warning: 錄音超過 ${Math.round(ac.maxDurationSec / 60)} 分鐘上限,請切段後再上傳。`,
          );
        } else if (result.partialTranscript) {
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
          releaseAudio(file.id); // failed before any usable output → allow retry
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
        audioFiles.length < totalAudio
          ? "\n_（本則多個音訊只處理了第一個,其餘請另開訊息）_"
          : "";

      await post(summary.text + extra);
    } catch (err) {
      releaseAudio(file.id);
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
}
