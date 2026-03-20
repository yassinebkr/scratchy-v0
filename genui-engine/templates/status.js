/**
 * Status Template - Tier 1 Instant Response
 * Generates status layout in <50ms
 */

export function generateStatus(context = {}) {
  const {
    title = "System Status",
    subtitle = "Current operational status",
    services = [],
    progress = null,
    alert = null
  } = context;

  const ops = [
    {
      op: "clear"
    },
    {
      op: "upsert",
      id: "status-hero",
      type: "hero", 
      data: {
        title,
        subtitle,
        icon: "⚡",
        style: "accent"
      },
      layout: { zone: "auto" }
    }
  ];

  // Add services checklist
  if (services.length > 0) {
    ops.push({
      op: "upsert",
      id: "status-services",
      type: "checklist",
      data: {
        title: "Services",
        items: services
      },
      layout: { zone: "auto" }
    });
  } else {
    ops.push({
      op: "upsert", 
      id: "status-services",
      type: "checklist",
      data: {
        title: "System Services",
        items: [
          { text: "Web Server", checked: true },
          { text: "Database", checked: true },
          { text: "API Gateway", checked: true },
          { text: "File System", checked: true }
        ]
      },
      layout: { zone: "auto" }
    });
  }

  // Add progress if provided
  if (progress) {
    ops.push({
      op: "upsert",
      id: "status-progress",
      type: "progress",
      data: progress,
      layout: { zone: "auto" }
    });
  }

  // Add alert if provided
  if (alert) {
    ops.push({
      op: "upsert",
      id: "status-alert",
      type: "alert",
      data: alert,
      layout: { zone: "auto" }
    });
  }

  return {
    ops,
    timing: "<50ms",
    source: "tier1-status",
    confidence: 1.0
  };
}

export function parseStatusContext(message) {
  const context = {};
  
  if (message.includes('build') || message.includes('deployment')) {
    context.title = "Build Status";
    context.services = [
      { text: "Code Compilation", checked: true },
      { text: "Tests Passing", checked: true },
      { text: "Security Scan", checked: false },
      { text: "Ready for Deploy", checked: false }
    ];
    context.progress = {
      label: "Build Progress",
      value: 75,
      max: 100,
      color: "blue"
    };
  }
  
  if (message.includes('health') || message.includes('running')) {
    context.alert = {
      title: "Health Check",
      message: "All systems operational",
      severity: "success"
    };
  }
  
  if (message.includes('server') || message.includes('system')) {
    context.subtitle = "Server and system status";
    context.services = [
      { text: "OpenClaw Gateway", checked: true },
      { text: "Scratchy UI", checked: true },
      { text: "Database", checked: true },
      { text: "File Storage", checked: true }
    ];
  }
  
  return context;
}