import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { adminReview } from "../src/gateway/slack/admin-review";
import { loadRawGatewayConfig, saveGatewayConfig } from "../src/gateway/config";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME; // gatewayDir() is HOME-based
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ar-")); process.env.HOME = tmp; });
afterEach(() => { process.env.HOME = ORIG_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

describe("adminReview approval toggle", () => {
  it("preserves protectionExemptions across an enable/disable cycle", () => {
    saveGatewayConfig({
      version: 1, admins: ["U1"], blocklist: [], slack: {},
      review: {
        enabled: true,
        approval: {
          enabled: true,
          protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
        },
      },
    } as never);

    adminReview("U1", ["approval", "disable"]);
    adminReview("U1", ["approval", "enable"]);

    const after = loadRawGatewayConfig();
    assert.deepEqual(
      after.review?.approval?.protectionExemptions,
      [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      "toggling the approval gate must not silently wipe the exemptions",
    );
    assert.equal(after.review?.approval?.enabled, true);
  });
});
