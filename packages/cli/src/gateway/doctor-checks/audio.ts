import type { DoctorCheck, DoctorCheckResult } from "../doctor";
import { resolveAudioConfig } from "../config";
import { secretDiskLabel, validateSecretSource } from "../secret-source";
import { runMedia } from "../audio/spawn";

/**
 * audio check for the voice-message transcription flow. PASS when audio is
 * disabled (flow off). When enabled: openaiApiKey set + ffmpeg + ffprobe on
 * PATH → pass; any missing → fail.
 */
export const audioDoctorCheck: DoctorCheck = async (
  ctx,
): Promise<DoctorCheckResult> => {
  const audio = resolveAudioConfig(ctx.config?.audio);
  if (!audio.enabled) {
    return {
      name: "audio",
      severity: "pass",
      message: "audio off (transcription disabled)",
    };
  }

  const rawSrc = validateSecretSource(
    ctx.config?.audio?.openaiApiKey,
    "audio.openaiApiKey",
  );
  const diskLabel = secretDiskLabel(rawSrc);

  const ffmpegOk = await runMedia("ffmpeg", ["-version"], { timeoutMs: 5000 })
    .then(() => "ok")
    .catch(() => "missing");
  const ffprobeOk = await runMedia("ffprobe", ["-version"], { timeoutMs: 5000 })
    .then(() => "ok")
    .catch(() => "missing");

  const problems: string[] = [];
  if (diskLabel === "unset") problems.push("audio.openaiApiKey unset");
  if (ffmpegOk === "missing") problems.push("ffmpeg not on PATH");
  if (ffprobeOk === "missing") problems.push("ffprobe not on PATH");

  const detail = `enabled; openaiApiKey=${diskLabel}; ffmpeg=${ffmpegOk}; ffprobe=${ffprobeOk}`;
  return {
    name: "audio",
    severity: problems.length ? "fail" : "pass",
    message: problems.length
      ? `${detail} — ${problems.join("; ")}`
      : detail,
  };
};
