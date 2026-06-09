import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_FILES_PER_MESSAGE,
  FILE_EXTRACT_CAP,
  MAX_ATTACHMENT_CONTEXT_CHARS,
  MIN_ATTACHMENT_CONTEXT_CHARS,
  INGEST_PHASE_TIMEOUT_MS,
} from "../src/gateway/attachments/types";

describe("attachment constants", () => {
  it("are the spec'd defaults and consistently ordered", () => {
    assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
    assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
    assert.equal(MAX_FILES_PER_MESSAGE, 10);
    assert.equal(FILE_EXTRACT_CAP, 30_000);
    assert.equal(MAX_ATTACHMENT_CONTEXT_CHARS, 30_000);
    assert.equal(MIN_ATTACHMENT_CONTEXT_CHARS, 4_000);
    assert.equal(INGEST_PHASE_TIMEOUT_MS, 60_000);
    assert.ok(MIN_ATTACHMENT_CONTEXT_CHARS < MAX_ATTACHMENT_CONTEXT_CHARS);
  });
});
