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

/**
 * Self-heal orphaned review claims (B). A claim that was created but never
 * finalized (`done !== true`) is the signature of a gateway that
 * crashed/restarted mid-review: the awaiting process died, finalizeReview
 * never ran, and the lingering claim would otherwise make a re-`:cr:` falsely
 * report "already reviewed" instead of re-reviewing.
 *
 * Run at startup, when ALL non-finalized claims belong to a now-dead previous
 * instance. We still gate on `staleMs` — it MUST exceed the longest a real
 * review can run (on-demand PKB build + debate) so an orphaned mra that is
 * still finishing (and may yet post to GitHub) isn't released out from under
 * it, which would risk a duplicate review. Finalized claims (`done:true`) are
 * always kept — they are the idempotency record of a completed review.
 *
 * Returns the number of claims released. Best-effort: unreadable files are
 * treated as orphaned; a file that vanishes mid-sweep is skipped, never fatal.
 */
export function recoverReviewClaims(
  staleMs: number,
  onWarn: (msg: string) => void,
): number {
  let dir: string;
  try {
    dir = reviewsDir();
  } catch {
    return 0;
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no reviews dir yet — nothing to recover
  }
  let released = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(dir, name);
    let done = false;
    try {
      done = (JSON.parse(fs.readFileSync(p, "utf8")) as ClaimRecord).done === true;
    } catch {
      done = false; // unreadable / malformed — treat as a non-finalized orphan
    }
    if (done) continue; // completed review — keep (idempotency record)
    let ageMs: number;
    try {
      // clamp to 0 against sub-ms / future-skew, mirroring recoverIssueClaims
      ageMs = Math.max(0, Date.now() - fs.statSync(p).mtimeMs);
    } catch {
      continue; // vanished between listing and stat — skip, don't abort the sweep
    }
    if (ageMs < staleMs) continue; // too recent — an orphaned mra may still be finishing
    try {
      fs.rmSync(p, { force: true });
      released += 1;
      onWarn(
        `recovered orphaned review claim ${name} (unfinalized after ${Math.round(ageMs / 1000)}s) — PR can be re-reviewed`,
      );
    } catch {
      /* concurrent removal / permission — skip, don't abort the sweep */
    }
  }
  return released;
}

function nowIso(): string {
  return new Date().toISOString();
}
