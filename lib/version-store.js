/**
 * Version Store — Manages versioned snapshots of web/ for controlled deployment
 * 
 * Storage:
 *   .scratchy-data/versions.json   — metadata (tag, hash, timestamp, description, status)
 *   versions/{tag}/web/            — full copy of web/ directory at that point
 * 
 * Flow:
 *   1. Agent stages a new version → copies web/ to versions/{tag}/web/, records metadata
 *   2. Admin reviews in Deploy Manager widget
 *   3. Admin pushes version to specific users or all users
 *   4. Admin can revert any user to any previous version
 * 
 * Agent can ONLY stage. Push/revert are admin-only widget actions (server-side).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class VersionStore {
  constructor(scratchyDir) {
    this.scratchyDir = scratchyDir;
    this.dataDir = path.join(scratchyDir, ".scratchy-data");
    this.versionsDir = path.join(scratchyDir, "versions");
    this.metaFile = path.join(this.dataDir, "versions.json");
    this.webDir = path.join(scratchyDir, "web");
    this._versions = []; // sorted newest-first

    // Push secret — random token generated at startup, lives only in memory.
    // Required by markLive() to prevent unauthorized pushes (e.g., from AI agent exec).
    // Only the Deploy Manager widget receives this token (injected server-side at init).
    this._pushSecret = require("crypto").randomBytes(32).toString("hex");
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.versionsDir, { recursive: true });
    this._load();
    return this;
  }

  // ── Persistence ──

  _load() {
    try {
      if (fs.existsSync(this.metaFile)) {
        this._versions = JSON.parse(fs.readFileSync(this.metaFile, "utf-8"));
        // Sort newest first
        this._versions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        // ── Security: strip live/default properties from staged versions ──
        // Catches manual file tampering or agent bypasses
        let tampered = false;
        for (const v of this._versions) {
          if (v.status === 'staged' && v._isDefault) {
            console.warn(`[VersionStore] ⚠️ SECURITY: Stripped _isDefault from staged version "${v.tag}" — possible tampering`);
            delete v._isDefault;
            v.pushedAt = null;
            v.pushedBy = null;
            tampered = true;
          }
        }
        if (tampered) this._save();
      }
    } catch (err) {
      console.error("[VersionStore] Failed to load versions:", err.message);
      this._versions = [];
    }
  }

  _save() {
    // ── Security invariant: staged versions must NEVER have live/default properties ──
    // This prevents bypasses via direct file edits or agent exec access.
    for (const v of this._versions) {
      if (v.status === 'staged') {
        delete v._isDefault;
        v.pushedAt = null;
        v.pushedBy = null;
      }
    }
    const json = JSON.stringify(this._versions, null, 2);
    const tmp = this.metaFile + ".tmp";
    fs.writeFileSync(tmp, json, "utf-8");
    fs.renameSync(tmp, this.metaFile);
  }

  // ── Version CRUD ──

  /**
   * Stage a new version by copying web/ directory
   * @param {object} opts - { description, tag? }
   * @returns {object} version metadata
   */
  stage({ description = "No description", tag = null } = {}) {
    // Auto-generate tag if not provided
    if (!tag) {
      const nextNum = this._versions.length > 0
        ? Math.max(...this._versions.map(v => {
            const m = v.tag.match(/^v(\d+)$/);
            return m ? parseInt(m[1], 10) : 0;
          })) + 1
        : 1;
      tag = `v${nextNum}`;
    }

    // Verify tag doesn't already exist
    if (this._versions.find(v => v.tag === tag)) {
      throw new Error(`Version ${tag} already exists`);
    }

    // Get git hash
    let gitHash = "unknown";
    try {
      gitHash = require("child_process")
        .execSync("git rev-parse --short HEAD", { cwd: this.scratchyDir, encoding: "utf8" })
        .trim();
    } catch { /* no git */ }

    // Create version directory
    const versionDir = path.join(this.versionsDir, tag, "web");
    fs.mkdirSync(versionDir, { recursive: true });

    // Copy web/ → versions/{tag}/web/
    this._copyDir(this.webDir, versionDir);

    // Count files
    const fileCount = this._countFiles(versionDir);

    // Compute checksum of index.html (quick integrity check)
    let indexChecksum = null;
    const indexPath = path.join(versionDir, "index.html");
    if (fs.existsSync(indexPath)) {
      indexChecksum = crypto
        .createHash("sha256")
        .update(fs.readFileSync(indexPath))
        .digest("hex")
        .slice(0, 12);
    }

    const version = {
      tag,
      gitHash,
      description,
      fileCount,
      indexChecksum,
      status: "staged", // staged | live | archived
      createdAt: new Date().toISOString(),
      pushedAt: null,
      pushedBy: null,
    };

    this._versions.unshift(version);
    this._save();

    console.log(`[VersionStore] Staged ${tag} (${gitHash}) — ${fileCount} files`);
    return version;
  }

  /**
   * Get path to a version's web directory
   */
  getWebDir(tag) {
    const dir = path.join(this.versionsDir, tag, "web");
    if (!fs.existsSync(dir)) return null;
    return dir;
  }

  /**
   * List all versions (newest first)
   */
  list() {
    this._load(); // Always reload from disk — versions may be staged externally
    return [...this._versions];
  }

  /**
   * Get a specific version
   */
  get(tag) {
    return this._versions.find(v => v.tag === tag) || null;
  }

  /**
   * Get the latest version
   */
  latest() {
    return this._versions[0] || null;
  }

  /**
   * Mark a version as "live" (pushed to at least one user).
   * Requires pushSecret — only available to Deploy Manager widget (injected server-side).
   * This prevents the AI agent from pushing versions via exec/shell access.
   */
  markLive(tag, adminUserId, pushSecret) {
    if (!pushSecret || pushSecret !== this._pushSecret) {
      throw new Error("Push denied — invalid or missing push secret. Only the Deploy Manager UI can push versions live.");
    }
    const v = this.get(tag);
    if (!v) throw new Error(`Version ${tag} not found`);
    v.status = "live";
    v.pushedAt = v.pushedAt || new Date().toISOString();
    v.pushedBy = v.pushedBy || adminUserId;
    this._save();
  }

  /**
   * Archive old versions (keep last N)
   */
  archiveOld(keepCount = 10) {
    for (let i = keepCount; i < this._versions.length; i++) {
      if (this._versions[i].status !== "live") {
        this._versions[i].status = "archived";
      }
    }
    this._save();
  }

  /**
   * Delete a version's files (metadata stays for history)
   */
  purge(tag) {
    const dir = path.join(this.versionsDir, tag);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const v = this.get(tag);
    if (v) {
      v.status = "purged";
      this._save();
    }
  }

  // ── File operations ──

  _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  _countFiles(dir) {
    let count = 0;
    const walk = (d) => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else count++;
      }
    };
    walk(dir);
    return count;
  }
}

module.exports = { VersionStore };
