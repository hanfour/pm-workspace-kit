/**
 * Durable, snapshot record for the confirmed-problem → GitHub issue flow.
 * Independent of the consumable escalation marker: it is NOT cleared when
 * a tech reply is absorbed, so the 🎫 path survives "reply first, react
 * later". Lifecycle is LOCK-THEN-FINALIZE (the lock must outlive an async,
 * non-idempotent `gh issue create`), distinct from claimThreadEscalation's
 * consume-on-claim.
 *
 * Files: <gatewayDir>/issue-candidates/<channelId>__<anchorTs>.json (0600).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "./config";
import { assertSafeSegment } from "./session-store";

export interface IssueCandidate {
  channelId: string;
  threadTs: string;
  /** Bot escalation message ts — the exact 🎫 react target + storage key. */
  anchorTs: string;
  /** request.repo (always present — repo-less escalations write no candidate). */
  scope: string;
  askerUserId: string;
  /** Tech pool actually @-mentioned for THIS thread (authorization snapshot). */
  mentionedUserIds: string[];
  question: string;
  diagnosis: string;
  /** Best-effort Slack permalink of the anchor message. */
  permalink?: string;
  /** Set once the issue is created (idempotency / finalize commit). */
  issuedUrl?: string;
}

function issueCandidatesDir(): string {
  return path.join(gatewayDir(), "issue-candidates");
}

export function issueCandidatePath(channelId: string, anchorTs: string): string {
  return path.join(
    issueCandidatesDir(),
    `${assertSafeSegment(channelId, "channelId")}__${assertSafeSegment(anchorTs, "anchorTs")}.json`,
  );
}

function isIssueCandidate(v: unknown): v is IssueCandidate {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.channelId === "string" &&
    typeof o.threadTs === "string" &&
    typeof o.anchorTs === "string" &&
    typeof o.scope === "string" &&
    typeof o.askerUserId === "string" &&
    Array.isArray(o.mentionedUserIds) &&
    typeof o.question === "string" &&
    typeof o.diagnosis === "string"
  );
}

export function saveIssueCandidate(c: IssueCandidate): void {
  const file = issueCandidatePath(c.channelId, c.anchorTs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
}

/**
 * Load a candidate. Missing file → undefined (silent). File present but
 * unparseable / failing the guard → undefined AND onLog is called once
 * (a corrupt record must be diagnosable, not a silent no-op).
 */
export function loadIssueCandidate(
  channelId: string,
  anchorTs: string,
  onLog?: (msg: string) => void,
): IssueCandidate | undefined {
  const file = issueCandidatePath(channelId, anchorTs);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (isIssueCandidate(parsed)) return parsed;
    onLog?.(`issue-candidate ${channelId}__${anchorTs} failed validation`);
    return undefined;
  } catch {
    onLog?.(`issue-candidate ${channelId}__${anchorTs} is corrupt JSON`);
    return undefined;
  }
}

/**
 * Atomically claim by renaming .json → .claiming (POSIX-atomic; only one
 * caller wins). Returns the parsed candidate, or undefined if the rename
 * fails (already claimed / finalized / missing). Does NOT delete the lock.
 */
export function claimIssueCandidate(
  channelId: string,
  anchorTs: string,
): IssueCandidate | undefined {
  const file = issueCandidatePath(channelId, anchorTs);
  const claiming = `${file}.claiming`;
  try {
    fs.renameSync(file, claiming);
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(claiming, "utf8")) as unknown;
    return isIssueCandidate(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Release a claim: rename .claiming → .json. Returns false (logged by caller) on failure. */
export function releaseIssueCandidate(channelId: string, anchorTs: string): boolean {
  const file = issueCandidatePath(channelId, anchorTs);
  try {
    fs.renameSync(`${file}.claiming`, file);
    return true;
  } catch {
    return false;
  }
}

/** Finalize: write issuedUrl into the .claiming file, THEN rename → .json (commit). */
export function finalizeIssueCandidate(
  channelId: string,
  anchorTs: string,
  url: string,
): void {
  const file = issueCandidatePath(channelId, anchorTs);
  const claiming = `${file}.claiming`;
  const parsed = JSON.parse(fs.readFileSync(claiming, "utf8")) as IssueCandidate;
  const updated: IssueCandidate = { ...parsed, issuedUrl: url };
  fs.writeFileSync(claiming, JSON.stringify(updated, null, 2), { mode: 0o600 });
  fs.renameSync(claiming, file);
}

/**
 * Recovery sweep (called by doctor). For each *.claiming file:
 *  - has issuedUrl → finalize (rename to .json); the issue exists, never re-create.
 *  - no issuedUrl and older than staleMs → warn (possible orphan; verify on GitHub).
 */
export function recoverIssueClaims(
  staleMs: number,
  onWarn: (msg: string) => void,
): void {
  const dir = issueCandidatesDir();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".claiming")) continue;
    const claiming = path.join(dir, name);
    const finalName = claiming.replace(/\.claiming$/, "");
    try {
      const parsed = JSON.parse(fs.readFileSync(claiming, "utf8")) as IssueCandidate;
      if (parsed.issuedUrl) {
        try {
          fs.renameSync(claiming, finalName);
        } catch {
          /* concurrent move / permission — skip, don't abort the sweep */
        }
        continue;
      }
    } catch {
      /* unreadable claiming file — fall through to staleness check */
    }
    try {
      const ageMs = Math.max(0, Date.now() - fs.statSync(claiming).mtimeMs);
      if (ageMs >= staleMs) {
        onWarn(`stale issue-candidate lock ${name} — verify on GitHub, then delete/restore`);
      }
    } catch {
      /* file disappeared between listing and statSync — skip, don't abort the sweep */
    }
  }
}
