'use strict';

const path = require('node:path');

function compareSessions(left, right) {
  const leftInactive = ['completed', 'stale'].includes(left.status);
  const rightInactive = ['completed', 'stale'].includes(right.status);
  if (leftInactive !== rightInactive) return leftInactive ? 1 : -1;
  return String(right.lastActivity || '').localeCompare(String(left.lastActivity || ''));
}

// Build a forest from transcript metadata without trusting parent_thread_id.
// Codex 0.162 can emit self-parented session metadata, and interrupted
// subagents may leave larger cycles. Those sessions are safely shown as roots.
function buildSessionForest(sessions, options = {}) {
  options = { ...options, budget: { remaining: options.maxNodes || 2000 } };
  // Agent paths repeat between runs. Resolve each connected run separately so
  // its task assignments, completion reports and placeholders remain local.
  const qualify = (session, id) => `${session.provider || ''}\u0000${id}`;
  const keys = sessions.map((session, index) => qualify(session, session.id || session.file || `anonymous:${index}`));
  const parents = new Map(keys.map((key) => [key, key]));
  const find = (key) => {
    let root = key;
    while (parents.get(root) !== root) root = parents.get(root);
    while (key !== root) { const next = parents.get(key); parents.set(key, root); key = next; }
    return root;
  };
  const join = (left, right) => parents.set(find(left), find(right));
  sessions.forEach((session, index) => {
    const parent = qualify(session, session.parentId);
    if (session.parentId && parents.has(parent)) join(keys[index], parent);
  });
  const owners = new Map();
  sessions.forEach((session, index) => {
    const paths = [...(session.spawnedAgentPaths || []), ...(session.agentReports || []).flatMap((report) => report.spawnedAgentPaths || [])];
    for (const agentPath of paths) {
      const key = qualify(session, agentPath);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(keys[index]);
    }
  });
  // Explicit ancestry and a recorded root anchor a component. Repeated agent
  // paths may attach otherwise unresolved fragments, never merge known runs.
  const anchored = new Set();
  sessions.forEach((session, index) => {
    if (!session.agentPath || session.agentPath.split('/').filter(Boolean).length === 1 || session.parentId && session.parentId !== session.id) anchored.add(find(keys[index]));
  });
  sessions.forEach((session, index) => {
    const component = find(keys[index]);
    if (anchored.has(component)) return;
    const candidates = new Set([...(owners.get(qualify(session, session.agentPath)) || [])].map(find));
    candidates.delete(component);
    if (candidates.size === 1) join(component, [...candidates][0]);
  });
  const groups = new Map();
  sessions.forEach((session, index) => {
    const key = find(keys[index]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  });
  return [...groups.values()].flatMap(group => buildSessionForestGroup(group, options)).sort((left, right) => compareSessions(left.session, right.session));
}

function buildSessionForestGroup(sessions, { maxDepth = 256, onLimit = () => {}, budget = { remaining: 2000 } } = {}) {
  // A multi-agent Codex run shares a session_id across rollout files. The
  // agent_path is therefore part of an observer node's identity.
  const byNodeKey = new Map(), originals = new Map();
  for (const session of sessions) {
    const nodeKey = `${session.id || session.file}\u0000${session.agentPath || ''}`;
    const existing = byNodeKey.get(nodeKey);
    // Codex can write a short guardian/auxiliary rollout with the same root
    // session id but no lifecycle records. Never let that `unknown` fragment
    // replace the real session simply because it was written a moment later.
    if (!existing || (existing.status === 'unknown' && session.status !== 'unknown')) { byNodeKey.set(nodeKey, { ...session, nodeKey }); originals.set(nodeKey, session); }
  }
  // A root run is often persisted as several rollout fragments. Keep the
  // newest lifecycle state selected above, but merge its historical spawn
  // metadata so a still-running parent retains edges to dormant children.
  for (const session of sessions) {
    const nodeKey = `${session.id || session.file}\u0000${session.agentPath || ''}`;
    const target = byNodeKey.get(nodeKey);
    if (!target || originals.get(nodeKey) === session) continue;
    target.spawnedAgentPaths = [...new Set([...(target.spawnedAgentPaths || []), ...(session.spawnedAgentPaths || [])])];
    target.completedAgentPaths = [...new Set([...(target.completedAgentPaths || []), ...(session.completedAgentPaths || [])])];
    const agents = new Map();
    for (const agent of [...(target.spawnedAgents || []), ...(session.spawnedAgents || [])]) {
      const key = agent.agentPath + '\u0000' + (agent.kind || 'spawn'), previous = agents.get(key);
      const newer = Date.parse(agent.timestamp) > Date.parse(previous?.timestamp);
      if (!previous || agent.kind === 'followup' && newer || agent.kind !== 'followup' && Date.parse(agent.timestamp) < Date.parse(previous.timestamp)) agents.set(key, agent);
    }
    target.spawnedAgents = [...agents.values()];
    target.agentReports = [...(target.agentReports || []), ...(session.agentReports || [])];
    target.agentObservations = [...(target.agentObservations || []), ...(session.agentObservations || [])];
  }
  const uniqueSessions = [...byNodeKey.values()];
  const byId = new Map();
  for (const session of uniqueSessions) {
    // Prefer the root rollout for an id; subagent rollouts frequently carry
    // that same id and would otherwise become the false parent.
    if (session.id && (!byId.has(session.id) || (!session.agentPath && byId.get(session.id).agentPath))) byId.set(session.id, session);
  }
  const reportsByAgentPath = new Map();
  const observationsByAgentPath = new Map();
  const assignedTaskByAgentPath = new Map(), originalAssignments = new Map();
  for (const session of uniqueSessions) {
    for (const observation of session.agentObservations || []) {
      const existing = observationsByAgentPath.get(observation.agentPath);
      if (!existing || Date.parse(observation.timestamp) > (Date.parse(existing.timestamp) || -Infinity)) observationsByAgentPath.set(observation.agentPath, observation);
    }
    for (const spawned of session.spawnedAgents || []) {
      const initial = originalAssignments.get(spawned.agentPath);
      if (spawned.kind !== 'followup' && (!initial || Date.parse(spawned.timestamp) < Date.parse(initial.timestamp))) originalAssignments.set(spawned.agentPath, spawned);
      const previous = assignedTaskByAgentPath.get(spawned.agentPath);
      if (spawned.agentPath && spawned.task && (!previous || Date.parse(spawned.timestamp) > (Date.parse(previous.timestamp) || -Infinity))) assignedTaskByAgentPath.set(spawned.agentPath, spawned);
    }
    for (const report of session.agentReports || []) {
      const existing = reportsByAgentPath.get(report.agentPath) || { agentPath: report.agentPath, spawnedAgentPaths: new Set(), completedAgentPaths: new Set() };
      for (const childPath of report.spawnedAgentPaths || []) existing.spawnedAgentPaths.add(childPath);
      for (const childPath of report.completedAgentPaths || []) existing.completedAgentPaths.add(childPath);
      reportsByAgentPath.set(report.agentPath, existing);
    }
  }
  const rootAgentPaths = new Map();
  for (const session of uniqueSessions) {
    if (session.agentPath) continue;
    const directChild = (session.spawnedAgentPaths || []).find((agentPath) => agentPath.split('/').filter(Boolean).length === 2);
    if (directChild) rootAgentPaths.set(session.nodeKey, path.dirname(directChild));
  }
  const sessionPath = (session) => session.agentPath || rootAgentPaths.get(session.nodeKey);
  const spawnedByParentPath = new Map();
  const completedAgentPaths = new Set();
  for (const session of uniqueSessions) {
    for (const agentPath of session.spawnedAgentPaths || []) {
      const parentPath = path.dirname(agentPath);
      const childrenAtPath = spawnedByParentPath.get(parentPath) || new Set();
      childrenAtPath.add(agentPath); spawnedByParentPath.set(parentPath, childrenAtPath);
    }
    for (const agentPath of session.completedAgentPaths || []) completedAgentPaths.add(agentPath);
  }
  for (const report of reportsByAgentPath.values()) {
    for (const agentPath of report.spawnedAgentPaths) {
      const parentPath = path.dirname(agentPath);
      const childrenAtPath = spawnedByParentPath.get(parentPath) || new Set();
      childrenAtPath.add(agentPath); spawnedByParentPath.set(parentPath, childrenAtPath);
    }
    for (const agentPath of report.completedAgentPaths) completedAgentPaths.add(agentPath);
  }
  // A later progress report invalidates older completion evidence, including
  // completion metadata merged from an earlier rollout fragment.
  for (const observation of observationsByAgentPath.values()) {
    if (observation.status === 'completed') completedAgentPaths.add(observation.agentPath);
    else completedAgentPaths.delete(observation.agentPath);
  }
  const completionApplies = (session) => {
    if (!completedAgentPaths.has(session.agentPath)) return false;
    // A recorded local terminal event is authoritative, including failures.
    if (session.hasLifecycle && session.status === 'completed') return false;
    const reportAt = Date.parse(observationsByAgentPath.get(session.agentPath)?.timestamp);
    const activityAt = Date.parse(session.lastActivity || session.turnStartedAt);
    if (Number.isFinite(reportAt) && Number.isFinite(activityAt)) return reportAt >= activityAt;
    // Legacy reports without timestamps cannot override a proven lifecycle.
    return !session.hasLifecycle && !Number.isFinite(activityAt);
  };
  const spawnedByPath = new Map();
  for (const session of uniqueSessions) {
    for (const childPath of session.spawnedAgentPaths || []) {
      if (!spawnedByPath.has(childPath)) spawnedByPath.set(childPath, session.nodeKey);
    }
  }
  const byPath = new Map(uniqueSessions.map(session => [sessionPath(session), session]));
  const parentFor = (session) => {
    const explicitParent = session.parentId && byId.get(session.parentId);
    // Shared/self-parented thread ids identify the run, not the immediate
    // delegator. Prefer the canonical path before falling back to that root.
    if (explicitParent && session.parentId !== session.id && explicitParent.nodeKey !== session.nodeKey) return explicitParent.nodeKey;
    const parentPath = session.agentPath && path.dirname(session.agentPath);
    const parentSession = parentPath && byPath.get(parentPath);
    if (parentSession && parentSession.nodeKey !== session.nodeKey) return parentSession.nodeKey;
    if (explicitParent && explicitParent.nodeKey !== session.nodeKey) return explicitParent.nodeKey;
    const spawnedParent = session.agentPath && spawnedByPath.get(session.agentPath);
    return spawnedParent && spawnedParent !== session.nodeKey && byNodeKey.has(spawnedParent) ? spawnedParent : undefined;
  };
  const children = new Map();
  const roots = [];
  const parentKeys = new Map(uniqueSessions.map(session => [session.nodeKey, parentFor(session)]));
  const acyclic = new Map();
  for (const session of uniqueSessions) {
    let key = session.nodeKey;
    const trail = [], visiting = new Set();
    while (key && !acyclic.has(key) && !visiting.has(key)) {
      visiting.add(key); trail.push(key); key = parentKeys.get(key);
    }
    const valid = !key || acyclic.get(key) === true;
    for (const visited of trail) acyclic.set(visited, valid);
  }
  const isAttachable = session => acyclic.get(session.nodeKey) && parentKeys.has(session.nodeKey) && Boolean(parentKeys.get(session.nodeKey));
  for (const session of uniqueSessions) {
    if (isAttachable(session)) {
      const parentId = parentFor(session);
      const list = children.get(parentId) || [];
      list.push(session); children.set(parentId, list);
    } else roots.push(session);
  }
  const knownAgentPaths = new Set(uniqueSessions.map((session) => session.agentPath).filter(Boolean));
  const childSessionsFor = (parent) => {
    const directChildren = children.get(parent.nodeKey) || [];
    const directPaths = new Set(directChildren.map((child) => child.agentPath).filter(Boolean));
    const placeholders = [];
    const parentPath = sessionPath(parent);
    const paths = parentPath ? spawnedByParentPath.get(parentPath) || new Set() : new Set(parent.spawnedAgentPaths || []);
    for (const agentPath of paths) {
      if (knownAgentPaths.has(agentPath) || directPaths.has(agentPath)) continue;
      const report = reportsByAgentPath.get(agentPath);
      const observation = observationsByAgentPath.get(agentPath);
      const completed = completedAgentPaths.has(agentPath);
      placeholders.push({
        id: `${parent.nodeKey}:placeholder:${agentPath}`,
        provider: parent.provider,
        providerLabel: parent.providerLabel,
        agentName: path.basename(agentPath),
        agentPath,
        status: completed ? 'completed' : parent.status === 'stale' ? 'stale' : report || observation ? 'active' : 'starting',
        attentionState: completed ? 'completed' : parent.status === 'stale' ? 'stalled' : report || observation ? 'running' : 'waiting',
        attentionDetail: completed ? 'Task completed (agent report received)' : parent.status === 'stale' ? 'Transcript has stopped updating' : report || observation ? 'Working (agent report received)' : 'Waiting for transcript',
        completionSource: completed ? 'agent_report' : undefined,
        spawnedAgentPaths: report ? [...report.spawnedAgentPaths] : [],
        completedAgentPaths: report ? [...report.completedAgentPaths] : [],
        isPlaceholder: true,
        cwd: parent.cwd,
        currentTask: assignedTaskByAgentPath.get(agentPath)?.task,
        lastActivity: observation?.timestamp || parent.lastActivity
      });
    }
    return [...directChildren, ...placeholders].sort(compareSessions);
  };
  const make = (session, ancestry = new Set()) => {
    if (!budget.remaining) { onLimit(); return undefined; }
    budget.remaining--;
    const identity = session.agentPath || session.nodeKey;
    if (ancestry.has(identity)) return { session: { ...session, unsupportedReason: 'Cyclic reported agent relationship' }, children: [] };
    const next = new Set(ancestry); next.add(identity);
    const assignedTask = session.agentPath && assignedTaskByAgentPath.get(session.agentPath);
    const localAt = Date.parse(session.currentTaskAt), assignedAt = Date.parse(assignedTask?.timestamp);
    const useAssignment = assignedTask && (!session.currentTask || !Number.isFinite(localAt) || Number.isFinite(assignedAt) && assignedAt >= localAt);
    const taskSession = assignedTask ? { ...session, originalAssignment: (originalAssignments.get(session.agentPath) || assignedTask).task,
      ...(useAssignment ? { currentTask: assignedTask.task, currentTaskAt: assignedTask.timestamp, taskSource: assignedTask.kind === 'followup' ? 'parent_followup' : 'parent_spawn' } : { taskSource: 'local' }) }
      : session.currentTaskAt ? { ...session, taskSource: 'local' } : session;
    const displayedSession = taskSession.agentPath && completionApplies(taskSession)
      ? { ...taskSession, status: 'completed', attentionState: 'completed', attentionDetail: 'Task completed (agent report received)', completionSource: 'agent_report' }
      : taskSession;
    const descendants = childSessionsFor(session);
    if (ancestry.size >= maxDepth && descendants.length) onLimit();
    const childNodes = ancestry.size >= maxDepth ? [] : descendants.map((child) => make(child, next)).filter(Boolean);
    const delegated = displayedSession.status === 'completed' && childNodes.some((child) => ['active', 'waiting', 'starting', 'delegating'].includes(child.session.status));
    return { session: delegated ? { ...displayedSession, status: 'delegating', attentionState: 'running', attentionDetail: 'Delegating to active subagent(s)' } : displayedSession, children: childNodes };
  };
  return roots.sort(compareSessions).map((root) => make(root)).filter(Boolean);
}

module.exports = { buildSessionForest, compareSessions };
