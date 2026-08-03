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
    info: async ({ channel }: { channel: string }) => ({
      channel: channel.startsWith("D")
        ? { is_im: true }
        : { is_channel: true, is_private: channel === "CPRIV" },
    }),
    members: async () => ({ members: ["U1", "U2"] }),
    ...over,
  },
}) as never;

describe("canUserAccessAtom", () => {
  // BEHAVIOUR CHANGE: an unparseable threadKey used to resolve to an empty
  // channel and return TRUE ("legacy/general atom — was always retrievable").
  // That is a fail-OPEN default in the only untrusted-content→LLM-context path
  // there is, and it contradicts the module's own fail-closed policy for
  // present-but-unresolvable channels. `parseAtomMarkdown` defaults a missing
  // front-matter field to "", so a mangled atom file landed straight on it and
  // became readable by every Slack user regardless of channel privacy.
  //
  // Unreachable-but-fixable beats silently-leaked: a denied atom shows up in
  // the log with its id, and repairing the front-matter restores it.
  describe("malformed threadKey → fail closed", () => {
    for (const [label, threadKey] of [
      ["empty (parseAtomMarkdown default for a missing field)", ""],
      ["no colon separator", "CPRIV"],
      ["leading colon → empty channel segment", ":1700000000.1"],
    ] as Array<[string, string]>) {
      it(`denies ${label}`, async () => {
        const c = makeAtomAccessChecker(web());
        assert.equal(await c.canUserAccessAtom("Uany", atom(threadKey)), false);
      });
    }

    it("names the denied atom in the log so a mangled file is fixable", async () => {
      const logs: string[] = [];
      const c = makeAtomAccessChecker(web(), undefined, (m) => logs.push(m));
      await c.canUserAccessAtom("Uany", atom(""));
      assert.ok(
        logs.some((l) => l.includes("x")),
        "the denial must name the atom id",
      );
    });
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
  it("DM/IM channel → only members, non-member excluded (fail-closed bug fix)", async () => {
    const dmMembers = ["U1"];
    const dmWeb = ({
      conversations: {
        info: async () => ({ channel: { is_im: true } }),
        members: async () => ({ members: dmMembers }),
      },
    }) as never;
    const c = makeAtomAccessChecker(dmWeb);
    assert.equal(await c.canUserAccessAtom("U1", atom("D123:1.1")), true);
    assert.equal(await c.canUserAccessAtom("U9", atom("D123:1.1")), false);
  });
  it("lookup error → fail closed (excluded)", async () => {
    const c = makeAtomAccessChecker(web({ info: async () => { throw new Error("boom"); } }));
    assert.equal(await c.canUserAccessAtom("U2", atom("CPRIV:1.1")), false);
  });

  // Cache: a fixed clock keeps both calls inside the TTL → the second is served
  // from cache, so info/members are each hit exactly once.
  it("caches isPublicChannel + members within TTL (no refetch on second call)", async () => {
    let infoCalls = 0, memberCalls = 0;
    const counting = {
      conversations: {
        info: async ({ channel }: { channel: string }) => { infoCalls++; return { channel: { is_channel: true, is_private: channel === "CPRIV" } }; },
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
        info: async ({ channel }: { channel: string }) => { infoCalls++; return { channel: { is_channel: true, is_private: channel === "CPRIV" } }; },
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
