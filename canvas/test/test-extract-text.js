const { describe, it } = require("node:test");
const assert = require("node:assert");
const { extractAssistantText } = require("../lib/extract-text");

describe("extractAssistantText", () => {
  it("should extract text from content array", () => {
    const frame = {
      payload: {
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" }
          ]
        }
      }
    };
    assert.strictEqual(extractAssistantText(frame), "Hello world");
  });

  it("should skip non-text content blocks", () => {
    const frame = {
      payload: {
        message: {
          content: [
            { type: "tool_use", id: "123" },
            { type: "text", text: "only this" }
          ]
        }
      }
    };
    assert.strictEqual(extractAssistantText(frame), "only this");
  });

  it("should return empty string for missing content", () => {
    assert.strictEqual(extractAssistantText({ payload: {} }), "");
    assert.strictEqual(extractAssistantText({ payload: { message: {} } }), "");
  });

  it("should return empty string for empty content array", () => {
    const frame = { payload: { message: { content: [] } } };
    assert.strictEqual(extractAssistantText(frame), "");
  });

  it("should handle single text block", () => {
    const frame = {
      payload: {
        message: {
          content: [{ type: "text", text: "solo" }]
        }
      }
    };
    assert.strictEqual(extractAssistantText(frame), "solo");
  });
});
