function extractAssistantText(frame) {
  let text = "";
  if (frame.payload && frame.payload.message && Array.isArray(frame.payload.message.content)) {
    text = frame.payload.message.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
  }
  return text;
}

module.exports = { extractAssistantText };
