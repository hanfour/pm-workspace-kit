---
sidebar_position: 2
---

# Skill: requirement-intake

AI 引導需求蒐集。Skill 扮演需求分析師，一次問 1–2 題，直到資訊結構化到可產需求卡。

## 何時用

- Stakeholder 說「我需要一個功能…」、你想系統化蒐集 context
- 想避免「寄詳細 ticket 給我」→ 然後什麼都沒到的死路
- 問題模糊、使用者不確定自己要什麼

## 輸入 / 輸出

**輸入**：使用者對話起手式。
**輸出**：結構化需求卡於 `docs/requirements/REQ-YYYY-NNNN.md`，含背景、痛點、受影響角色、影響分析、優先級、複雜度估計、指派 PM 等欄位。

## Pipeline 位置

PRD 的上游。需求卡（REQ-YYYY-NNNN）會成為後續 PRD 的 `related.requirement`。

## Next Step

卡 `Ready` 後跑 `/generate-prd REQ-YYYY-NNNN`（小中規模）或 `/create-prd`（大規模）。

## Skill body（英文，複製到 `.claude/skills/`）

參見 [英文版](https://hanfourhuang.github.io/pm-workspace-kit/docs/skills/requirement-intake) 完整 skill body。Claude Code 讀英文 prompt 更穩定，故 skill 內文保留英文；本頁翻譯的是使用情境說明。
