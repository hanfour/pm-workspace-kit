/**
 * Shape-based snapshot tests for the prompt constants in @pmk/shared.
 *
 * These prompts are load-bearing for every gateway turn — a typo in
 * an audience prompt directly changes how the bot talks to humans.
 * The package was previously test-free, so a regression in
 * PROMPT_GATEWAY_DM_BIZ would have shipped silently.
 *
 * We intentionally do NOT pin exact text. Prompt engineering is a
 * living surface; freezing the bytes makes routine wording changes
 * fight the test suite. Instead the assertions check structural
 * invariants:
 *
 *   - non-empty + reasonable length (catches accidentally-cleared
 *     constants or truncations)
 *   - includes the BASE_RULES preamble (proves it wasn't dropped
 *     when adding new prompt content)
 *   - audience-specific marker phrases (catches cross-wired tiers
 *     where e.g. PROMPT_GATEWAY_DM_PM was accidentally pointed at
 *     the tech body)
 *   - pickGatewayPrompt round-trips every AudienceKey to the
 *     correct constant
 *   - PROMPTS map covers every VerbPromptKey
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  AUDIENCE_KEYS,
  BASE_RULES,
  DEFAULT_CONFIG,
  PROMPTS,
  PROMPT_APPLY,
  PROMPT_ASK,
  PROMPT_CASE,
  PROMPT_DEBUG,
  PROMPT_DISCUSS,
  PROMPT_DRAFT_PRD,
  PROMPT_GATEWAY_DM,
  PROMPT_GATEWAY_DM_BIZ,
  PROMPT_GATEWAY_DM_EXEC,
  PROMPT_GATEWAY_DM_PM,
  PROMPT_GATEWAY_DM_TECH,
  PROMPT_INGEST,
  PROMPT_PROPOSE,
  PROMPT_TDD,
  pickGatewayPrompt,
} from "../src/index";

const MIN_PROMPT_BYTES = 200;

describe("BASE_RULES", () => {
  it("is a non-empty string establishing the no-tools / language rules", () => {
    assert.equal(typeof BASE_RULES, "string");
    assert.ok(BASE_RULES.length >= MIN_PROMPT_BYTES);
    // Must clamp the model to prose-only (no tool / agent claims).
    assert.match(BASE_RULES, /No\s*tools|NO tools|no tool/i);
    // Must clamp language behaviour (繁中 vs English mirror).
    assert.match(BASE_RULES, /繁體中文|Traditional Chinese|Chinese/);
  });
});

describe("audience prompts", () => {
  const audiencePrompts: Array<[string, string]> = [
    ["tech", PROMPT_GATEWAY_DM_TECH],
    ["pm", PROMPT_GATEWAY_DM_PM],
    ["biz", PROMPT_GATEWAY_DM_BIZ],
    ["exec", PROMPT_GATEWAY_DM_EXEC],
  ];

  for (const [name, prompt] of audiencePrompts) {
    it(`PROMPT_GATEWAY_DM_${name.toUpperCase()} is non-empty and embeds BASE_RULES`, () => {
      assert.equal(typeof prompt, "string");
      assert.ok(
        prompt.length >= MIN_PROMPT_BYTES,
        `length=${prompt.length} suspiciously small`,
      );
      assert.ok(
        prompt.startsWith(BASE_RULES),
        "audience prompt must start with BASE_RULES so the no-tools clamp applies",
      );
    });
  }

  it("tech prompt mentions PKB / file paths (engineering tier markers)", () => {
    assert.match(PROMPT_GATEWAY_DM_TECH, /PKB|file path|module|api|API/);
  });

  it("pm prompt has the PM cheat-sheet + bans formulas in question-back-to-user form", () => {
    assert.match(PROMPT_GATEWAY_DM_PM, /senior PM helping another PM/);
    assert.match(PROMPT_GATEWAY_DM_PM, /No formulas|No SQL|No code blocks/);
  });

  it("biz prompt mentions business / 業務 framing", () => {
    assert.match(PROMPT_GATEWAY_DM_BIZ, /business|商業|業務|意義/);
  });

  it("exec prompt prioritises 結論 / 影響 / 建議行動 framing", () => {
    assert.match(PROMPT_GATEWAY_DM_EXEC, /結論/);
    assert.match(PROMPT_GATEWAY_DM_EXEC, /影響/);
    assert.match(PROMPT_GATEWAY_DM_EXEC, /建議行動/);
  });

  it("PROMPT_GATEWAY_DM is the tech alias (back-compat for v0.7 callers)", () => {
    assert.equal(PROMPT_GATEWAY_DM, PROMPT_GATEWAY_DM_TECH);
  });

  it("pickGatewayPrompt round-trips every AudienceKey to the right constant", () => {
    assert.equal(pickGatewayPrompt("tech"), PROMPT_GATEWAY_DM_TECH);
    assert.equal(pickGatewayPrompt("pm"), PROMPT_GATEWAY_DM_PM);
    assert.equal(pickGatewayPrompt("biz"), PROMPT_GATEWAY_DM_BIZ);
    assert.equal(pickGatewayPrompt("exec"), PROMPT_GATEWAY_DM_EXEC);
    // Unknown / undefined falls back to tech (safest default).
    assert.equal(pickGatewayPrompt(undefined), PROMPT_GATEWAY_DM_TECH);
  });

  it("AUDIENCE_KEYS lists exactly the 4 keys pickGatewayPrompt knows", () => {
    assert.deepEqual([...AUDIENCE_KEYS], ["tech", "pm", "biz", "exec"]);
  });

  it("audience prompts have distinct bodies (cross-wire regression)", () => {
    const bodies = new Set([
      PROMPT_GATEWAY_DM_TECH,
      PROMPT_GATEWAY_DM_PM,
      PROMPT_GATEWAY_DM_BIZ,
      PROMPT_GATEWAY_DM_EXEC,
    ]);
    assert.equal(bodies.size, 4, "all four audience prompts must be distinct");
  });
});

describe("verb prompts (PROMPTS map)", () => {
  const expectedKeys = [
    "propose",
    "draft-prd",
    "ingest",
    "discuss",
    "ask",
    "tdd",
    "apply",
    "debug",
    "case",
  ];

  for (const key of expectedKeys) {
    it(`PROMPTS[${key}] is non-empty and starts with BASE_RULES`, () => {
      const p = (PROMPTS as Record<string, string>)[key];
      assert.equal(typeof p, "string", `PROMPTS[${key}] missing`);
      assert.ok(p.length >= MIN_PROMPT_BYTES);
      assert.ok(
        p.startsWith(BASE_RULES),
        `verb prompt ${key} must embed BASE_RULES`,
      );
    });
  }

  it("PROMPTS map matches the individual exported constants", () => {
    assert.equal(PROMPTS.propose, PROMPT_PROPOSE);
    assert.equal(PROMPTS["draft-prd"], PROMPT_DRAFT_PRD);
    assert.equal(PROMPTS.ingest, PROMPT_INGEST);
    assert.equal(PROMPTS.discuss, PROMPT_DISCUSS);
    assert.equal(PROMPTS.ask, PROMPT_ASK);
    assert.equal(PROMPTS.tdd, PROMPT_TDD);
    assert.equal(PROMPTS.apply, PROMPT_APPLY);
    assert.equal(PROMPTS.debug, PROMPT_DEBUG);
    assert.equal(PROMPTS.case, PROMPT_CASE);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has expected shape with sane defaults", () => {
    assert.ok(DEFAULT_CONFIG && typeof DEFAULT_CONFIG === "object");
    const keys = Object.keys(DEFAULT_CONFIG);
    assert.ok(keys.length > 0, "DEFAULT_CONFIG must define at least one field");
  });
});
