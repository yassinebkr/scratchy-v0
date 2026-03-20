'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEMORY_DIR = path.join(__dirname, '..', '.scratchy-data', 'memory');

class MemoryStore {
  constructor() {
    this._cache = new Map(); // userId -> { memories: [], dirty: false, loadedAt }
    this._ensureDir();
  }

  _ensureDir() {
    try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch {}
  }

  _filePath(userId) {
    return path.join(MEMORY_DIR, `${userId}.json`);
  }

  // Load memories for a user (with cache)
  _load(userId) {
    const cached = this._cache.get(userId);
    if (cached && (Date.now() - cached.loadedAt < 30000)) return cached.memories;

    try {
      const raw = fs.readFileSync(this._filePath(userId), 'utf-8');
      const data = JSON.parse(raw);
      const memories = data.memories || [];
      this._cache.set(userId, { memories, dirty: false, loadedAt: Date.now() });
      return memories;
    } catch {
      const empty = [];
      this._cache.set(userId, { memories: empty, dirty: false, loadedAt: Date.now() });
      return empty;
    }
  }

  // Atomic save
  _save(userId) {
    const cached = this._cache.get(userId);
    if (!cached) return;

    const data = {
      userId,
      version: 1,
      updatedAt: new Date().toISOString(),
      memories: cached.memories
    };

    const filePath = this._filePath(userId);
    const tmpPath = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');

    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      cached.dirty = false;
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch {}
      console.error('[MemoryStore] Save failed for', userId, e.message);
    }
  }

  // Add a memory entry
  add(userId, entry) {
    const memories = this._load(userId);

    const memory = {
      id: crypto.randomBytes(8).toString('hex'),
      type: entry.type || 'fact', // fact, preference, episode, widget-state, decision
      content: entry.content,
      source: entry.source || 'conversation', // conversation, widget, system, user
      tags: entry.tags || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      relevance: entry.relevance || 1.0,
      accessCount: 0,
      lastAccessed: null,
      metadata: entry.metadata || {}
    };

    // Dedup: if very similar content exists, update instead of adding
    const existing = this._findSimilar(memories, memory.content, memory.type);
    if (existing) {
      existing.content = memory.content;
      existing.updatedAt = memory.updatedAt;
      existing.relevance = Math.min(existing.relevance + 0.1, 2.0);
      existing.tags = [...new Set([...existing.tags, ...memory.tags])];
    } else {
      memories.push(memory);
    }

    const c = this._cache.get(userId);
    if (c) c.dirty = true;
    this._save(userId);

    return existing || memory;
  }

  // Find similar memory (basic keyword overlap)
  _findSimilar(memories, content, type) {
    const words = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    for (const m of memories) {
      if (m.type !== type) continue;
      const mWords = new Set(m.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));

      let overlap = 0;
      for (const w of words) {
        if (mWords.has(w)) overlap++;
      }

      const similarity = overlap / Math.max(words.size, mWords.size, 1);
      if (similarity > 0.6) return m;
    }
    return null;
  }

  // Get all memories for a user
  getAll(userId) {
    return this._load(userId).slice();
  }

  // Get memories by type
  getByType(userId, type) {
    return this._load(userId).filter(m => m.type === type);
  }

  // Search memories
  search(userId, query, { limit = 10, types = null } = {}) {
    const memories = this._load(userId);
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    if (queryWords.length === 0) return memories.slice(0, limit);

    const scored = memories
      .filter(m => !types || types.includes(m.type))
      .map(m => {
        const text = (m.content + ' ' + m.tags.join(' ')).toLowerCase();
        let score = 0;

        for (const w of queryWords) {
          if (text.includes(w)) score += 1;
          // Exact phrase match bonus
          if (text.includes(query.toLowerCase())) score += 3;
        }

        // Relevance weight
        score *= m.relevance;

        // Recency boost (last 7 days get +0.5)
        const age = Date.now() - new Date(m.updatedAt).getTime();
        if (age < 7 * 24 * 60 * 60 * 1000) score += 0.5;

        return { memory: m, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Update access counts
    for (const s of scored) {
      s.memory.accessCount++;
      s.memory.lastAccessed = new Date().toISOString();
    }

    return scored.map(s => s.memory);
  }

  // Update a memory
  update(userId, memoryId, updates) {
    const memories = this._load(userId);
    const m = memories.find(x => x.id === memoryId);
    if (!m) return null;

    if (updates.content !== undefined) m.content = updates.content;
    if (updates.tags !== undefined) m.tags = updates.tags;
    if (updates.relevance !== undefined) m.relevance = updates.relevance;
    if (updates.type !== undefined) m.type = updates.type;
    m.updatedAt = new Date().toISOString();

    const c = this._cache.get(userId);
    if (c) c.dirty = true;
    this._save(userId);
    return m;
  }

  // Delete a memory
  delete(userId, memoryId) {
    const memories = this._load(userId);
    const idx = memories.findIndex(x => x.id === memoryId);
    if (idx === -1) return false;

    memories.splice(idx, 1);
    const c = this._cache.get(userId);
    if (c) c.dirty = true;
    this._save(userId);
    return true;
  }

  // Get context for injection after compaction
  // Returns the most relevant memories formatted for LLM context
  getCompactionContext(userId, { maxTokens = 2000 } = {}) {
    const memories = this._load(userId);
    if (memories.length === 0) return '';

    // Sort by relevance * recency
    const now = Date.now();
    const sorted = memories
      .map(m => {
        const age = now - new Date(m.updatedAt).getTime();
        const recencyScore = Math.max(0, 1 - (age / (30 * 24 * 60 * 60 * 1000))); // Decay over 30 days
        return { m, score: m.relevance * (0.5 + 0.5 * recencyScore) + (m.accessCount * 0.1) };
      })
      .sort((a, b) => b.score - a.score);

    // Build context string, respecting approximate token limit (4 chars ≈ 1 token)
    const maxChars = maxTokens * 4;
    let context = '## User Memories\n\n';
    let charCount = context.length;

    const sections = {
      'preference': { title: '### Preferences', items: [] },
      'fact': { title: '### Known Facts', items: [] },
      'decision': { title: '### Past Decisions', items: [] },
      'episode': { title: '### Notable Events', items: [] },
      'widget-state': { title: '### Widget State', items: [] }
    };

    for (const { m } of sorted) {
      const line = `- ${m.content}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}\n`;
      if (charCount + line.length > maxChars) break;

      const section = sections[m.type] || sections.fact;
      section.items.push(line);
      charCount += line.length;
    }

    for (const section of Object.values(sections)) {
      if (section.items.length > 0) {
        context += section.title + '\n';
        context += section.items.join('');
        context += '\n';
      }
    }

    return context.trim();
  }

  // Decay relevance of old memories (run periodically)
  decayRelevance(userId, { decayRate = 0.02 } = {}) {
    const memories = this._load(userId);
    const now = Date.now();
    let changed = false;

    for (const m of memories) {
      const age = now - new Date(m.updatedAt).getTime();
      const daysSinceUpdate = age / (24 * 60 * 60 * 1000);

      if (daysSinceUpdate > 7 && m.relevance > 0.1) {
        m.relevance = Math.max(0.1, m.relevance - decayRate);
        changed = true;
      }
    }

    if (changed) {
      const c = this._cache.get(userId);
      if (c) c.dirty = true;
      this._save(userId);
    }

    return changed;
  }

  // Get stats for a user
  stats(userId) {
    const memories = this._load(userId);
    const byType = {};
    for (const m of memories) {
      byType[m.type] = (byType[m.type] || 0) + 1;
    }
    return {
      total: memories.length,
      byType,
      oldestDate: memories.length ? memories.reduce((a, b) => a.createdAt < b.createdAt ? a : b).createdAt : null,
      newestDate: memories.length ? memories.reduce((a, b) => a.createdAt > b.createdAt ? a : b).createdAt : null
    };
  }
}

module.exports = { MemoryStore };
