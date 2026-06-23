/**
 * Idempotency for PR reviews. A claim file per (owner,repo,pr,headSha) ensures
 * the same head SHA is never reviewed twice (re-reactions, multiple reactors),
 * while new commits (new SHA) form a fresh claim → re-review. Atomic create via
 * wx flag. Mirrors the storage discipline of issue-candidate.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "./config"; // SAME base as issue-candidate.ts (imports gatewayDir from ./config)

export interface ReviewRef {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
}

interface ClaimRecord {
  key: string;
  claimedAt: string;
  done?: boolean;
  status?: string;
  reviewUrl?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function reviewClaimKey(r: ReviewRef): string {
  return [sanitize(r.owner), sanitize(r.repo), String(r.pr), sanitize(r.headSha)].join("__");
}

function reviewsDir(): string {
  const dir = path.join(gatewayDir(), "reviews");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function claimPath(r: ReviewRef): string {
  return path.join(reviewsDir(), `${reviewClaimKey(r)}.json`);
}

export function claimReview(r: ReviewRef): boolean {
  const rec: ClaimRecord = { key: reviewClaimKey(r), claimedAt: nowIso() };
  try {
    fs.writeFileSync(claimPath(r), JSON.stringify(rec), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export function finalizeReview(r: ReviewRef, info: { reviewUrl?: string; status?: string }): void {
  const p = claimPath(r);
  let rec: ClaimRecord;
  try {
    rec = JSON.parse(fs.readFileSync(p, "utf8")) as ClaimRecord;
  } catch {
    rec = { key: reviewClaimKey(r), claimedAt: nowIso() };
  }
  const updated: ClaimRecord = { ...rec, done: true, status: info.status, reviewUrl: info.reviewUrl };
  fs.writeFileSync(p, JSON.stringify(updated), { mode: 0o600 });
}

export function releaseReview(r: ReviewRef): void {
  try {
    fs.rmSync(claimPath(r), { force: true });
  } catch {
    /* best-effort */
  }
}

export function isReviewDone(r: ReviewRef): boolean {
  try {
    const rec = JSON.parse(fs.readFileSync(claimPath(r), "utf8")) as ClaimRecord;
    return rec.done === true;
  } catch {
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
