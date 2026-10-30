'use strict';

const { version } = require('../package.json');

function agentKeyFor(session) {
  return JSON.stringify([session.id || session.file || 'unknown', session.agentPath || '', session.provider || 'codex']);
}

function liveMapModel(forest, state = {}, now = Date.now()) {
  const agents = Object.create(null);
  const inactiveAfterMs = state.inactiveAfterMs ?? 3600000;
  const failedInactiveAfterMs = state.failedInactiveAfterMs ?? 900000;
  const quietHistoryAfterMs = state.quietHistoryAfterMs ?? 1800000;
  const card = (node, runKey) => {
    const session = node.session;
    const toolHistory = session.toolHistory || [];
    const recordedTools = [...toolHistory];
    for (const tool of [session.lastTool, session.currentTool]) {
      if (tool && !recordedTools.some(entry => entry === tool || (tool.id && entry.id === tool.id))) recordedTools.push(tool);
    }
    const currentTool = session.currentTool;
    const recentTools = recordedTools.filter(tool => !currentTool || !(tool === currentTool || (currentTool.id && tool.id === currentTool.id)))
      .slice(currentTool ? -4 : -5).reverse();
    if (currentTool) recentTools.unshift(currentTool);
    const id = agentKeyFor(session);
    const needsInput = Boolean(session.needsInput || session.currentTool && /(request_?user_?input|user_?input|approval|permission)/i.test(session.currentTool.name));
    const failed = session.attentionState === 'failed';
    const displayState = failed ? (/interrupted/i.test(session.attentionDetail || '') ? 'interrupted' : 'failed')
      : session.status === 'stale' ? 'quiet'
      : session.status === 'completed' ? 'completed'
      : needsInput ? 'input'
      : session.status === 'starting' ? 'starting'
      : session.currentTool ? 'tool'
      : ['active', 'delegating'].includes(session.status) ? 'working' : 'unknown';
    const phaseLabel = session.observationStale ? 'Observation unavailable; showing the last successful scan'
      : failed ? session.attentionDetail || 'Task failed'
      : displayState === 'quiet' ? 'No recent transcript activity'
      : displayState === 'completed' ? 'Task completed'
      : needsInput ? 'Waiting for your input'
      : session.currentTool ? 'Using ' + (session.currentTool.label || session.currentTool.name)
      : session.status === 'delegating' ? 'Subagents are working'
      : session.status === 'starting' ? 'Waiting for transcript'
      : displayState === 'working' ? 'Thinking' : 'Lifecycle not recorded';
    const lastActivityMs = Date.parse(session.lastActivity || '');
    const cutoff = ['failed', 'interrupted'].includes(displayState) ? failedInactiveAfterMs : inactiveAfterMs;
    const inactive = ['failed', 'interrupted', 'unknown', 'starting'].includes(displayState)
      && Number.isFinite(lastActivityMs) && now - lastActivityMs >= cutoff;
    const quiet = displayState === 'quiet' && Number.isFinite(lastActivityMs) && now - lastActivityMs >= quietHistoryAfterMs;
    const historyGroup = displayState === 'completed' ? 'completed' : session.observationStale ? undefined : quiet ? 'quiet' : inactive ? 'inactive' : undefined;
    const model = {
      id, runKey, name: session.agentName || 'Main agent',
      provider: session.provider || 'codex', providerLabel: session.providerLabel || 'Codex',
      shortId: session.shortId || session.id?.slice(0, 8), agentPath: session.agentPath,
      title: session.currentTask || session.agentName || 'Untitled session',
      task: session.currentTask, originalAssignment: session.originalAssignment, taskSource: session.taskSource, currentTaskAt: session.currentTaskAt, progress: session.currentProgress?.text,
      status: session.status, displayState, phaseLabel,
      archived: Boolean(historyGroup), historyGroup,
      needsAttention: !historyGroup && (['input', 'quiet', 'failed', 'interrupted', 'unknown'].includes(displayState) || Boolean(session.unsupportedReason)),
      elapsedAt: ['completed', 'quiet', 'failed', 'interrupted'].includes(displayState) ? session.lastActivity
        : session.currentTool?.startedAt || session.currentTool?.timestamp || session.lastActivity,
      lastActivity: session.lastActivity, tokenUsage: session.tokenUsage,
      cwd: session.cwd || 'Unknown workspace',
      observationStale: Boolean(session.observationStale),
      warning: session.observationStale ? 'This harness could not be refreshed. Recorded activity may be out of date.' : session.unsupportedReason || session.compatibilityDetail,
      transcript: {
        version: session.cliVersion || 'Unknown',
        supportLevel: session.supportLevel || 'unknown',
        resolution: session.compatibilityResolution || 'Parser resolution was not recorded'
      },
      currentTool, recentTools,
      toolHistory, activityTimeline: session.activityTimeline || [],
      children: node.children.map((child) => card(child, runKey))
    };
    // Sum each child's own usage plus its descendants once. The parent's
    // usage stays on its card; filters and collapsed history do not alter totals.
    const subagents = { count: 0, reportingCount: 0, tokenUsage: {} };
    for (const child of model.children) {
      subagents.count += 1 + child.subagents.count;
      subagents.reportingCount += Number(['input', 'cachedInput', 'output'].some((field) => Number.isFinite(child.tokenUsage?.[field]))) + child.subagents.reportingCount;
      for (const usage of [child.tokenUsage, child.subagents.tokenUsage]) {
        for (const field of ['input', 'cachedInput', 'output']) {
          if (Number.isFinite(usage?.[field])) subagents.tokenUsage[field] = (subagents.tokenUsage[field] || 0) + usage[field];
        }
      }
    }
    model.subagents = subagents;
    agents[id] = model;
    return model;
  };
  const roots = forest.map((node) => card(node, agentKeyFor(node.session)));
  return {
    version, compactDensity: Boolean(state.compactDensity), selectedAgentKey: state.selectedAgentKey,
    forest: roots, agents,
    runs: roots.map((root) => ({ id: root.id, title: root.title, shortId: root.shortId }))
  };
}

module.exports = { agentKeyFor, liveMapModel };
