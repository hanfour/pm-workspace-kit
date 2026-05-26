// Smoke-test seed for `pmk gateway demo seed/unseed`.
//
// FR4 of PRD-2026-0006. Writes a single, well-known KnowledgeAtom so a
// new host can verify the full retrieval path (DM the bot → atoms
// hit) without escalation, without polished walkthrough, without
// inventing schema details. Tagged with DEMO_SEED_TAG so `unseed`
// (and any future audit) can identify and clean up just the
// smoke-test data, never a real production atom.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  type KnowledgeAtom,
  knowledgeRoot,
  loadAtoms,
  safeScope,
  saveAtom,
} from "./knowledge";

export const DEMO_SEED_TAG = "demo-seed";
const DEMO_SEED_SCOPE = "general";
const DEMO_SEED_QUESTION = "pmk gateway 是什麼？";
const DEMO_SEED_ANSWER = [
  "pmk gateway 是 PM Workspace Kit 提供給非 CLI stakeholder 的 Slack 入口：",
  "",
  "- 主持人（host）在自己機器上跑 `pmk gateway start`，把 bot 拉到 workspace 裡；",
  "- 其他 PM / SA / 非工程同事直接在 Slack DM 或 @-mention 這個 bot，",
  "  不需要裝 CLI、不需要 OAuth screen；",
  "- bot 收到問題後會先在 PKB 找答案（本機 markdown + mra repo summaries），",
  "  PKB 不夠時自動呼叫 `mra ask`，再不夠時 @-mention 真人 IT 接手；",
  "- 真人的回答會被吸收成 KnowledgeAtom，未來相同問題就能直接命中。",
  "",
  "這條 atom 是 `pmk gateway demo seed` 寫入的 smoke-test 種子，",
  "用來在裝機完成後立刻驗證 retrieval 鏈跑得通。",
  "清掉用 `pmk gateway demo unseed`。",
].join("\n");
const DEMO_SEED_SUMMARY =
  "pmk gateway 是 Slack 上 PM/stakeholder 的入口；host 跑 bridge，非工程同事直接 DM/@bot，回答經過 PKB → mra-ask → 人工 escalate 三層。";

export interface DemoSeedResult {
  /** True iff a fresh atom was written by this call (false on idempotent re-runs). */
  written: boolean;
  atomId: string;
  filePath: string;
  question: string;
}

export interface DemoUnseedResult {
  removed: string[];
}

/**
 * Ensure exactly one demo-seed atom exists in the local PKB. Re-running
 * is a no-op (returns the existing atom's id); no duplicates accumulate.
 */
export function seedDemoAtom(): DemoSeedResult {
  const existing = findDemoAtoms();
  if (existing.length > 0) {
    const first = existing[0];
    return {
      written: false,
      atomId: first.id,
      filePath: demoAtomFile(first),
      question: first.question,
    };
  }
  const atom: KnowledgeAtom = {
    id: `demo-seed-${Date.now().toString(36)}`,
    createdAt: Date.now(),
    scope: DEMO_SEED_SCOPE,
    question: DEMO_SEED_QUESTION,
    answer: DEMO_SEED_ANSWER,
    summary: DEMO_SEED_SUMMARY,
    tags: [DEMO_SEED_TAG, "pmk", "gateway", "onboarding"],
    source: {
      threadKey: "demo:onboarding",
      contributorUserId: "DEMO",
    },
    status: "approved",
  };
  const filePath = saveAtom(atom);
  return {
    written: true,
    atomId: atom.id,
    filePath,
    question: atom.question,
  };
}

/**
 * Remove every atom tagged with DEMO_SEED_TAG. Returns the atom ids
 * removed (empty list = nothing to clean, which is fine — idempotent).
 * NEVER touches atoms without the tag.
 */
export function unseedDemoAtoms(): DemoUnseedResult {
  const demoAtoms = findDemoAtoms();
  const removed: string[] = [];
  for (const atom of demoAtoms) {
    const file = demoAtomFile(atom);
    try {
      fs.unlinkSync(file);
      removed.push(atom.id);
    } catch {
      // best-effort: file may have vanished between load and unlink
    }
  }
  return { removed };
}

/** Atoms currently tagged demo-seed (exposed for tests + audit). */
export function findDemoAtoms(): KnowledgeAtom[] {
  return loadAtoms({ promote: false }).filter((a) =>
    a.tags.includes(DEMO_SEED_TAG),
  );
}

function demoAtomFile(atom: KnowledgeAtom): string {
  return path.join(knowledgeRoot(), safeScope(atom.scope), `${atom.id}.md`);
}
