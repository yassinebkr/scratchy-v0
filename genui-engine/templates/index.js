/**
 * Tier 1 Template Index - All 8 Instant Templates
 * Exports all templates and routing logic
 */

import { generateDashboard, parseDashboardContext } from './dashboard.js';
import { generateForm, parseFormContext } from './form.js';
import { generateStatus, parseStatusContext } from './status.js';
import StandardNotesWidget from './notes.js';

// Quick implementations for remaining templates
function generateDetail(context = {}) {
  const { title = "Item Details", data = {} } = context;
  return {
    ops: [
      { op: "clear" },
      { 
        op: "upsert", 
        id: "detail-hero", 
        type: "hero", 
        data: { title, icon: "📋", style: "accent" },
        layout: { zone: "auto" }
      },
      {
        op: "upsert",
        id: "detail-kv",
        type: "kv",
        data: {
          title: "Details",
          items: Object.keys(data).length > 0 ? 
            Object.entries(data).map(([k, v]) => ({ key: k, value: v })) :
            [
              { key: "ID", value: "12345" },
              { key: "Name", value: "Sample Item" },
              { key: "Status", value: "Active" },
              { key: "Created", value: "2026-02-19" }
            ]
        },
        layout: { zone: "auto" }
      }
    ],
    timing: "<50ms", source: "tier1-detail", confidence: 1.0
  };
}

function generateTimeline(context = {}) {
  const { title = "Timeline", events = [] } = context;
  return {
    ops: [
      { op: "clear" },
      { 
        op: "upsert", 
        id: "timeline-hero", 
        type: "hero", 
        data: { title, icon: "📅", style: "accent" },
        layout: { zone: "auto" }
      },
      {
        op: "upsert",
        id: "main-timeline",
        type: "timeline",
        data: {
          title: "Events",
          items: events.length > 0 ? events : [
            { title: "Project Started", text: "Initial setup completed", time: "09:00", icon: "🚀" },
            { title: "Development", text: "Core features implemented", time: "12:00", icon: "💻" },
            { title: "Testing", text: "Quality assurance phase", time: "15:00", icon: "🧪" },
            { title: "Deployment", text: "Released to production", time: "18:00", icon: "✅" }
          ]
        },
        layout: { zone: "auto" }
      }
    ],
    timing: "<50ms", source: "tier1-timeline", confidence: 1.0
  };
}

function generateChart(context = {}) {
  const { title = "Analytics Chart", chartType = "bar" } = context;
  
  const chartData = chartType === "pie" ? {
    op: "upsert",
    id: "main-chart",
    type: "chart-pie",
    data: {
      title: "Data Distribution",
      slices: [
        { label: "Category A", value: 45, color: "blue" },
        { label: "Category B", value: 30, color: "green" },
        { label: "Category C", value: 25, color: "orange" }
      ]
    },
    layout: { zone: "auto" }
  } : {
    op: "upsert", 
    id: "main-chart",
    type: "chart-bar",
    data: {
      title: "Performance Metrics",
      labels: ["Jan", "Feb", "Mar", "Apr", "May"],
      datasets: [{
        label: "Revenue",
        data: [12, 19, 8, 15, 22],
        color: "blue"
      }]
    },
    layout: { zone: "auto" }
  };

  return {
    ops: [
      { op: "clear" },
      { 
        op: "upsert", 
        id: "chart-hero", 
        type: "hero", 
        data: { title, icon: "📊", style: "accent" },
        layout: { zone: "auto" }
      },
      chartData
    ],
    timing: "<50ms", source: "tier1-chart", confidence: 1.0
  };
}

function generateEmail(context = {}) {
  const { to = "", subject = "", body = "" } = context;
  return {
    ops: [
      { op: "clear" },
      { 
        op: "upsert", 
        id: "email-hero", 
        type: "hero", 
        data: { title: "Compose Email", icon: "📧", style: "accent" },
        layout: { zone: "auto" }
      },
      {
        op: "upsert",
        id: "email-form",
        type: "form",
        data: {
          title: "Email Details",
          id: "email-compose",
          fields: [
            { name: "to", type: "email", label: "To", value: to },
            { name: "subject", type: "text", label: "Subject", value: subject },
            { name: "body", type: "textarea", label: "Message", value: body }
          ],
          actions: [
            { label: "Send", action: "send", style: "primary" },
            { label: "Save Draft", action: "draft", style: "ghost" }
          ]
        },
        layout: { zone: "auto" }
      }
    ],
    timing: "<50ms", source: "tier1-email", confidence: 1.0
  };
}

function generateChecklist(context = {}) {
  const { title = "Task Checklist", items = [] } = context;
  return {
    ops: [
      { op: "clear" },
      { 
        op: "upsert", 
        id: "checklist-hero", 
        type: "hero", 
        data: { title, icon: "✅", style: "accent" },
        layout: { zone: "auto" }
      },
      {
        op: "upsert",
        id: "main-checklist",
        type: "checklist",
        data: {
          title: "Tasks",
          items: items.length > 0 ? items : [
            { text: "Review requirements", checked: true },
            { text: "Design architecture", checked: true },
            { text: "Implement features", checked: false },
            { text: "Write tests", checked: false },
            { text: "Deploy to production", checked: false }
          ]
        },
        layout: { zone: "auto" }
      }
    ],
    timing: "<50ms", source: "tier1-checklist", confidence: 1.0
  };
}

function generateNotes(context = {}) {
  const notesWidget = new StandardNotesWidget();
  const template = notesWidget.getTier1Template(context);
  return {
    ...template,
    timing: "<50ms", 
    source: "tier1-notes", 
    confidence: 1.0,
    widget: notesWidget // Return widget instance for UserAction handling
  };
}

// Template registry
export const templates = {
  dashboard: { generate: generateDashboard, parseContext: parseDashboardContext },
  form: { generate: generateForm, parseContext: parseFormContext },
  status: { generate: generateStatus, parseContext: parseStatusContext },
  detail: { generate: generateDetail, parseContext: () => ({}) },
  timeline: { generate: generateTimeline, parseContext: () => ({}) },
  chart: { generate: generateChart, parseContext: () => ({}) },
  email: { generate: generateEmail, parseContext: () => ({}) },
  checklist: { generate: generateChecklist, parseContext: () => ({}) },
  notes: { generate: generateNotes, parseContext: () => ({}) }
};

/**
 * Generate Tier 1 template
 * @param {string} layoutType - One of the 8 layout types
 * @param {string} message - Original user message
 * @returns {Object} - Template operations
 */
export function generateTier1Template(layoutType, message) {
  const template = templates[layoutType];
  if (!template) {
    throw new Error(`Unknown template type: ${layoutType}`);
  }
  
  const context = template.parseContext(message);
  return template.generate(context);
}

/**
 * Test all templates
 */
export function testAllTemplates() {
  const testMessages = {
    dashboard: "show me the system dashboard",
    form: "create a new user account", 
    status: "what's the current build status?",
    detail: "view user profile details",
    timeline: "show project timeline",
    chart: "display analytics chart",
    email: "compose email to team",
    checklist: "show task checklist",
    notes: "show my notes"
  };
  
  const results = {};
  
  for (const [type, message] of Object.entries(testMessages)) {
    const start = process.hrtime.bigint();
    const template = generateTier1Template(type, message);
    const end = process.hrtime.bigint();
    const timing = Number(end - start) / 1000000; // Convert to ms
    
    results[type] = {
      ...template,
      actualTiming: Math.round(timing * 100) / 100
    };
  }
  
  return results;
}