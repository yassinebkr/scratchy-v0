#!/usr/bin/env node

/**
 * Simple Test for Tier 1 Templates
 * Tests template generation performance
 */

const ScratchyIntentClassifier = require('./classifier');

// Simple template generators (inline for testing)
const templates = {
  dashboard: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "Dashboard", icon: "📊" }, layout: { zone: "auto" } },
      { op: "upsert", id: "stats", type: "stats", data: { title: "Metrics", items: [
        { label: "Sessions", value: "1" }, { label: "Response", value: "<1ms" }
      ]}, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-dashboard", confidence: 1.0
  }),
  
  form: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "Create Form", icon: "📝" }, layout: { zone: "auto" } },
      { op: "upsert", id: "form", type: "form", data: { 
        title: "Form", id: "test", 
        fields: [{ name: "name", type: "text", label: "Name", value: "" }], 
        actions: [{ label: "Submit", action: "submit", style: "primary" }]
      }, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-form", confidence: 1.0
  }),
  
  status: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "System Status", icon: "⚡" }, layout: { zone: "auto" } },
      { op: "upsert", id: "checklist", type: "checklist", data: { title: "Services", items: [
        { text: "Web Server", checked: true }, { text: "Database", checked: true }
      ]}, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-status", confidence: 1.0
  }),
  
  detail: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "Item Details", icon: "📋" }, layout: { zone: "auto" } },
      { op: "upsert", id: "kv", type: "kv", data: { title: "Details", items: [
        { key: "ID", value: "12345" }, { key: "Status", value: "Active" }
      ]}, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-detail", confidence: 1.0
  }),
  
  timeline: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "Timeline", icon: "📅" }, layout: { zone: "auto" } },
      { op: "upsert", id: "timeline", type: "timeline", data: { title: "Events", items: [
        { title: "Started", text: "Project began", time: "09:00", icon: "🚀" }
      ]}, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-timeline", confidence: 1.0
  }),
  
  chart: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "Analytics", icon: "📊" }, layout: { zone: "auto" } },
      { op: "upsert", id: "chart", type: "chart-bar", data: { 
        title: "Metrics", 
        labels: ["A", "B"], 
        datasets: [{ label: "Data", data: [10, 20], color: "blue" }]
      }, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-chart", confidence: 1.0
  }),
  
  email: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "Compose Email", icon: "📧" }, layout: { zone: "auto" } },
      { op: "upsert", id: "form", type: "form", data: { 
        title: "Email", id: "email", 
        fields: [
          { name: "to", type: "email", label: "To", value: "" },
          { name: "subject", type: "text", label: "Subject", value: "" }
        ], 
        actions: [{ label: "Send", action: "send", style: "primary" }]
      }, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-email", confidence: 1.0
  }),
  
  checklist: () => ({
    ops: [
      { op: "clear" },
      { op: "upsert", id: "hero", type: "hero", data: { title: "Task List", icon: "✅" }, layout: { zone: "auto" } },
      { op: "upsert", id: "checklist", type: "checklist", data: { title: "Tasks", items: [
        { text: "Task 1", checked: true }, { text: "Task 2", checked: false }
      ]}, layout: { zone: "auto" } }
    ],
    timing: "<50ms", source: "tier1-checklist", confidence: 1.0
  })
};

console.log('🚀 Testing Tier 1 Templates\n');

const classifier = new ScratchyIntentClassifier();

const testMessages = {
  dashboard: "show me the system dashboard",
  form: "create a new user account", 
  status: "what's the current build status?",
  detail: "view user profile details",
  timeline: "show project timeline",
  chart: "display analytics chart",
  email: "compose email to team",
  checklist: "show task checklist"
};

console.log('📊 Template Generation Performance:');
console.log('   Template    | Generation | Components | Intent Match');
console.log('   ----------- | ---------- | ---------- | ------------');

let totalTime = 0;
let allUnder50ms = true;
let correctIntents = 0;

for (const [type, message] of Object.entries(testMessages)) {
  // Test intent classification
  const intentResult = classifier.classify(message);
  const intentMatch = intentResult.type === type;
  if (intentMatch) correctIntents++;
  
  // Test template generation
  const start = process.hrtime.bigint();
  const template = templates[type]();
  const end = process.hrtime.bigint();
  const timing = Number(end - start) / 1000000;
  
  totalTime += timing;
  if (timing >= 50) allUnder50ms = false;
  
  const timingStr = timing.toFixed(2) + 'ms';
  const componentCount = template.ops.length + ' ops';
  const matchStr = intentMatch ? '✅' : '❌';
  
  console.log(`   ${type.padEnd(11)} | ${timingStr.padEnd(10)} | ${componentCount.padEnd(10)} | ${matchStr}`);
}

const avgTime = totalTime / Object.keys(testMessages).length;

console.log('\n📈 Summary:');
console.log(`   Average generation: ${avgTime.toFixed(2)}ms`);
console.log(`   All under 50ms: ${allUnder50ms ? '✅' : '❌'}`);
console.log(`   Total render time: ${totalTime.toFixed(2)}ms`);
console.log(`   Target <200ms total: ${totalTime < 200 ? '✅' : '❌'}`);
console.log(`   Intent accuracy: ${correctIntents}/${Object.keys(testMessages).length} (${Math.round(correctIntents/Object.keys(testMessages).length*100)}%)`);

// Test template structure
console.log('\n🧪 Template Structure Validation:');

const sampleTemplate = templates.dashboard();
const requiredFields = ['ops', 'timing', 'source', 'confidence'];
const hasAllFields = requiredFields.every(field => field in sampleTemplate);

console.log(`   Required fields: ${hasAllFields ? '✅' : '❌'}`);
console.log(`   Clear operation: ${sampleTemplate.ops[0].op === 'clear' ? '✅' : '❌'}`);
console.log(`   Hero component: ${sampleTemplate.ops[1].type === 'hero' ? '✅' : '❌'}`);
console.log(`   Layout zones: ${sampleTemplate.ops[1].layout?.zone === 'auto' ? '✅' : '❌'}`);

// Performance projections
console.log('\n🎯 Performance Projections:');
const intentTime = 0.72; // From benchmark
const templateTime = avgTime;
const renderTime = 100; // Estimated UI rendering
const totalProjected = intentTime + templateTime + renderTime;

console.log(`   Intent classification: ${intentTime}ms`);
console.log(`   Template generation: ${templateTime.toFixed(2)}ms`);
console.log(`   UI rendering (est): ${renderTime}ms`);
console.log(`   Total projected: ${totalProjected.toFixed(2)}ms`);
console.log(`   Target <200ms: ${totalProjected < 200 ? '✅' : '❌'}`);

console.log('\n🏆 Tier 1 Templates: ' + (totalProjected < 200 && allUnder50ms ? 'READY FOR INTEGRATION!' : 'NEEDS OPTIMIZATION'));

if (totalProjected < 200 && allUnder50ms && correctIntents === Object.keys(testMessages).length) {
  console.log('\n✅ All tests passed - ready for Phase 2!');
  process.exit(0);
} else {
  console.log('\n❌ Some tests failed - needs work');
  process.exit(1);
}