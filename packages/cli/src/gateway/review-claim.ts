/**
 * Idempotency for PR reviews. A claim file per (owner,repo,pr,headSha) ensures
 * the same head SHA is never reviewed twice (re-reactions, multiple reactors),
 * while new commits (new SHA) form a fresh claim → re-review. Atomic create via
 * wx flag. Mirrors the storage discipline of issue-candidate.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { gatewayDir } from "./config"; // SAME base as issue-candidate.ts (imports gatewayDir from ./config)

export interface ReviewRef {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  intent?: "review" | "approve";
  /**
   * The PR's `updated_at` at trigger time. Carried for callers that record it,
   * but DELIBERATELY NOT part of the claim key — see {@link reviewClaimKey}.
   */
  contextVersion?: string;
}

interface ClaimRecord {
  key: string;
  claimedAt: string;
  ownerPid?: number;
  ownerId?: string;
  done?: boolean;
  status?: string;
  reviewUrl?: string;
}

const activeOwners = new Map<string, string>();

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The identity of one review: (owner, repo, pr, headSha) plus intent.
 *
 * `contextVersion` (the PR's `updated_at`) is deliberately EXCLUDED. Including
 * it silently defeated the whole mechanism: the gateway's own review post bumps
 * `updated_at`, as does any teammate comment, so the next trigger computed a
 * different key, the `wx` create succeeded, and the same commit was reviewed
 * again. Seen live 9 times, with the verdict flipping between
 * CHANGES_REQUESTED and 0-blocker on byte-identical code — and since a
 * 0-blocker result is what opens the approve offer, a blocked PR could become
 * approvable without a single line changing.
 *
 * The approve path reached the same conclusion independently (see the
 * freshness-pin comment in slack/review.ts: pin headSha + baseRef, never
 * updatedAt); the claim key simply never followed.
 */
export function reviewClaimKey(r: ReviewRef): string {
  const base = [sanitize(r.owner), sanitize(r.repo), String(r.pr), sanitize(r.headSha)];
  const intent = r.intent ?? "review";
  return (intent === "review" ? base : [...base, sanitize(intent)]).join("__");
}

function reviewsDir(): string {
  const dir = path.join(gatewayDir(), "reviews");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function claimPath(r: ReviewRef): string {
  return path.join(reviewsDir(), `${reviewClaimKey(r)}.json`);
}

/**
 * A sanitized ISO instant, i.e. the shape a legacy `contextVersion` segment
 * takes on disk (`2026-07-13T08_42_44Z`). Matching the SHAPE rather than any
 * `key__…` suffix matters: the approve key is the review key plus `__approve`,
 * so a loose prefix match would let an approve claim block a review claim.
 */
const LEGACY_CONTEXT_SUFFIX = /^\d{4}-\d{2}-\d{2}T[\d_]+Z$/;

/**
 * True when a pre-upgrade claim for this same review was already finalized.
 *
 * Claims written while `contextVersion` was part of the key carry it as a
 * trailing segment. Dropping it from the key would otherwise orphan every one
 * of them, so the first trigger after upgrading would re-review an
 * already-reviewed commit — reproducing, once per PR, the very bug the change
 * removes. Recognised on read; nothing on disk is rewritten.
 */
function hasFinalizedLegacyClaim(key: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(reviewsDir());
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || !name.startsWith(`${key}__`)) continue;
    const suffix = name.slice(key.length + 2, -".json".length);
    if (!LEGACY_CONTEXT_SUFFIX.test(suffix)) continue;
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(reviewsDir(), name), "utf8"),
      ) as ClaimRecord;
      // Only a FINALIZED legacy claim counts. An unfinalized one is an orphan
      // from a crashed run, which recoverReviewClaims would have released.
      if (rec.done === true) return true;
    } catch {
      /* unreadable — treat as absent rather than blocking a fresh review */
    }
  }
  return false;
}

export function claimReview(r: ReviewRef): boolean {
  const key = reviewClaimKey(r);
  if (hasFinalizedLegacyClaim(key)) return false;
  const ownerId = randomUUID();
  const rec: ClaimRecord = { key, claimedAt: nowIso(), ownerPid: process.pid, ownerId };
  try {
    fs.writeFileSync(claimPath(r), JSON.stringify(rec), { flag: "wx", mode: 0o600 });
    activeOwners.set(key, ownerId);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Archive a completed claim and atomically claim the same SHA again. */
export function forceClaimReview(r: ReviewRef): boolean {
  const p = claimPath(r);
  let rec: ClaimRecord;
  try {
    rec = JSON.parse(fs.readFileSync(p, "utf8")) as ClaimRecord;
  } catch {
    return claimReview(r);
  }
  if (rec.done !== true) return false;
  const archive = path.join(
    reviewsDir(),
    `${reviewClaimKey(r)}.history.${Date.now()}.${process.pid}.json`,
  );
  try {
    fs.renameSync(p, archive);
  } catch {
    return false;
  }
  if (claimReview(r)) return true;
  try { fs.renameSync(archive, p); } catch { /* best-effort restore */ }
  return false;
}

export function finalizeReview(r: ReviewRef, info: { reviewUrl?: string; status?: string }): void {
  const p = claimPath(r);
  const key = reviewClaimKey(r);
  const ownerId = activeOwners.get(key);
  if (!ownerId) return;
  let rec: ClaimRecord;
  try {
    rec = JSON.parse(fs.readFileSync(p, "utf8")) as ClaimRecord;
  } catch {
    return;
  }
  if (rec.ownerId !== ownerId) return;
  const updated: ClaimRecord = { ...rec, done: true, status: info.status, reviewUrl: info.reviewUrl };
  fs.writeFileSync(p, JSON.stringify(updated), { mode: 0o600 });
  activeOwners.delete(key);
}

export function releaseReview(r: ReviewRef): void {
  const key = reviewClaimKey(r);
  const ownerId = activeOwners.get(key);
  if (!ownerId) return;
  try {
    const rec = JSON.parse(fs.readFileSync(claimPath(r), "utf8")) as ClaimRecord;
    if (rec.ownerId !== ownerId) return;
    fs.rmSync(claimPath(r), { force: true });
    activeOwners.delete(key);
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
    let ownerPid: number | undefined;
    try {
      const record = JSON.parse(fs.readFileSync(p, "utf8")) as ClaimRecord;
      done = record.done === true;
      ownerPid = record.ownerPid;
    } catch {
      done = false; // unreadable / malformed — treat as a non-finalized orphan
    }
    if (done) continue; // completed review — keep (idempotency record)
    if (ownerPid && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        continue; // another live gateway still owns this review
      } catch { /* owner exited; age gate below still applies */ }
    }
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
