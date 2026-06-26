import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { categoryFor } from "../src/gateway/attachments/registry";

describe("categoryFor audio", () => {
  it("classifies common audio mimetypes as audio", () => {
    for (const mt of ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/webm", "audio/ogg", "audio/flac", "audio/aac"]) {
      assert.equal(categoryFor({ mimetype: mt }), "audio", mt);
    }
  });
  it("classifies by Slack filetype when mimetype is missing", () => {
    for (const ft of ["m4a", "mp3", "mp4", "wav", "webm", "ogg", "flac", "mpga"]) {
      assert.equal(categoryFor({ filetype: ft }), "audio", ft);
    }
  });
  it("does not misclassify text/image/pdf as audio", () => {
    assert.equal(categoryFor({ mimetype: "application/pdf" }), "pdf");
    assert.equal(categoryFor({ mimetype: "image/png" }), "image");
    assert.equal(categoryFor({ mimetype: "text/markdown" }), "text");
  });
});
