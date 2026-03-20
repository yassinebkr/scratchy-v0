/**
 * Standard Notes API Integration - Phase 4
 * Real-world service integration using sn-cli
 */

const { exec, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const execAsync = util.promisify(exec);

class StandardNotesAPI {
  constructor() {
    this.sessions = new Map(); // Store authenticated sessions
    this.configDir = path.join(__dirname, '..', '.sn-cli-configs');
    this.ensureConfigDir();
  }
  
  async ensureConfigDir() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      // Set restrictive permissions
      await fs.chmod(this.configDir, 0o700);
    } catch (error) {
      console.error('[StandardNotes] Failed to create config directory:', error);
    }
  }
  
  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  getSessionConfigPath(sessionId) {
    return path.join(this.configDir, `session-${sessionId}.json`);
  }
  
  async authenticate(email, password, server = null) {
    const sessionId = this.generateSessionId();
    const configPath = this.getSessionConfigPath(sessionId);
    
    try {
      // Check if sn-cli is installed
      await this.checkSNCliInstalled();
      
      // Build authentication command
      let authCmd = `sn-cli --config-file "${configPath}" auth --email "${email}" --password "${password}"`;
      
      if (server) {
        authCmd += ` --server "${server}"`;
      }
      
      console.log('[StandardNotes] Authenticating user...');
      
      // Execute authentication (with timeout)
      const { stdout, stderr } = await execAsync(authCmd, { 
        timeout: 30000,
        env: { ...process.env, SN_CLI_CONFIG: configPath }
      });
      
      if (stderr && stderr.includes('error')) {
        throw new Error(`Authentication failed: ${stderr}`);
      }
      
      // Store session
      this.sessions.set(sessionId, {
        email,
        configPath,
        createdAt: Date.now(),
        lastUsed: Date.now()
      });
      
      console.log('[StandardNotes] Authentication successful for:', email);
      
      return {
        success: true,
        sessionId,
        message: 'Authentication successful'
      };
      
    } catch (error) {
      // Clean up failed config file
      try {
        await fs.unlink(configPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      console.error('[StandardNotes] Authentication failed:', error);
      return {
        success: false,
        error: error.message || 'Authentication failed'
      };
    }
  }
  
  async checkSNCliInstalled() {
    try {
      await execAsync('sn-cli --version', { timeout: 5000 });
      return true;
    } catch (error) {
      throw new Error('sn-cli is not installed. Please install it first: npm install -g sn-cli');
    }
  }
  
  validateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Invalid session. Please authenticate first.');
    }
    
    // Update last used timestamp
    session.lastUsed = Date.now();
    
    return session;
  }
  
  async listNotes(sessionId, options = {}) {
    const session = this.validateSession(sessionId);
    
    try {
      let cmd = `sn-cli --config-file "${session.configPath}" notes list`;
      
      // Add filters
      if (options.tag) {
        cmd += ` --tag "${options.tag}"`;
      }
      
      if (options.limit) {
        cmd += ` --limit ${options.limit}`;
      }
      
      if (options.search) {
        cmd += ` --search "${options.search}"`;
      }
      
      // Output as JSON for easier parsing
      cmd += ' --output json';
      
      const { stdout, stderr } = await execAsync(cmd, { timeout: 15000 });
      
      if (stderr && stderr.includes('error')) {
        throw new Error(`Failed to list notes: ${stderr}`);
      }
      
      // Parse JSON output
      const notes = JSON.parse(stdout || '[]');
      
      console.log(`[StandardNotes] Retrieved ${notes.length} notes for session ${sessionId}`);
      
      return {
        success: true,
        notes: notes.map(note => ({
          id: note.uuid,
          title: note.title || 'Untitled',
          content: note.content || '',
          createdAt: note.created_at,
          updatedAt: note.updated_at,
          tags: note.tags || [],
          pinned: note.pinned || false
        }))
      };
      
    } catch (error) {
      console.error('[StandardNotes] Failed to list notes:', error);
      return {
        success: false,
        error: error.message || 'Failed to retrieve notes'
      };
    }
  }
  
  async getNote(sessionId, noteId) {
    const session = this.validateSession(sessionId);
    
    try {
      const cmd = `sn-cli --config-file "${session.configPath}" notes show "${noteId}" --output json`;
      
      const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
      
      if (stderr && stderr.includes('error')) {
        throw new Error(`Failed to get note: ${stderr}`);
      }
      
      const note = JSON.parse(stdout);
      
      return {
        success: true,
        note: {
          id: note.uuid,
          title: note.title || 'Untitled',
          content: note.content || '',
          createdAt: note.created_at,
          updatedAt: note.updated_at,
          tags: note.tags || [],
          pinned: note.pinned || false
        }
      };
      
    } catch (error) {
      console.error('[StandardNotes] Failed to get note:', error);
      return {
        success: false,
        error: error.message || 'Failed to retrieve note'
      };
    }
  }
  
  async createNote(sessionId, title, content, tags = []) {
    const session = this.validateSession(sessionId);
    
    try {
      let cmd = `sn-cli --config-file "${session.configPath}" notes create`;
      
      if (title) {
        cmd += ` --title "${title}"`;
      }
      
      if (content) {
        cmd += ` --content "${content}"`;
      }
      
      if (tags.length > 0) {
        cmd += ` --tags "${tags.join(',')}"`;
      }
      
      cmd += ' --output json';
      
      const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
      
      if (stderr && stderr.includes('error')) {
        throw new Error(`Failed to create note: ${stderr}`);
      }
      
      const note = JSON.parse(stdout);
      
      console.log(`[StandardNotes] Created note: ${title} (${note.uuid})`);
      
      return {
        success: true,
        note: {
          id: note.uuid,
          title: note.title || 'Untitled',
          content: note.content || '',
          createdAt: note.created_at,
          updatedAt: note.updated_at,
          tags: note.tags || [],
          pinned: note.pinned || false
        }
      };
      
    } catch (error) {
      console.error('[StandardNotes] Failed to create note:', error);
      return {
        success: false,
        error: error.message || 'Failed to create note'
      };
    }
  }
  
  async updateNote(sessionId, noteId, updates) {
    const session = this.validateSession(sessionId);
    
    try {
      let cmd = `sn-cli --config-file "${session.configPath}" notes update "${noteId}"`;
      
      if (updates.title !== undefined) {
        cmd += ` --title "${updates.title}"`;
      }
      
      if (updates.content !== undefined) {
        cmd += ` --content "${updates.content}"`;
      }
      
      if (updates.tags) {
        cmd += ` --tags "${updates.tags.join(',')}"`;
      }
      
      cmd += ' --output json';
      
      const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
      
      if (stderr && stderr.includes('error')) {
        throw new Error(`Failed to update note: ${stderr}`);
      }
      
      const note = JSON.parse(stdout);
      
      console.log(`[StandardNotes] Updated note: ${noteId}`);
      
      return {
        success: true,
        note: {
          id: note.uuid,
          title: note.title || 'Untitled',
          content: note.content || '',
          createdAt: note.created_at,
          updatedAt: note.updated_at,
          tags: note.tags || [],
          pinned: note.pinned || false
        }
      };
      
    } catch (error) {
      console.error('[StandardNotes] Failed to update note:', error);
      return {
        success: false,
        error: error.message || 'Failed to update note'
      };
    }
  }
  
  async deleteNote(sessionId, noteId) {
    const session = this.validateSession(sessionId);
    
    try {
      const cmd = `sn-cli --config-file "${session.configPath}" notes delete "${noteId}"`;
      
      const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
      
      if (stderr && stderr.includes('error')) {
        throw new Error(`Failed to delete note: ${stderr}`);
      }
      
      console.log(`[StandardNotes] Deleted note: ${noteId}`);
      
      return {
        success: true,
        message: 'Note deleted successfully'
      };
      
    } catch (error) {
      console.error('[StandardNotes] Failed to delete note:', error);
      return {
        success: false,
        error: error.message || 'Failed to delete note'
      };
    }
  }
  
  async searchNotes(sessionId, query, options = {}) {
    // Use listNotes with search parameter
    return await this.listNotes(sessionId, { 
      search: query,
      limit: options.limit || 50
    });
  }
  
  async logout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        // Clean up config file
        await fs.unlink(session.configPath);
      } catch (error) {
        console.warn('[StandardNotes] Failed to cleanup config file:', error);
      }
      
      this.sessions.delete(sessionId);
      console.log(`[StandardNotes] Session ${sessionId} logged out`);
    }
    
    return { success: true };
  }
  
  // Cleanup old sessions periodically
  startSessionCleanup() {
    setInterval(() => {
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      for (const [sessionId, session] of this.sessions.entries()) {
        if (now - session.lastUsed > maxAge) {
          console.log(`[StandardNotes] Cleaning up expired session: ${sessionId}`);
          this.logout(sessionId);
        }
      }
    }, 60 * 60 * 1000); // Check every hour
  }
  
  getStatus() {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([id, session]) => ({
        sessionId: id,
        email: session.email,
        createdAt: session.createdAt,
        lastUsed: session.lastUsed
      }))
    };
  }
}

module.exports = StandardNotesAPI;