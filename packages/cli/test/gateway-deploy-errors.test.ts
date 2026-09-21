import { it } from "node:test";
import * as assert from "node:assert/strict";
import { deployCmd } from "../src/commands/gateway/deploy";
import { useIsolatedHome } from "./helpers/isolated-home";

const home = useIsolatedHome("pmk-deploy-errors-");
it("repo detection prints the underlying git error and the repo hint", async (t) => {
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const output: string[] = [];
  const write = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output.push(chunk.toString());
    return true;
  });
  try {
    process.chdir(home.dir());
    await deployCmd(["HEAD"]);
    assert.equal(process.exitCode, 1);
    assert.match(output.join(""), /not inside a git repository; pass --repo <path>/);
    assert.match(output.join(""), /fatal: not a git repository/);
  } finally {
    write.mock.restore();
    process.chdir(cwd);
    process.exitCode = exitCode;
  }
});
