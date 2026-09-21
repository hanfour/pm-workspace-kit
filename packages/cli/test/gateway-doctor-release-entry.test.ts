import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { evaluateReleaseEntry, releaseStatusLine } from "../src/gateway/doctor-checks/release-entry";
import { currentEntry, pointLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

import { buildPlist } from "../src/commands/gateway/service";

const root = "/Users/x/.pmk/releases";
const plist = (entry: string) =>
  `<key>ProgramArguments</key><array>\n    <string>/usr/bin/node</string><string>${entry}</string><string>gateway</string><string>start</string>\n  </array>`;

describe("release-entry doctor check", () => {
  it("passes when the LaunchAgent runs releases/current", () => {
    const r = evaluateReleaseEntry({ plistXml: plist(currentEntry(root)), root, currentRelease: "0.45.0-abcdef0", insideGitTree: () => false });
    assert.equal(r.severity, "pass");
    assert.match(r.message, /0\.45\.0-abcdef0/);
  });

  it("recognizes an XML-escaped release entry", () => {
    const root = "/Users/a&b/.pmk/releases";
    const plistXml = buildPlist({ nodePath: "/usr/bin/node", distEntry: currentEntry(root), home: "/Users/a&b", workingDir: "/ws" });
    const r = evaluateReleaseEntry({ plistXml, root, currentRelease: "0.45.0-abcdef0", insideGitTree: () => false });
    assert.equal(r.severity, "pass");
    assert.match(r.message, /0\.45\.0-abcdef0/);
  });

  it("warns with the decoded working-tree entry", () => {
    const entry = "/Users/a&b/repo/packages/cli/dist/index.js";
    const plistXml = buildPlist({ nodePath: "/usr/bin/node", distEntry: entry, home: "/Users/a&b", workingDir: "/ws" });
    const r = evaluateReleaseEntry({ plistXml, root, currentRelease: undefined, insideGitTree: (dir) => {
      assert.equal(dir, path.dirname(entry));
      return true;
    } });
    assert.equal(r.severity, "warn");
    assert.ok(r.message.includes(entry));
  });

  it("fails when it runs releases/current but the link is missing", () => {
    const r = evaluateReleaseEntry({ plistXml: plist(currentEntry(root)), root, currentRelease: undefined, insideGitTree: () => false });
    assert.equal(r.severity, "fail");
    assert.match(r.hint ?? "", /pmk gateway deploy/);
  });

  it("warns when the entry point is inside a git working tree", () => {
    const r = evaluateReleaseEntry({
      plistXml: plist("/Users/x/pm-workspace-kit/packages/cli/dist/index.js"), root, currentRelease: undefined, insideGitTree: () => true,
    });
    assert.equal(r.severity, "warn");
    assert.match(r.message, /working tree/);
  });

  it("passes quietly with no LaunchAgent, or an entry point elsewhere", () => {
    assert.equal(evaluateReleaseEntry({ plistXml: undefined, root, currentRelease: undefined, insideGitTree: () => false }).severity, "pass");
    const other = evaluateReleaseEntry({ plistXml: plist("/opt/pmk/index.js"), root, currentRelease: undefined, insideGitTree: () => false });
    assert.equal(other.severity, "pass");
  });
});

describe("releaseStatusLine", () => {
  const home = useIsolatedHome("pmk-release-status-");

  it("shows the current release, its sha and ref", () => {
    const r = releasesRoot(home.dir());
    fs.mkdirSync(path.join(r, "0.45.0-abcdef0"), { recursive: true });
    writeReleaseInfo(path.join(r, "0.45.0-abcdef0"), { ref: "main", sha: "abcdef0" + "1".repeat(33), version: "0.45.0", builtAt: "2026-09-21T00:00:00.000Z", nodeVersion: "v22" });
    pointLink(r, "current", "0.45.0-abcdef0");
    assert.equal(releaseStatusLine(r), "  release:    0.45.0-abcdef0 (main, built 2026-09-21T00:00:00.000Z)");
  });

  it("degrades when current points to an invalid release name", () => {
    const root = releasesRoot(home.dir());
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync("not-a-release", path.join(root, "current"));
    const line = releaseStatusLine(root);
    assert.ok(line.startsWith("  release:    (unreadable:"));
    assert.equal(line, "  release:    (unreadable: invalid release name: not-a-release)");
  });

  it("says so when nothing is deployed", () => {
    assert.equal(releaseStatusLine(releasesRoot(home.dir())), "  release:    — (not deployed; see `pmk gateway deploy`)");
  });
});
