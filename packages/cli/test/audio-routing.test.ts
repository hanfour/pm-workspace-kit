import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isAudioMessage } from "../src/gateway/audio/coordinator";
import { needsConsentNotice } from "../src/gateway/audio/consent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

describe("audio routing helpers", () => {
  it("isAudioMessage true only when an audio file is present", () => {
    assert.equal(isAudioMessage([{ id: "A", mimetype: "audio/mp4" } as never]), true);
    assert.equal(isAudioMessage([{ id: "T", mimetype: "text/plain" } as never]), false);
    assert.equal(isAudioMessage([]), false);
  });

  it("needsConsentNotice fires once per scope", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-cn-"));
    process.env.HOME = tmp;
    try {
      assert.equal(needsConsentNotice("C1"), true);
      assert.equal(needsConsentNotice("C1"), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (ORIG_HOME) process.env.HOME = ORIG_HOME;
      else delete process.env.HOME;
    }
  });
});
