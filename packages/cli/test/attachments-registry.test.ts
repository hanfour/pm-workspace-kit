import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { categoryFor } from "../src/gateway/attachments/registry";

describe("categoryFor", () => {
  it("classifies by mimetype/filetype, unknown → unsupported", () => {
    assert.equal(categoryFor({ mimetype: "text/markdown" }), "text");
    assert.equal(categoryFor({ mimetype: "application/json" }), "text");
    assert.equal(categoryFor({ mimetype: "application/octet-stream", filetype: "javascript" }), "text");
    assert.equal(categoryFor({ mimetype: "application/pdf" }), "pdf");
    assert.equal(categoryFor({ mimetype: "image/png" }), "image");
    assert.equal(categoryFor({ mimetype: "image/svg+xml" }), "unsupported");
    assert.equal(categoryFor({ mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "unsupported");
    assert.equal(categoryFor({}), "unsupported");
  });
});
