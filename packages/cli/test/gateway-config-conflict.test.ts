import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

/**
 * The gateway config is edited through a read-modify-write: every admin
 * command does `loadRawGatewayConfig()` -> mutate one field ->
 * `saveGatewayConfig()`. Only the WRITE took the authorization lock, so the
 * read sat outside it and two writers could interleave:
 *
 *   host CLI:  load (admins: [A, B])            <- snapshot
 *   gateway:                       load (admins: [A, B])
 *   host CLI:  save (admins: [A])   <- removes a compromised admin
 *   gateway:                       save (audience change, admins: [A, B])
 *
 * The second save is built from a stale snapshot, so it silently restores the
 * admin the host just removed. Losing `admins` / `blocklist` that way is a
 * security regression, not just a lost preference.
 */
describe("gateway config concurrent-write conflict", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-cfg-conflict-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  const seed = async () => {
    const { saveGatewayConfig, GATEWAY_CONFIG_VERSION } = await import(
      "../src/gateway/config"
    );
    saveGatewayConfig({
      version: GATEWAY_CONFIG_VERSION,
      admins: ["U_A", "U_B"],
      blocklist: [],
      audience: { default: "biz", users: {}, channels: {}, domainExamples: { biz: [], pm: [] } },
      escalation: { default: [], repos: {} },
      slack: {},
    });
  };

  // Mutate-then-save on the loaded object is exactly how every admin command
  // is written (`const cfg = loadRawGatewayConfig(); cfg.x = …; save(cfg)`),
  // so the tests use that shape rather than a spread.
  it("refuses a save built on a snapshot another writer has superseded", async () => {
    const { loadRawGatewayConfig, saveGatewayConfig } = await import(
      "../src/gateway/config"
    );
    await seed();

    // This writer reads the config it intends to edit.
    const mine = loadRawGatewayConfig();

    // Another writer commits an unrelated edit in the meantime — here, the
    // host removing a compromised admin from the terminal.
    const theirs = loadRawGatewayConfig();
    theirs.admins = ["U_A"];
    saveGatewayConfig(theirs);

    // Our save carries the pre-removal snapshot. It must be refused, not
    // written: writing it would resurrect U_B.
    mine.mraWorkspace = "/tmp/ws";
    assert.throws(
      () => saveGatewayConfig(mine),
      (err: Error) => err.name === "GatewayConfigConflictError",
      "a stale-snapshot save must be refused",
    );

    // The other writer's removal survived.
    assert.deepEqual(loadRawGatewayConfig().admins, ["U_A"]);
  });

  it("allows a save that follows its own load (the normal path)", async () => {
    const { loadRawGatewayConfig, saveGatewayConfig } = await import(
      "../src/gateway/config"
    );
    await seed();
    const cfg = loadRawGatewayConfig();
    cfg.mraWorkspace = "/tmp/ws";
    assert.doesNotThrow(() => saveGatewayConfig(cfg));
    assert.equal(loadRawGatewayConfig().mraWorkspace, "/tmp/ws");
  });

  // Admin commands save the same loaded object more than once (a switch branch
  // per subcommand), so a save must re-baseline its own write.
  it("allows repeated saves of the same loaded snapshot", async () => {
    const { loadRawGatewayConfig, saveGatewayConfig } = await import(
      "../src/gateway/config"
    );
    await seed();
    const cfg = loadRawGatewayConfig();
    for (const ws of ["/a", "/b", "/c"]) {
      cfg.mraWorkspace = ws;
      assert.doesNotThrow(() => saveGatewayConfig(cfg));
    }
    assert.equal(loadRawGatewayConfig().mraWorkspace, "/c");
  });

  it("allows a freshly constructed config with no snapshot to compare (init)", async () => {
    const { loadRawGatewayConfig, saveGatewayConfig } = await import(
      "../src/gateway/config"
    );
    await seed();
    const cfg = loadRawGatewayConfig();
    // A spread makes a NEW object that was never loaded — no baseline exists,
    // so it is written as before. `pmk gateway init` builds configs this way.
    assert.doesNotThrow(() => saveGatewayConfig({ ...cfg, mraWorkspace: "/x" }));
    assert.equal(loadRawGatewayConfig().mraWorkspace, "/x");
  });

  it("allows the first write when no config file exists yet", async () => {
    const { loadRawGatewayConfig, saveGatewayConfig } = await import(
      "../src/gateway/config"
    );
    const cfg = loadRawGatewayConfig(); // defaults; nothing on disk
    cfg.mraWorkspace = "/x";
    assert.doesNotThrow(() => saveGatewayConfig(cfg));
    assert.equal(loadRawGatewayConfig().mraWorkspace, "/x");
  });
});
