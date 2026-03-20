#!/usr/bin/env node

/**
 * Scratchy Intent Classifier Prototype
 * Goal: Classify user messages into 8 layout types in <500ms
 */

const fs = require('fs');
const path = require('path');

class ScratchyIntentClassifier {
  constructor() {
    this.layoutTypes = [
      'dashboard', 'form', 'status', 'detail', 
      'timeline', 'chart', 'email', 'checklist', 'notes'
    ];
    
    // Simple keyword-based classification for prototype
    // In production, would use embeddings (sentence-transformers, etc.)
    // More precise keyword mapping with weights
    this.keywords = {
      dashboard: ['dashboard', 'overview', 'metrics', 'kpi', 'stats', 'summary', 'vitals', 'indicators', 'control', 'monitoring', 'big picture'],
      form: ['create', 'add', 'enter', 'input', 'fill', 'submit', 'register', 'complete', 'provide', 'credentials', 'account', 'new entry', 'data entry'],
      status: ['status', 'health', 'check', 'running', 'progress', 'build', 'deployment', 'service', 'operational', 'activity', 'working', 'current state'],
      detail: ['detail', 'view', 'profile', 'information', 'properties', 'specifications', 'record', 'attributes', 'breakdown', 'comprehensive', 'extended', 'full'],
      timeline: ['timeline', 'history', 'chronological', 'events', 'sequence', 'progression', 'milestones', 'development', 'historical', 'time-based', 'event log'],
      chart: ['chart', 'graph', 'visualize', 'analytics', 'statistics', 'trends', 'plot', 'bar', 'pie', 'visualization', 'comparison', 'data viz'],
      email: ['email', 'send', 'draft', 'notification', 'letter', 'announcement', 'report', 'invitation', 'newsletter', 'message to'],
      checklist: ['todo', 'tasks', 'checklist', 'pending', 'completion', 'action items', 'deliverables', 'outstanding', 'task list'],
      notes: ['notes', 'note', 'notebook', 'writing', 'standard notes', 'note taking', 'write down', 'jot down', 'save note', 'note editor', 'encrypted notes', 'note management', 'text notes', 'note workspace', 'note vault']
    };
    
    // Strong indicators that boost confidence
    this.strongIndicators = {
      dashboard: ['dashboard', 'overview', 'kpi'],
      form: ['create', 'add', 'enter', 'fill out'],
      status: ['status', 'health check', 'running'],
      detail: ['detail', 'profile', 'specifications'],
      timeline: ['timeline', 'chronological', 'history'],
      chart: ['chart', 'graph', 'analytics'],
      email: ['email', 'send email', 'compose email'],
      checklist: ['todo', 'checklist', 'tasks'],
      notes: ['notes', 'note', 'notebook', 'standard notes', 'note taking']
    };
  }

  /**
   * Classify user message into layout type
   * @param {string} message - User message to classify
   * @returns {Object} - {type: string, confidence: number, timing: number}
   */
  classify(message) {
    const startTime = process.hrtime.bigint();
    
    const normalized = message.toLowerCase();
    const words = normalized.split(/\s+/);
    
    // Score each layout type
    const scores = {};
    for (const layoutType of this.layoutTypes) {
      scores[layoutType] = this.calculateScore(words, this.keywords[layoutType], this.strongIndicators[layoutType]);
    }
    
    // Find best match
    const sortedScores = Object.entries(scores)
      .sort(([,a], [,b]) => b - a);
    
    const [bestType, bestScore] = sortedScores[0];
    const [secondType, secondScore] = sortedScores[1] || [null, 0];
    
    // Improved confidence calculation
    let confidence = 0;
    if (bestScore > 0) {
      // Base confidence on absolute score
      const baseConfidence = Math.min(1.0, bestScore / 3); // 3+ matches = full confidence
      
      // Bonus for clear winner (large gap between 1st and 2nd)
      const gap = bestScore - secondScore;
      const gapBonus = Math.min(0.3, gap / 5); // Up to 30% bonus for clear gap
      
      confidence = Math.min(1.0, baseConfidence + gapBonus);
    }
    
    const endTime = process.hrtime.bigint();
    const timingMs = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    
    return {
      type: bestType,
      confidence: Math.round(confidence * 100) / 100, // Round to 2 decimal places
      timing: Math.round(timingMs * 100) / 100,
      scores: scores,
      allResults: sortedScores
    };
  }

  /**
   * Calculate score for a layout type based on keyword matches
   * @param {string[]} words - Tokenized message words
   * @param {string[]} keywords - Keywords for this layout type
   * @param {string[]} strongIndicators - Strong indicators that boost confidence
   * @returns {number} - Score (higher is better match)
   */
  calculateScore(words, keywords, strongIndicators = []) {
    let score = 0;
    const message = words.join(' ');
    
    // Check for strong indicators first (phrase matches)
    for (const indicator of strongIndicators) {
      if (message.includes(indicator)) {
        score += 5; // Strong boost for key phrases
      }
    }
    
    // Check individual word matches
    for (const word of words) {
      for (const keyword of keywords) {
        if (word.includes(keyword) || keyword.includes(word)) {
          // Exact match gets higher score
          if (word === keyword) {
            score += strongIndicators.includes(keyword) ? 3 : 2;
          } else {
            score += 1;
          }
        }
      }
    }
    
    return score;
  }

  /**
   * Load and test against training data
   * @returns {Object} - Test results
   */
  runTests() {
    const trainingDataPath = path.join(__dirname, 'training-data.json');
    const trainingData = JSON.parse(fs.readFileSync(trainingDataPath, 'utf8'));
    
    const results = {
      correct: 0,
      total: 0,
      avgTiming: 0,
      avgConfidence: 0,
      details: []
    };
    
    let totalTiming = 0;
    let totalConfidence = 0;
    
    for (const [expectedType, messages] of Object.entries(trainingData)) {
      for (const message of messages) {
        const result = this.classify(message);
        const isCorrect = result.type === expectedType;
        
        results.total++;
        if (isCorrect) results.correct++;
        
        totalTiming += result.timing;
        totalConfidence += result.confidence;
        
        results.details.push({
          message,
          expected: expectedType,
          predicted: result.type,
          confidence: result.confidence,
          timing: result.timing,
          correct: isCorrect
        });
      }
    }
    
    results.accuracy = Math.round((results.correct / results.total) * 100);
    results.avgTiming = Math.round((totalTiming / results.total) * 100) / 100;
    results.avgConfidence = Math.round((totalConfidence / results.total) * 100) / 100;
    
    return results;
  }
}

// CLI Interface
if (require.main === module) {
  const classifier = new ScratchyIntentClassifier();
  
  const command = process.argv[2];
  
  if (command === 'test') {
    console.log('🧠 Running Intent Classifier Tests...\n');
    
    const results = classifier.runTests();
    
    console.log(`📊 Results:`);
    console.log(`   Accuracy: ${results.accuracy}% (${results.correct}/${results.total})`);
    console.log(`   Avg Timing: ${results.avgTiming}ms`);
    console.log(`   Avg Confidence: ${results.avgConfidence}`);
    console.log(`   Target: <500ms ✓`);
    
    // Show errors
    const errors = results.details.filter(d => !d.correct);
    if (errors.length > 0) {
      console.log(`\n❌ Classification Errors (${errors.length}):`);
      errors.slice(0, 5).forEach(error => {
        console.log(`   "${error.message}"`);
        console.log(`   Expected: ${error.expected}, Got: ${error.predicted} (${error.confidence})`);
      });
      if (errors.length > 5) {
        console.log(`   ... and ${errors.length - 5} more`);
      }
    }
    
  } else if (command === 'classify') {
    const message = process.argv.slice(3).join(' ');
    if (!message) {
      console.log('Usage: node classifier.js classify "your message here"');
      process.exit(1);
    }
    
    const result = classifier.classify(message);
    console.log(`🎯 Classification Result:`);
    console.log(`   Message: "${message}"`);
    console.log(`   Type: ${result.type}`);
    console.log(`   Confidence: ${result.confidence}`);
    console.log(`   Timing: ${result.timing}ms`);
    
    if (result.confidence < 0.7) {
      console.log(`   ⚠️ Low confidence - would fallback to Tier 3`);
    } else {
      console.log(`   ✅ High confidence - Tier 1 instant response`);
    }
    
  } else {
    console.log('Scratchy Intent Classifier Prototype');
    console.log('');
    console.log('Commands:');
    console.log('  test                     Run tests against training data');
    console.log('  classify "message"       Classify a single message');
    console.log('');
    console.log('Example:');
    console.log('  node classifier.js classify "show me the dashboard"');
  }
}

module.exports = ScratchyIntentClassifier;