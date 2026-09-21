import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import {
  ENTRY_RELATIVE, assertSafeRef, assertSafeReleaseName, currentEntry, listReleases,
  pointLink, readLink, readReleaseInfo, releaseDir, releaseName, releasesRoot,
  stagingDir, writeReleaseInfo,
} from "../src/gateway/deploy/paths";

const SHA = "2fa1497aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeRelease(root: string, name: string, builtAt: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  writeReleaseInfo(dir, { ref: "HEAD", sha: SHA, version: "0.44.0", builtAt, nodeVersion: "v22.21.1" });
}

describe("deploy paths", () => {
  const home = useIsolatedHome("pmk-deploy-paths-");

  it("releasesRoot is ~/.pmk/releases", () => {
    assert.equal(releasesRoot(home.dir()), path.join(home.dir(), ".pmk", "releases"));
  });

  it("releaseName joins version and the 7-char sha", () => {
    assert.equal(releaseName("0.44.0", SHA), "0.44.0-2fa1497");
  });

  it("currentEntry and stagingDir are derived from the root", () => {
    assert.equal(currentEntry("/r"), path.join("/r", "current", ENTRY_RELATIVE));
    assert.equal(stagingDir("/r", SHA), path.join("/r", ".staging-2fa1497"));
  });

  it("assertSafeReleaseName rejects traversal, flags and dotfiles", () => {
    for (const bad of ["", "..", "../x-2fa1497", "-rf-2fa1497", ".staging-2fa1497", "0.44.0", "0.44.0-XYZ1234", "a/b-2fa1497"]) {
      assert.throws(() => assertSafeReleaseName(bad), /invalid release name/, bad);
    }
    assert.doesNotThrow(() => assertSafeReleaseName("0.44.0-2fa1497"));
    assert.doesNotThrow(() => assertSafeReleaseName("1.0.0-rc.1-abcdef0"));
  });

  it("releaseDir refuses an unsafe name", () => {
    assert.throws(() => releaseDir("/r", "../etc-2fa1497"), /invalid release name/);
  });

  it("assertSafeRef rejects flag-like and shell-special refs", () => {
    for (const bad of ["", "-x", "a b", "a;b", "a..b", "$(id)"]) {
      assert.throws(() => assertSafeRef(bad), bad);
    }
    for (const ok of ["HEAD", "main", "v0.44.0", "feat/x", SHA]) {
      assert.doesNotThrow(() => assertSafeRef(ok), ok);
    }
  });

  it("readLink is undefined before any deploy; pointLink creates then replaces", () => {
    const root = releasesRoot(home.dir());
    fs.mkdirSync(root, { recursive: true });
    assert.equal(readLink(root, "current"), undefined);
    makeRelease(root, "0.44.0-2fa1497", "2026-09-21T00:00:00.000Z");
    makeRelease(root, "0.45.0-abcdef0", "2026-09-22T00:00:00.000Z");
    pointLink(root, "current", "0.44.0-2fa1497");
    assert.equal(readLink(root, "current"), "0.44.0-2fa1497");
    pointLink(root, "current", "0.45.0-abcdef0");
    assert.equal(readLink(root, "current"), "0.45.0-abcdef0");
    assert.ok(fs.lstatSync(path.join(root, "current")).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(root, "current", "RELEASE.json")), "link resolves into the release");
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes(".tmp-")), [], "no temp link left behind");
  });

  it("release info round-trips; a missing or corrupt file reads as undefined", () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, "0.44.0-2fa1497", "2026-09-21T00:00:00.000Z");
    assert.equal(readReleaseInfo(path.join(root, "0.44.0-2fa1497"))?.sha, SHA);
    assert.equal(readReleaseInfo(path.join(root, "nope-2fa1497")), undefined);
    fs.writeFileSync(path.join(root, "0.44.0-2fa1497", "RELEASE.json"), "{not json");
    assert.equal(readReleaseInfo(path.join(root, "0.44.0-2fa1497")), undefined);
  });

  it("listReleases returns built releases oldest first, skipping links, staging and unbuilt dirs", () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, "0.45.0-abcdef0", "2026-09-22T00:00:00.000Z");
    makeRelease(root, "0.44.0-2fa1497", "2026-09-21T00:00:00.000Z");
    fs.mkdirSync(path.join(root, ".staging-1234567"));
    fs.mkdirSync(path.join(root, "0.46.0-1111111")); // no RELEASE.json
    pointLink(root, "current", "0.45.0-abcdef0");
    assert.deepEqual(listReleases(root), ["0.44.0-2fa1497", "0.45.0-abcdef0"]);
  });

  it("listReleases on a missing root is empty", () => {
    assert.deepEqual(listReleases(path.join(home.dir(), "absent")), []);
  });
});
