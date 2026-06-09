import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ingestAttachments } from "../src/gateway/attachments/ingest";
import { loadAttachments } from "../src/gateway/attachments/store";
import type { ThreadKey, SlackFile } from "../src/gateway/attachments/types";

const ORIG = process.env.HOME;
const KEY: ThreadKey = { kind: "dm", userId: "U1", threadTs: "1.2" };
const f = (over: Partial<SlackFile>): SlackFile => ({ id: "F1", name: "a.md", mimetype: "text/markdown", size: 10, url_private_download: "https://files.slack.com/a.md", ...over });

function deps(over: any = {}) {
  return {
    download: async (file: SlackFile) => Buffer.from(`BODY:${file.id}`),
    extractText: async (b: Buffer) => ({ ok: true as const, text: b.toString() }),
    extractPdf: async () => ({ ok: true as const, text: "pdftext_xxxxxxxxxxxxxxxxxxxx" }),
    extractImage: async () => ({ ok: true as const, text: "imgdesc_xxxxxxxxxxxxxxxxxxxx" }),
    llm: { name: "x", displayName: "x", chat: async () => "" },
    now: () => 1,
    ...over,
  };
}

describe("ingestAttachments", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ing-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("downloads, extracts, stores, and reports ok", async () => {
    const r = await ingestAttachments({ files: [f({})], threadKey: KEY, botToken: "t", ...deps() });
    assert.equal(r[0].status, "ok");
    assert.equal(loadAttachments(KEY)[0].text, "BODY:F1");
  });
  it("skips unsupported types without downloading", async () => {
    let downloaded = false;
    const r = await ingestAttachments({ files: [f({ mimetype: "application/zip", filetype: "zip" })], threadKey: KEY, botToken: "t", ...deps({ download: async () => { downloaded = true; return Buffer.from(""); } }) });
    assert.equal(r[0].status, "skipped");
    assert.equal(downloaded, false);
  });
  it("skips external files and missing-url files pre-download", async () => {
    const r = await ingestAttachments({ files: [f({ is_external: true })], threadKey: KEY, botToken: "t", ...deps() });
    assert.equal(r[0].status, "skipped");
    assert.match(r[0].reason!, /linked/i);
  });
  it("skips a file over MAX_FILE_BYTES by metadata", async () => {
    const r = await ingestAttachments({ files: [f({ size: 99 * 1024 * 1024 })], threadKey: KEY, botToken: "t", ...deps() });
    assert.equal(r[0].status, "skipped");
    assert.match(r[0].reason!, /10 ?MB|limit/i);
  });
  it("is idempotent: re-ingesting the same fileId does not re-download", async () => {
    let n = 0;
    const d = deps({ download: async (file: SlackFile) => { n++; return Buffer.from(`B${file.id}`); } });
    await ingestAttachments({ files: [f({})], threadKey: KEY, botToken: "t", ...d });
    await ingestAttachments({ files: [f({})], threadKey: KEY, botToken: "t", ...d });
    assert.equal(n, 1);
  });
  it("caps the number of files per message", async () => {
    const many = Array.from({ length: 12 }, (_, i) => f({ id: `F${i}` }));
    const r = await ingestAttachments({ files: many, threadKey: KEY, botToken: "t", ...deps() });
    assert.equal(r.filter((x) => x.status === "ok").length, 10);
  });
  it("a download error never leaks the url/token", async () => {
    const d = deps({ download: async () => { throw new Error("download failed for F1 (network error)"); } });
    const r = await ingestAttachments({ files: [f({})], threadKey: KEY, botToken: "xoxb-SECRET", ...d });
    assert.equal(r[0].status, "skipped");
    assert.ok(!(r[0] as Extract<(typeof r)[0], { status: "skipped" }>).reason.includes("xoxb-SECRET"));
  });
  it("stops processing remaining files once the phase deadline passes", async () => {
    let t = 0;
    const clock = () => (t += 100_000); // each call jumps 100s — past the 60s deadline after file 1
    const r = await ingestAttachments({ files: [f({ id: "A" }), f({ id: "B" })], threadKey: KEY, botToken: "t", ...deps({ clock }) });
    assert.equal(r.find((x) => x.fileId === "B")!.status, "skipped");
    assert.match((r.find((x) => x.fileId === "B") as Extract<(typeof r)[0], { status: "skipped" }>).reason, /tim(e|ed) ?out/i);
  });

  it("Fix 2: unsafe file.id is skipped without aborting remaining files", async () => {
    // A forged path-traversal id must not propagate appendAttachment's throw
    // out of ingestAttachments; the other files in the batch must still process.
    const evil = f({ id: "../../evil", name: "evil.txt" });
    const good = f({ id: "F-GOOD", name: "good.md" });
    let downloaded = 0;
    const d = deps({ download: async (file: SlackFile) => { downloaded++; return Buffer.from(`BODY:${file.id}`); } });
    const r = await ingestAttachments({ files: [evil, good], threadKey: KEY, botToken: "t", ...d });

    const evilStatus = r.find((x) => x.fileId === "../../evil");
    assert.ok(evilStatus, "evil file must appear in results");
    assert.equal(evilStatus!.status, "skipped");
    assert.match((evilStatus as Extract<typeof evilStatus, { status: "skipped" }>)!.reason, /invalid|unsafe/i);

    const goodStatus = r.find((x) => x.fileId === "F-GOOD");
    assert.ok(goodStatus, "good file must still be processed");
    assert.equal(goodStatus!.status, "ok", "good file must succeed despite the earlier unsafe id");
    assert.equal(downloaded, 1, "only the good file should be downloaded");
  });

  it("Fix 3: files beyond the cap are reported as skipped with the truncation reason", async () => {
    const many = Array.from({ length: 12 }, (_, i) => f({ id: `F${i}`, name: `file${i}.md` }));
    const r = await ingestAttachments({ files: many, threadKey: KEY, botToken: "t", ...deps() });

    // First 10 succeed
    assert.equal(r.filter((x) => x.status === "ok").length, 10);

    // Files 10 and 11 appear as skipped with the file-cap reason
    const dropped = r.filter((x) => x.status === "skipped" && x.fileId === "F10");
    assert.equal(dropped.length, 1, "file F10 should be in results as skipped");
    assert.match(
      (dropped[0] as Extract<(typeof r)[0], { status: "skipped" }>).reason,
      /只讀前 10 個/,
      "truncation reason must mention the 10-file cap",
    );

    const dropped11 = r.find((x) => x.fileId === "F11");
    assert.ok(dropped11, "file F11 must also appear in results");
    assert.equal(dropped11!.status, "skipped");
  });
});
