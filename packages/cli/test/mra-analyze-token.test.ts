import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runMraAnalyze } from "../src/adapters/mra";

describe("runMraAnalyze fetch token", () => {
  let tmp: string;
  let oldEnv: Record<string, string | undefined>;
  let capture: string;

  beforeEach(() => {
    oldEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MRA_GIT_FETCH_TOKEN: process.env.MRA_GIT_FETCH_TOKEN,
      PMK_SKIP_MRA_PROBE: process.env.PMK_SKIP_MRA_PROBE,
      MRA_ANALYZE_CAPTURE_PATH: process.env.MRA_ANALYZE_CAPTURE_PATH,
    };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-mra-analyze-token-"));
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    capture = path.join(tmp, "captured-token");
    fs.writeFileSync(
      path.join(bin, "mra"),
      "#!/bin/sh\nprintf '%s' \"${MRA_GIT_FETCH_TOKEN-<unset>}\" > \"$MRA_ANALYZE_CAPTURE_PATH\"\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${oldEnv.PATH ?? ""}`;
    process.env.HOME = tmp;
    process.env.MRA_ANALYZE_CAPTURE_PATH = capture;
    delete process.env.PMK_SKIP_MRA_PROBE;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sets the supplied token after stripping the parent environment", async () => {
    process.env.MRA_GIT_FETCH_TOKEN = "inherited-token";
    const result = await runMraAnalyze({ project: "example-ui", cwd: tmp, token: "pinned-token" });

    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(capture, "utf8"), "pinned-token");
  });

  it("strips an inherited token when no token is supplied", async () => {
    process.env.MRA_GIT_FETCH_TOKEN = "inherited-token";
    const result = await runMraAnalyze({ project: "example-ui", cwd: tmp });

    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(capture, "utf8"), "<unset>");
  });
});
