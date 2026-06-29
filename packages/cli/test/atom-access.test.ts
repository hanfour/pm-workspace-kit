import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { makeAtomAccessChecker } from "../src/gateway/atom-access";
import type { KnowledgeAtom } from "../src/gateway/knowledge";

const atom = (threadKey: string): KnowledgeAtom => ({
  id: "x", createdAt: 1, scope: "general", question: "q", answer: "a", tags: [],
  source: { threadKey, contributorUserId: "U1" }, status: "approved",
});
const web = (over: Record<string, unknown> = {}) => ({
  conversations: {
    info: async ({ channel }: { channel: string }) => ({ channel: { is_private: channel === "CPRIV" } }),
    members: async () => ({ members: ["U1", "U2"] }),
    ...over,
  },
}) as never;

describe("canUserAccessAtom", () => {
  it("legacy atom with no channel → accessible", async () => {
    const c = makeAtomAccessChecker(web());
    assert.equal(await c.canUserAccessAtom("Uany", { ...atom(""), source: { threadKey: "", contributorUserId: "U1" } }), true);
  });
  it("public channel → accessible to anyone", async () => {
    const c = makeAtomAccessChecker(web());
    assert.equal(await c.canUserAccessAtom("Ustranger", atom("CPUB:1.1")), true);
  });
  it("private channel → only members", async () => {
    const c = makeAtomAccessChecker(web());
    assert.equal(await c.canUserAccessAtom("U2", atom("CPRIV:1.1")), true);
    assert.equal(await c.canUserAccessAtom("U9", atom("CPRIV:1.1")), false);
  });
  it("lookup error → fail closed (excluded)", async () => {
    const c = makeAtomAccessChecker(web({ info: async () => { throw new Error("boom"); } }));
    assert.equal(await c.canUserAccessAtom("U2", atom("CPRIV:1.1")), false);
  });

  // Cache: a fixed clock keeps both calls inside the TTL → the second is served
  // from cache, so info/members are each hit exactly once.
  it("caches is_private + members within TTL (no refetch on second call)", async () => {
    let infoCalls = 0, memberCalls = 0;
    const counting = {
      conversations: {
        info: async ({ channel }: { channel: string }) => { infoCalls++; return { channel: { is_private: channel === "CPRIV" } }; },
        members: async () => { memberCalls++; return { members: ["U1", "U2"] }; },
      },
    } as never;
    const now = () => 1000;
    const c = makeAtomAccessChecker(counting, now);
    assert.equal(await c.canUserAccessAtom("U2", atom("CPRIV:1.1")), true);
    assert.equal(await c.canUserAccessAtom("U2", atom("CPRIV:1.1")), true);
    assert.equal(infoCalls, 1);
    assert.equal(memberCalls, 1);
  });

  // TTL expiry: advancing the clock past TTL_MS (5*60*1000 = 300000) invalidates
  // both caches → the second call refetches, so info/members are hit twice.
  it("refetches after TTL expiry", async () => {
    let infoCalls = 0, memberCalls = 0;
    const counting = {
      conversations: {
        info: async ({ channel }: { channel: string }) => { infoCalls++; return { channel: { is_private: channel === "CPRIV" } }; },
        members: async () => { memberCalls++; return { members: ["U1", "U2"] }; },
      },
    } as never;
    let t = 1000;
    const now = () => t;
    const c = makeAtomAccessChecker(counting, now);
    assert.equal(await c.canUserAccessAtom("U2", atom("CPRIV:1.1")), true);
    t += 300001; // TTL_MS (300000) + 1 → caches expired
    assert.equal(await c.canUserAccessAtom("U2", atom("CPRIV:1.1")), true);
    assert.equal(infoCalls, 2);
    assert.equal(memberCalls, 2);
  });
});
