'use strict';

const { createFileIssues } = require('../file-issues');

const fs = require('node:fs/promises');
const path = require('node:path');
const { createIngestion } = require('../ingestion');
const { createImageOmitter } = require('./codex-images');
const { resourceLimits, limitError } = require('../limits');
const { commandCategory, callDetails, resultDetails, runningProcesses } = require('../tool-details');

const SUPPORTED_VERSION_PREFIXES = ['0.160.', '0.162.', '0.164.', '0.166.'];

function transcriptRoot(env = process.env, home = require('node:os').homedir()) {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
}

const TOOL_LABELS = {
  read: 'Read',
  view_image: 'View image',
  exec: 'Exec',
  exec_command: 'Exec',
  apply_patch: 'Apply patch',
  write_stdin: 'Write to process',
  wait: 'Wait',
  wait_agent: 'Wait for agent',
  spawn_agent: 'Spawn agent',
  send_message: 'Send message',
  search_query: 'Web search',
  web_search_call: 'Web search'
};

function toolLabel(name, input) {
  const shortName = String(name || '').split('.').at(-1).toLowerCase();
  const base = TOOL_LABELS[shortName] || shortName.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  const category = ['exec', 'exec_command'].includes(shortName) ? commandCategory(input) : undefined;
  return category ? `${base} · ${category}` : base;
}

function eventFrom(record) {
  return record.type === 'event_msg' ? record.payload?.type : record.payload?.event?.type;
}

function toolFrom(record, context) {
  const item = record.payload;
  if (record.type !== 'response_item' || !item) return undefined;
  const directCall = ['custom_tool_call', 'function_call', 'web_search_call', 'tool_search_call'].includes(item.type);
  const genericCall = item.type === 'tool_call' && (item.name || item.function?.name || item.tool?.name);
  if (!directCall && !genericCall) return undefined;
  const name = item.name || item.function?.name || item.tool?.name || item.type;
  const input = item.input ?? item.arguments ?? item.function?.arguments ?? item.tool?.input;
  const details = callDetails(name, input, context);
  return { id: item.call_id || item.tool_call_id || item.id, name, label: toolLabel(name, input), status: item.status, ...(Object.keys(details).length ? { details } : {}) };
}

function toolOutputFrom(record) {
  const item = record.payload;
  if (record.type !== 'response_item' || !item) return undefined;
  const knownOutput = ['custom_tool_call_output', 'function_call_output', 'tool_search_output'].includes(item.type);
  if (!knownOutput && item.type !== 'tool_output') return undefined;
  const id = item.call_id || item.tool_call_id || item.id;
  return id ? { id, payload: item } : undefined;
}

function tokenUsageFrom(record) {
  const usage = record.type === 'token_usage_record'
    ? record.payload?.thread_token_usage || record.payload?.turn_token_usage || record.payload?.usage
    : eventFrom(record) === 'token_count' ? record.payload?.info?.total_token_usage : undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const readCount = (name) => Number.isFinite(usage[name]) && usage[name] >= 0 ? usage[name] : undefined;
  const input = readCount('input_tokens');
  const cachedInput = readCount('cached_input_tokens');
  const output = readCount('output_tokens');
  return input === undefined && cachedInput === undefined && output === undefined ? undefined : { input, cachedInput, output };
}

function transcriptCompatibility(records, cliVersion) {
  const supportedPrefix = SUPPORTED_VERSION_PREFIXES.find((prefix) => cliVersion.startsWith(prefix));
  if (supportedPrefix) return { level: 'supported', resolution: `Verified parser for the ${supportedPrefix.slice(0, -1)} transcript family` };
  const recognizable = records.some((record) => ['task_started', 'task_complete', 'turn_aborted'].includes(eventFrom(record)) || Boolean(toolFrom(record)) || Boolean(toolOutputFrom(record)));
  if (recognizable) return {
    level: 'best_effort', detail: `Best effort: unverified Codex transcript version ${cliVersion || 'unknown'}`,
    resolution: 'Generic adapters recognized lifecycle or tool-call records'
  };
  return {
    level: 'unsupported', detail: `Unrecognized Codex transcript schema for version ${cliVersion || 'unknown'}`,
    resolution: 'No recognized lifecycle or tool-call records'
  };
}

function terminalToolStatus(output, details) {
  // Output records differ between built-in and custom tools. Keep the raw
  // output private, but retain the one fact the UI needs: did it work?
  const status = String(output?.status || output?.result?.status || '').toLowerCase();
  if (output?.is_error || details?.failure || ['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return 'completed';
}

function attentionFrom({ status, currentTool, lastTool, terminalError, modelContinuedAfterTool }) {
  // A transcript does not have a generic "waiting for approval" event.  Only
  // label an agent as awaiting input when its outstanding tool explicitly
  // asks for it; otherwise it is simply waiting on a running tool.
  if (status === 'stale') return { state: 'stalled', detail: 'Transcript has stopped updating' };
  if (terminalError) return { state: 'failed', detail: terminalError };
  // A normal task completion is authoritative: earlier failed tool attempts
  // remain in the timeline, but must not leave the session card marked failed.
  if (status === 'completed') return { state: 'completed', detail: 'Task completed' };
  if (currentTool) {
    const name = String(currentTool.name || 'tool');
    if (/(request_?user_?input|user_?input|approval|permission)/i.test(name)) {
      return { state: 'waiting', detail: `Awaiting input or approval: ${name}` };
    }
    return { state: 'waiting', detail: `Waiting for tool: ${name}` };
  }
  if (lastTool?.status === 'failed' && !modelContinuedAfterTool) return { state: 'failed', detail: `Last tool failed: ${lastTool.name}` };
  if (status === 'active' || status === 'delegating') return { state: 'running', detail: status === 'delegating' ? 'Delegating to active subagent(s)' : 'Working' };
  if (status === 'starting') return { state: 'waiting', detail: 'Waiting for transcript' };
  return { state: 'unknown', detail: 'No reliable activity state' };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
  return '';
}

function compactTask(content, limit = 160) {
  // Remove known runtime envelopes without discarding a request after them.
  const text = contentText(content)
    .replace(/<(environment_context|skills_instructions|external_codex_apps_open_page|codex_apps_open_page_instructions|turn_aborted)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\s+/g, ' ').trim();
  if (!text || /^# AGENTS\.md instructions\b/i.test(text)
    || /^The following is (?:the )?Codex agent history whose request action you are assessing\b/i.test(text)) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

// Progress is intentionally separate from the originating task: it is the
// latest display-safe assistant commentary, with timeline activity as fallback.
function compactProgress(content, limit = 180) {
  const text = contentText(content).replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<environment_context>') || text.startsWith('<skills_instructions>')) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function progressFromTimeline(timeline) {
  const event = timeline.at(-1);
  if (!event) return undefined;
  const text = event.kind === 'tool' ? `${event.status === 'in_progress' ? 'Using' : 'Finished'} tool: ${event.label}` : event.label;
  return { text, timestamp: event.completedAt || event.timestamp, source: event.kind };
}

function createTranscriptReducer(file, overrides) {
  const bounds = resourceLimits(overrides);
  let meta, recordCount = 0, recognized = false, historyStart = 0;
  let subagentCreatedAt;
  let turnActive = false;
  let currentTurnId;
  let turnStartedAt;
  let sawLifecycle = false;
  let lastTool;
  let modelContinuedAfterTool = false;
  const openTools = new Map();
  const processes = new Map();
  const toolHistory = [];
  const toolEntriesByCallId = new Map();
  // Keep a deliberately small, display-safe event stream.  It contains no
  // tool arguments or outputs, only the milestones needed for an at-a-glance
  // activity timeline in the observer.
  const activityTimeline = [];
  const timelineToolsByCallId = new Map();
  let lastActivity;
  const spawnCalls = new Map();
  const spawnedAgentPaths = new Set();
  const spawnedAgents = [], followupAssignments = new Map();
  const completedAgentPaths = new Set();
  const agentObservations = new Map();
  const agentReports = new Map();
  let reportedEdges = 0;
  let currentTask, currentTaskAt;
  let currentProgress;
  let tokenUsage;
  let childThreadUsage;
  let terminalError;
  const closeTools = (status, timestamp) => {
    for (const [id, tool] of openTools) {
      tool.status = status; tool.completedAt = timestamp;
      const timeline = timelineToolsByCallId.get(id);
      if (timeline) { timeline.status = status; timeline.completedAt = timestamp; }
      if (!toolHistory.includes(tool)) { toolEntriesByCallId.delete(id); timelineToolsByCallId.delete(id); }
    }
    openTools.clear();
    processes.clear();
  };
  const finishTool = (tool, status, timestamp) => {
    openTools.delete(tool.id);
    tool.status = status; tool.completedAt = timestamp;
    if (tool === lastTool) modelContinuedAfterTool = false;
    const timeline = timelineToolsByCallId.get(tool.id);
    if (timeline) { timeline.status = status; timeline.completedAt = timestamp; }
    if (!toolHistory.includes(tool)) { toolEntriesByCallId.delete(tool.id); timelineToolsByCallId.delete(tool.id); }
  };
  const observeAgent = (agentPath, status, timestamp, direct = true) => {
    agentObservations.set(agentPath, { agentPath, status, timestamp });
    if (direct) {
      if (status === 'completed') completedAgentPaths.add(agentPath);
      else completedAgentPaths.delete(agentPath);
    }
  };
  const push = record => {
    const index = recordCount++;
    if (!meta && record.type === 'session_meta') {
      const value = record.payload || {};
      meta = Object.fromEntries(['session_id', 'id', 'cwd', 'cli_version', 'agent_path', 'agent_nickname', 'parent_thread_id', 'subagent_history_start_ordinal'].map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 4096) : Number.isSafeInteger(value[key]) ? value[key] : undefined]));
      meta.source = { subagent: { other: value.source?.subagent?.other === 'guardian' ? 'guardian' : undefined } };
      subagentCreatedAt = meta.agent_path ? Date.parse(value.timestamp || record.timestamp) : undefined;
      historyStart = meta?.agent_path && Number.isInteger(meta.subagent_history_start_ordinal) && meta.subagent_history_start_ordinal >= 0 ? meta.subagent_history_start_ordinal + 1 : 0;
    }
    if (['task_started', 'task_complete', 'turn_aborted'].includes(eventFrom(record)) || toolFrom(record) || toolOutputFrom(record)) recognized = true;
    // Some child rollouts have a history ordinal beyond their own records.
    // Explicit thread identity still proves these counts belong to the child,
    // independently of the fork boundary used for tools and lifecycle events.
    if (meta?.agent_path && meta.id && record.type === 'token_usage_record' && record.payload?.thread_id === meta.id) {
      const usage = tokenUsageFrom(record);
      if (usage) childThreadUsage = usage;
    }
    if (!meta || index < historyStart) return;
    if (record.timestamp) lastActivity = record.timestamp;
    const event = eventFrom(record);
    const execution = record.type === 'event_msg' && event === 'item_completed' && record.payload?.item;
    if (execution?.type === 'CommandExecution') {
      const processId = String(execution.process_id || '');
      const entry = processes.get(processId);
      if (entry) {
        processes.delete(processId);
        const seconds = execution.duration?.secs, nanos = execution.duration?.nanos;
        const elapsed = Number.isSafeInteger(seconds) && seconds >= 0 && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9 ? seconds + nanos / 1e9 : undefined;
        const outcome = { exit_code: execution.exit_code, duration_ms: elapsed === undefined ? undefined : elapsed * 1000, status: execution.status };
        entry.details = resultDetails(entry.name, outcome, entry.details);
        if (![...processes.values()].includes(entry)) finishTool(entry, terminalToolStatus(outcome, entry.details), record.timestamp);
      }
    }
    const lifecycle = record.type === 'event_msg' ? record.payload : record.payload?.event;
    const turnId = lifecycle?.turn_id;
    if (event === 'task_started' && !(turnActive && turnId && turnId === currentTurnId)) {
      closeTools('cancelled', record.timestamp);
      turnActive = true; currentTurnId = turnId; turnStartedAt = record.timestamp; sawLifecycle = true;
      // A transcript can contain many turns. A failure in an earlier one must
      // not make a later, newly-started task look failed.
      lastTool = undefined;
      modelContinuedAfterTool = false;
      terminalError = undefined;
      currentProgress = undefined;
      activityTimeline.push({ kind: 'task', label: 'Task started', timestamp: record.timestamp });
    }
    if ((event === 'task_complete' || event === 'turn_aborted') && !(turnId && currentTurnId && turnId !== currentTurnId)) {
      turnActive = false; sawLifecycle = true;
      closeTools(event === 'turn_aborted' ? 'cancelled' : 'unknown', record.timestamp);
      if (lifecycle?.error?.message) terminalError = 'Task failed';
      else if (event === 'turn_aborted') terminalError = 'Task was interrupted';
      activityTimeline.push({ kind: event === 'turn_aborted' ? 'aborted' : 'completed', label: event === 'turn_aborted' ? 'Task aborted' : 'Task completed', timestamp: record.timestamp });
    }
    if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user') {
      // Forked history can be replayed with fresh record timestamps and no
      // history-start ordinal. Its original message creation time still proves
      // that these user prompts predate this child and belong to the parent.
      const created = record.payload.internal_chat_message_metadata_passthrough?.create_time;
      const originalAt = Number.isFinite(created) ? created * 1000 : Date.parse(record.timestamp);
      const inherited = meta.agent_path && Number.isFinite(subagentCreatedAt) && originalAt < subagentCreatedAt;
      const task = !inherited && compactTask(record.payload.content);
      if (task) { currentTask = task; currentTaskAt = record.timestamp; }
    }
    if (record.type === 'response_item' && record.payload?.type === 'agent_message' && meta.agent_path
      && record.payload.recipient === meta.agent_path && record.payload.author === path.posix.dirname(meta.agent_path)) {
      const text = contentText(record.payload.content);
      const envelope = text.match(/^Message Type: NEW_TASK\r?\nTask name: ([^\r\n]+)\r?\nSender: ([^\r\n]+)\r?\nPayload:[ \t]*\r?\n/);
      if (envelope && envelope[1] === meta.agent_path && envelope[2] === record.payload.author) {
        const assignment = text.slice(envelope[0].length).trim();
        // An encrypted payload is not a displayable task. Clear inherited
        // prompts so the parent's recorded assignment/name can supply it.
        currentTask = assignment.startsWith('gAAAA') ? undefined : compactTask(assignment);
        currentTaskAt = record.timestamp;
      }
    }
    if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'assistant') {
      const text = compactProgress(record.payload.content);
      if (text) currentProgress = { text, timestamp: record.timestamp, source: 'assistant' };
    }
    // A command error can be a recoverable step inside an active turn. New
    // reasoning or assistant output proves the model continued afterward;
    // bookkeeping records alone do not. Keep the failed tool in its history.
    const modelActivity = record.type === 'response_item' && (record.payload?.type === 'reasoning'
      || record.payload?.type === 'message' && record.payload.role === 'assistant');
    if (turnActive && modelActivity && !(Date.parse(record.timestamp) < Date.parse(lastTool?.completedAt))) modelContinuedAfterTool = true;
    const recordedUsage = tokenUsageFrom(record);
    if (recordedUsage) tokenUsage = recordedUsage;
    const tool = toolFrom(record, { cwd: meta.cwd });
    if (tool) {
      // A completed call envelope means the model finished emitting the request.
      // Execution stays pending until its matching output or a turn boundary.
      const inferredRunning = ['function_call', 'custom_tool_call', 'tool_call'].includes(record.payload?.type)
        && (!tool.status || tool.status === 'completed');
      const normalized = { ...tool, status: inferredRunning || tool.status === 'in_progress' ? 'in_progress' : tool.status || 'completed' };
      const entry = { ...normalized, timestamp: record.timestamp, startedAt: record.timestamp };
      toolHistory.push(entry);
      toolEntriesByCallId.set(entry.id, entry);
      const timelineEntry = { kind: 'tool', label: normalized.name, status: entry.status, timestamp: record.timestamp };
      activityTimeline.push(timelineEntry);
      timelineToolsByCallId.set(entry.id, timelineEntry);
      lastTool = entry;
      modelContinuedAfterTool = false;
      if (normalized.status === 'in_progress') openTools.set(normalized.id, entry);
    }
    const toolOutput = toolOutputFrom(record);
    if (toolOutput) {
      const entry = toolEntriesByCallId.get(toolOutput.id);
      if (entry) {
        const details = resultDetails(entry.name, toolOutput.payload, entry.details);
        if (Object.keys(details).length) entry.details = details;
        if (entry.status === 'in_progress') for (const processId of runningProcesses(entry.name, toolOutput.payload)) {
          if (!processes.has(processId)) processes.set(processId, entry);
        }
        if ([...processes.values()].includes(entry)) {
          entry.status = 'in_progress'; openTools.set(entry.id, entry);
        } else finishTool(entry, terminalToolStatus(toolOutput.payload, details), record.timestamp);
      }
      const timelineEntry = timelineToolsByCallId.get(toolOutput.id);
      if (timelineEntry) {
        timelineEntry.status = entry?.status || terminalToolStatus(toolOutput.payload);
        if (!entry || entry.completedAt) timelineEntry.completedAt = entry?.completedAt || record.timestamp;
      }
    }
    if (record.type === 'response_item' && record.payload?.type === 'function_call' && record.payload.namespace === 'collaboration' && record.payload.name === 'spawn_agent') {
      try {
        const args = typeof record.payload.arguments === 'string' ? JSON.parse(record.payload.arguments) : record.payload.arguments;
        if (typeof args?.task_name === 'string') {
          const message = typeof args.message === 'string' && !args.message.startsWith('gAAAA') ? compactTask(args.message) : undefined;
          spawnCalls.set(record.payload.call_id, { taskName: args.task_name, message, timestamp: record.timestamp });
        }
      } catch { /* Ignore malformed tool arguments. */ }
    }
    if (record.type === 'response_item' && record.payload?.type === 'function_call' && record.payload.namespace === 'collaboration' && record.payload.name === 'followup_task') {
      try {
        const args = typeof record.payload.arguments === 'string' ? JSON.parse(record.payload.arguments) : record.payload.arguments;
        const matches = typeof args?.target === 'string' ? [...spawnedAgentPaths].filter(agentPath => agentPath === args.target || agentPath.endsWith('/' + args.target)) : [];
        const agentPath = args?.target?.startsWith('/') ? args.target : matches.length === 1 ? matches[0] : undefined;
        const task = typeof args?.message === 'string' && !args.message.startsWith('gAAAA') ? compactTask(args.message) : undefined;
        if (agentPath && task) spawnCalls.set(record.payload.call_id, { followup: true, agentPath, task, timestamp: record.timestamp });
      } catch { /* Ignore malformed or unresolved follow-up targets. */ }
    }
    if (record.type === 'response_item' && record.payload?.type === 'function_call_output' && spawnCalls.has(record.payload.call_id)) {
      try {
        const result = typeof record.payload.output === 'string' ? JSON.parse(record.payload.output) : record.payload.output;
        const assignment = spawnCalls.get(record.payload.call_id);
        if (assignment.followup && result?.isError !== true && result?.is_error !== true && result?.status !== 'error') {
          followupAssignments.set(assignment.agentPath, { agentPath: assignment.agentPath, task: assignment.task, timestamp: assignment.timestamp || record.timestamp, kind: 'followup' });
        } else if (!assignment.followup && typeof result?.task_name === 'string') {
          spawnedAgentPaths.add(result.task_name);
          const spawn = spawnCalls.get(record.payload.call_id);
          spawnedAgents.push({ agentPath: result.task_name, task: spawn.message || `Assigned subtask: ${spawn.taskName.replace(/[_-]/g, ' ')}`, timestamp: spawn.timestamp || record.timestamp });
          activityTimeline.push({ kind: 'delegation', label: `Delegated to ${result.task_name.split('/').filter(Boolean).pop() || result.task_name}`, timestamp: record.timestamp, target: result.task_name });
        }
      } catch { /* A failed spawn has no graph edge. */ }
      spawnCalls.delete(record.payload.call_id);
    }
    // Ordinary inter-agent messages are progress, not terminal responses.
    // Only an explicit final envelope (or a relay completion marker) can end
    // a child for which no authoritative local lifecycle is available.
    if (record.type === 'response_item' && record.payload?.type === 'agent_message' && record.payload.author) {
      const author = record.payload.author;
      const relays = [...contentText(record.payload.content).matchAll(/\[codex-observer\]\s+(spawn|complete)\s+(\/[^\s`]+)/g)];
      if (relays.length) {
        const report = agentReports.get(author) || { agentPath: author, spawnedAgentPaths: new Set(), completedAgentPaths: new Set() };
        for (const [, action, agentPath] of relays) {
          const paths = action === 'spawn' ? report.spawnedAgentPaths : report.completedAgentPaths;
          if (!paths.has(agentPath)) reportedEdges++;
          paths.add(agentPath);
          observeAgent(agentPath, action === 'complete' ? 'completed' : 'active', record.timestamp, false);
        }
        agentReports.set(author, report);
      }
      const agentPath = meta.agent_path || '/root';
      if (author.startsWith(agentPath + '/')) {
        const messageType = record.payload.message_type || contentText(record.payload.content).match(/^\s*Message Type:\s*(FINAL_ANSWER|MESSAGE)\s*(?:\r?\n|$)/)?.[1];
        if (!relays.length || messageType === 'FINAL_ANSWER') {
          observeAgent(author, messageType === 'FINAL_ANSWER' ? 'completed' : 'active', record.timestamp);
        }
      }
    }
  }
  const snapshot = stat => {
    const mtime = stat?.mtime?.toISOString();
    if (!meta) return { file, unsupportedReason: 'Missing session_meta record', lastActivity: mtime };
    const compatibility = transcriptCompatibility(recognized ? [{ type: 'event_msg', payload: { type: 'task_started' } }] : [], String(meta.cli_version || ''));
    if (compatibility.level === 'unsupported') return { file, id: meta.session_id || meta.id, cwd: meta.cwd, lastActivity: mtime, cliVersion: meta.cli_version, supportLevel: compatibility.level, compatibilityResolution: compatibility.resolution, unsupportedReason: compatibility.detail };
    const currentTool = [...openTools.values()].at(-1);
    const status = turnActive ? (currentTool ? 'waiting' : 'active') : (sawLifecycle ? 'completed' : 'unknown');
    const attention = attentionFrom({ status, currentTool, lastTool, terminalError, modelContinuedAfterTool });
    return {
      file,
      id: meta.session_id || meta.id,
      parentId: meta.parent_thread_id,
      agentName: meta.agent_nickname || meta.agent_path?.split('/').pop(),
      agentPath: meta.agent_path,
      spawnedAgentPaths: [...spawnedAgentPaths],
      spawnedAgents: [...spawnedAgents, ...followupAssignments.values()],
      completedAgentPaths: [...completedAgentPaths],
      agentObservations: [...agentObservations.values()],
      agentReports: [...agentReports.values()].map((report) => ({ ...report, spawnedAgentPaths: [...report.spawnedAgentPaths], completedAgentPaths: [...report.completedAgentPaths] })),
      cwd: meta.cwd,
      cliVersion: meta.cli_version,
      supportLevel: compatibility.level,
      compatibilityDetail: compatibility.detail,
      compatibilityResolution: compatibility.resolution,
      lastActivity: lastActivity || stat?.mtime.toISOString(),
      status,
      hasLifecycle: sawLifecycle, currentTurnId, turnStartedAt,
      attentionState: attention.state,
      attentionDetail: attention.detail,
      lastTool,
      currentTool,
      toolHistory: toolHistory.slice(-100),
      activityTimeline: activityTimeline.slice(-100),
      currentTask, currentTaskAt,
      currentProgress: currentProgress || progressFromTimeline(activityTimeline),
      // Generic token_count events in a child can contain parent totals. Prefer
      // its explicitly identified thread usage whenever it is available.
      tokenUsage: childThreadUsage || tokenUsage,
      recordCount
    };
  };
  return { push(record) {
    push(record);
    while (toolHistory.length > 100) { const old = toolHistory.shift(); timelineToolsByCallId.delete(old.id); if (!openTools.has(old.id)) toolEntriesByCallId.delete(old.id); }
    while (activityTimeline.length > 100) activityTimeline.shift();
    if ([openTools, processes, spawnCalls, followupAssignments, toolEntriesByCallId, timelineToolsByCallId, spawnedAgentPaths, completedAgentPaths, agentObservations, agentReports].some(collection => collection.size > bounds.maxStateEntries) || spawnedAgents.length > bounds.maxStateEntries || reportedEdges > bounds.maxStateEntries) throw limitError('STATE_LIMIT');
  }, snapshot(stat) { return structuredClone(snapshot(stat)); }, memory() { return Buffer.byteLength(JSON.stringify(snapshot())) + (openTools.size + processes.size + spawnCalls.size) * 512; }, get guardian() { return meta?.source?.subagent?.other === 'guardian'; } };
}

function summarizeTranscript(records, file, stat) {
  const reducer = createTranscriptReducer(file);
  for (const record of records) reducer.push(record);
  return reducer.snapshot(stat);
}

// Each observer owns a separate adapter instance and cache. Only reduced session
// summaries leave this harness; root scope and time-based UI policy live upstream.
function create({ roots = [], limits, indexFile, indexVersion } = {}) {
  const bounds = resourceLimits(limits), reader = createIngestion(limits, { createProjection: createImageOmitter, indexFile, indexVersion, resumable: true, resumableScanBytes: 64 * 1024 * 1024 });
  const modificationTimes = new Map(), fileSizes = new Map();
  return { knowsFile: file => reader.has(file), async close() { await reader.saveIndex({ force: true }); }, async scan({ signal, onProgress, knownUnchanged } = {}) {
    await reader.loadIndex();
    reader.beginScan();
    const files = new Set(), provenance = new Map(), sources = [], sessions = [];
    let unreadable = 0; const diagnostics = new Set();
    const fileIssues = createFileIssues();
    const walk = async (directory, budget) => {
      signal?.throwIfAborted();
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => b.name.localeCompare(a.name))) {
        if (budget.discovered >= budget.discoveryLimit) { diagnostics.add('INGESTION_LIMIT'); budget.limited = true; return; }
        const file = path.join(directory, entry.name);
        // Directory and file symlinks are never followed inside a store.
        if (entry.isDirectory()) {
          try { await walk(file, budget); } catch (error) { signal?.throwIfAborted(); unreadable++; budget.unreadable = true; }
        } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) && !provenance.has(file)) {
          budget.candidates.push(file); provenance.set(file, budget.directory); budget.discovered++;
        }
      }
    };
    const stores = [...new Set(roots)];
    for (const [index, directory] of stores.entries()) {
      const capacity = Math.floor(bounds.maxFiles / stores.length) + Number(index < bounds.maxFiles % stores.length);
      // Bound discovery separately from ingestion so long-running sessions in
      // older date directories can compete for the available file slots.
      const budget = { candidates: [], discovered: 0, discoveryLimit: Math.min(65536, Math.max(1024, bounds.maxFiles * 16)), limited: false, directory };
      try {
        await walk(directory, budget);
        for (let offset = 0; offset < budget.candidates.length; offset += 64) {
          signal?.throwIfAborted();
          await Promise.all(budget.candidates.slice(offset, offset + 64).map(async file => {
            if (knownUnchanged?.(file) && modificationTimes.has(file)) return;
            try { const stat = await fs.lstat(file); modificationTimes.set(file, stat.isFile() && !stat.isSymbolicLink() ? stat.mtimeMs : 0); fileSizes.set(file, stat.size); }
            catch { modificationTimes.set(file, 0); fileSizes.set(file, Infinity); }
          }));
        }
        budget.candidates.sort((a, b) => (modificationTimes.get(b) || 0) - (modificationTimes.get(a) || 0) || b.localeCompare(a));
        if (budget.candidates.length > capacity) { diagnostics.add('INGESTION_LIMIT'); budget.limited = true; }
        for (const file of budget.candidates.slice(0, capacity)) files.add(file);
        sources.push({ directory, provider: 'codex', status: budget.limited ? 'limited' : budget.unreadable ? 'unreadable' : 'ready' });
      } catch (error) { signal?.throwIfAborted(); sources.push({ directory, provider: 'codex', status: error.code === 'ENOENT' ? 'missing' : 'unreadable' }); }
    }
    for (const file of modificationTimes.keys()) if (!provenance.has(file)) { modificationTimes.delete(file); fileSizes.delete(file); }
    const recentCutoff = Date.now() - 10 * 60 * 1000;
    const priority = file => {
      const recent = (modificationTimes.get(file) || 0) >= recentCutoff;
      return recent ? (fileSizes.get(file) <= 32 * 1024 * 1024 ? 0 : 1) : 2;
    };
    // Quickly surface other recently active sessions before a very large
    // transcript consumes the scan budget; older history follows both.
    const orderedFiles = [...files].sort((a, b) => priority(a) - priority(b) || (modificationTimes.get(b) || 0) - (modificationTimes.get(a) || 0) || b.localeCompare(a));
    for (const file of orderedFiles) {
      signal?.throwIfAborted();
      try {
        const entry = await reader.read(file, () => createTranscriptReducer(file, limits), { signal, knownUnchanged: knownUnchanged?.(file) });
        if (!entry.guardian) sessions.push({ ...entry.value, sourceDirectory: provenance.get(file), provider: 'codex', providerLabel: 'Codex' });
      } catch (error) {
        signal?.throwIfAborted();
        if (error.code !== 'INGESTION_LIMIT') { unreadable++; fileIssues.add(file, error); if (error.code?.endsWith('LIMIT')) diagnostics.add(error.code); }
        const known = error.code !== 'ENOENT' && reader.lastKnown(file);
        if (known && !known.guardian) sessions.push({ ...known.value, sourceDirectory: provenance.get(file), provider: 'codex', providerLabel: 'Codex', observationStale: true, currentTool: undefined });
      } finally { onProgress?.(); }
    }
    reader.prune(files);
    await reader.saveIndex();
    return { sessions, sources, unreadable, ...(reader.deferredCount ? { deferredFiles: reader.deferredCount } : {}), ...(reader.progress ? { loadProgress: reader.progress } : {}), ...fileIssues.snapshot(), ...(diagnostics.size ? { diagnostics: [...diagnostics] } : {}) };
  } };
}

function defaultRoots(rootFolder) {
  return [transcriptRoot(), path.join(rootFolder, '.codex', 'sessions')];
}

module.exports = {
  id: 'codex', label: 'Codex', configKey: 'sessionRoots', cliFlag: '--sessions',
  cliDescription: 'Codex transcript store (repeat for multiple stores)', defaultRoots, create,
  SUPPORTED_VERSION_PREFIXES, transcriptRoot, summarizeTranscript, compactTask, compactProgress, toolLabel, transcriptCompatibility
};
