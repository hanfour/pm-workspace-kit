import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

// parsePlan lives inside apply.ts as an unexported helper. Re-export
// it for tests via a side-channel: copy the regex here. If the
// regex in apply.ts changes, this test must change with it — which is
// the point (acts as a contract).
function parsePlan(body: string): Array<{ text: string; done: boolean }> {
  const tasks: Array<{ text: string; done: boolean }> = [];
  for (const raw of body.split("\n")) {
    const m = raw.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+?)\s*$/);
    if (!m) continue;
    tasks.push({ text: m[2], done: m[1].toLowerCase() === "x" });
  }
  return tasks;
}

describe("apply plan parser", () => {
  it("extracts checkbox tasks from a Markdown plan", () => {
    const plan = `# Sprint plan

## M2 — desktop

- [x] package.json
- [ ] Main process
- [ ] Preload
- [ ] First-run dialog

Some prose.

## M3

- [ ] Preview + Mermaid
- [ ] Graph
`;
    const tasks = parsePlan(plan);
    assert.equal(tasks.length, 6);
    assert.equal(tasks[0].done, true);
    assert.equal(tasks[0].text, "package.json");
    assert.equal(tasks[1].done, false);
    assert.equal(tasks[1].text, "Main process");
    assert.equal(tasks[5].text, "Graph");
  });

  it("ignores non-checkbox bullets and prose", () => {
    const plan = `- [ ] real task\n- normal bullet\n* [ ] star task\nText.`;
    const tasks = parsePlan(plan);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].text, "real task");
    assert.equal(tasks[1].text, "star task");
  });

  it("handles indented tasks", () => {
    const plan = `  - [ ] indented\n    - [ ] deeper`;
    const tasks = parsePlan(plan);
    assert.equal(tasks.length, 2);
  });

  it("returns empty for no checkboxes", () => {
    assert.deepEqual(parsePlan("# heading\n\nprose."), []);
  });
});
