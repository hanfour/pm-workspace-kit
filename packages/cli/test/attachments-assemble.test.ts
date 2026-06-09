import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { assembleFromEntries, FRAME_HEADER } from "../src/gateway/attachments/assemble";
import type { ExtractedAttachment } from "../src/gateway/attachments/types";

const e = (id: string, text: string, at: number): ExtractedAttachment => ({
  fileId: id, name: `${id}.md`, mimetype: "text/markdown", text, at,
});

describe("assembleFromEntries", () => {
  it("empty → no messages", () => {
    assert.deepEqual(assembleFromEntries([], 30_000), []);
  });
  it("frames content as untrusted data", () => {
    const msgs = assembleFromEntries([e("F1", "body", 1)], 30_000);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "user");
    assert.ok(msgs[0].content.startsWith(FRAME_HEADER));
    assert.match(msgs[0].content, /F1\.md/);
    assert.match(msgs[0].content, /body/);
  });
  it("drops whole oldest entries when over budget", () => {
    const entries = [e("OLD", "x".repeat(5000), 1), e("NEW", "y".repeat(5000), 2)];
    const msgs = assembleFromEntries(entries, 6000);
    assert.match(msgs[0].content, /NEW\.md/);
    assert.doesNotMatch(msgs[0].content, /OLD\.md/);
  });
});
