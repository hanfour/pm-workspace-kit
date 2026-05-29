import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  DoctorContext,
  DoctorRunners,
  DoctorCheck,
} from "../src/gateway/doctor";
import {
  formatDoctorReport,
  runDoctor,
} from "../src/gateway/doctor";
import {
  configFileCheck,
  slackAppTokenCheck,
  slackBotTokenCheck,
  anthropicKeyCheck,
  mraWorkspaceCheck,
  pkbContentCheck,
  channelAclCheck,
  manifestAlignmentCheck,
  DEFAULT_CHECKS,
} from "../src/gateway/doctor-checks";
import type { GatewayConfig } from "../src/gateway/config";

const REPO_MANIFEST = path.resolve(
  __dirname,
  "..",
  "src",
  "gateway",
  "slack",
  "manifest.template.json",
);

function makeOkRunners(): DoctorRunners {
  return {
    slackAppAuth: async () => ({ ok: true }),
    slackBotAuth: async () => ({ ok: true, team: "T123", user: "pmk" }),
    anthropicEcho: async () => ({ ok: true }),
    mraList: async () => ({ ok: true, repos: ["repo-a", "repo-b"] }),
    // Default: PKB already has content so pkb-content PASSes unless a
    // test overrides atomCount to 0 to exercise the empty-PKB paths.
    atomCount: async () => 7,
    // Default: local `claude` present, so the OAuth/claude-agent path
    // is available when no API key is set.
    claudeCli: async () => ({ available: true, path: "/usr/local/bin/claude" }),
  };
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    version: 1,
    admins: [],
    blocklist: [],
    audience: { default: "biz", users: {}, channels: {} },
    escalation: { default: [], repos: {} },
    slack: { appToken: "xapp-test", botToken: "xoxb-test" },
    apiKey: "sk-ant-test",
    mraWorkspace: "/tmp/fake-mra",
    defaultIngest: "mra:--all",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    home: "/tmp/fake-home",
    configPath: "/tmp/fake-home/.pmk/gateway.json",
    config: makeConfig(),
    configFileStat: { exists: true, mode: 0o600 },
    envAnthropicKey: undefined,
    llmProvider: "auto",
    manifestRepoPath: REPO_MANIFEST,
    runners: makeOkRunners(),
    ...overrides,
  };
}

describe("doctor — config-file check (FR2 #1)", () => {
  it("FAILs when config file missing", async () => {
    const r = await configFileCheck(
      makeCtx({ configFileStat: { exists: false } }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /not found/);
    assert.match(r.hint ?? "", /pmk gateway init/);
  });

  it("FAILs when config parsed as null (corrupt JSON)", async () => {
    const r = await configFileCheck(makeCtx({ config: null }));
    assert.equal(r.severity, "fail");
    assert.match(r.message, /could not be parsed/);
  });

  it("WARNs when mode is not 0600", async () => {
    const r = await configFileCheck(
      makeCtx({ configFileStat: { exists: true, mode: 0o644 } }),
    );
    assert.equal(r.severity, "warn");
    assert.match(r.hint ?? "", /chmod 600/);
  });

  it("PASSes when present and 0600", async () => {
    const r = await configFileCheck(makeCtx());
    assert.equal(r.severity, "pass");
  });
});

describe("doctor — slack-app-token check (FR2 #2)", () => {
  it("FAILs when no appToken in config", async () => {
    const r = await slackAppTokenCheck(
      makeCtx({ config: makeConfig({ slack: { botToken: "xoxb-test" } }) }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /no App-Level Token/);
  });

  it("FAILs when Slack rejects the token", async () => {
    const r = await slackAppTokenCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          slackAppAuth: async () => ({ ok: false, error: "invalid_auth" }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /invalid_auth/);
  });

  it("PASSes when Slack accepts the token", async () => {
    const r = await slackAppTokenCheck(makeCtx());
    assert.equal(r.severity, "pass");
  });
});

describe("doctor — slack-bot-token check (FR2 #3)", () => {
  it("FAILs when no botToken in config", async () => {
    const r = await slackBotTokenCheck(
      makeCtx({ config: makeConfig({ slack: { appToken: "xapp-test" } }) }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /no Bot User OAuth Token/);
  });

  it("FAILs when Slack rejects the token", async () => {
    const r = await slackBotTokenCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          slackBotAuth: async () => ({ ok: false, error: "token_expired" }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /token_expired/);
  });

  it("PASSes when Slack accepts the token", async () => {
    const r = await slackBotTokenCheck(makeCtx());
    assert.equal(r.severity, "pass");
    assert.match(r.message, /team=T123/);
  });
});

describe("doctor — llm-provider check (FR2 #4)", () => {
  // v0.16: mirrors resolveProvider — the runtime falls back to the
  // local `claude` login (claude-agent SDK) when no API key is set,
  // so doctor must NOT FAIL an OAuth-only host.
  it("PASSes (auto) with no key but local claude available — OAuth path", async () => {
    const r = await anthropicKeyCheck(
      makeCtx({ config: makeConfig({ apiKey: undefined }) }),
    );
    assert.equal(r.severity, "pass");
    assert.match(r.message, /claude login|claude-agent/i);
  });

  it("FAILs (auto) only when no key AND no local claude", async () => {
    const r = await anthropicKeyCheck(
      makeCtx({
        config: makeConfig({ apiKey: undefined }),
        runners: {
          ...makeOkRunners(),
          claudeCli: async () => ({ available: false }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /no LLM provider/i);
  });

  it("FAILs (auto) when key present but Anthropic rejects it", async () => {
    const r = await anthropicKeyCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          anthropicEcho: async () => ({ ok: false, error: "HTTP 401" }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /401/);
  });

  it("PASSes (auto) with env key (env source preferred)", async () => {
    const r = await anthropicKeyCheck(
      makeCtx({ envAnthropicKey: "sk-ant-env" }),
    );
    assert.equal(r.severity, "pass");
    assert.match(r.message, /env ANTHROPIC_API_KEY/);
  });

  it("PASSes (auto) with config-only key", async () => {
    const r = await anthropicKeyCheck(makeCtx());
    assert.equal(r.severity, "pass");
    assert.match(r.message, /gateway\.json apiKey/);
  });

  it("FAILs when provider=anthropic-api but no key", async () => {
    const r = await anthropicKeyCheck(
      makeCtx({
        llmProvider: "anthropic-api",
        config: makeConfig({ apiKey: undefined }),
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /anthropic-api/);
  });

  it("PASSes when provider=claude-agent and claude on PATH (key irrelevant)", async () => {
    const r = await anthropicKeyCheck(
      makeCtx({
        llmProvider: "claude-agent",
        config: makeConfig({ apiKey: undefined }),
      }),
    );
    assert.equal(r.severity, "pass");
    assert.match(r.message, /claude/i);
  });

  it("FAILs when provider=claude-agent but claude not on PATH", async () => {
    const r = await anthropicKeyCheck(
      makeCtx({
        llmProvider: "claude-agent",
        runners: {
          ...makeOkRunners(),
          claudeCli: async () => ({ available: false }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /not on PATH|claude/i);
  });
});

describe("doctor — mra-workspace check (FR2 #5)", () => {
  it("WARNs when no mraWorkspace configured", async () => {
    const r = await mraWorkspaceCheck(
      makeCtx({ config: makeConfig({ mraWorkspace: undefined }) }),
    );
    assert.equal(r.severity, "warn");
  });

  it("FAILs when runner reports unusable workspace", async () => {
    const r = await mraWorkspaceCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          mraList: async () => ({
            ok: false,
            repos: [],
            error: ".collab/repos.json missing",
          }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
  });

  it("WARNs when workspace exists but has 0 repos", async () => {
    const r = await mraWorkspaceCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          mraList: async () => ({ ok: true, repos: [] }),
        },
      }),
    );
    assert.equal(r.severity, "warn");
  });

  it("PASSes with ≥1 repo", async () => {
    const r = await mraWorkspaceCheck(makeCtx());
    assert.equal(r.severity, "pass");
    assert.match(r.message, /2 repo/);
  });
});

describe("doctor — pkb-content check (FR2 #6)", () => {
  it("FAILs when neither defaultIngest nor mraWorkspace set", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        config: makeConfig({ defaultIngest: undefined, mraWorkspace: undefined }),
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /no PKB source/);
  });

  it("PASSes when the PKB already has approved atoms on disk", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        runners: { ...makeOkRunners(), atomCount: async () => 12 },
      }),
    );
    assert.equal(r.severity, "pass");
    assert.match(r.message, /12 approved atom/);
  });

  // v0.16 hardening: an empty PKB whose mra source has no repos can
  // never be seeded — this used to slip through as a soft WARN.
  it("FAILs when PKB empty AND mra source has 0 repos (M6 empty-PKB)", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          atomCount: async () => 0,
          mraList: async () => ({ ok: true, repos: [] }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /empty/);
    assert.match(r.hint ?? "", /register repos/);
  });

  it("FAILs when PKB empty AND mra workspace is unreachable", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          atomCount: async () => 0,
          mraList: async () => ({
            ok: false,
            repos: [],
            error: "workspace not found",
          }),
        },
      }),
    );
    assert.equal(r.severity, "fail");
  });

  it("WARNs when PKB empty but mra source has repos (fresh, will seed)", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        runners: {
          ...makeOkRunners(),
          atomCount: async () => 0,
          mraList: async () => ({ ok: true, repos: ["repo-a"] }),
        },
      }),
    );
    assert.equal(r.severity, "warn");
    assert.match(r.message, /will seed/);
  });

  it("FAILs when defaultIngest uses mra: but no mraWorkspace and PKB empty", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        config: makeConfig({
          defaultIngest: "mra:--all",
          mraWorkspace: undefined,
        }),
        runners: { ...makeOkRunners(), atomCount: async () => 0 },
      }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /mraWorkspace/);
  });

  it("WARNs when mraWorkspace set, no defaultIngest, empty PKB, repos present", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        config: makeConfig({ defaultIngest: undefined }),
        runners: {
          ...makeOkRunners(),
          atomCount: async () => 0,
          mraList: async () => ({ ok: true, repos: ["repo-a"] }),
        },
      }),
    );
    assert.equal(r.severity, "warn");
    assert.match(r.hint ?? "", /defaultIngest/);
  });

  it("WARNs when PKB empty and ingest spec is non-mra (unverifiable)", async () => {
    const r = await pkbContentCheck(
      makeCtx({
        config: makeConfig({
          defaultIngest: "file:/some/path",
          mraWorkspace: undefined,
        }),
        runners: { ...makeOkRunners(), atomCount: async () => 0 },
      }),
    );
    assert.equal(r.severity, "warn");
    assert.match(r.message, /non-mra/);
  });
});

describe("doctor — channel-acl check (FR2 #7)", () => {
  it("WARNs when 0 channels configured", async () => {
    const r = await channelAclCheck(makeCtx());
    assert.equal(r.severity, "warn");
    assert.match(r.message, /DMs/);
  });

  it("PASSes with ≥1 channel", async () => {
    const r = await channelAclCheck(
      makeCtx({
        config: makeConfig({
          audience: {
            default: "biz",
            users: {},
            channels: { Cabc: "tech" },
          },
        }),
      }),
    );
    assert.equal(r.severity, "pass");
    assert.match(r.message, /1 channel/);
  });
});

describe("doctor — manifest-alignment check (FR2 #8)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-doctor-mf-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("FAILs when manifest file missing", async () => {
    const r = await manifestAlignmentCheck(
      makeCtx({ manifestRepoPath: path.join(tmpDir, "nope.json") }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /missing/);
  });

  it("FAILs when manifest is invalid JSON", async () => {
    const file = path.join(tmpDir, "bad.json");
    fs.writeFileSync(file, "{not json");
    const r = await manifestAlignmentCheck(
      makeCtx({ manifestRepoPath: file }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /not valid JSON/);
  });

  it("FAILs when a required scope is missing", async () => {
    const file = path.join(tmpDir, "short.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        oauth_config: { scopes: { bot: ["chat:write"] } },
        settings: {
          socket_mode_enabled: true,
          event_subscriptions: {
            bot_events: ["message.im", "app_mention", "reaction_added"],
          },
        },
      }),
    );
    const r = await manifestAlignmentCheck(
      makeCtx({ manifestRepoPath: file }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /missing/);
  });

  it("FAILs when socket_mode_enabled is false", async () => {
    const file = path.join(tmpDir, "no-sock.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        oauth_config: {
          scopes: {
            bot: [
              "app_mentions:read",
              "chat:write",
              "im:history",
              "im:read",
              "im:write",
              "users:read",
              "reactions:read",
            ],
          },
        },
        settings: {
          socket_mode_enabled: false,
          event_subscriptions: {
            bot_events: ["message.im", "app_mention", "reaction_added"],
          },
        },
      }),
    );
    const r = await manifestAlignmentCheck(
      makeCtx({ manifestRepoPath: file }),
    );
    assert.equal(r.severity, "fail");
    assert.match(r.message, /Socket Mode/);
  });

  it("PASSes on the canonical repo manifest", async () => {
    const r = await manifestAlignmentCheck(
      makeCtx({ manifestRepoPath: REPO_MANIFEST }),
    );
    assert.equal(r.severity, "pass");
    assert.match(r.message, /MANIFEST_VERSION/);
  });
});

describe("doctor — orchestrator (runDoctor + formatDoctorReport)", () => {
  const fakePass: DoctorCheck = async () => ({
    name: "fake-pass",
    severity: "pass",
    message: "ok",
  });
  const fakeWarn: DoctorCheck = async () => ({
    name: "fake-warn",
    severity: "warn",
    message: "soft issue",
    hint: "do something",
  });
  const fakeFail: DoctorCheck = async () => ({
    name: "fake-fail",
    severity: "fail",
    message: "broken",
    hint: "fix it",
  });
  const fakeThrow: DoctorCheck = async () => {
    throw new Error("boom");
  };

  it("aggregates counts correctly", async () => {
    const report = await runDoctor(makeCtx(), [fakePass, fakeWarn, fakeFail]);
    assert.equal(report.passed, 1);
    assert.equal(report.warned, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.results.length, 3);
  });

  it("catches thrown errors as FAIL", async () => {
    const report = await runDoctor(makeCtx(), [fakeThrow]);
    assert.equal(report.failed, 1);
    assert.match(report.results[0].message, /check threw: boom/);
  });

  it("text output orders FAIL → WARN → PASS regardless of input order", async () => {
    const report = await runDoctor(makeCtx(), [fakePass, fakeWarn, fakeFail]);
    const text = formatDoctorReport(report);
    const failIdx = text.indexOf("[FAIL]");
    const warnIdx = text.indexOf("[WARN]");
    const passIdx = text.indexOf("[PASS]");
    assert.ok(failIdx >= 0 && warnIdx > failIdx && passIdx > warnIdx);
  });

  it("text output prints hint lines for non-pass results only", async () => {
    const report = await runDoctor(makeCtx(), [fakePass, fakeWarn, fakeFail]);
    const text = formatDoctorReport(report);
    // hints from warn + fail should both render
    assert.match(text, /hint: do something/);
    assert.match(text, /hint: fix it/);
    // pass shouldn't get a hint line (fakePass has no hint anyway, but check)
    const passSegment = text.slice(text.indexOf("[PASS]"));
    assert.ok(!passSegment.includes("hint:"));
  });

  it("--json output is valid JSON containing all results", async () => {
    const report = await runDoctor(makeCtx(), [fakePass, fakeFail]);
    const text = formatDoctorReport(report, { json: true });
    const parsed = JSON.parse(text);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.failed, 1);
  });
});

describe("doctor — DEFAULT_CHECKS shape", () => {
  it("exports exactly 8 checks in the FR2 order", () => {
    assert.equal(DEFAULT_CHECKS.length, 8);
    const names = DEFAULT_CHECKS.map((c) => c.name);
    assert.deepEqual(names, [
      "configFileCheck",
      "slackAppTokenCheck",
      "slackBotTokenCheck",
      "anthropicKeyCheck",
      "mraWorkspaceCheck",
      "pkbContentCheck",
      "channelAclCheck",
      "manifestAlignmentCheck",
    ]);
  });
});
