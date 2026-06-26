import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runMedia } from "../src/gateway/audio/spawn";

/**
 * Verifies that runMedia strips all secret-named env vars from the child
 * process environment while preserving safe vars like PATH.
 * FIX 5 (MEDIUM) — strip ALL secret-ish env vars from the media child env.
 */
describe("runMedia env stripping", () => {
  const SAVED: Record<string, string | undefined> = {};
  const SECRET_VARS = ["PMK_SLACK_BOT_TOKEN", "OPENAI_API_KEY", "GH_TOKEN"];

  beforeEach(() => {
    for (const k of SECRET_VARS) SAVED[k] = process.env[k];
    process.env.PMK_SLACK_BOT_TOKEN = "secret-bot-token";
    process.env.OPENAI_API_KEY = "sk-test-openai";
    process.env.GH_TOKEN = "ghp_test_token";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("strips secret-named env vars but keeps PATH", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    // Minimal fake spawn: captures opts.env, emits close(0) via setImmediate.
    const fakeSpawn = (
      _bin: string,
      _args: string[],
      opts: { env?: NodeJS.ProcessEnv },
    ) => {
      capturedEnv = opts.env;
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (sig: string) => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      setImmediate(() => proc.emit("close", 0, null));
      return proc;
    };

    await runMedia("ffmpeg", ["-version"], {}, { spawn: fakeSpawn as never });

    assert.ok(capturedEnv !== undefined, "env should have been captured");
    assert.equal(
      capturedEnv!.PMK_SLACK_BOT_TOKEN,
      undefined,
      "PMK_SLACK_BOT_TOKEN must be stripped",
    );
    assert.equal(
      capturedEnv!.OPENAI_API_KEY,
      undefined,
      "OPENAI_API_KEY must be stripped",
    );
    assert.equal(
      capturedEnv!.GH_TOKEN,
      undefined,
      "GH_TOKEN must be stripped",
    );
    assert.ok(
      capturedEnv!.PATH !== undefined,
      "PATH must be preserved in child env",
    );
  });
});
