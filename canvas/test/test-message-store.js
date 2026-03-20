const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { MessageStore } = require("../lib/message-store");

describe("MessageStore", () => {
  let store;
  const testFile = "/tmp/test-messages-" + Date.now() + ".json";

  beforeEach(() => {
    store = new MessageStore(testFile);
  });

  afterEach(() => {
    try { fs.unlinkSync(testFile); } catch {}
  });

  it("should add a message with auto-generated id and timestamp", () => {
    const msg = store.add("s1", { role: "user", text: "hello" });
    assert.ok(msg.id, "should have id");
    assert.ok(msg.timestamp, "should have timestamp");
    assert.strictEqual(msg.role, "user");
    assert.strictEqual(msg.text, "hello");
  });

  it("should retrieve messages for a session", () => {
    store.add("s1", { role: "user", text: "msg1" });
    store.add("s1", { role: "assistant", text: "msg2" });
    store.add("s2", { role: "user", text: "other session" });
    const msgs = store.getRecent("s1");
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].text, "msg1");
    assert.strictEqual(msgs[1].text, "msg2");
  });

  it("should respect limit parameter", () => {
    for (let i = 0; i < 30; i++) {
      store.add("s1", { role: "user", text: "msg" + i });
    }
    const msgs = store.getRecent("s1", 5);
    assert.strictEqual(msgs.length, 5);
    assert.strictEqual(msgs[0].text, "msg25");
  });

  it("should persist to file and reload", () => {
    store.add("s1", { role: "user", text: "persisted" });
    store._saveSync(); // Force sync save for test
    const store2 = new MessageStore(testFile);
    const msgs = store2.getRecent("s1");
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, "persisted");
  });

  it("should return empty array for unknown session", () => {
    const msgs = store.getRecent("nonexistent");
    assert.deepStrictEqual(msgs, []);
  });

  it("should generate unique ids", () => {
    const m1 = store.add("s1", { role: "user", text: "a" });
    const m2 = store.add("s1", { role: "user", text: "b" });
    assert.notStrictEqual(m1.id, m2.id);
  });

  it("should cap at 100 messages per session", () => {
    for (let i = 0; i < 110; i++) {
      store.add("s1", { role: "user", text: "msg" + i });
    }
    const msgs = store.getRecent("s1", 200);
    assert.strictEqual(msgs.length, 100);
    assert.strictEqual(msgs[0].text, "msg10"); // first 10 evicted
  });
});
