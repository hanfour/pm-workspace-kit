import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { githubTokenCheck } from "../src/gateway/doctor-checks/github-token";
import type { DoctorContext } from "../src/gateway/doctor";
import { GATEWAY_CONFIG_VERSION, type GatewayConfig } from "../src/gateway/config";

const cfg = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  version: GATEWAY_CONFIG_VERSION,
  admins: [],
  blocklist: [],
  audience: { default: "biz", users: {}, channels: {}, domainExamples: { biz: [], pm: [] } },
  escalation: { default: [], repos: {} },
  slack: {},
  ...over,
});

const ctx = (config: GatewayConfig | null): DoctorContext =>
  ({ config } as unknown as DoctorContext);

describe("github-token doctor check", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-doc-gh-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("passes when github is unconfigured", async () => {
    const r = await githubTokenCheck(ctx(cfg()));
    assert.equal(r.severity, "pass");
    assert.match(r.message, /not configured|off/i);
  });

  it("fails when github.token unset/unresolved but github present", async () => {
    process.env.PMK_SKIP_GH_PROBE = "1";
    try {
      const r = await githubTokenCheck(ctx(cfg({ github: { token: { env: "PMK_NO_SUCH_VAR" } } })));
      assert.equal(r.severity, "fail");
    } finally {
      delete process.env.PMK_SKIP_GH_PROBE;
    }
  });
});
