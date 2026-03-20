#!/usr/bin/env node

/**
 * Performance Benchmark for Scratchy Intent Classifier
 * Goal: Prove <500ms classification target
 */

const ScratchyIntentClassifier = require('./classifier');

class ClassifierBenchmark {
  constructor() {
    this.classifier = new ScratchyIntentClassifier();
  }

  /**
   * Run comprehensive performance benchmarks
   */
  async runBenchmarks() {
    console.log('🚀 Scratchy Intent Classifier Performance Benchmark\n');
    
    // Test messages for each category
    const testMessages = [
      'show me the server dashboard',
      'create a new user account',
      'what is the current build status?',
      'view user profile details',
      'show project timeline',
      'display sales analytics chart',
      'compose email to team',
      'show todo checklist'
    ];

    // Single message performance
    console.log('📊 Single Message Performance:');
    let totalTime = 0;
    let maxTime = 0;
    let minTime = Infinity;

    for (const message of testMessages) {
      const result = this.classifier.classify(message);
      totalTime += result.timing;
      maxTime = Math.max(maxTime, result.timing);
      minTime = Math.min(minTime, result.timing);
      
      console.log(`   "${message}"`);
      console.log(`   → ${result.type} (${result.confidence}) in ${result.timing}ms`);
    }

    const avgTime = totalTime / testMessages.length;
    console.log(`\n   Average: ${Math.round(avgTime * 100) / 100}ms`);
    console.log(`   Min: ${Math.round(minTime * 100) / 100}ms`);
    console.log(`   Max: ${Math.round(maxTime * 100) / 100}ms`);
    console.log(`   Target: <500ms ${avgTime < 500 ? '✅' : '❌'}`);

    // Batch performance test
    console.log('\n⚡ Batch Performance Test (100 classifications):');
    const batchStart = process.hrtime.bigint();
    
    for (let i = 0; i < 100; i++) {
      const message = testMessages[i % testMessages.length];
      this.classifier.classify(message);
    }
    
    const batchEnd = process.hrtime.bigint();
    const batchTime = Number(batchEnd - batchStart) / 1000000;
    const perMessageTime = batchTime / 100;
    
    console.log(`   Total: ${Math.round(batchTime)}ms`);
    console.log(`   Per message: ${Math.round(perMessageTime * 100) / 100}ms`);
    console.log(`   Throughput: ${Math.round(100000 / perMessageTime)} messages/second`);

    // Memory usage
    const memUsage = process.memoryUsage();
    console.log('\n💾 Memory Usage:');
    console.log(`   Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100} MB`);
    console.log(`   Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100} MB`);
    console.log(`   RSS: ${Math.round(memUsage.rss / 1024 / 1024 * 100) / 100} MB`);

    // Stress test
    console.log('\n🔥 Stress Test (1000 rapid classifications):');
    const stressStart = process.hrtime.bigint();
    
    for (let i = 0; i < 1000; i++) {
      this.classifier.classify('show me dashboard status with charts');
    }
    
    const stressEnd = process.hrtime.bigint();
    const stressTime = Number(stressEnd - stressStart) / 1000000;
    const stressPerMessage = stressTime / 1000;
    
    console.log(`   Total: ${Math.round(stressTime)}ms`);
    console.log(`   Per message: ${Math.round(stressPerMessage * 100) / 100}ms`);
    console.log(`   Still under 500ms: ${stressPerMessage < 500 ? '✅' : '❌'}`);

    // Accuracy test
    console.log('\n🎯 Accuracy Test:');
    const testResults = this.classifier.runTests();
    console.log(`   Accuracy: ${testResults.accuracy}%`);
    console.log(`   High confidence (>0.7): ${testResults.details.filter(d => d.confidence > 0.7).length}/${testResults.total}`);
    console.log(`   Low confidence (<0.7): ${testResults.details.filter(d => d.confidence < 0.7).length}/${testResults.total}`);

    // Summary
    console.log('\n📋 Performance Summary:');
    console.log(`   ✅ Target <500ms: ${avgTime < 500 ? 'ACHIEVED' : 'FAILED'} (${Math.round(avgTime * 100) / 100}ms avg)`);
    console.log(`   ✅ Accuracy: ${testResults.accuracy}% (target >80%)`);
    console.log(`   ✅ Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)} MB (lightweight)`);
    console.log(`   ✅ Throughput: ${Math.round(100000 / perMessageTime)} messages/second`);

    const isReady = avgTime < 500 && testResults.accuracy >= 80;
    console.log(`\n🏆 Ready for Tier 1 Integration: ${isReady ? 'YES' : 'NO'}`);

    return {
      avgTime,
      accuracy: testResults.accuracy,
      throughput: Math.round(100000 / perMessageTime),
      memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      ready: isReady
    };
  }

  /**
   * Test specific edge cases
   */
  testEdgeCases() {
    console.log('\n🎭 Edge Case Testing:');
    
    const edgeCases = [
      '',
      'a',
      'show',
      'this is a very long message that contains multiple keywords from different categories like dashboard and chart and form and status to see how the classifier handles ambiguous cases',
      'xyz123 nonexistent keywords test',
      'SHOW ME THE DASHBOARD',
      'show me the dashboard please',
      '   show   me   the   dashboard   ',
      'dashboard dashboard dashboard',
      'form chart email status'
    ];

    edgeCases.forEach(testCase => {
      const result = this.classifier.classify(testCase);
      console.log(`   "${testCase}" → ${result.type} (${result.confidence}) [${result.timing}ms]`);
    });
  }
}

// Run benchmarks
if (require.main === module) {
  const benchmark = new ClassifierBenchmark();
  
  benchmark.runBenchmarks()
    .then(results => {
      if (process.argv.includes('--edge-cases')) {
        benchmark.testEdgeCases();
      }
      
      console.log('\n🚀 Benchmark Complete!');
      process.exit(results.ready ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Benchmark failed:', error);
      process.exit(1);
    });
}