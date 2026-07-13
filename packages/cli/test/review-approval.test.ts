import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { consumeApprovalOffer, consumeApprovalReservation, listPendingApprovalReconciliations, markApprovalPendingReconcile, releaseApprovalReservation, reserveApprovalOffer, resolveApprovalReconciliation, saveApprovalOffer, sweepApprovalOffers } from "../src/gateway/review-approval";

const originalHome = process.env.HOME;
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-review-offer-"));
  process.env.HOME = tmp;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("review approval offers", () => {
  it("persists refs and consumes the offer exactly once", () => {
    const ref = { owner: "o", repo: "r", number: 3, url: "https://github.com/o/r/pull/3", headSha: "abc", baseRef: "main", artifactSha256: "digest" };
    saveApprovalOffer("C1", "1.1", ref);
    assert.deepEqual(consumeApprovalOffer("C1", "1.1"), [ref]);
    assert.equal(consumeApprovalOffer("C1", "1.1"), undefined);
  });

  it("rejects an expired offer", () => {
    saveApprovalOffer("C1", "1.1", { owner: "o", repo: "r", number: 3, url: "u", headSha: "abc", baseRef: "main", artifactSha256: "digest" }, -1);
    assert.equal(consumeApprovalOffer("C1", "1.1"), undefined);
  });

  it("releases a reservation after preflight failure and consumes only after publish", () => {
    const ref = { owner: "o", repo: "r", number: 3, url: "u", headSha: "abc", baseRef: "main", artifactSha256: "digest" };
    saveApprovalOffer("C1", "1.1", ref);
    const first = reserveApprovalOffer("C1", "1.1");
    assert.ok(first);
    assert.equal(reserveApprovalOffer("C1", "1.1"), undefined);
    releaseApprovalReservation(first);
    const second = reserveApprovalOffer("C1", "1.1");
    assert.ok(second);
    consumeApprovalReservation(second);
    assert.equal(reserveApprovalOffer("C1", "1.1"), undefined);
  });
  it("sweeps expired available offers into terminal state", () => {
    saveApprovalOffer("C1", "1.1", { owner: "o", repo: "r", number: 3, url: "u", headSha: "abc", baseRef: "main", artifactSha256: "digest" }, -1);
    assert.equal(sweepApprovalOffers(), 1);
    assert.equal(reserveApprovalOffer("C1", "1.1"), undefined);
  });
  it("does not overwrite a newer available offer when releasing an old reservation", () => {
    const oldRef = { owner: "o", repo: "r", number: 3, url: "old", headSha: "old", baseRef: "main", artifactSha256: "old" };
    const newRef = { ...oldRef, url: "new", headSha: "new", artifactSha256: "new" };
    saveApprovalOffer("C1", "1.1", oldRef);
    const reservation = reserveApprovalOffer("C1", "1.1");
    assert.ok(reservation);
    const available = reservation.reservedPath.split(".reserved.")[0]!;
    fs.writeFileSync(available, JSON.stringify({
      channelId: "C1", threadTs: "1.1", createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), refs: [newRef],
    }), { mode: 0o600 });
    releaseApprovalReservation(reservation);
    assert.deepEqual(consumeApprovalOffer("C1", "1.1"), [newRef]);
  });
  it("recovers a confirmed-absent pending publication exactly once", () => {
    const ref = { owner: "o", repo: "r", number: 3, url: "u", headSha: "a".repeat(40), baseRef: "main", artifactSha256: "b".repeat(64) };
    saveApprovalOffer("C1", "1.1", ref);
    const reservation = reserveApprovalOffer("C1", "1.1");
    assert.ok(reservation);
    markApprovalPendingReconcile(reservation);
    const [pending] = listPendingApprovalReconciliations("C1", "1.1");
    assert.ok(pending);
    resolveApprovalReconciliation(pending, "absent");
    assert.deepEqual(consumeApprovalOffer("C1", "1.1"), [ref]);
  });
});
