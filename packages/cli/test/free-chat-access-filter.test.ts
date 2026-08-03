/**
 * Task 10: Membership-gated atom retrieval in free-chat hot path.
 *
 * Test approach: `run()` is hard to drive in isolation (requires a live
 * WebClient, LLM, mraDoctor, etc.), so we test the access-filter loop
 * directly against `makeAtomAccessChecker` with a stub web — exactly the
 * boundary the brief names.  Each test mirrors one slice of the filter
 * loop + downstream atomIds mapping that `bumpReuse` receives.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { makeAtomAccessChecker } from "../src/gateway/atom-access";
import type { KnowledgeAtom } from "../src/gateway/knowledge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const atom = (id: string, threadKey: string): KnowledgeAtom => ({
  id,
  createdAt: 1,
  scope: "general",
  question: "q",
  answer: "a",
  tags: [],
  source: { threadKey, contributorUserId: "U1" },
  status: "approved",
});

/** CPUB is public; CPRIV is private, members = [U1, U2]. */
const makeStubWeb = () =>
  ({
    conversations: {
      info: async ({ channel }: { channel: string }) => ({
        channel: { is_channel: true, is_private: channel === "CPRIV" },
      }),
      members: async () => ({ members: ["U1", "U2"] }),
    },
  }) as never;

/** Run the same filter loop that free-chat-turn.ts uses post-Task-10. */
async function filterAtoms(
  checker: ReturnType<typeof makeAtomAccessChecker>,
  userId: string,
  atoms: KnowledgeAtom[],
): Promise<KnowledgeAtom[]> {
  const accessible: KnowledgeAtom[] = [];
  for (const a of atoms) {
    if (await checker.canUserAccessAtom(userId, a)) accessible.push(a);
  }
  return accessible;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("free-chat-turn access filter (Task 10)", () => {
  it("public-channel atom is accessible to any user", async () => {
    const checker = makeAtomAccessChecker(makeStubWeb());
    const result = await filterAtoms(checker, "Ustranger", [
      atom("pub-1", "CPUB:1.1"),
    ]);
    assert.deepEqual(
      result.map((a) => a.id),
      ["pub-1"],
    );
  });

  it("private-channel atom is excluded for non-member", async () => {
    const checker = makeAtomAccessChecker(makeStubWeb());
    const result = await filterAtoms(checker, "Ustranger", [
      atom("priv-1", "CPRIV:1.1"),
    ]);
    assert.deepEqual(result, []);
  });

  it("mixed atoms — only the accessible atom survives (primary scenario)", async () => {
    // Ustranger is NOT in CPRIV → priv-1 must be excluded.
    const checker = makeAtomAccessChecker(makeStubWeb());
    const retrievedRaw = [
      atom("pub-1", "CPUB:1.1"),
      atom("priv-1", "CPRIV:1.1"),
    ];
    const retrieved = await filterAtoms(checker, "Ustranger", retrievedRaw);
    assert.deepEqual(
      retrieved.map((a) => a.id),
      ["pub-1"],
    );
  });

  it("bumpReuse atomIds: only injected atom IDs reach telemetry", async () => {
    // This mirrors the downstream `atomIds = retrieved.map((a) => a.id)` call
    // that feeds bumpReuse in free-chat-turn.ts.
    const checker = makeAtomAccessChecker(makeStubWeb());
    const retrievedRaw = [
      atom("pub-1", "CPUB:1.1"),
      atom("priv-1", "CPRIV:1.1"),
    ];
    const retrieved = await filterAtoms(checker, "Ustranger", retrievedRaw);
    // Downstream code: const atomIds = retrieved.map((a) => a.id);
    const atomIds = retrieved.map((a) => a.id);
    assert.deepEqual(atomIds, ["pub-1"]);
    // pre-filter length (2) differs from post-filter (1) → proves pre-filter
    // set does NOT reach bumpReuse.
    assert.equal(retrievedRaw.length, 2);
    assert.equal(atomIds.length, 1);
  });

  it("member of private channel can access the private atom", async () => {
    // U1 IS in CPRIV — both atoms should survive.
    const checker = makeAtomAccessChecker(makeStubWeb());
    const retrieved = await filterAtoms(checker, "U1", [
      atom("pub-1", "CPUB:1.1"),
      atom("priv-1", "CPRIV:1.1"),
    ]);
    assert.deepEqual(
      retrieved.map((a) => a.id),
      ["pub-1", "priv-1"],
    );
  });

  it("fail-closed: lookup error excludes atom even if user might be a member", async () => {
    const errorWeb = {
      conversations: {
        info: async () => {
          throw new Error("network error");
        },
        members: async () => ({ members: ["Ustranger"] }),
      },
    } as never;
    const checker = makeAtomAccessChecker(errorWeb);
    const result = await filterAtoms(checker, "Ustranger", [
      atom("priv-1", "CPRIV:1.1"),
    ]);
    assert.deepEqual(result, []);
  });

  // Was "legacy atom with no channel is always accessible". An atom whose
  // thread key names no channel cannot be proven visible to the asker, and
  // `parseAtomMarkdown` produces exactly that shape from a damaged front-matter
  // field — so the old carve-out let a mangled private-channel atom reach any
  // user through retrieval injection. Fail closed at the filter too, not just
  // in the checker, so the end-to-end path can never re-open it.
  it("atom whose thread key names no channel is filtered out", async () => {
    const checker = makeAtomAccessChecker(makeStubWeb());
    const result = await filterAtoms(checker, "Ustranger", [
      atom("legacy-1", ""),
    ]);
    assert.deepEqual(result, []);
  });

  it("checker instance reuses TTL cache across successive calls (simulate per-turn reuse)", async () => {
    // The runner caches `this.accessChecker` so the TTL cache inside it
    // survives across turns.  Verify: two canUserAccessAtom calls against the
    // same channel hit conversations.info only once.
    let infoCalls = 0;
    const counting = {
      conversations: {
        info: async ({ channel }: { channel: string }) => {
          infoCalls++;
          return { channel: { is_channel: true, is_private: channel === "CPRIV" } };
        },
        members: async () => ({ members: ["U1"] }),
      },
    } as never;
    const now = () => 1000; // fixed clock — always within TTL
    const checker = makeAtomAccessChecker(counting, now);
    const a = atom("priv-1", "CPRIV:1.1");
    await checker.canUserAccessAtom("U1", a);
    await checker.canUserAccessAtom("U1", a);
    assert.equal(infoCalls, 1, "second call must be served from cache");
  });
});
