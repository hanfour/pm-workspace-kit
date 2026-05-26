import * as fs from "node:fs";

import {
  MANIFEST_VERSION,
  expectedEvents,
  expectedScopes,
} from "../slack/manifest-version";
import type { DoctorCheckResult, DoctorContext } from "../doctor";

interface ManifestShape {
  oauth_config?: { scopes?: { bot?: string[] } };
  settings?: {
    socket_mode_enabled?: boolean;
    event_subscriptions?: { bot_events?: string[] };
  };
}

export async function manifestAlignmentCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  if (!fs.existsSync(ctx.manifestRepoPath)) {
    return {
      name: "manifest-alignment",
      severity: "fail",
      message: `manifest template missing at ${ctx.manifestRepoPath}`,
      hint: "git status — manifest.template.json should be tracked",
    };
  }
  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(
      fs.readFileSync(ctx.manifestRepoPath, "utf8"),
    ) as ManifestShape;
  } catch (err) {
    return {
      name: "manifest-alignment",
      severity: "fail",
      message: `manifest template at ${ctx.manifestRepoPath} is not valid JSON`,
      hint: err instanceof Error ? err.message : String(err),
    };
  }
  const botScopes = new Set(manifest.oauth_config?.scopes?.bot ?? []);
  const missingScopes = expectedScopes().filter((s) => !botScopes.has(s));
  if (missingScopes.length > 0) {
    return {
      name: "manifest-alignment",
      severity: "fail",
      message: `repo-side manifest is missing ${missingScopes.length} expected bot scope(s)`,
      hint: `add to oauth_config.scopes.bot: ${missingScopes.join(", ")}`,
    };
  }
  const events = new Set(
    manifest.settings?.event_subscriptions?.bot_events ?? [],
  );
  const missingEvents = expectedEvents().filter((e) => !events.has(e));
  if (missingEvents.length > 0) {
    return {
      name: "manifest-alignment",
      severity: "fail",
      message: `repo-side manifest is missing ${missingEvents.length} expected bot event(s)`,
      hint: `add to settings.event_subscriptions.bot_events: ${missingEvents.join(", ")}`,
    };
  }
  if (manifest.settings?.socket_mode_enabled !== true) {
    return {
      name: "manifest-alignment",
      severity: "fail",
      message: "repo-side manifest does not enable Socket Mode",
      hint: 'set settings.socket_mode_enabled to true',
    };
  }
  return {
    name: "manifest-alignment",
    severity: "pass",
    message: `manifest template aligned with MANIFEST_VERSION=${MANIFEST_VERSION}`,
  };
}
