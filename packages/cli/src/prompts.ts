/**
 * Re-export prompts from the single source of truth in @pmk/shared so
 * the CLI and the desktop app never drift.
 *
 * (Per-workspace prompt overrides are not implemented yet — see
 * https://github.com/hanfour/pm-workspace-kit/issues for the v1.1
 * tracking issue.)
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
