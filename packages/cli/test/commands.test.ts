import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { _internal as applyInternal } from "../src/commands/apply";
import { _internal as ingestInternal } from "../src/commands/ingest";
import { pickReplyText } from "../src/commands/demo";
import { handleParkCommand } from "../src/commands/park-hook";
import type { Session } from "../src/session";

const { parsePlan } = applyInternal;
const { resolveRepoSpec, formatRepoBlock } = ingestInternal;

describe("apply.parsePlan", () => {
  it("parses unchecked + checked checkbox tasks and flags done", () => {
    const tasks = parsePlan(
      [
        "# Plan",
        "",
        "- [ ] first task",
        "- [x] already done",
        "* [X] star-bullet done",
        "  - [ ] indented task",
        "not a task line",
        "- [ ]   trims surrounding space   ",
      ].join("\n"),
    );
    assert.equal(tasks.length, 5);
    assert.deepEqual(
      tasks.map((t) => [t.text, t.done]),
      [
        ["first task", false],
        ["already done", true],
        ["star-bullet done", true],
        ["indented task", false],
        ["trims surrounding space", false],
      ],
    );
  });

  it("returns empty for prose with no checkbox lines", () => {
    assert.deepEqual(parsePlan("just some\nplain text\n- a bullet"), []);
  });

  it("the outstanding-task filter (callers drop done) leaves only undone", () => {
    const outstanding = parsePlan("- [ ] a\n- [x] b\n- [ ] c").filter(
      (t) => !t.done,
    );
    assert.deepEqual(
      outstanding.map((t) => t.text),
      ["a", "c"],
    );
  });
});

describe("ingest.resolveRepoSpec", () => {
  it("single repo → one-element list", () => {
    assert.deepEqual(resolveRepoSpec("erp", "/ws"), ["erp"]);
  });

  it("comma-separated → split + trimmed, blanks dropped", () => {
    assert.deepEqual(resolveRepoSpec("erp, oss-ui-v2 ,, api-gateway", "/ws"), [
      "erp",
      "oss-ui-v2",
      "api-gateway",
    ]);
  });

  it("whitespace-only spec → empty", () => {
    assert.deepEqual(resolveRepoSpec("  ,  , ", "/ws"), []);
  });
});

describe("ingest.formatRepoBlock", () => {
  it("renders a repo header + one fenced section per doc", () => {
    const block = formatRepoBlock("erp", [
      { name: "overview.md", content: "  hello  ", mtime: 0, path: "a/overview.md" },
      { name: "api.md", content: "world", mtime: 0, path: "a/api.md" },
    ]);
    assert.match(block, /^## repo: erp/);
    assert.match(block, /### overview\.md\n\n```markdown\nhello\n```/);
    assert.match(block, /### api\.md\n\n```markdown\nworld\n```/);
  });
});

describe("demo.pickReplyText", () => {
  it("returns the matching message's text by ts", () => {
    const msgs = [
      { ts: "1.1", text: "first" },
      { ts: "2.2", text: "second" },
    ];
    assert.equal(pickReplyText(msgs, "2.2"), "second");
  });

  it("returns '' when ts not found or text missing", () => {
    assert.equal(pickReplyText([{ ts: "1.1", text: "x" }], "9.9"), "");
    assert.equal(pickReplyText([{ ts: "1.1" }], "1.1"), "");
  });
});

describe("park-hook.handleParkCommand", () => {
  function fakeSession(): { session: Session; parkCalls: string[] } {
    const parkCalls: string[] = [];
    const session = {
      park(name: string): string {
        parkCalls.push(name);
        return `~/.pmk/sessions/${name}.json`;
      },
    } as unknown as Session;
    return { session, parkCalls };
  }

  it("non-/park line → not handled, park untouched", () => {
    const { session, parkCalls } = fakeSession();
    assert.equal(handleParkCommand("hello world", session, "ask"), false);
    assert.equal(parkCalls.length, 0);
  });

  it("/park with no name → handled, but does not park", () => {
    const { session, parkCalls } = fakeSession();
    assert.equal(handleParkCommand("/park", session, "ask"), true);
    assert.equal(handleParkCommand("/park   ", session, "ask"), true);
    assert.equal(parkCalls.length, 0);
  });

  it("/park <name> → handled and parks under that name", () => {
    const { session, parkCalls } = fakeSession();
    assert.equal(handleParkCommand("/park my-thread", session, "ask"), true);
    assert.deepEqual(parkCalls, ["my-thread"]);
  });
});
