'use strict';

const { resourceLimits, limitError } = require('./limits');

function encodeSnapshot(model, overrides) {
  const bounds = resourceLimits(overrides);
  const { forest, agents: unused, ...metadata } = model;
  const agents = Object.create(null), roots = [], stack = forest.slice().reverse().map(node => ({ node, depth: 0 }));
  let omitted = 0, count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (Object.hasOwn(agents, node.id)) continue;
    if (count >= bounds.maxAgents || depth > bounds.maxDepth) { omitted++; continue; }
    const { children, ...record } = node;
    agents[node.id] = { ...record, childIds: children.map(child => child.id), toolHistory: record.toolHistory.slice(-100), activityTimeline: record.activityTimeline.slice(-100) };
    count++;
    if (!depth) roots.push(node.id);
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], depth: depth + 1 });
  }
  for (const agent of Object.values(agents)) agent.childIds = agent.childIds.filter(id => Object.hasOwn(agents, id));
  const wire = { ...metadata, protocolVersion: 2, roots, agents, runs: model.runs.filter(run => roots.includes(run.id)) };
  if (omitted) wire.health = { ...wire.health, status: 'degraded', diagnostics: [...(wire.health?.diagnostics || []), 'SNAPSHOT_LIMIT'], omittedBranches: omitted };
  let json = JSON.stringify(wire);
  if (Buffer.byteLength(json) > bounds.maxSnapshotBytes) {
    for (const agent of Object.values(agents)) { agent.toolHistory = agent.toolHistory.slice(-5); agent.activityTimeline = agent.activityTimeline.slice(-8); }
    wire.health = { ...wire.health, status: 'degraded', diagnostics: [...(wire.health?.diagnostics || []), 'HISTORY_LIMIT'] };
    json = JSON.stringify(wire);
  }
  if (Buffer.byteLength(json) > bounds.maxSnapshotBytes) throw limitError('SNAPSHOT_LIMIT');
  return json;
}
module.exports = { encodeSnapshot };
