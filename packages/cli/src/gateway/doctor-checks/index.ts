import type { DoctorCheck } from "../doctor";
import { configFileCheck } from "./config-file";
import { slackAppTokenCheck } from "./slack-app-token";
import { slackBotTokenCheck } from "./slack-bot-token";
import { anthropicKeyCheck } from "./anthropic-key";
import { mraWorkspaceCheck } from "./mra-workspace";
import { pkbContentCheck } from "./pkb-content";
import { channelAclCheck } from "./channel-acl";
import { manifestAlignmentCheck } from "./manifest-alignment";
import { secretSourcesCheck } from "./secret-sources";
import { githubTokenCheck } from "./github-token";
import { reviewDoctorCheck } from "./review";
import { audioDoctorCheck } from "./audio";

export {
  configFileCheck,
  slackAppTokenCheck,
  slackBotTokenCheck,
  anthropicKeyCheck,
  mraWorkspaceCheck,
  pkbContentCheck,
  channelAclCheck,
  manifestAlignmentCheck,
  secretSourcesCheck,
  githubTokenCheck,
  reviewDoctorCheck,
  audioDoctorCheck,
};

// Order matters for output legibility: config-file first (blocks
// everything below if missing), then secret-sources (disk/effective labels
// before the live token checks), then external service checks (Slack,
// Anthropic, mra), then content/policy checks, then the static
// manifest-alignment self-check last.
export const DEFAULT_CHECKS: DoctorCheck[] = [
  configFileCheck,
  secretSourcesCheck,
  slackAppTokenCheck,
  slackBotTokenCheck,
  anthropicKeyCheck,
  mraWorkspaceCheck,
  pkbContentCheck,
  channelAclCheck,
  manifestAlignmentCheck,
  githubTokenCheck,
  reviewDoctorCheck,
  audioDoctorCheck,
];
