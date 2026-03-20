// lib/subagent-dashboard.js — Helper to generate canvas ops for sub-agent tracking
//
// Usage (by the agent in scratchy-canvas blocks):
//   The agent generates these ops directly in its response.
//   This module provides server-side helpers if needed.

/**
 * Generate initial canvas ops for a set of sub-agents
 * @param {Array<{id: string, label: string, task: string}>} agents
 * @returns {Array<Object>} canvas ops
 */
function createSubagentDashboard(agents) {
  const ops = [
    { op: 'upsert', id: 'sa-header', type: 'hero', data: {
      title: '🤖 Sub-agent Sprint',
      subtitle: `${agents.length} agents deployed`,
      icon: '⚡',
      gradient: true
    }},
    { op: 'upsert', id: 'sa-stats', type: 'stats', data: {
      title: 'Progress',
      items: [
        { label: 'Active', value: String(agents.length) },
        { label: 'Complete', value: '0' },
        { label: 'Failed', value: '0' }
      ]
    }}
  ];

  for (const agent of agents) {
    ops.push({ op: 'upsert', id: `sa-${agent.id}`, type: 'card', data: {
      title: agent.label,
      text: agent.task.slice(0, 100) + (agent.task.length > 100 ? '...' : ''),
      icon: '⏳'
    }});
  }

  return ops;
}

/**
 * Generate patch ops when an agent completes
 * @param {string} agentId - The agent id (without sa- prefix)
 * @param {string} summary - Brief completion summary
 * @param {{active: number, complete: number, failed: number}} stats - Current counts
 * @returns {Array<Object>} canvas ops
 */
function agentCompleted(agentId, summary, stats) {
  return [
    { op: 'patch', id: `sa-${agentId}`, data: {
      text: '✅ ' + summary,
      icon: '✅'
    }},
    { op: 'patch', id: 'sa-stats', data: {
      items: [
        { label: 'Active', value: String(stats.active) },
        { label: 'Complete', value: String(stats.complete) },
        { label: 'Failed', value: String(stats.failed) }
      ]
    }}
  ];
}

/**
 * Generate patch ops when an agent fails
 * @param {string} agentId - The agent id (without sa- prefix)
 * @param {string} error - Error description
 * @param {{active: number, complete: number, failed: number}} stats - Current counts
 * @returns {Array<Object>} canvas ops
 */
function agentFailed(agentId, error, stats) {
  return [
    { op: 'patch', id: `sa-${agentId}`, data: {
      text: '❌ ' + error,
      icon: '❌'
    }},
    { op: 'patch', id: 'sa-stats', data: {
      items: [
        { label: 'Active', value: String(stats.active) },
        { label: 'Complete', value: String(stats.complete) },
        { label: 'Failed', value: String(stats.failed) }
      ]
    }}
  ];
}

/**
 * Generate final summary ops when all agents are done
 * @param {string} totalTime - Human-readable elapsed time (e.g. "2m 34s")
 * @param {string} results - Summary message
 * @returns {Array<Object>} canvas ops
 */
function sprintComplete(totalTime, results) {
  return [
    { op: 'patch', id: 'sa-header', data: {
      title: '🤖 Sprint Complete',
      subtitle: `Finished in ${totalTime}`,
    }},
    { op: 'upsert', id: 'sa-summary', type: 'alert', data: {
      title: 'Summary',
      message: results,
      severity: 'success'
    }}
  ];
}

module.exports = { createSubagentDashboard, agentCompleted, agentFailed, sprintComplete };
