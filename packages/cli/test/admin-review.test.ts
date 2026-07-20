import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { adminReview } from "../src/gateway/slack/admin-review";
import { loadRawGatewayConfig, saveGatewayConfig } from "../src/gateway/config";

const ORIG_HOME = process.env.HOME; // gatewayDir() is HOME-based
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ar-")); process.env.HOME = tmp; });
afterEach(() => { if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

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
