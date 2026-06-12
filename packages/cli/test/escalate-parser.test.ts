import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseEscalate } from "../src/gateway/escalate";

const fence = (body: string) => "```escalate\n" + body + "\n```";

describe("parseEscalate repo hint", () => {
  it("preserves a nested repo id", () => {
    const r = parseEscalate(fence("repo: erp/order\nquestion: why broken"));
    assert.equal(r?.repo, "erp/order");
  });
  it("keeps a bare repo id", () => {
    const r = parseEscalate(fence("repo: erp\nquestion: q"));
    assert.equal(r?.repo, "erp");
  });
  it("strips traversal to a safe form (no .. survives)", () => {
    const r = parseEscalate(fence("repo: ../../etc\nquestion: q"));
    assert.ok(!r?.repo || !r.repo.includes(".."));
  });
  it("undefined repo when absent", () => {
    const r = parseEscalate(fence("question: q"));
    assert.equal(r?.repo, undefined);
  });
});
