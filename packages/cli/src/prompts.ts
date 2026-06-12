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
  PROMPT_CASE,
  PROMPT_DEBUG,
  PROMPT_DISCUSS,
  PROMPT_DRAFT_PRD,
  PROMPT_GATEWAY_DM,
  PROMPT_GATEWAY_DM_BIZ,
  PROMPT_GATEWAY_DM_EXEC,
  PROMPT_GATEWAY_DM_PM,
  PROMPT_GATEWAY_DM_SALES,
  PROMPT_GATEWAY_DM_TECH,
  PROMPT_INGEST,
  PROMPT_PROPOSE,
  PROMPT_TDD,
  PROMPTS,
  type VerbPromptKey,
} from "@pmk/shared";
