/**
 * Re-export prompts from the single source of truth in @pmk/shared so
 * the CLI and the desktop app never drift. Customisation still goes
 * through `.claude/skills/<verb>.md` at the workspace root.
 */

export {
  BASE_RULES,
  PROMPT_APPLY,
  PROMPT_ASK,
  PROMPT_DEBUG,
  PROMPT_DISCUSS,
  PROMPT_DRAFT_PRD,
  PROMPT_INGEST,
  PROMPT_PROPOSE,
  PROMPT_TDD,
  PROMPTS,
  type VerbPromptKey,
} from "@pmk/shared";
