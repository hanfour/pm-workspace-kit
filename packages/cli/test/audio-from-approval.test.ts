import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AudioCoordinator, type AudioCoordinatorDeps } from "../src/gateway/audio/coordinator";
import { writeAtomMarker, readAtomMarker } from "../src/gateway/audio/atom-marker";
import { loadAtoms, type KnowledgeAtom } from "../src/gateway/knowledge";

const ORIG = process.env.HOME;
function coord(opts: { admins?: string[]; getPermalink?: () => Promise<unknown>; posts: string[]; ephem: string[]; deps?: AudioCoordinatorDeps }) {
  const web = {
    chat: {
      postMessage: async (a: { text: string }) => { opts.posts.push(a.text); return { ts: "r" }; },
      postEphemeral: async (a: { text: string }) => { opts.ephem.push(a.text); return {}; },
      getPermalink: opts.getPermalink ?? (async () => ({ permalink: "https://x.slack.com/archives/C1/p99" })),
    },
  };
  return new AudioCoordinator({ web: web as never, config: { admins: opts.admins ?? [] } as never, onLog: () => {}, llm: {} as never, deps: opts.deps });
}
const marker = () => writeAtomMarker({ threadKey: "C1:1.1", channelId: "C1", summaryTs: "9.9", uploaderId: "U1", scope: "general", title: "認證決議", tags: ["auth"], summaryText: "決議採 OAuth。", at: Date.now() });

describe("AudioCoordinator.fromApproval", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-fa-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("uploader 📚 → saves an approved atom with permalink + id in reply", async () => {
    const posts: string[] = [], ephem: string[] = [];
    marker();
    const c = coord({ posts, ephem });
    assert.equal(await c.fromApproval({ channelId: "C1", messageTs: "9.9", reactorUserId: "U1" }), true);
    const atoms = loadAtoms({ scope: "general" });
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].status, "approved");
    assert.equal(atoms[0].source.permalink, "https://x.slack.com/archives/C1/p99");
    assert.equal(atoms[0].question, "認證決議");
    assert.ok(posts.some((p) => p.includes("已加進知識庫") && p.includes(atoms[0].id)));
  });

  it("non-uploader non-admin → ephemeral note, no save", async () => {
    const posts: string[] = [], ephem: string[] = [];
    marker();
    const c = coord({ posts, ephem });
    assert.equal(await c.fromApproval({ channelId: "C1", messageTs: "9.9", reactorUserId: "U2" }), true);
    assert.equal(loadAtoms({ scope: "general" }).length, 0);
    assert.ok(ephem.some((e) => e.includes("上傳者或管理員")));
  });

  it("admin can save", async () => {
    marker();
    const c = coord({ admins: ["UADMIN"], posts: [], ephem: [] });
    await c.fromApproval({ channelId: "C1", messageTs: "9.9", reactorUserId: "UADMIN" });
    assert.equal(loadAtoms({ scope: "general" }).length, 1);
  });

  it("no marker → returns false (not our message)", async () => {
    const c = coord({ posts: [], ephem: [] });
    assert.equal(await c.fromApproval({ channelId: "C1", messageTs: "nope", reactorUserId: "U1" }), false);
  });

  it("dedup: second 📚 (after one save) does not create a second atom", async () => {
    marker();
    const c = coord({ posts: [], ephem: [] });
    await c.fromApproval({ channelId: "C1", messageTs: "9.9", reactorUserId: "U1" });
    marker(); // simulate a fresh marker for the same threadKey (e.g. retry)
    await c.fromApproval({ channelId: "C1", messageTs: "9.9", reactorUserId: "U1" });
    assert.equal(loadAtoms({ scope: "general" }).length, 1);
  });

  it("getPermalink failure → atom saved without permalink", async () => {
    marker();
    const c = coord({ posts: [], ephem: [], getPermalink: async () => { throw new Error("no permalink"); } });
    await c.fromApproval({ channelId: "C1", messageTs: "9.9", reactorUserId: "U1" });
    const [a] = loadAtoms({ scope: "general" });
    assert.equal(a.source.permalink, undefined);
  });

  it("saveAtom failure → user gets error reply, marker is restored for retry, no atom saved", async () => {
    marker();
    const posts: string[] = [], ephem: string[] = [];
    const throwingSave = (_atom: KnowledgeAtom): string => { throw new Error("disk full"); };
    const c = coord({ posts, ephem, deps: { saveAtom: throwingSave } });
    assert.equal(await c.fromApproval({ channelId: "C1", messageTs: "9.9", reactorUserId: "U1" }), true);
    // (a) user received failure reply
    assert.ok(posts.some((p) => p.includes("再按一次") && p.includes("📚") && p.includes("重試")));
    // (b) marker is restored so re-react can retry
    assert.ok(readAtomMarker("C1", "9.9") !== undefined, "marker should be restored for retry");
    // (c) no atom was saved
    assert.equal(loadAtoms({ scope: "general" }).length, 0);
  });
});
