/**
 * Memory Protection Hooks - Abort-Resistant Memory System
 * Automatically saves memory and project state to prevent data loss
 */

const fs = require('fs').promises;
const path = require('path');

class MemoryProtectionSystem {
  constructor(workspaceDir = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '.', '.openclaw', 'workspace')) {
    this.workspaceDir = workspaceDir;
    this.memoryDir = path.join(workspaceDir, 'memory');
    this.projectsDir = path.join(this.memoryDir, 'projects');
    this.autoSaveInterval = 30000; // 30 seconds
    this.lastSave = 0;
    this.pendingChanges = new Set();
    this.isAutoSaving = false;
  }

  /**
   * Initialize memory protection hooks (ONLY when user explicitly requests)
   */
  async initializeProtection(userRequested = false) {
    if (!userRequested) {
      console.log('⚠️ Memory protection requires explicit user request');
      return false;
    }

    console.log('🛡️ Initializing memory protection system...');
    
    // Ensure directories exist
    await this.ensureDirectories();
    
    // Start auto-save timer
    this.startAutoSave();
    
    // Set up process handlers for graceful shutdown
    this.setupShutdownHandlers();
    
    console.log('✅ Memory protection active - continuous auto-save enabled');
    return true;
  }

  /**
   * Ensure memory directories exist
   */
  async ensureDirectories() {
    try {
      await fs.mkdir(this.memoryDir, { recursive: true });
      await fs.mkdir(this.projectsDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create memory directories:', error);
    }
  }

  /**
   * Mark data as changed and needing save
   */
  markChanged(dataType, data = null) {
    this.pendingChanges.add({
      type: dataType,
      data,
      timestamp: Date.now()
    });
    
    // Trigger immediate save if critical data
    if (this.isCriticalData(dataType)) {
      setImmediate(() => this.performSave());
    }
  }

  /**
   * Check if data type is critical (needs immediate save)
   */
  isCriticalData(dataType) {
    return [
      'session_end',
      'project_milestone', 
      'security_event',
      'widget_configuration',
      'user_credentials_attempted'
    ].includes(dataType);
  }

  /**
   * Start auto-save timer
   */
  startAutoSave() {
    setInterval(async () => {
      if (this.pendingChanges.size > 0 && !this.isAutoSaving) {
        await this.performSave();
      }
    }, this.autoSaveInterval);
  }

  /**
   * Perform actual save operation
   */
  async performSave() {
    if (this.isAutoSaving || this.pendingChanges.size === 0) {
      return;
    }

    this.isAutoSaving = true;
    const changes = Array.from(this.pendingChanges);
    this.pendingChanges.clear();

    try {
      // Save daily memory
      await this.saveDailyMemory(changes);
      
      // Update project files if needed
      await this.saveProjectUpdates(changes);
      
      // Save system state
      await this.saveSystemState(changes);
      
      this.lastSave = Date.now();
      
      if (changes.length > 0) {
        console.log(`💾 Auto-saved ${changes.length} memory changes`);
      }
      
    } catch (error) {
      console.error('❌ Auto-save failed:', error);
      // Re-add failed changes to queue
      changes.forEach(change => this.pendingChanges.add(change));
    } finally {
      this.isAutoSaving = false;
    }
  }

  /**
   * Save to daily memory file
   */
  async saveDailyMemory(changes) {
    const today = new Date().toISOString().split('T')[0];
    const dailyFile = path.join(this.memoryDir, `${today}.md`);
    
    // Prepare memory entries
    const memoryEntries = changes.map(change => {
      const time = new Date(change.timestamp).toLocaleTimeString();
      return `## [auto-save] ${change.type} at ${time}\n${change.data || 'State updated'}\n`;
    }).join('\n');
    
    if (memoryEntries.length === 0) return;
    
    try {
      // Append to daily file
      let existingContent = '';
      try {
        existingContent = await fs.readFile(dailyFile, 'utf8');
      } catch (error) {
        // File doesn't exist, create with header
        existingContent = `# ${today}\n\n`;
      }
      
      await fs.writeFile(dailyFile, existingContent + memoryEntries);
      
    } catch (error) {
      console.error('Failed to save daily memory:', error);
      throw error;
    }
  }

  /**
   * Save project-specific updates
   */
  async saveProjectUpdates(changes) {
    const projectChanges = changes.filter(c => c.type.includes('project_'));
    
    for (const change of projectChanges) {
      const projectName = this.extractProjectName(change.type);
      if (projectName) {
        await this.updateProjectFile(projectName, change);
      }
    }
  }

  /**
   * Extract project name from change type
   */
  extractProjectName(changeType) {
    const match = changeType.match(/project_(\w+)/);
    return match ? match[1] : null;
  }

  /**
   * Update specific project file
   */
  async updateProjectFile(projectName, change) {
    const projectFile = path.join(this.projectsDir, `${projectName}.md`);
    
    try {
      let content = '';
      try {
        content = await fs.readFile(projectFile, 'utf8');
      } catch (error) {
        // Create new project file
        content = `# ${projectName.toUpperCase()} — Project Memory\n> Last updated: ${new Date().toISOString().split('T')[0]}\n\n`;
      }
      
      // Append change
      const timestamp = new Date().toISOString();
      const updateEntry = `\n## Auto-Save Update (${timestamp})\n${change.data}\n`;
      
      await fs.writeFile(projectFile, content + updateEntry);
      
    } catch (error) {
      console.error(`Failed to update project file ${projectName}:`, error);
    }
  }

  /**
   * Save system state for recovery
   */
  async saveSystemState(changes) {
    const systemState = {
      timestamp: Date.now(),
      lastSave: this.lastSave,
      changesCount: changes.length,
      systemHealth: 'operational',
      memoryProtectionActive: true
    };
    
    const stateFile = path.join(this.memoryDir, 'system-state.json');
    await fs.writeFile(stateFile, JSON.stringify(systemState, null, 2));
  }

  /**
   * Set up graceful shutdown handlers
   */
  setupShutdownHandlers() {
    const gracefulShutdown = async (signal) => {
      console.log(`🛡️ Received ${signal} - performing final memory save...`);
      
      this.markChanged('session_end', `Session ended gracefully via ${signal}`);
      await this.performSave();
      
      console.log('✅ Memory protection: Final save completed');
      process.exit(0);
    };
    
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGUSR1', gracefulShutdown);
    
    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      console.error('🚨 Uncaught exception - emergency memory save');
      this.markChanged('uncaught_exception', `Error: ${error.message}`);
      await this.performSave();
      process.exit(1);
    });
  }

  /**
   * Manual save trigger
   */
  async forceSave(reason = 'manual_trigger') {
    this.markChanged(reason, 'Manual save requested');
    await this.performSave();
  }

  /**
   * Get memory protection status
   */
  getStatus() {
    return {
      active: this.isAutoSaving !== undefined,
      lastSave: this.lastSave,
      pendingChanges: this.pendingChanges.size,
      autoSaveInterval: this.autoSaveInterval,
      memoryDirectory: this.memoryDir
    };
  }
}

// Export singleton instance
const memoryProtection = new MemoryProtectionSystem();

module.exports = {
  MemoryProtectionSystem,
  memoryProtection
};