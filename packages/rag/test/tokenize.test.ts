import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { tokenize } from "../src/tokenize";

describe("tokenize", () => {
  it("splits ASCII words on whitespace and lowercases", () => {
    assert.deepEqual(tokenize("Hello World FOO"), ["hello", "world", "foo"]);
  });

  it("keeps hyphens and underscores inside words", () => {
    assert.deepEqual(tokenize("PRD-2026-0001 foo_bar"), [
      "prd-2026-0001",
      "foo_bar",
    ]);
  });

  it("treats CJK as character unigrams", () => {
    assert.deepEqual(tokenize("需求文件"), ["需", "求", "文", "件"]);
  });

  it("mixes ASCII + CJK correctly", () => {
    assert.deepEqual(tokenize("PRD 需求 spec"), ["prd", "需", "求", "spec"]);
  });

  it("strips punctuation and numbers-only strings are kept", () => {
    assert.deepEqual(tokenize("a, b. c!"), ["a", "b", "c"]);
    assert.deepEqual(tokenize("123 456"), ["123", "456"]);
  });

  it("handles Japanese hiragana / katakana and Korean as unigrams", () => {
    assert.deepEqual(tokenize("あいう"), ["あ", "い", "う"]);
    assert.deepEqual(tokenize("カナ"), ["カ", "ナ"]);
    assert.deepEqual(tokenize("한글"), ["한", "글"]);
  });

  it("returns empty for whitespace-only input", () => {
    assert.deepEqual(tokenize("   \n\t "), []);
  });
});
