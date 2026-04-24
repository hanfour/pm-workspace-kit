import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Session, listParks, parkPath, parksDir } from "../src/session";

const ORIG_HOME = process.env.HOME;

describe("Session.park + resumeFromPark", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-home-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("parks and restores message history", () => {
    const s = new Session();
    s.addUser("hello");
    s.addAssistant("hi there");
    const file = s.park("demo", "discuss", "discuss");
    assert.equal(file, parkPath("demo"));
    assert.equal(file.startsWith(tmpHome), true);

    const parked = Session.resumeFromPark("demo");
    assert.equal(parked.name, "demo");
    assert.equal(parked.verb, "discuss");
    assert.equal(parked.systemPromptKey, "discuss");
    assert.equal(parked.messages.length, 2);
    assert.deepEqual(parked.messages[0], { role: "user", content: "hello" });
    assert.deepEqual(parked.messages[1], {
      role: "assistant",
      content: "hi there",
    });
  });

  it("listParks returns names without .json extension, sorted", () => {
    assert.deepEqual(listParks(), []);
    const s1 = new Session();
    s1.addUser("one");
    s1.park("zeta", "discuss");
    const s2 = new Session();
    s2.addUser("two");
    s2.park("alpha", "debug");
    assert.deepEqual(listParks(), ["alpha", "zeta"]);
  });

  it("throws when park file is missing", () => {
    assert.throws(() => Session.resumeFromPark("missing"), /not found/);
  });

  it("parksDir is under $HOME/.pmk/parks", () => {
    assert.equal(parksDir(), path.join(tmpHome, ".pmk", "parks"));
  });

  it("Session.load replaces history", () => {
    const s = new Session();
    s.addUser("kept");
    s.load([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    assert.equal(s.size(), 2);
    assert.equal(s.last("user"), "a");
    assert.equal(s.last("assistant"), "b");
  });
});
