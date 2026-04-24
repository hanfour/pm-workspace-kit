import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractPrdBody, slugify, nextPrdId } from "../src/frontmatter";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("extractPrdBody", () => {
  it("extracts content between markers", () => {
    const input = `before\n=== PRD ===\nhello\n=== END ===\nafter`;
    assert.equal(extractPrdBody(input), "hello");
  });

  it("falls back to full text when markers missing", () => {
    assert.equal(extractPrdBody("just text\n"), "just text");
  });

  it("returns full text when end precedes start (malformed)", () => {
    const input = "=== END === before === PRD === oops";
    assert.equal(extractPrdBody(input), input.trim());
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  it("preserves CJK characters", () => {
    assert.equal(slugify("客戶 自助 下載"), "客戶-自助-下載");
  });

  it("collapses runs of separators", () => {
    assert.equal(slugify("a---b___c   d"), "a-b-c-d");
  });

  it("returns empty string for all-punctuation input", () => {
    assert.equal(slugify("???!!!"), "");
  });
});

describe("nextPrdId", () => {
  it("returns PRD-YYYY-0001 for empty dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-test-"));
    try {
      const id = nextPrdId(tmp, 2026);
      assert.equal(id, "PRD-2026-0001");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  it("increments past the max existing id", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-test-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "a.md"),
        "---\ndoc_id: PRD-2026-0003\n---\n",
      );
      fs.writeFileSync(
        path.join(tmp, "b.md"),
        "---\ndoc_id: PRD-2026-0007\n---\n",
      );
      assert.equal(nextPrdId(tmp, 2026), "PRD-2026-0008");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });
});
