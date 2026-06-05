import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSecret,
  validateSecretSource,
  secretDiskLabel,
  SecretResolutionError,
} from "../src/gateway/secret-source";

describe("validateSecretSource", () => {
  it("passes a literal string through", () => {
    assert.equal(validateSecretSource("xapp-x", "slack.appToken"), "xapp-x");
  });
  it("accepts a well-formed {env} / {cmd}", () => {
    assert.deepEqual(validateSecretSource({ env: "X" }, "s"), { env: "X" });
    assert.deepEqual(validateSecretSource({ cmd: "op read x" }, "s"), { cmd: "op read x" });
  });
  it("undefined → undefined (absent, not an error)", () => {
    assert.equal(validateSecretSource(undefined, "s"), undefined);
  });
  it("throws on ambiguous {env,cmd}", () => {
    assert.throws(() => validateSecretSource({ env: "X", cmd: "y" }, "s"), SecretResolutionError);
  });
  it("throws on empty / unknown / non-string", () => {
    assert.throws(() => validateSecretSource({}, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource({ foo: "x" }, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource({ cmd: "" }, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource({ env: 42 }, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource(42, "s"), SecretResolutionError);
  });
});

describe("resolveSecret", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.PMK_TEST_SECRET; });
  afterEach(() => {
    if (saved === undefined) delete process.env.PMK_TEST_SECRET;
    else process.env.PMK_TEST_SECRET = saved;
  });

  it("literal → itself; undefined → undefined", () => {
    assert.equal(resolveSecret("lit", "s"), "lit");
    assert.equal(resolveSecret(undefined, "s"), undefined);
  });
  it("{env} set → value; unset → throws; empty → throws", () => {
    process.env.PMK_TEST_SECRET = "v";
    assert.equal(resolveSecret({ env: "PMK_TEST_SECRET" }, "s"), "v");
    delete process.env.PMK_TEST_SECRET;
    assert.throws(() => resolveSecret({ env: "PMK_TEST_SECRET" }, "s"), SecretResolutionError);
    process.env.PMK_TEST_SECRET = "";
    assert.throws(() => resolveSecret({ env: "PMK_TEST_SECRET" }, "s"), SecretResolutionError);
  });
  it("{cmd} success → trimmed stdout", () => {
    assert.equal(resolveSecret({ cmd: "printf 'tok\\n'" }, "s"), "tok");
  });
  it("{cmd} non-zero / empty → throws", () => {
    assert.throws(() => resolveSecret({ cmd: "exit 3" }, "s"), SecretResolutionError);
    assert.throws(() => resolveSecret({ cmd: "true" }, "s"), SecretResolutionError);
  });
  it("{cmd} that hangs → throws (timeout)", () => {
    // resolveSecret caps cmd at 10s; a 30s sleep must be killed and throw,
    // not hang. (execSync's timeout kills the child.)
    assert.throws(() => resolveSecret({ cmd: "sleep 30" }, "s"), SecretResolutionError);
  });
  it("error never leaks stdout OR stderr", () => {
    const cmd = "echo SECRET_ON_STDOUT; echo SECRET_ON_STDERR 1>&2; exit 1";
    try {
      resolveSecret({ cmd }, "slack.appToken");
      assert.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      assert.doesNotMatch(msg, /SECRET_ON_STDOUT/);
      assert.doesNotMatch(msg, /SECRET_ON_STDERR/);
      assert.match(msg, /slack\.appToken/);
    }
  });
});

describe("secretDiskLabel", () => {
  it("labels each shape", () => {
    assert.equal(secretDiskLabel("x"), "literal");
    assert.equal(secretDiskLabel({ env: "MY" }), "env:MY");
    assert.equal(secretDiskLabel({ cmd: "op read x" }), "cmd");
    assert.equal(secretDiskLabel(undefined), "unset");
  });
});
