import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildPlist, envSecretWarnings } from "../src/commands/gateway/service";

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
