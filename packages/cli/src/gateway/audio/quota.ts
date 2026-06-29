import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface DayUsage {
  global: number;
  perUser: Record<string, number>;
}

interface MonthUsage {
  global: number;
}

function dayFile(now: number): string {
  const d = new Date(now).toISOString().slice(0, 10);
  return path.join(os.homedir(), ".pmk", "gateway", `audio-usage-${d}.json`);
}

function monthFile(now: number): string {
  const m = new Date(now).toISOString().slice(0, 7); // YYYY-MM
  return path.join(os.homedir(), ".pmk", "gateway", `audio-usage-month-${m}.json`);
}

function loadMonth(file: string): MonthUsage {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MonthUsage;
    if (!Number.isFinite(parsed.global)) return { global: 0 };
    return { global: Number(parsed.global) };
  } catch {
    return { global: 0 };
  }
}

function writeMonth(file: string, usage: MonthUsage): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(usage));
}

function load(file: string): DayUsage {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DayUsage;
    // Validate shape: guard against valid-JSON-but-wrong-type files that
    // would make global/perUser arithmetic produce NaN and bypass caps.
    if (!Number.isFinite(parsed.global) || typeof parsed.perUser !== "object" || parsed.perUser === null) {
      return { global: 0, perUser: {} };
    }
    // Coerce each per-user value; drop non-finite entries.
    const perUser: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.perUser)) {
      const n = Number(v);
      if (Number.isFinite(n)) perUser[k] = n;
    }
    return { global: Number(parsed.global), perUser };
  } catch {
    return { global: 0, perUser: {} };
  }
}

export function reserveAudioQuota(args: {
  userId: string;
  minutes: number;
  perUserDailyMinutes: number;
  globalDailyMinutes: number;
  /** Whole-workspace monthly ceiling in minutes; omit to disable the monthly cap. */
  globalMonthlyMinutes?: number;
  now?: () => number;
}): { ok: true } | { ok: false; reason: string } {
  const now = (args.now ?? (() => Date.now()))();
  const file = dayFile(now);
  const usage = load(file);
  const userUsed = usage.perUser[args.userId] ?? 0;

  const mFile = monthFile(now);
  const month = loadMonth(mFile);

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

  if (
    Number.isFinite(args.globalMonthlyMinutes) &&
    month.global + args.minutes > (args.globalMonthlyMinutes as number)
  )
    return {
      ok: false,
      reason: `已達全域每月音訊上限（${args.globalMonthlyMinutes} 分鐘）,請下個月再試`,
    };

  const next: DayUsage = {
    global: usage.global + args.minutes,
    perUser: { ...usage.perUser, [args.userId]: userUsed + args.minutes },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next));
  // Always track the monthly accumulator so releases can refund it, regardless
  // of whether the cap is currently enforced.
  writeMonth(mFile, { global: month.global + args.minutes });

  return { ok: true };
}

export function releaseAudioQuota(args: {
  userId: string;
  minutes: number;
  now?: () => number;
  /**
   * Timestamp the quota was RESERVED at. Refunds the reserve-time day/month
   * buckets rather than wall-clock-at-release, so a job that crosses a day or
   * month boundary refunds the same file it charged (otherwise the refund hits
   * a fresh next-period file — a no-op — and the charged period leaks minutes).
   */
  reservedAt?: number;
}): void {
  const ts = args.reservedAt ?? (args.now ?? (() => Date.now()))();
  const file = dayFile(ts);
  const usage = load(file);
  const userUsed = usage.perUser[args.userId] ?? 0;
  const next: DayUsage = {
    global: Math.max(0, usage.global - args.minutes),
    perUser: { ...usage.perUser, [args.userId]: Math.max(0, userUsed - args.minutes) },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next));

  const mFile = monthFile(ts);
  const month = loadMonth(mFile);
  writeMonth(mFile, { global: Math.max(0, month.global - args.minutes) });
}
