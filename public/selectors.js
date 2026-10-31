(function (root) {
  'use strict';
  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);
  // layoutHeld retains a completed workspace temporarily without changing agent status.
  const hasLive = (node) => Boolean(node.layoutHeld) || !node.archived || node.children.some(hasLive);
  const hasHistoryGroup = (node, group) => node.historyGroup === group || node.children.some(child => hasHistoryGroup(child, group));
  const historyGroupFor = node => hasHistoryGroup(node, 'quiet') ? 'quiet' : hasHistoryGroup(node, 'inactive') ? 'inactive' : 'completed';
  const completedBranch = node => node.displayState === 'completed' && node.children.every(completedBranch);
  const allSubagentsCompleted = agent => agent.children.length > 0 && agent.children.every(completedBranch);
  const subagentGroups = (agent, agents = {}) => {
    const completed = [], active = [];
    for (const child of agent.children) (completedBranch(agents[child.id] || child) ? completed : active).push(child);
    return { completed, active, completedCount: flatten(completed).length };
  };
  const filterTree = (node, ui, inheritedMatch = false) => {
    const text = ui.search.trim().toLowerCase();
    const matches = inheritedMatch || !text || [node.title, node.name, node.shortId, node.agentPath, node.cwd, node.progress].some((value) => value?.toLowerCase().includes(text));
    const children = node.children.map((child) => filterTree(child, ui, matches)).filter(Boolean);
    if ((!matches || (ui.attentionOnly && !node.needsAttention)) && !children.length) return undefined;
    return { ...node, children };
  };
  const familyTokenUsage = root => {
    const totals = {};
    for (const field of ['input', 'cachedInput', 'output']) {
      const values = [root.tokenUsage?.[field], root.subagents?.tokenUsage?.[field]].filter(Number.isFinite);
      if (values.length) totals[field] = values.reduce((sum, value) => sum + value, 0);
    }
    return totals;
  };
  const projectWorkspace = (nodes, workspace) => {
    const memberIds = new Set(), contextIds = new Set();
    const project = nodes => nodes.flatMap(node => {
      const children = project(node.children), member = !workspace || node.cwd === workspace;
      if (!member && !children.length) return [];
      (member ? memberIds : contextIds).add(node.id);
      return [{ ...node, children, workspaceContext: !member }];
    });
    return { forest: project(nodes), memberIds, contextIds };
  };
  const filterWorkspace = (nodes, workspace) => projectWorkspace(nodes, workspace).forest;
  const api = { flatten, hasLive, historyGroupFor, completedBranch, allSubagentsCompleted, subagentGroups, filterTree, filterWorkspace, projectWorkspace, familyTokenUsage };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.agentobsSelectors = api;
})(globalThis);
