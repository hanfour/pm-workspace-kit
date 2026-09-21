import { it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { settle, type DeployDeps } from "../src/commands/gateway/deploy";
import { realDeps } from "../src/commands/gateway/deploy-deps";
import { pointLink } from "../src/gateway/deploy/paths";
import type { GatewayDeployEvent } from "../src/gateway/events";

const home = useIsolatedHome("pmk-outcomes-");
for (const current of [undefined, "0.1.0-0000001", "0.2.0-0000002"]) {
  it(`failed records actual current (${current}) and omits live when absent`, () => {
    const root = path.join(home.dir(), "releases");
    fs.mkdirSync(root);
    if (current) pointLink(root, "current", current);
    const events: GatewayDeployEvent[] = [];
    const d: DeployDeps = { ...realDeps(root), print: () => {}, record: (e) => { events.push(e); } };
    assert.equal(settle(root, { outcome: "failed", release: "0.2.0-0000002", message: "failed" }, "sha", undefined, d), 1);
    assert.equal(events[0].live, current);
    assert.equal(Object.hasOwn(events[0], "live"), current !== undefined);
  });
}
it("operator rollback ending links-only records gateway.rollback and the links-only reason", () => {
  const events: GatewayDeployEvent[] = [];
  const root = home.dir();
  const d: DeployDeps = { ...realDeps(root), print: () => {}, record: (e) => { events.push(e); } };
  assert.equal(settle(root, { outcome: "links-only", release: "0.1.0-0000001", message: "migration required" },
    "sha", undefined, d, "gateway.rollback"), 0);
  assert.deepEqual(events, [{ type: "gateway.rollback", release: "0.1.0-0000001", sha: "sha", ref: undefined,
    previous: undefined, reason: "links only: service not restarted — LaunchAgent does not run releases/current" }]);
});
