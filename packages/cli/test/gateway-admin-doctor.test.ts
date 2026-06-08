import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAdminSlash } from "../src/gateway/slack/admin";
import { SlashCommandHandler } from "../src/gateway/slack/slash-command";
import { writeRunState } from "../src/gateway/run-state";
import type { GatewayConfig } from "../src/gateway/config";

const ORIG_HOME = process.env.HOME;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    version: 1,
    admins: ["U-ADMIN"],
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

describe("/pmk admin doctor", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-doc-"));
    process.env.HOME = tmp;
    writeRunState({
      pid: process.pid,
      startedAt: Date.now() - 5000,
      phase: "ready",
      supervised: null,
    });
    fs.mkdirSync(path.join(tmp, ".pmk", "gateway"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pmk", "gateway", "heartbeat"),
      String(Date.now()),
    );
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("reads the provider at COMMAND time (not construction)", async () => {
    let state: "connected" | "reconnecting" = "connected";
    const provider = () => ({
      socket: {
        state: state as "connected" | "reconnecting",
        pongTimeoutsInWindow: 0,
        unstableMs: 0,
      },
      watchdog: { flaps: 0, confirmedFailures: 0 },
      startedAt: Date.now() - 5000,
    });

    // AdminSlashArgs: { actor: string; tokens: string[] }
    // tokens[0] = subcommand ("doctor"), rest = tokens.slice(1)
    const args = {
      actor: "U-ADMIN",
      tokens: ["doctor"],
      getRuntimeHealthSnapshot: provider,
    };

    const r1 = await handleAdminSlash(args as any);
    assert.match(r1.text, /🟢|healthy/);

    state = "reconnecting"; // change between calls — second call must reflect this
    const r2 = await handleAdminSlash(args as any);
    assert.match(r2.text, /🟡|degraded/); // proves command-time read
  });

  it("non-admin denied (tested via SlashCommandHandler where the gate lives)", async () => {
    const replies: string[] = [];
    const fakeWeb = {
      chat: {
        postMessage: async (opts: { text: string }) => {
          replies.push(opts.text);
          return { ok: true };
        },
      },
    };

    const handler = new SlashCommandHandler({
      web: fakeWeb as any,
      config: makeConfig(), // admins: ["U-ADMIN"] — U-X is not in the list
    });

    await handler.run({
      channelId: "D-DM",
      userId: "U-X",
      rest: "admin doctor",
      scope: { kind: "user", userId: "U-X" },
    });

    assert.equal(replies.length, 1);
    assert.match(replies[0], /not author|admin|管理員/i);
  });
});
