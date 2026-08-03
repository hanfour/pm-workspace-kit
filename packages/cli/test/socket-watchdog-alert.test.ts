import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";
import { useIsolatedHome } from "./helpers/isolated-home";

function fakeWeb(opts: { hang?: boolean } = {}) {
  const posts: Array<{ channel: string; text: string }> = [];
  const web = {
    conversations: {
      open: async ({ users }: { users: string }) => ({ channel: { id: `D-${users}` } }),
    },
    chat: {
      postMessage: async (a: { channel: string; text: string }) => {
        if (opts.hang) return new Promise(() => {}); // never settles
        posts.push(a);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  return { web, posts };
}

describe("PresenceBroadcaster.watchdogTerminate", () => {
  // watchdogTerminate APPENDS the daemon's self-termination record to the
  // event log before it DMs anyone. Without an isolated home that lands in the
  // operator's live audit trail — which is exactly what happened here: three
  // entries per suite run, 1,056 fabricated self-terminations against one real
  // incident.
  useIsolatedHome("pmk-watchdog-alert-");

  it("DMs each admin via conversations.open → postMessage", async () => {
    const { PresenceBroadcaster } = await import("../src/gateway/slack/presence");
    const { web, posts } = fakeWeb();
    const p = new PresenceBroadcaster({ web, onLog: () => {}, gracefulShutdown: false });
    await p.watchdogTerminate({ adminIds: ["U1", "U2"], attempts: 3, alertTimeoutMs: 5_000 });
    assert.deepEqual(posts.map((x) => x.channel).sort(), ["D-U1", "D-U2"]);
    assert.ok(posts.every((x) => /self-terminated/i.test(x.text)));
  });

  it("returns within the alert timeout even if Slack hangs", async () => {
    const { PresenceBroadcaster } = await import("../src/gateway/slack/presence");
    const { web } = fakeWeb({ hang: true });
    const p = new PresenceBroadcaster({ web, onLog: () => {}, gracefulShutdown: false });
    const start = Date.now();
    await p.watchdogTerminate({ adminIds: ["U1"], attempts: 3, alertTimeoutMs: 60 });
    assert.ok(Date.now() - start < 2_000); // did not wait on the hung post
  });

  it("with no admins, does not post and still resolves", async () => {
    const { PresenceBroadcaster } = await import("../src/gateway/slack/presence");
    const { web, posts } = fakeWeb();
    const p = new PresenceBroadcaster({ web, onLog: () => {}, gracefulShutdown: false });
    await p.watchdogTerminate({ adminIds: [], attempts: 3, alertTimeoutMs: 5_000 });
    assert.equal(posts.length, 0);
  });
});
