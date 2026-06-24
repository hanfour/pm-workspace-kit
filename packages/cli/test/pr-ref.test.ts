import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePrRefs } from "../src/gateway/pr-ref";

describe("parsePrRefs", () => {
  it("parses a Slack mrkdwn link <url|label>", () => {
    const text = "@reviewer :cr: feat(x) <https://github.com/onead/OnePixel/pull/129|#129>";
    assert.deepEqual(parsePrRefs(text), [
      { owner: "onead", repo: "OnePixel", number: 129, url: "https://github.com/onead/OnePixel/pull/129" },
    ]);
  });

  it("parses a bare PR url and dedupes repeats", () => {
    const text = "see https://github.com/o/r/pull/7 and again https://github.com/o/r/pull/7";
    assert.deepEqual(parsePrRefs(text).length, 1);
  });

  it("parses multiple distinct PRs, order-preserving", () => {
    const text = "<https://github.com/o/a/pull/1|#1> <https://github.com/o/b/pull/2|#2>";
    assert.deepEqual(parsePrRefs(text).map((r) => r.repo), ["a", "b"]);
  });

  it("ignores non-PR github links (issues, tree, blob)", () => {
    const text = "<https://github.com/o/r/issues/9|#9> https://github.com/o/r/tree/main";
    assert.deepEqual(parsePrRefs(text), []);
  });

  it("caps the result", () => {
    const text = [1,2,3,4,5,6,7].map((n) => `https://github.com/o/r${n}/pull/${n}`).join(" ");
    assert.equal(parsePrRefs(text, { cap: 5 }).length, 5);
  });

  it("returns [] for empty / no links", () => {
    assert.deepEqual(parsePrRefs(""), []);
    assert.deepEqual(parsePrRefs("just text"), []);
  });
});
