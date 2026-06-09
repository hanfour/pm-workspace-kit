import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractPdf } from "../src/gateway/attachments/extractors/pdf";

describe("extractPdf", () => {
  it("extracts text from a PDF fixture", async () => {
    const buf = fs.readFileSync(path.join(__dirname, "fixtures", "hello.pdf"));
    const r = await extractPdf(buf);
    assert.equal(r.ok, true);
    assert.match((r as { text: string }).text, /HELLO_PMK/);
  });
  it("returns a reason for a non-PDF / no-text buffer", async () => {
    const r = await extractPdf(Buffer.from("not a pdf"));
    assert.equal(r.ok, false);
  });
});
