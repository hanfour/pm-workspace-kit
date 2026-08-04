import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  admissionRefusal,
  admissionRefusalMessage,
} from "../src/gateway/slack/review-admission";

/**
 * Three independent limits guard a review start: total concurrency, per-actor
 * concurrency, and one-review-per-repo. They were a single `||` chain inside
 * runOne, reachable only by driving the coordinator with a populated in-flight
 * set — so which limit fired was never asserted anywhere, and the user was told
 * "已達併發上限，或同一 repo 正在 review" for all three. The code knew; the
 * message did not.
 */
const entry = (actorUserId: string, projectKey: string) => ({ actorUserId, projectKey });
const limits = { maxConcurrent: 3, maxConcurrentPerUser: 2 };

describe("admissionRefusal", () => {
  it("admits when nothing is in flight", () => {
    assert.equal(
      admissionRefusal([], { actorUserId: "U1", projectKey: "o/r", ...limits }),
      undefined,
    );
  });

  it("admits below every limit", () => {
    const inFlight = [entry("U2", "o/other")];
    assert.equal(
      admissionRefusal(inFlight, { actorUserId: "U1", projectKey: "o/r", ...limits }),
      undefined,
    );
  });

  it("refuses on the global limit", () => {
    const inFlight = [entry("U2", "a/a"), entry("U3", "b/b"), entry("U4", "c/c")];
    const res = admissionRefusal(inFlight, { actorUserId: "U1", projectKey: "o/r", ...limits });
    assert.equal(res?.limit, "global");
    if (res?.limit === "global") {
      assert.equal(res.active, 3);
      assert.equal(res.max, 3);
    }
  });

  it("refuses on the per-actor limit while the global limit still has room", () => {
    const inFlight = [entry("U1", "a/a"), entry("U1", "b/b")];
    const res = admissionRefusal(inFlight, { actorUserId: "U1", projectKey: "o/r", ...limits });
    assert.equal(res?.limit, "per-user");
    if (res?.limit === "per-user") assert.equal(res.active, 2);
  });

  it("counts only the asking actor toward the per-actor limit", () => {
    const inFlight = [entry("U9", "a/a"), entry("U9", "b/b")];
    const res = admissionRefusal(inFlight, { actorUserId: "U1", projectKey: "o/r", ...limits });
    assert.equal(res, undefined, "another user's reviews must not block this one");
  });

  it("refuses a second review of the same repo", () => {
    const inFlight = [entry("U9", "o/r")];
    const res = admissionRefusal(inFlight, { actorUserId: "U1", projectKey: "o/r", ...limits });
    assert.equal(res?.limit, "same-repo");
    if (res?.limit === "same-repo") assert.equal(res.projectKey, "o/r");
  });

  // Preserves the original short-circuit order, so the reported cause stays
  // the outermost one when several apply at once.
  it("reports the global limit first when several limits apply", () => {
    const inFlight = [entry("U1", "o/r"), entry("U1", "b/b"), entry("U5", "c/c")];
    const res = admissionRefusal(inFlight, { actorUserId: "U1", projectKey: "o/r", ...limits });
    assert.equal(res?.limit, "global");
  });
});

describe("admissionRefusalMessage", () => {
  // The old text named all three causes with "或" regardless of which fired.
  // A user hitting the per-repo limit was told the system was busy, when in
  // fact their own earlier review was still running on that repo.
  it("names the actual cause, and each cause reads differently", () => {
    const texts = [
      admissionRefusalMessage({ limit: "global", active: 3, max: 3 }),
      admissionRefusalMessage({ limit: "per-user", active: 2, max: 2 }),
      admissionRefusalMessage({ limit: "same-repo", projectKey: "o/r" }),
    ];
    assert.equal(new Set(texts).size, 3, "each cause must produce distinct text");
    for (const t of texts) assert.ok(t.length > 0);
  });

  it("names the repo when the repo is the reason", () => {
    assert.match(
      admissionRefusalMessage({ limit: "same-repo", projectKey: "onead/erp" }),
      /onead\/erp/,
    );
  });

  it("shows the limit that was reached", () => {
    assert.match(admissionRefusalMessage({ limit: "global", active: 3, max: 3 }), /3/);
    assert.match(admissionRefusalMessage({ limit: "per-user", active: 2, max: 2 }), /2/);
  });
});
