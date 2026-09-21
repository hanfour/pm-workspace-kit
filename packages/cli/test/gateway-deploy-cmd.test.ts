import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { parseDeployArgs, plistRunsCurrent, readPlistXml, runDeploy, type DeployDeps } from "../src/commands/gateway/deploy";
import { currentEntry, listReleases, pointLink, readLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

const SHA = "abcdef0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function deps(o: { ready: boolean[]; buildFails?: boolean }): { d: DeployDeps; events: unknown[]; out: string[]; restarts: () => number } {
  const events: unknown[] = [];
  const out: string[] = [];
  let restarts = 0;
  let pid = 1;
  let phase = "ready";
  const d: DeployDeps = {
    record: (e) => { events.push(e); },
    print: (l) => { out.push(l); },
    build: {
      nodeVersion: "v22", nodePath: "/usr/bin/node", now: () => new Date("2026-09-21T00:00:00.000Z"),
      exportTree: (_r, _s, dest) => { fs.writeFileSync(path.join(dest, "package.json"), "{}"); },
      run: (file, args) => {
        if (o.buildFails && file === "npm") throw new Error("npm ci failed");
        if (args[0] === "rev-parse") return `${SHA}\n`;
        if (args[0] === "show") return JSON.stringify({ version: "0.45.0" });
        if (args.includes("--version")) return "0.45.0\n";
        return "";
      },
    },
    activate: {
      serviceRunsCurrent: () => true, sleep: async () => {},
      restart: async () => { phase = o.ready[restarts] ? "ready" : "starting"; restarts += 1; pid += 1; return "ok"; },
      readReady: () => ({ pid, phase }),
    },
  };
  return { d, events, out, restarts: () => restarts };
}

describe("parseDeployArgs", () => {
  it("takes a ref, optional --repo, and --no-activate", () => {
    assert.deepEqual(parseDeployArgs(["HEAD"]), { ref: "HEAD", repo: undefined, activate: true });
    assert.deepEqual(parseDeployArgs(["v0.45.0", "--repo", "/r", "--no-activate"]), { ref: "v0.45.0", repo: "/r", activate: false });
  });
  it("requires exactly one ref", () => {
    assert.throws(() => parseDeployArgs([]), /usage: pmk gateway deploy/);
    assert.throws(() => parseDeployArgs(["a", "b"]), /usage: pmk gateway deploy/);
    assert.throws(() => parseDeployArgs(["HEAD", "--repo"]), /usage: pmk gateway deploy/);
  });
});

describe("readPlistXml", () => {
  it("returns undefined without reading when no plist path exists", () => {
    assert.equal(readPlistXml(undefined, () => { assert.fail("must not read"); }), undefined);
  });
  it("returns undefined when reading throws, so service detection is false", () => {
    const xml = readPlistXml("/fake.plist", () => { throw new Error("permission denied"); });
    assert.equal(xml, undefined);
    assert.equal(plistRunsCurrent(xml, "/releases"), false);
  });
  it("returns the XML read from the supplied path", () => {
    assert.equal(readPlistXml("/fake.plist", (p) => {
      assert.equal(p, "/fake.plist");
      return "<plist/>";
    }), "<plist/>");
  });
});

describe("plistRunsCurrent", () => {
  it("is true only when the plist names releases/current's entry", () => {
    const root = "/Users/x/.pmk/releases";
    assert.equal(plistRunsCurrent(`<string>${currentEntry(root)}</string>`, root), true);
    assert.equal(plistRunsCurrent("<string>/Users/x/pm-workspace-kit/packages/cli/dist/index.js</string>", root), false);
    assert.equal(plistRunsCurrent(undefined, root), false);
  });
});

describe("runDeploy", () => {
  const home = useIsolatedHome("pmk-deploy-cmd-");
  const base = () => ({ ref: "HEAD", repo: "/repo", root: releasesRoot(home.dir()), activate: true });

  it("prune failure: preserves exit 0 and the deployment event, and prints a warning", async () => {
    const { d, events, out } = deps({ ready: [true] });
    const withPrune = { ...d, prune: (root: string): string[] => {
      assert.equal(root, base().root);
      throw new Error("permission denied");
    } };
    assert.equal(await runDeploy(base(), withPrune), 0);
    assert.equal(readLink(base().root, "current"), "0.45.0-abcdef0");
    assert.deepEqual(events, [{ type: "gateway.deployed", release: "0.45.0-abcdef0", sha: SHA, ref: "HEAD", previous: undefined }]);
    assert.ok(out.includes("warning: could not prune old releases: permission denied"));
  });

  it("already-current: a second deploy exits 0 without another event or restart", async () => {
    const { d, events, restarts } = deps({ ready: [true] });
    assert.equal(await runDeploy(base(), d), 0);
    const firstEvents = [...events];
    assert.equal(firstEvents.length, 1);
    assert.equal(restarts(), 1);
    assert.equal(await runDeploy(base(), d), 0);
    assert.deepEqual(events, firstEvents);
    assert.equal(restarts(), 1);
  });

  it("links-only: exit 0, current changes and exactly one deployment is recorded", async () => {
    const { d, events } = deps({ ready: [] });
    const linksOnly = { ...d, activate: { ...d.activate, serviceRunsCurrent: () => false } };
    assert.equal(await runDeploy(base(), linksOnly), 0);
    assert.equal(readLink(base().root, "current"), "0.45.0-abcdef0");
    assert.deepEqual(events, [{
      type: "gateway.deployed", release: "0.45.0-abcdef0", sha: SHA, ref: "HEAD", previous: undefined,
      reason: "links only: service not restarted — LaunchAgent does not run releases/current",
    }]);
  });

  it("build + activate: exit 0, gateway.deployed recorded, old releases pruned", async () => {
    const root = base().root;
    for (const [n, day] of [["0.1.0-0000001", "01"], ["0.2.0-0000002", "02"], ["0.3.0-0000003", "03"]] as const) {
      fs.mkdirSync(path.join(root, n), { recursive: true });
      writeReleaseInfo(path.join(root, n), { ref: "x", sha: "b".repeat(40), version: "0", builtAt: `2026-09-${day}T00:00:00.000Z`, nodeVersion: "v22" });
    }
    pointLink(root, "current", "0.3.0-0000003");
    const { d, events } = deps({ ready: [true] });
    assert.equal(await runDeploy(base(), d), 0);
    assert.equal(readLink(root, "current"), "0.45.0-abcdef0");
    assert.deepEqual(events, [{ type: "gateway.deployed", release: "0.45.0-abcdef0", sha: SHA, ref: "HEAD", previous: "0.3.0-0000003" }]);
    assert.deepEqual(listReleases(root), ["0.2.0-0000002", "0.3.0-0000003", "0.45.0-abcdef0"]);
  });

  it("--no-activate: builds, leaves current alone, records nothing", async () => {
    const { d, events, out } = deps({ ready: [true] });
    assert.equal(await runDeploy({ ...base(), activate: false }, d), 0);
    assert.equal(readLink(base().root, "current"), undefined);
    assert.deepEqual(events, []);
    assert.ok(out.some((l) => /pmk gateway activate 0\.45\.0-abcdef0/.test(l)));
  });

  it("build failure: exit 1, current untouched, nothing recorded", async () => {
    const { d, events } = deps({ ready: [true], buildFails: true });
    assert.equal(await runDeploy(base(), d), 1);
    assert.equal(readLink(base().root, "current"), undefined);
    assert.deepEqual(events, []);
  });

  it("rolled back: exit 1 and gateway.rollback with the reason", async () => {
    const root = base().root;
    fs.mkdirSync(path.join(root, "0.3.0-0000003"), { recursive: true });
    writeReleaseInfo(path.join(root, "0.3.0-0000003"), { ref: "x", sha: "b".repeat(40), version: "0", builtAt: "2026-09-03T00:00:00.000Z", nodeVersion: "v22" });
    pointLink(root, "current", "0.3.0-0000003");
    const { d, events } = deps({ ready: [false, true] });
    assert.equal(await runDeploy(base(), d), 1);
    assert.equal(readLink(root, "current"), "0.3.0-0000003");
    assert.equal((events[0] as { type: string }).type, "gateway.rollback");
    assert.match((events[0] as { reason: string }).reason, /did not reach phase/);
  });
});
