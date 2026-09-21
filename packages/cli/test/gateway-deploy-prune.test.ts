import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { pruneReleases } from "../src/gateway/deploy/prune";
import { listReleases, pointLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

function makeRelease(root: string, name: string, day: number): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const builtAt = `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  writeReleaseInfo(dir, { ref: "HEAD", sha: "a".repeat(40), version: "0", builtAt, nodeVersion: "v22" });
}

describe("pruneReleases", () => {
  const home = useIsolatedHome("pmk-deploy-prune-");
  const five = (): string => {
    const root = releasesRoot(home.dir());
    ["0.1.0-0000001", "0.2.0-0000002", "0.3.0-0000003", "0.4.0-0000004", "0.5.0-0000005"]
      .forEach((n, i) => makeRelease(root, n, i + 1));
    return root;
  };

  it("keeps 3: current, previous and the newest other; removes the oldest", () => {
    const root = five();
    pointLink(root, "current", "0.5.0-0000005");
    pointLink(root, "previous", "0.4.0-0000004");
    assert.deepEqual(pruneReleases(root), ["0.1.0-0000001", "0.2.0-0000002"]);
    assert.deepEqual(listReleases(root), ["0.3.0-0000003", "0.4.0-0000004", "0.5.0-0000005"]);
  });

  it("never removes current or previous even when they are the oldest", () => {
    const root = five();
    pointLink(root, "current", "0.1.0-0000001");
    pointLink(root, "previous", "0.2.0-0000002");
    pruneReleases(root);
    assert.deepEqual(listReleases(root), ["0.1.0-0000001", "0.2.0-0000002", "0.5.0-0000005"]);
  });

  it("does nothing at or under the limit", () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, "0.1.0-0000001", 1);
    makeRelease(root, "0.2.0-0000002", 2);
    assert.deepEqual(pruneReleases(root), []);
  });

  it("with no links yet, keeps the newest 3", () => {
    const root = five();
    assert.deepEqual(pruneReleases(root), ["0.1.0-0000001", "0.2.0-0000002"]);
  });
});
