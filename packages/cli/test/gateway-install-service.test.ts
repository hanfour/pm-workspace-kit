import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { buildPlist, envSecretWarnings, resolveServiceEntry } from "../src/commands/gateway/service";

describe("install-service plist", () => {
  it("plist has Label/KeepAlive/PMK_SERVICE env, abs paths, NO secret", () => {
    const xml = buildPlist({ nodePath: "/usr/bin/node", distEntry: "/abs/dist/index.js", home: "/Users/x", workingDir: "/ws" });
    assert.match(xml, /<key>Label<\/key>\s*<string>com\.pmk\.gateway<\/string>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(xml, /PMK_SERVICE<\/key>\s*<string>launchd<\/string>/);
    assert.match(xml, /\/abs\/dist\/index\.js/);
    assert.doesNotMatch(xml, /xapp-|xoxb-|sk-ant-/);
  });

  it("warns when a raw secret source is {env} (won't resolve under launchd)", () => {
    const warns = envSecretWarnings({
      slack: { appToken: { env: "MY_APP" }, botToken: "xoxb-x" }, apiKey: { cmd: "op read x" },
    } as any);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /MY_APP/);
  });

  it("no warning when all secrets are literal/{cmd}", () => {
    const warns = envSecretWarnings({ slack: { appToken: { cmd: "op read a" }, botToken: "xoxb-x" } } as any);
    assert.equal(warns.length, 0);
  });

  it("no warning when secrets are plain literal strings", () => {
    const warns = envSecretWarnings({ slack: { appToken: "xapp-x", botToken: "xoxb-x" }, apiKey: "sk-ant-x" } as any);
    assert.equal(warns.length, 0);
  });

  it("ProcessType is Interactive, not Background (socket daemon must not be App-Nap throttled)", () => {
    const xml = buildPlist({ nodePath: "/usr/bin/node", distEntry: "/abs/dist/index.js", home: "/Users/x", workingDir: "/ws" });
    assert.match(xml, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
    assert.doesNotMatch(xml, /<string>Background<\/string>/);
  });

  it("XML-escapes special chars in path values (&, <, >, \")", () => {
    const xml = buildPlist({
      nodePath: "/usr/bin/node",
      distEntry: "/a&b/dist/index.js",
      home: "/Users/x",
      workingDir: "/ws & co",
    });
    assert.match(xml, /\/a&amp;b\/dist\/index\.js/);
    assert.match(xml, /\/ws &amp; co/);
    assert.doesNotMatch(xml, /<string>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)[^<]*<\/string>/);
  });
});

describe("install-service entry point", () => {
  const home = "/Users/x";
  const root = path.join(home, ".pmk", "releases");
  const never = () => false;

  it("run from a release: writes releases/current, not the versioned directory", () => {
    const scriptDir = path.join(root, "0.45.0-abcdef0", "packages", "cli", "dist", "commands", "gateway");
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: never });
    assert.equal(r.entry, path.join(root, "current", "packages", "cli", "dist", "index.js"));
    assert.equal(r.warning, undefined);
  });

  it("run from a git working tree: keeps the path and warns", () => {
    const scriptDir = "/Users/x/pm-workspace-kit/packages/cli/dist/commands/gateway";
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: () => true });
    assert.equal(r.entry, "/Users/x/pm-workspace-kit/packages/cli/dist/index.js");
    assert.match(r.warning ?? "", /working tree/);
    assert.match(r.warning ?? "", /pmk gateway deploy/);
  });

  it("run from anywhere else (global npm install): keeps the path, no warning", () => {
    const scriptDir = "/usr/local/lib/node_modules/@pmk/cli/dist/commands/gateway";
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: never });
    assert.equal(r.entry, "/usr/local/lib/node_modules/@pmk/cli/dist/index.js");
    assert.equal(r.warning, undefined);
  });

  it("a sibling directory that merely starts with the root's name is not a release", () => {
    const scriptDir = path.join(home, ".pmk", "releases-old", "x", "packages", "cli", "dist", "commands", "gateway");
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: never });
    assert.ok(r.entry.includes("releases-old"));
  });
});
