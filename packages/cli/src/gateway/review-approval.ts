import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "./config";

export interface ApprovalOfferRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
  headSha: string;
  baseRef: string;
  artifactSha256: string;
  contextVersion?: string;
}

interface ApprovalOffer {
  channelId: string;
  threadTs: string;
  createdAt: string;
  expiresAt: string;
  refs: ApprovalOfferRef[];
}

export interface ApprovalReservation {
  id: string;
  channelId: string;
  threadTs: string;
  refs: ApprovalOfferRef[];
  expiresAt: string;
  reservedPath: string;
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function offerDir(): string {
  const dir = path.join(gatewayDir(), "review-approval-offers");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function offerPath(channelId: string, threadTs: string): string {
  return path.join(offerDir(), `${safe(channelId)}__${safe(threadTs)}.json`);
}

function writeOfferAtomic(target: string, offer: ApprovalOffer): void {
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(offer));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

function acquireOfferLock(target: string): string | undefined {
  const lock = `${target}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, "owner"), String(process.pid), { mode: 0o600 });
      return lock;
    } catch {
      try {
        const pid = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
        process.kill(pid, 0);
        return undefined;
      } catch {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

function releaseOfferLock(lock: string): void {
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export function saveApprovalOffer(
  channelId: string,
  threadTs: string,
  ref: ApprovalOfferRef,
  ttlMs = 24 * 60 * 60_000,
): void {
  const p = offerPath(channelId, threadTs);
  const lock = acquireOfferLock(p);
  if (!lock) return;
  try {
  const reservedPrefix = `${path.basename(p)}.reserved.`;
  if (fs.readdirSync(offerDir()).some((name) => name.startsWith(reservedPrefix))) return;
  let refs: ApprovalOfferRef[] = [];
  try {
    const old = JSON.parse(fs.readFileSync(p, "utf8")) as ApprovalOffer;
    if (Date.parse(old.expiresAt) > Date.now()) refs = old.refs;
  } catch { /* new offer */ }
  refs = [...refs.filter((r) => !(r.owner === ref.owner && r.repo === ref.repo && r.number === ref.number)), ref];
  const offer: ApprovalOffer = {
    channelId,
    threadTs,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    refs,
  };
  writeOfferAtomic(p, offer);
  } finally {
    releaseOfferLock(lock);
  }
}

/** Consume exactly once by renaming before reading. */
export function consumeApprovalOffer(channelId: string, threadTs: string): ApprovalOfferRef[] | undefined {
  const p = offerPath(channelId, threadTs);
  const consumed = `${p}.consumed.${Date.now()}.${process.pid}`;
  try {
    fs.renameSync(p, consumed);
  } catch {
    return undefined;
  }
  try {
    const offer = JSON.parse(fs.readFileSync(consumed, "utf8")) as ApprovalOffer;
    if (offer.channelId !== channelId || offer.threadTs !== threadTs) return undefined;
    if (Date.parse(offer.expiresAt) <= Date.now()) return undefined;
    return offer.refs;
  } catch {
    return undefined;
  }
}

export function reserveApprovalOffer(channelId: string, threadTs: string): ApprovalReservation | undefined {
  const p = offerPath(channelId, threadTs);
  const lock = acquireOfferLock(p);
  if (!lock) return undefined;
  const id = `${Date.now()}.${process.pid}.${Math.random().toString(16).slice(2)}`;
  const reservedPath = `${p}.reserved.${id}`;
  try {
    fs.renameSync(p, reservedPath);
    const offer = JSON.parse(fs.readFileSync(reservedPath, "utf8")) as ApprovalOffer;
    if (offer.channelId !== channelId || offer.threadTs !== threadTs || Date.parse(offer.expiresAt) <= Date.now()) {
      fs.renameSync(reservedPath, `${reservedPath}.invalidated`);
      return undefined;
    }
    return { id, channelId, threadTs, refs: offer.refs, expiresAt: offer.expiresAt, reservedPath };
  } catch {
    return undefined;
  } finally {
    releaseOfferLock(lock);
  }
}

export function releaseApprovalReservation(reservation: ApprovalReservation): void {
  const target = offerPath(reservation.channelId, reservation.threadTs);
  const lock = acquireOfferLock(target);
  if (!lock) return;
  try {
  if (Date.parse(reservation.expiresAt) <= Date.now()) {
    try { fs.renameSync(reservation.reservedPath, `${reservation.reservedPath}.expired`); } catch { /* already terminal */ }
    return;
  }
  const available = target;
  if (fs.existsSync(available)) {
    try { fs.renameSync(reservation.reservedPath, `${reservation.reservedPath}.invalidated`); } catch { /* already terminal */ }
    return;
  }
  try { fs.renameSync(reservation.reservedPath, available); } catch { /* already terminal */ }
  } finally {
    releaseOfferLock(lock);
  }
}

export function consumeApprovalReservation(reservation: ApprovalReservation): void {
  fs.renameSync(reservation.reservedPath, `${reservation.reservedPath}.consumed`);
}

export function markApprovalPendingReconcile(reservation: ApprovalReservation): void {
  fs.renameSync(reservation.reservedPath, `${reservation.reservedPath}.pending-reconcile`);
}

export function listPendingApprovalReconciliations(channelId: string, threadTs: string): ApprovalReservation[] {
  const prefix = `${path.basename(offerPath(channelId, threadTs))}.reserved.`;
  const out: ApprovalReservation[] = [];
  for (const name of fs.readdirSync(offerDir())) {
    if (!name.startsWith(prefix) || !name.endsWith(".pending-reconcile")) continue;
    const pendingPath = path.join(offerDir(), name);
    try {
      const offer = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as ApprovalOffer;
      if (offer.channelId === channelId && offer.threadTs === threadTs)
        out.push({ id: name, channelId, threadTs, refs: offer.refs, expiresAt: offer.expiresAt, reservedPath: pendingPath });
    } catch { /* leave malformed evidence for operator inspection */ }
  }
  return out;
}

export function resolveApprovalReconciliation(reservation: ApprovalReservation, outcome: "consumed" | "absent"): void {
  if (outcome === "consumed") {
    fs.renameSync(reservation.reservedPath, `${reservation.reservedPath}.consumed`);
    return;
  }
  const available = offerPath(reservation.channelId, reservation.threadTs);
  if (Date.parse(reservation.expiresAt) <= Date.now() || fs.existsSync(available)) {
    fs.renameSync(reservation.reservedPath, `${reservation.reservedPath}.invalidated`);
    return;
  }
  fs.renameSync(reservation.reservedPath, available);
}

export function sweepApprovalOffers(now = Date.now(), terminalRetentionMs = 30 * 24 * 60 * 60_000): number {
  const dir = offerDir();
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (/\.(consumed|invalidated|expired)$/.test(name) && now - st.mtimeMs > terminalRetentionMs) {
        fs.rmSync(p, { force: true });
        removed++;
      } else if (name.endsWith(".json")) {
        const offer = JSON.parse(fs.readFileSync(p, "utf8")) as ApprovalOffer;
        if (Date.parse(offer.expiresAt) <= now) {
          fs.renameSync(p, `${p}.expired`);
          removed++;
        }
      }
    } catch { /* concurrent transition */ }
  }
  return removed;
}
