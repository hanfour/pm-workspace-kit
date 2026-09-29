import childProcess from "node:child_process";
import { it } from "node:test";
import * as assert from "node:assert/strict";
import { describeCommandFailure, lastLines, realDeps } from "../src/commands/gateway/deploy-deps";

it("lastLines keeps the requested tail, ignoring the final newline", () => {
  assert.equal(lastLines("one\ntwo\nthree\n", 2), "two\nthree");
  assert.equal(lastLines("one\r\ntwo\r\n", 1), "two");
  assert.equal(lastLines("one", 0), "");
});
it("command failure includes the last 40 stdout and captured stderr lines", () => {
  const stdout = Array.from({ length: 45 }, (_, i) => `diagnostic ${i}`).join("\n") + "\n";
  const error = Object.assign(new Error("exit 2"), { stdout: Buffer.from(stdout), stderr: "stderr detail\n" });
  const message = describeCommandFailure("npm", ["run", "build"], error);
  assert.match(message, /npm run build.*exit 2/);
  assert.ok(message.includes("diagnostic 5\n"));
  assert.ok(!message.includes("diagnostic 4\n"));
  assert.match(message, /diagnostic 44/);
  assert.match(message, /stderr detail/);
  assert.match(describeCommandFailure("tool", [], "oops"), /oops/);
});
it("realDeps.run preserves captured command diagnostics", () => {
  assert.throws(() => realDeps("/unused").build.run(process.execPath,
    ["-e", "console.log(String.fromCharCode(84,83,32,100,105,97,103,110,111,115,116,105,99)); process.exit(2)"], process.cwd()), /TS diagnostic/);
});

it("exportTree explicitly extracts the archive from stdin", (t) => {
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const archive = Buffer.from("fake archive");
  t.mock.method(childProcess, "execFileSync", (file: string, args: readonly string[], options: unknown) => {
    calls.push({ file, args, options });
    return archive;
  });
  realDeps("/unused").build.exportTree("/repo", "sha", "/dest");
  assert.deepEqual(calls, [
    { file: "git", args: ["-C", "/repo", "archive", "--format=tar", "sha"], options: { maxBuffer: 512 * 1024 * 1024 } },
    { file: "tar", args: ["-xf", "-", "-C", "/dest"], options: { input: archive } },
  ]);
});
