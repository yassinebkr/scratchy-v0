const fs = require("fs");

class MessageStore {
  constructor(filePath) {
    this.filePath = filePath || "/tmp/scratchy-canvas-messages.json";
    this.messages = new Map();
    this.saveTimer = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf-8");
        const json = JSON.parse(data);
        for (const [key, msgs] of Object.entries(json)) {
          this.messages.set(key, msgs);
        }
      }
    } catch (e) {
      console.error("Failed to load messages:", e);
    }
  }

  _save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const obj = Object.fromEntries(this.messages);
        fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
      } catch (e) {
        console.error("Failed to save messages:", e);
      }
    }, 1000);
  }

  _saveSync() {
    try {
      const obj = Object.fromEntries(this.messages);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error("Failed to save messages:", e);
    }
  }

  add(sessionKey, msg) {
    if (!this.messages.has(sessionKey)) {
      this.messages.set(sessionKey, []);
    }
    const msgs = this.messages.get(sessionKey);
    if (!msg.id) msg.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
    if (!msg.timestamp) msg.timestamp = Date.now();
    if (!msg.components) msg.components = [];
    msgs.push(msg);
    if (msgs.length > 100) msgs.shift();
    this._save();
    return msg;
  }

  getRecent(sessionKey, limit = 20) {
    const msgs = this.messages.get(sessionKey) || [];
    return msgs.slice(-limit);
  }
}

module.exports = { MessageStore };
