import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface DayUsage {
  global: number;
  perUser: Record<string, number>;
}

function dayFile(now: number): string {
  const d = new Date(now).toISOString().slice(0, 10);
  return path.join(os.homedir(), ".pmk", "gateway", `audio-usage-${d}.json`);
}

function load(file: string): DayUsage {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DayUsage;
  } catch {
    return { global: 0, perUser: {} };
  }
}

export function reserveAudioQuota(args: {
  userId: string;
  minutes: number;
  perUserDailyMinutes: number;
  globalDailyMinutes: number;
  now?: () => number;
}): { ok: true } | { ok: false; reason: string } {
  const now = (args.now ?? (() => Date.now()))();
  const file = dayFile(now);
  const usage = load(file);
  const userUsed = usage.perUser[args.userId] ?? 0;

  if (userUsed + args.minutes > args.perUserDailyMinutes)
    return {
      ok: false,
      reason: `已達每人每日音訊上限（${args.perUserDailyMinutes} 分鐘）,請明天再試`,
    };

  if (usage.global + args.minutes > args.globalDailyMinutes)
    return {
      ok: false,
      reason: `已達全域每日音訊上限（${args.globalDailyMinutes} 分鐘）,請稍後再試`,
    };

  const next: DayUsage = {
    global: usage.global + args.minutes,
    perUser: { ...usage.perUser, [args.userId]: userUsed + args.minutes },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next));

  return { ok: true };
}

export function releaseAudioQuota(args: {
  userId: string;
  minutes: number;
  now?: () => number;
}): void {
  const now = (args.now ?? (() => Date.now()))();
  const file = dayFile(now);
  const usage = load(file);
  const userUsed = usage.perUser[args.userId] ?? 0;
  const next: DayUsage = {
    global: Math.max(0, usage.global - args.minutes),
    perUser: { ...usage.perUser, [args.userId]: Math.max(0, userUsed - args.minutes) },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next));
}
