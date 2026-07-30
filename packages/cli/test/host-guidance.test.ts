import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { stripHostOnlyGuidance } from "../src/gateway/slack/host-guidance";

// Regression: a `:a:` approve confirmation that carried a PR link fell through
// to free-chat, where the agent hit its own tool-permission guard and answered
// with host-machine instructions (`/permissions`, `~/.claude/settings.json`).
// That reply was posted verbatim to Slack, telling an external user to edit
// settings they do not have and exposing the host's internal layout.
const REAL_LEAK = `gh 指令被 Claude Code 的 permission guard 擋下了，需要你在設定中放行。最快的解法：

在 terminal 開一個 Claude Code interactive session，執行：

/permissions

或是直接在 ~/.claude/settings.json 的 allowedTools 加上 Bash(gh *) 這個 pattern，然後回來重跑 \`/review <url>\`。`;

describe("stripHostOnlyGuidance", () => {
  it("redacts a reply that instructs the user to edit host Claude Code settings", () => {
    const out = stripHostOnlyGuidance(REAL_LEAK);
    assert.equal(out.redacted, true);
    assert.ok(!out.text.includes("~/.claude"), "must not leak the host home path");
    assert.ok(!out.text.includes("allowedTools"), "must not leak the host setting name");
    assert.ok(!out.text.includes("/permissions"), "must not leak the host command");
    assert.ok(/PMK admin/.test(out.text), "should redirect the user to an admin");
  });

  it("leaves ordinary replies untouched", () => {
    for (const t of [
      "這個 PR 看起來沒問題，可以 merge。",
      "我幫你查了 traceability matrix，有 7 筆通過。",
      "",
    ]) {
      const out = stripHostOnlyGuidance(t);
      assert.equal(out.redacted, false, `should not redact: '${t}'`);
      assert.equal(out.text, t);
    }
  });

  // A single incidental mention is a legitimate technical answer — this bot
  // serves an engineering team. Only the combination reads as host guidance.
  it("does NOT redact a single incidental mention", () => {
    for (const t of [
      "allowedTools 是 Claude Agent SDK 用來限制工具的欄位。",
      "settings.json 通常放在專案根目錄。",
    ]) {
      const out = stripHostOnlyGuidance(t);
      assert.equal(out.redacted, false, `should not redact: '${t}'`);
    }
  });

  it("redacts when two or more host-only markers appear together", () => {
    const out = stripHostOnlyGuidance(
      "請編輯 ~/.claude/settings.json 並加入 allowedTools。",
    );
    assert.equal(out.redacted, true);
  });
});
