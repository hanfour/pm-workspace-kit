import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexDocs, query, saveIndex, loadIndex } from "../src/index";

describe("indexDocs + query", () => {
  let root: string;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-rag-"));
    fs.writeFileSync(
      path.join(root, "strangler.md"),
      `---\ndoc_id: ADR-2026-0001\ntitle: Strangler Fig Protocol\n---\n\n# Strangler Fig\n\nGradually replace a legacy system by routing traffic to new services.\n`,
    );
    fs.writeFileSync(
      path.join(root, "rollback.md"),
      `---\ndoc_id: ADR-2026-0002\ntitle: Rollback\n---\n\n# Rollback Plan\n\nAlways prepare a rollback path before shipping a migration.\n`,
    );
    fs.writeFileSync(
      path.join(root, "unrelated.md"),
      `---\ntitle: Unrelated\n---\n\n# Unrelated\n\nToday's weather is sunny.\n`,
    );
    // Noise: ignored dir, non-markdown file.
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "junk.md"), "noise");
    fs.writeFileSync(path.join(root, "not-md.txt"), "plain text");
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("indexes only .md/.mdx files and skips IGNORED dirs", async () => {
    const index = await indexDocs(root);
    const paths = new Set(index.chunks.map((c) => c.path));
    assert.ok(paths.has("strangler.md"));
    assert.ok(paths.has("rollback.md"));
    assert.ok(paths.has("unrelated.md"));
    assert.ok(!paths.has("node_modules/junk.md"));
    assert.ok(!paths.has("not-md.txt"));
  });

  it("attaches doc_id + title from front-matter to every chunk", async () => {
    const index = await indexDocs(root);
    const stranglerChunk = index.chunks.find(
      (c) => c.path === "strangler.md",
    );
    assert.equal(stranglerChunk?.docId, "ADR-2026-0001");
    assert.equal(stranglerChunk?.title, "Strangler Fig Protocol");
  });

  it("query ranks the matching doc first and excludes noise", async () => {
    const index = await indexDocs(root);
    const results = query(index, "strangler fig migration", 3);
    assert.ok(results.length > 0);
    assert.equal(results[0].chunk.path, "strangler.md");
    assert.ok(
      (results[1]?.chunk.path ?? "") !== "unrelated.md" ||
        results[1].score < results[0].score,
    );
  });

  it("query returns empty for a corpus-miss", async () => {
    const index = await indexDocs(root);
    const results = query(index, "quasars astrophysics", 5);
    assert.equal(results.length, 0);
  });

  it("saveIndex + loadIndex round-trip preserves chunks", async () => {
    const index = await indexDocs(root);
    const file = path.join(root, ".pmk", "rag-index.json");
    saveIndex(index, file);
    const loaded = loadIndex(file);
    assert.ok(loaded);
    assert.equal(loaded!.chunks.length, index.chunks.length);
    assert.deepEqual(
      loaded!.chunks.map((c) => c.id).sort(),
      index.chunks.map((c) => c.id).sort(),
    );
  });

  it("loadIndex returns null for missing file", () => {
    assert.equal(loadIndex(path.join(root, "does-not-exist.json")), null);
  });
});
