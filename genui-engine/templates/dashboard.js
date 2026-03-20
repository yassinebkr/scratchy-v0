/**
 * Dashboard Template - Tier 1 Instant Response
 * Generates dashboard layout in <50ms
 */

export function generateDashboard(context = {}) {
  const { 
    title = "Dashboard Overview",
    subtitle = "System status and key metrics",
    metrics = [],
    alerts = [],
    gauges = []
  } = context;

  return {
    ops: [
      {
        op: "clear"
      },
      {
        op: "upsert",
        id: "dashboard-hero",
        type: "hero",
        data: {
          title,
          subtitle,
          icon: "📊",
          style: "accent"
        },
        layout: { zone: "auto" }
      },
      {
        op: "upsert", 
        id: "dashboard-stats",
        type: "stats",
        data: {
          title: "Key Metrics",
          items: metrics.length > 0 ? metrics : [
            { label: "Active Sessions", value: "1" },
            { label: "Response Time", value: "<1ms" },
            { label: "Memory Usage", value: "5MB" },
            { label: "Uptime", value: "100%" }
          ]
        },
        layout: { zone: "auto" }
      },
      ...(gauges.length > 0 ? [{
        op: "upsert",
        id: "dashboard-gauges", 
        type: "gauge",
        data: gauges[0],
        layout: { zone: "auto" }
      }] : []),
      ...(alerts.length > 0 ? [{
        op: "upsert",
        id: "dashboard-alert",
        type: "alert", 
        data: alerts[0],
        layout: { zone: "auto" }
      }] : [])
    ],
    timing: "<50ms",
    source: "tier1-dashboard",
    confidence: 1.0
  };
}

// Context parsing helpers
export function parseDashboardContext(message) {
  const context = {};
  
  // Extract metrics keywords
  if (message.includes('server') || message.includes('system')) {
    context.title = "System Dashboard";
    context.metrics = [
      { label: "CPU Usage", value: "23%" },
      { label: "Memory", value: "4.2GB" },
      { label: "Disk", value: "45%" },
      { label: "Network", value: "125MB/s" }
    ];
  }
  
  if (message.includes('performance') || message.includes('metrics')) {
    context.metrics = [
      { label: "Requests/sec", value: "1,245" },
      { label: "Avg Response", value: "0.8ms" },
      { label: "Error Rate", value: "0.01%" },
      { label: "Uptime", value: "99.9%" }
    ];
  }
  
  if (message.includes('status') || message.includes('health')) {
    context.alerts = [{
      title: "System Status",
      message: "All services running normally",
      severity: "success"
    }];
  }
  
  return context;
}