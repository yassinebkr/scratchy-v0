/**
 * Deploy Manager Widget — Admin-only version management
 * 
 * Actions:
 *   deploy-manager    → Main view: version list + per-user status
 *   deploy-detail     → Version detail: changelog, files, push controls
 *   deploy-push       → Push a version to a specific user (context: { tag, userId })
 *   deploy-push-all   → Push a version to all active users (context: { tag })
 *   deploy-revert     → Revert a user to a specific version (context: { tag, userId })
 *   deploy-set-default → Set a version as the default for new users (context: { tag })
 *   deploy-purge      → Delete version files (context: { tag })
 * 
 * Agent can only stage versions. All push/revert actions are admin-only
 * and executed via widget buttons — never via agent tool calls.
 */

class DeployManagerWidget {
  constructor({ versionStore, userStore }) {
    this.versionStore = versionStore;
    this.userStore = userStore;
    // Push secret received from server — used to authorize markLive calls.
    // This secret lives only in memory (generated at startup), never on disk or in APIs.
    this._pushSecret = versionStore._pushSecret;
  }

  async handleAction(action, context = {}) {
    switch (action) {
      case "deploy-manager": return this._renderMain();
      case "deploy-detail":  return this._renderDetail(context.tag);
      case "deploy-push":    return this._pushToUser(context.tag, context.userId);
      case "deploy-push-all": return this._pushToAll(context.tag);
      case "deploy-revert":  return this._revertUser(context.tag, context.userId);
      case "deploy-set-default": return this._setDefault(context.tag);
      case "deploy-purge":   return this._purgeVersion(context.tag);
      case "deploy-users":   return this._renderUsers(context.tag);
      default:
        return { ops: [{ op: "upsert", id: "deploy-err", type: "alert", data: {
          title: "Unknown Action", message: `No handler for: ${action}`, severity: "error"
        }}]};
    }
  }

  // ── Main View: Version List ──

  _renderMain() {
    const versions = this.versionStore.list();
    const users = this.userStore.listUsers();

    // Find default version (tagged in metadata or latest live)
    const defaultTag = this._getDefaultTag();

    // Version cards
    const versionCards = versions.slice(0, 20).map(v => {
      const userCount = users.filter(u => (u.preferences?.clientVersion || null) === v.tag).length;
      const isDefault = v.tag === defaultTag;
      const statusIcon = v.status === "live" ? "🟢"
                       : v.status === "staged" ? "🟡"
                       : v.status === "purged" ? "⚫"
                       : "⚪";
      const desc = v.description.length > 60 ? v.description.slice(0, 57) + "…" : v.description;
      return {
        op: "upsert",
        id: `deploy-v-${v.tag}`,
        type: "card",
        data: {
          title: `${statusIcon} ${v.tag}${isDefault ? " ★" : ""}`,
          text: `${v.gitHash} · ${this._relativeTime(v.createdAt)} · ${userCount} user${userCount !== 1 ? "s" : ""}\n${desc}`,
          action: "deploy-detail",
          context: { tag: v.tag },
        },
      };
    });

    // Per-user version status
    const userRows = users.filter(u => u.status === "active").map(u => {
      const ver = u.preferences?.clientVersion || defaultTag || "latest";
      return [
        u.displayName || u.email,
        ver,
        u.role,
      ];
    });

    const ops = [
      { op: "clear" },
      { op: "upsert", id: "deploy-nav", type: "buttons", data: {
        buttons: [
          { label: "← Admin Dashboard", action: "admin-dashboard", style: "ghost" },
        ],
      }},
      { op: "upsert", id: "deploy-header", type: "hero", data: {
        title: "Deploy Manager",
        subtitle: `${versions.length} version${versions.length !== 1 ? "s" : ""} · ${users.filter(u => u.status === "active").length} active users`,
        icon: "🚀",
        gradient: true,
      }},
      { op: "upsert", id: "deploy-versions-label", type: "alert", data: {
        title: "📦 Version History",
        message: "Tap a version for details",
        severity: "info",
      }},
      ...versionCards,
      { op: "upsert", id: "deploy-user-map", type: "table", data: {
        title: "👤 User → Version Map",
        headers: ["User", "Version", "Role"],
        rows: userRows,
      }},
    ];

    if (versions.length === 0) {
      ops.push({ op: "upsert", id: "deploy-empty", type: "alert", data: {
        title: "No Versions Yet",
        message: "No versions have been staged. Ask the agent to stage a version, or stage manually via deploy.sh.",
        severity: "info",
      }});
    }

    return { ops };
  }

  // ── Version Detail ──

  _renderDetail(tag) {
    if (!tag) return this._error("No version tag provided");
    const v = this.versionStore.get(tag);
    if (!v) return this._error(`Version ${tag} not found`);

    const users = this.userStore.listUsers().filter(u => u.status === "active");
    const assignedUsers = users.filter(u => (u.preferences?.clientVersion || null) === tag);
    const defaultTag = this._getDefaultTag();

    const ops = [
      { op: "clear" },
      { op: "upsert", id: "deploy-detail-header", type: "hero", data: {
        title: `Version ${v.tag}`,
        subtitle: v.description,
        icon: v.status === "live" ? "🟢" : v.status === "staged" ? "🟡" : "⚪",
      }},
      { op: "upsert", id: "deploy-detail-info", type: "kv", data: {
        title: "📋 Details",
        items: [
          { key: "Git Hash", value: v.gitHash },
          { key: "Status", value: v.status },
          { key: "Staged", value: this._formatDate(v.createdAt) },
          { key: "Files", value: `${v.fileCount} files` },
          { key: "Checksum", value: v.indexChecksum || "—" },
          { key: "Pushed At", value: v.pushedAt ? this._formatDate(v.pushedAt) : "Not yet" },
          { key: "Default", value: tag === defaultTag ? "★ Yes" : "No" },
        ],
      }},
    ];

    // Users on this version
    if (assignedUsers.length > 0) {
      ops.push({ op: "upsert", id: "deploy-detail-users", type: "table", data: {
        title: `👤 Users on ${tag}`,
        headers: ["User", "Email", ""],
        rows: assignedUsers.map(u => [
          u.displayName || u.email,
          u.email,
          { text: "Revert…", action: "deploy-users", context: { tag, userId: u.id }, style: "ghost" },
        ]),
      }});
    }

    // Action buttons
    const buttons = [
      { label: "← Versions", action: "deploy-manager", style: "ghost" },
      { label: "← Admin", action: "admin-dashboard", style: "ghost" },
    ];

    if (v.status !== "purged") {
      buttons.push({ label: "🚀 Push to All Users", action: "deploy-push-all", context: { tag }, style: "primary" });
      buttons.push({ label: "👤 Push to User…", action: "deploy-users", context: { tag }, style: "ghost" });

      if (tag !== defaultTag) {
        buttons.push({ label: "★ Set as Default", action: "deploy-set-default", context: { tag }, style: "ghost" });
      }

      buttons.push({ label: "🗑️ Purge Files", action: "deploy-purge", context: { tag }, style: "ghost" });
    }

    ops.push({ op: "upsert", id: "deploy-detail-actions", type: "buttons", data: {
      title: "Actions",
      buttons,
    }});

    return { ops };
  }

  // ── User Selection (for per-user push/revert) ──

  _renderUsers(tag) {
    if (!tag) return this._error("No version tag provided");
    const v = this.versionStore.get(tag);
    if (!v) return this._error(`Version ${tag} not found`);

    const users = this.userStore.listUsers().filter(u => u.status === "active");
    const defaultTag = this._getDefaultTag();

    const rows = users.map(u => {
      const currentVer = u.preferences?.clientVersion || defaultTag || "latest";
      const isOnThis = (u.preferences?.clientVersion || null) === tag;
      return [
        u.displayName || u.email,
        currentVer,
        isOnThis
          ? { text: "✓ Current", action: "deploy-revert", context: { tag: null, userId: u.id }, style: "ghost" }
          : { text: `Push ${tag}`, action: "deploy-push", context: { tag, userId: u.id }, style: "primary" },
      ];
    });

    return { ops: [
      { op: "clear" },
      { op: "upsert", id: "deploy-push-header", type: "hero", data: {
        title: `Push ${tag} to User`,
        subtitle: v.description,
        icon: "🎯",
      }},
      { op: "upsert", id: "deploy-push-users", type: "table", data: {
        title: "Select User",
        headers: ["User", "Current Version", ""],
        rows,
      }},
      { op: "upsert", id: "deploy-push-back", type: "buttons", data: {
        buttons: [
          { label: "← Back to Detail", action: "deploy-detail", context: { tag }, style: "ghost" },
          { label: "← Back to List", action: "deploy-manager", style: "ghost" },
        ],
      }},
    ]};
  }

  // ── Push Actions ──

  _pushToUser(tag, userId) {
    if (!tag || !userId) return this._error("Missing tag or userId");
    const v = this.versionStore.get(tag);
    if (!v) return this._error(`Version ${tag} not found`);
    if (v.status === "purged") return this._error(`Version ${tag} files have been purged`);

    const user = this.userStore.getById(userId);
    if (!user) return this._error("User not found");

    // Update user's clientVersion preference
    const prefs = { ...(user.preferences || {}), clientVersion: tag };
    this.userStore.updateUser(userId, { preferences: prefs });

    // Mark version as live (requires push secret)
    this.versionStore.markLive(tag, null, this._pushSecret);

    console.log(`[DeployManager] Pushed ${tag} to ${user.email}`);

    return { ops: [
      { op: "upsert", id: "deploy-result", type: "alert", data: {
        title: "✅ Version Pushed",
        message: `${tag} is now active for ${user.displayName || user.email}. They'll get the new version on next page load.`,
        severity: "success",
      }},
      { op: "upsert", id: "deploy-result-back", type: "buttons", data: {
        buttons: [
          { label: "← Back to Detail", action: "deploy-detail", context: { tag }, style: "ghost" },
          { label: "← Back to List", action: "deploy-manager", style: "ghost" },
        ],
      }},
    ]};
  }

  _pushToAll(tag) {
    if (!tag) return this._error("Missing version tag");
    const v = this.versionStore.get(tag);
    if (!v) return this._error(`Version ${tag} not found`);
    if (v.status === "purged") return this._error(`Version ${tag} files have been purged`);

    // Only push to non-admin active users — admin always sees the dev version
    const users = this.userStore.listUsers().filter(u => u.status === "active" && u.role !== "admin");
    let pushed = 0;

    for (const u of users) {
      const full = this.userStore.getById(u.id);
      if (!full) continue;
      const prefs = { ...(full.preferences || {}), clientVersion: tag };
      this.userStore.updateUser(u.id, { preferences: prefs });
      pushed++;
    }

    this.versionStore.markLive(tag, null, this._pushSecret);

    console.log(`[DeployManager] Pushed ${tag} to ${pushed} users`);

    return { ops: [
      { op: "upsert", id: "deploy-result", type: "alert", data: {
        title: "✅ Pushed to All Users",
        message: `${tag} is now active for ${pushed} user${pushed !== 1 ? "s" : ""}. They'll get the new version on next page load.`,
        severity: "success",
      }},
      { op: "upsert", id: "deploy-result-back", type: "buttons", data: {
        buttons: [
          { label: "← Back to Detail", action: "deploy-detail", context: { tag }, style: "ghost" },
          { label: "← Back to List", action: "deploy-manager", style: "ghost" },
        ],
      }},
    ]};
  }

  _revertUser(tag, userId) {
    if (!userId) return this._error("Missing userId");

    const user = this.userStore.getById(userId);
    if (!user) return this._error("User not found");

    // tag=null means "reset to default/latest"
    const prefs = { ...(user.preferences || {}) };
    if (tag) {
      const v = this.versionStore.get(tag);
      if (!v) return this._error(`Version ${tag} not found`);
      if (v.status === "purged") return this._error(`Version ${tag} files have been purged`);
      prefs.clientVersion = tag;
    } else {
      delete prefs.clientVersion;
    }
    this.userStore.updateUser(userId, { preferences: prefs });

    const targetLabel = tag || "default (latest)";
    console.log(`[DeployManager] Reverted ${user.email} to ${targetLabel}`);

    return { ops: [
      { op: "upsert", id: "deploy-result", type: "alert", data: {
        title: "✅ User Reverted",
        message: `${user.displayName || user.email} is now on version: ${targetLabel}. Takes effect on next page load.`,
        severity: "success",
      }},
      { op: "upsert", id: "deploy-result-back", type: "buttons", data: {
        buttons: [
          { label: "← Back to List", action: "deploy-manager", style: "ghost" },
        ],
      }},
    ]};
  }

  _setDefault(tag) {
    if (!tag) return this._error("Missing version tag");
    const v = this.versionStore.get(tag);
    if (!v) return this._error(`Version ${tag} not found`);
    if (v.status === "purged") return this._error(`Version ${tag} files have been purged`);

    // Store default tag in version metadata
    // Remove old default
    for (const ver of this.versionStore.list()) {
      delete ver._isDefault;
    }
    v._isDefault = true;
    this.versionStore._save();

    console.log(`[DeployManager] Set default version to ${tag}`);

    return { ops: [
      { op: "upsert", id: "deploy-result", type: "alert", data: {
        title: "✅ Default Updated",
        message: `${tag} is now the default version for new users and users without a specific assignment.`,
        severity: "success",
      }},
      { op: "upsert", id: "deploy-result-back", type: "buttons", data: {
        buttons: [
          { label: "← Back to Detail", action: "deploy-detail", context: { tag }, style: "ghost" },
          { label: "← Back to List", action: "deploy-manager", style: "ghost" },
        ],
      }},
    ]};
  }

  _purgeVersion(tag) {
    if (!tag) return this._error("Missing version tag");

    // Check if any users are on this version
    const users = this.userStore.listUsers().filter(u =>
      u.status === "active" && u.preferences?.clientVersion === tag
    );

    if (users.length > 0) {
      return { ops: [
        { op: "upsert", id: "deploy-result", type: "alert", data: {
          title: "⛔ Cannot Purge",
          message: `${users.length} user${users.length !== 1 ? "s are" : " is"} still on ${tag}. Reassign them first.`,
          severity: "error",
        }},
        { op: "upsert", id: "deploy-result-back", type: "buttons", data: {
          buttons: [
            { label: "← Back to Detail", action: "deploy-detail", context: { tag }, style: "ghost" },
          ],
        }},
      ]};
    }

    this.versionStore.purge(tag);
    console.log(`[DeployManager] Purged ${tag}`);

    return { ops: [
      { op: "upsert", id: "deploy-result", type: "alert", data: {
        title: "✅ Version Purged",
        message: `${tag} files deleted. Metadata kept in history.`,
        severity: "success",
      }},
      { op: "upsert", id: "deploy-result-back", type: "buttons", data: {
        buttons: [
          { label: "← Back to List", action: "deploy-manager", style: "ghost" },
        ],
      }},
    ]};
  }

  // ── Helpers ──

  _getDefaultTag() {
    // Find explicitly marked default, or latest live version
    const explicit = this.versionStore.list().find(v => v._isDefault);
    if (explicit) return explicit.tag;
    const latestLive = this.versionStore.list().find(v => v.status === "live");
    if (latestLive) return latestLive.tag;
    return null;
  }

  _error(message) {
    return { ops: [{ op: "upsert", id: "deploy-err", type: "alert", data: {
      title: "Error", message, severity: "error",
    }}]};
  }

  _relativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  _formatDate(iso) {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }
}

module.exports = DeployManagerWidget;
