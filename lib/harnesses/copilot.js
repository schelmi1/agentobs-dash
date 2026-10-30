'use strict';

const { createFileIssues } = require('../file-issues');

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { parseJsonc } = require('../json-lines');
const { createIngestion } = require('../ingestion');
const { createStringLimiter } = require('./copilot-strings');
const { resourceLimits, limitError } = require('../limits');
const { callDetails, resultDetails } = require('../tool-details');

function copilotStorageRoots(env = process.env, home = os.homedir(), platform = process.platform) {
  const base = platform === 'darwin' ? path.join(home, 'Library/Application Support')
    : platform === 'win32' ? env.APPDATA || path.join(home, 'AppData/Roaming')
      : env.XDG_CONFIG_HOME || path.join(home, '.config');
  const products = ['Code', 'Code - Insiders'];
  return products.map(product => path.join(base, product, 'User/workspaceStorage'));
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const iso = value => {
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8640000000000000 ? new Date(milliseconds).toISOString() : undefined;
};
const text = (value, limit = 240) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : undefined;
const localPath = value => {
  try { return typeof value === 'string' && value.startsWith('file:') ? fileURLToPath(value) : path.isAbsolute(value || '') ? value : undefined; }
  catch { return undefined; }
};
const namespace = id => 'copilot-vscode:' + id;
const agentTool = name => /(?:run[_-]?subagent|run[_-]?agent|^task$)/i.test(name || '');

function replayChatSession(records, state, { clone = true } = {}) {
  for (const entry of records) {
    if (entry.kind === 0) {
      if (!object(entry.v)) throw new Error('Invalid initial chat state');
      state = clone ? structuredClone(entry.v) : entry.v;
      continue;
    }
    if (!state || ![1, 2, 3].includes(entry.kind) || !Array.isArray(entry.k) || !entry.k.length
      || entry.k.some(key => !['string', 'number'].includes(typeof key) || ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new Error('Invalid chat mutation');
    }
    let target = state;
    for (const key of entry.k.slice(0, -1)) {
      if (!Object.hasOwn(target, key) || !object(target[key]) && !Array.isArray(target[key])) throw new Error('Missing mutation path');
      target = target[key];
    }
    const key = entry.k.at(-1);
    if (entry.kind === 1) target[key] = clone ? structuredClone(entry.v) : entry.v;
    else if (entry.kind === 3) delete target[key];
    else {
      const array = target[key] ?? [];
      if (!Array.isArray(array) || entry.v !== undefined && !Array.isArray(entry.v)
        || entry.i !== undefined && (count(entry.i) === undefined || entry.i > array.length)) throw new Error('Invalid array mutation');
      if (entry.i !== undefined) array.length = entry.i;
      for (const item of entry.v || []) array.push(clone ? structuredClone(item) : item);
      target[key] = array;
    }
  }
  return state;
}

// All three VS Code formats meet here. Only normalized, safe summaries leave it.
function summarizeCopilot({ id, cwd, chat, transcript = [], debug = [], file, parentId, name, missing = false, reduced = false }) {
  const timeline = [], tools = new Map(), events = [];
  let task, taskAt, progress, status = missing ? 'starting' : 'unknown', failure, version, lastActivity, turnStartedAt, needsInput = false;
  const beginRequest = at => {
    status = 'active'; failure = undefined; needsInput = false; turnStartedAt = at;
    for (const tool of tools.values()) if (tool.status === 'in_progress' && tool.startedAt < at) {
      tool.status = 'interrupted'; tool.completedAt = at;
    }
  };
  const usage = {};
  const addUsage = value => {
    for (const field of ['input', 'cachedInput', 'output']) if (count(value[field]) !== undefined) usage[field] = (usage[field] || 0) + value[field];
  };
  const safeTool = (toolId, toolName, input, timestamp, completedAt, failed, output, safeDetails, safeResult) => {
    if (typeof toolName !== 'string' || !toolName || typeof toolId !== 'string') return;
    const canonical = /^(run_in_terminal|terminal)$/i.test(toolName) ? 'exec_command' : toolName;
    const details = reduced && safeDetails ? safeDetails : callDetails(canonical, input, { cwd });
    const label = toolName.replace(/[_-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    const previous = tools.get(toolId);
    const tool = previous || { id: toolId, name: toolName, label, startedAt: timestamp, timestamp, status: 'in_progress', details };
    if (completedAt) {
      tool.completedAt = completedAt; tool.status = failed ? 'failed' : 'completed';
      tool.details = reduced && safeResult ? { ...tool.details, ...safeResult } : resultDetails(toolName, { output, ...(failed ? { is_error: true } : {}) }, tool.details);
      const duration = Date.parse(completedAt) - Date.parse(tool.startedAt);
      if (Number.isFinite(duration) && duration >= 0) tool.details.durationMs = duration;
    }
    tools.set(toolId, tool);
    return tool;
  };

  if (chat) {
    cwd = localPath(chat.workingDirectory) || cwd;
    lastActivity = iso(chat.creationDate);
    for (const request of Array.isArray(chat.requests) ? chat.requests : []) {
      if (!object(request)) continue;
      const at = iso(request.timestamp) || lastActivity;
      const done = iso(request.modelState?.completedAt) || iso(request.responseTimestamp) || at;
      const state = request.modelState?.value;
      events.push({ at, order: 0, apply() {
        if (text(request.message?.text)) { task = text(request.message.text); taskAt = at; } beginRequest(at);
        timeline.push({ kind: 'task', label: 'Task started', timestamp: at });
      } });
      for (const [index, part] of (Array.isArray(request.response) ? request.response : []).entries()) {
        if (part?.kind !== 'toolInvocationSerialized') continue;
        const complete = part.isComplete === true;
        const startedAt = iso(part.startedAt) || at, completedAt = complete ? iso(part.completedAt) || done : undefined;
        events.push({ at: completedAt || startedAt, order: 1, apply() {
          safeTool(part.toolCallId || request.requestId + ':' + index, part.toolId, undefined, startedAt, completedAt, Boolean(part.resultError));
        } });
      }
      if (state !== undefined || request.isCanceled) events.push({ at: done, order: 3, apply() {
        status = [1, 2, 3].includes(state) || request.isCanceled ? 'completed' : 'active';
        needsInput = state === 4;
        failure = state === 3 ? 'Copilot request failed' : state === 2 || request.isCanceled ? 'Copilot request interrupted' : undefined;
      } });
    }
  }

  const seenTranscript = new Set();
  let requestedTools = false;
  for (const entry of transcript) {
    if (entry.id && seenTranscript.has(entry.id)) continue;
    if (entry.id) seenTranscript.add(entry.id);
    const at = iso(entry.timestamp), data = entry.data || {};
    if (!at) continue;
    events.push({ at, order: 2, apply() {
      switch (entry.type) {
        case 'session.start': version = data.copilotVersion; break;
        case 'user.message': if (text(data.content)) { task = text(data.content); taskAt = at; } beginRequest(at); break;
        case 'assistant.turn_start': status = 'active'; failure = undefined; needsInput = false; requestedTools = false; turnStartedAt = at; break;
        case 'assistant.message': progress = text(data.content, 500) || progress; requestedTools = Boolean(data.toolRequests?.length); break;
        case 'tool.execution_start': safeTool(data.toolCallId, data.toolName, data.arguments, at, undefined, false, undefined, data.safeDetails); status = 'active'; break;
        case 'tool.execution_complete': {
          const tool = tools.get(data.toolCallId);
          if (tool) safeTool(tool.id, tool.name, undefined, tool.startedAt, at, data.success === false, data.result?.content, undefined, data.safeResult);
          break;
        }
        case 'assistant.turn_end': if (!requestedTools && ![...tools.values()].some(tool => tool.status === 'in_progress')) status = 'completed'; break;
      }
    } });
  }

  const spans = new Set();
  for (const entry of debug) {
    const key = JSON.stringify([entry.rIdx || 0, entry.spanId, entry.type]);
    if (!entry.spanId || spans.has(key)) continue;
    spans.add(key);
    const at = iso(entry.ts), end = iso(entry.ts + (Number.isFinite(entry.dur) && entry.dur >= 0 ? entry.dur : 0)), attrs = entry.attrs || {};
    if (!at || entry.v !== undefined && entry.v !== 1) continue;
    if (entry.type === 'llm_request') addUsage({ input: attrs.inputTokens, cachedInput: attrs.cachedTokens, output: attrs.outputTokens });
    events.push({ at: end, order: 1, apply() {
      if (entry.type === 'session_start') version = attrs.copilotVersion || version;
      else if (entry.type === 'user_message') { if (text(attrs.content)) { task = text(attrs.content); taskAt = at; } beginRequest(at); }
      else if (entry.type === 'turn_start') { status = 'active'; failure = undefined; needsInput = false; turnStartedAt = at; }
      else if (entry.type === 'turn_end') status = 'completed';
      else if (entry.type === 'tool_call') {
        // OTel span IDs differ from transcript toolCallIds. Keep transcript tools
        // authoritative when present, rather than counting every call twice.
        if (!transcript.some(record => record.type === 'tool.execution_start')) safeTool(entry.spanId, entry.name, attrs.args, at, end, entry.status === 'error', attrs.result, attrs.safeDetails, attrs.safeResult);
      } else if (entry.type === 'error') failure = 'Copilot reported an error';
    } });
  }
  events.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.order - b.order);
  for (const event of events) { event.apply(); if (event.at && (!lastActivity || event.at > lastActivity)) lastActivity = event.at; }
  const toolHistory = [...tools.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  // A terminal turn closes unpaired tools, but cannot assert they succeeded.
  if (status === 'completed') for (const tool of toolHistory) if (tool.status === 'in_progress') tool.status = 'interrupted';
  const currentTool = toolHistory.findLast(tool => tool.status === 'in_progress');
  const lastTool = toolHistory.at(-1);
  if (status !== 'completed' && lastTool?.status === 'failed' && (!turnStartedAt || lastTool.completedAt >= turnStartedAt)) failure ||= 'Last Copilot tool failed';
  const recognized = Boolean(chat || transcript.some(entry => entry.type === 'session.start') || debug.some(entry => entry.type === 'session_start' && (entry.v === undefined || entry.v === 1)));
  return {
    id: namespace(id), provider: 'copilot-vscode', providerLabel: 'Copilot', parentId: parentId ? namespace(parentId) : undefined,
    agentName: name || 'Main agent', shortId: id.slice(0, 8), file, cwd, currentTask: task || text(chat?.customTitle), currentTaskAt: taskAt,
    currentProgress: progress ? { text: progress, timestamp: lastActivity } : undefined,
    status, lastActivity, hasLifecycle: status !== 'unknown', needsInput,
    attentionState: failure ? 'failed' : status === 'completed' ? 'completed' : 'running', attentionDetail: failure,
    currentTool, lastTool, toolHistory: toolHistory.slice(-100),
    activityTimeline: [...timeline, ...toolHistory.map(tool => ({ kind: 'tool', label: tool.name, status: tool.status, timestamp: tool.startedAt }))].slice(-100),
    tokenUsage: Object.keys(usage).length ? usage : undefined,
    cliVersion: version || 'VS Code chat storage', supportLevel: recognized ? 'best_effort' : 'unknown',
    compatibilityResolution: 'VS Code chat mutation logs, transcript v1 and debug spans v1',
    unsupportedReason: recognized ? undefined : 'Unrecognized Copilot session schema'
  };
}

// Project before caching. Unknown fields, raw arguments, prompts and output are
// discarded; replay keeps only fields consumed by the normalized reducer.
function createChatReducer(bounds, json = false) {
  let state, entries = 0;
  const size = value => {
    if (value === undefined) return 0;
    const queue = [value]; let count = 0;
    while (queue.length) {
      const item = queue.pop(); if (++count > bounds.maxStateEntries) throw limitError('STATE_LIMIT');
      if (Array.isArray(item)) { if (item.length > bounds.maxStateEntries) throw limitError('STATE_LIMIT'); queue.push(...item); }
      else if (object(item)) queue.push(...Object.values(item));
    }
    return count;
  };
  const fields = new Set('version sessionId workingDirectory creationDate responderUsername customTitle requests requestId timestamp responseTimestamp isCanceled modelState value completedAt message text agent id extensionId response kind toolCallId toolId isComplete startedAt resultError length'.split(' '));
  const project = value => {
    let entries = 0;
    const visit = (value, key, depth) => {
      if (++entries > bounds.maxStateEntries || depth > 32) throw limitError('STATE_LIMIT');
      if (Array.isArray(value)) return value.map(item => visit(item, key, depth + 1));
      if (object(value)) return Object.fromEntries(Object.entries(value).filter(([name]) => fields.has(name)).map(([name, item]) => [name, visit(item, name, depth + 1)]));
      if (typeof value === 'string') return value.slice(0, key === 'text' ? 500 : key === 'workingDirectory' ? 4096 : 240);
      return typeof value === 'boolean' || typeof value === 'number' || value === null ? value : undefined;
    };
    return visit(value, '', 0);
  };
  return { push(record) {
    if (json) { state = project(parseJsonc(record)); entries = size(state); return; }
    if (!object(record) || ![0, 1, 2, 3].includes(record.kind)) throw new Error('INVALID_MUTATION');
    if (record.kind === 0) { if (!object(record.v)) throw new Error('INVALID_MUTATION'); state = project(record.v); entries = size(state); return; }
    if (!Array.isArray(record.k) || record.k.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('INVALID_MUTATION');
    if (record.k.some(key => typeof key === 'string' && !fields.has(key))) return;
    if (record.k.some(key => typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0 || key > bounds.maxStateEntries))) throw limitError('STATE_LIMIT');
    const value = record.v === undefined ? undefined : project(record.v);
    let target = state;
    for (const key of record.k.slice(0, -1)) target = target?.[key];
    const key = record.k.at(-1), old = target?.[key];
    if (Array.isArray(target) && typeof key === 'number' && key > target.length) throw limitError('STATE_LIMIT');
    let nextSize = record.kind === 3 ? 0 : size(value);
    const arraySlot = Array.isArray(target) && typeof key === 'number';
    if (arraySlot && (record.kind === 3 || value === undefined)) nextSize = 1;
    if (record.kind === 2) {
      if (record.i !== undefined && (!Number.isSafeInteger(record.i) || record.i < 0)) throw limitError('STATE_LIMIT');
      nextSize = size(old || []) - (record.i === undefined ? 0 : (old || []).slice(record.i).reduce((sum, item) => sum + size(item), 0)) + (value || []).reduce((sum, item) => sum + size(item), 0);
    }
    if (Array.isArray(target) && key === 'length') {
      if (!Number.isSafeInteger(value) || value < 0 || value > target.length) throw limitError('STATE_LIMIT');
      entries -= target.slice(value).reduce((sum, item) => sum + size(item), 0);
    } else entries += nextSize - (arraySlot && key < target.length && old === undefined ? 1 : size(old));
    if (entries > bounds.maxStateEntries) throw limitError('STATE_LIMIT');
    state = replayChatSession([{ ...record, v: value }], state, { clone: false });
  }, snapshot() { return state; }, checkpoint() { return { state }; }, restore(saved) {
    if (!object(saved) || !object(saved.state)) throw new Error('INVALID_CHECKPOINT');
    state = saved.state; entries = size(state);
  } };
}

function createEventReducer(kind, cwd, bounds) {
  const events = [], anchors = new Map(), usage = new Map(), seen = new Set(), tools = new Map(), pending = new Map();
  let recordedCwd = cwd;
  const details = (name, args) => callDetails(/^(run_in_terminal|terminal)$/i.test(name) ? 'exec_command' : name, args, { cwd: recordedCwd });
  return { push(record) {
    if (!object(record)) return;
    let safe, key;
    if (kind === 'transcript') {
      const data = record.data || {};
      key = text(record.id);
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      while (seen.size > Math.min(2048, bounds.maxStateEntries)) seen.delete(seen.values().next().value);
      if (record.type === 'session.start') recordedCwd = localPath(data.context?.cwd) || recordedCwd;
      const safeData = {};
      if (record.type === 'session.start') Object.assign(safeData, { sessionId: text(data.sessionId), version: data.version, copilotVersion: text(data.copilotVersion), context: { cwd: recordedCwd } });
      else if (['user.message', 'assistant.message'].includes(record.type)) Object.assign(safeData, { content: text(data.content, 500), toolRequests: data.toolRequests?.length ? [true] : [] });
      else if (record.type === 'tool.execution_start') {
        const name = text(data.toolName); const safeDetails = details(name, data.arguments);
        tools.set(text(data.toolCallId), { name, details: safeDetails });
        Object.assign(safeData, { toolCallId: text(data.toolCallId), toolName: name, safeDetails });
      } else if (record.type === 'tool.execution_complete') {
        const tool = tools.get(text(data.toolCallId));
        Object.assign(safeData, { toolCallId: text(data.toolCallId), success: data.success === false ? false : true, safeResult: resultDetails(tool?.name || '', { output: data.result?.content, ...(data.success === false ? { is_error: true } : {}) }, tool?.details) });
      }
      safe = { id: key, type: text(record.type), timestamp: iso(record.timestamp), data: safeData };
      if (record.type === 'user.message') { tools.clear(); pending.clear(); }
      if (record.type === 'tool.execution_start') pending.set(text(data.toolCallId), safe);
      if (record.type === 'tool.execution_complete') { pending.delete(text(data.toolCallId)); tools.delete(text(data.toolCallId)); }
      if (['session.start', 'user.message', 'assistant.turn_start'].includes(record.type)) anchors.set(record.type, safe);
    } else {
      if (typeof record.sid !== 'string') return;
      key = JSON.stringify([text(record.sid), count(record.rIdx) || 0, text(record.spanId), text(record.type)]);
      if (seen.has(key)) return; seen.add(key);
      while (seen.size > Math.min(2048, bounds.maxStateEntries)) seen.delete(seen.values().next().value);
      const attrs = record.attrs || {}, safeAttrs = {};
      if (record.type === 'llm_request') {
        for (const name of ['inputTokens', 'cachedTokens', 'outputTokens']) if (count(attrs[name]) !== undefined) safeAttrs[name] = attrs[name];
      } else if (record.type === 'session_start') Object.assign(safeAttrs, { copilotVersion: text(attrs.copilotVersion), parentSessionId: text(attrs.parentSessionId), label: text(attrs.label) });
      else if (record.type === 'child_session_ref') Object.assign(safeAttrs, { childSessionId: text(attrs.childSessionId), label: text(attrs.label) });
      else if (record.type === 'user_message') safeAttrs.content = text(attrs.content, 240);
      else if (record.type === 'tool_call') { safeAttrs.safeDetails = details(record.name, attrs.args); safeAttrs.safeResult = resultDetails(record.name, { output: attrs.result, ...(record.status === 'error' ? { is_error: true } : {}) }, safeAttrs.safeDetails); }
      safe = { v: record.v === undefined ? undefined : record.v === 1 ? 1 : 0, sid: text(record.sid), rIdx: count(record.rIdx) || 0, spanId: text(record.spanId), parentSpanId: text(record.parentSpanId), type: text(record.type), name: text(record.name), ts: Number.isFinite(record.ts) ? record.ts : undefined, dur: Number.isFinite(record.dur) && record.dur >= 0 ? record.dur : 0, status: record.status === 'error' ? 'error' : 'ok', attrs: safeAttrs };
      if (record.type === 'llm_request') {
        // Numeric totals survive the event ring without retaining every model
        // call. Deduplication covers the bounded recent-ID horizon above.
        if (safe.v === undefined || safe.v === 1) {
          const total = usage.get(safe.sid) || { ...safe, spanId: 'agentobs-usage-total', rIdx: 0, attrs: {} };
          for (const [name, value] of Object.entries(safeAttrs)) total.attrs[name] = Math.min(Number.MAX_SAFE_INTEGER, (total.attrs[name] || 0) + value);
          total.ts = safe.ts; total.dur = safe.dur; usage.set(safe.sid, total);
        }
        safe = undefined;
      }
      else if (['session_start', 'user_message', 'turn_start'].includes(record.type)) anchors.set(record.sid + ':' + record.type, safe);
      else if (record.type === 'child_session_ref' || record.type === 'tool_call' && agentTool(record.name)) anchors.set(key, safe);
    }
    if (safe) events.push(safe);
    if (events.length > 2048) events.shift();
    if ([usage, tools, pending, anchors].some(collection => collection.size > bounds.maxStateEntries)) throw limitError('STATE_LIMIT');
  }, snapshot() { return [...new Set([...anchors.values(), ...pending.values(), ...events]), ...usage.values()]; },
  checkpoint() { return { recordedCwd, events, anchors: [...anchors], usage: [...usage], seen: [...seen], tools: [...tools], pending: [...pending] }; },
  restore(saved) {
    if (!object(saved) || !Array.isArray(saved.events) || saved.events.length > 2048 || !Array.isArray(saved.seen) || saved.seen.length > Math.min(2048, bounds.maxStateEntries) || (saved.recordedCwd !== undefined && typeof saved.recordedCwd !== 'string')) throw new Error('INVALID_CHECKPOINT');
    const maps = [[anchors, saved.anchors], [usage, saved.usage], [tools, saved.tools], [pending, saved.pending]];
    for (const [, rows] of maps) if (!Array.isArray(rows) || rows.length > bounds.maxStateEntries || rows.some(row => !Array.isArray(row) || row.length !== 2 || (typeof row[0] !== 'string' && row[0] !== null))) throw new Error('INVALID_CHECKPOINT');
    if (saved.events.some(row => !object(row)) || saved.seen.some(value => typeof value !== 'string')) throw new Error('INVALID_CHECKPOINT');
    recordedCwd = saved.recordedCwd; events.push(...saved.events); for (const item of saved.seen) seen.add(item);
    for (const [map, rows] of maps) for (const [key, value] of rows) map.set(key === null ? undefined : key, value);
  }, memory() { return Buffer.byteLength(JSON.stringify([...new Set([...anchors.values(), ...pending.values(), ...events]), ...usage.values()])) + Buffer.byteLength(JSON.stringify([...seen])) + tools.size * 1024; } };
}

function create({ roots = [], limits, indexFile, indexVersion } = {}) {
  const bounds = resourceLimits(limits), reader = createIngestion(limits, { createProjection: createStringLimiter, indexFile, indexVersion, resumable: true }), summaries = new Map();
  let externalWorkspaceFile = false;
  return { knowsFile: file => reader.has(file), canCache: () => !externalWorkspaceFile, async close() { await reader.saveIndex({ force: true }); }, async scan({ signal, onProgress, knownUnchanged } = {}) {
    externalWorkspaceFile = false;
    await reader.loadIndex();
    reader.beginScan();
    const sources = [], sessions = [], used = new Set(), usedWorkspaces = new Set(), diagnostics = new Set();
    let unreadable = 0, directoriesSeen = 0, summaryBytes = 0;
    const fileIssues = createFileIssues();
    let currentSource;
    const directories = async directory => {
      signal?.throwIfAborted();
      if (++directoriesSeen > bounds.maxFiles) { diagnostics.add('INGESTION_LIMIT'); if (currentSource) currentSource.status = 'limited'; return []; }
      try { const stat = await fs.lstat(directory); return stat.isDirectory() && !stat.isSymbolicLink() ? await fs.readdir(directory, { withFileTypes: true }) : []; }
      catch (error) { signal?.throwIfAborted(); if (error.code !== 'ENOENT') { unreadable++; if (currentSource) currentSource.status = 'unreadable'; } return []; }
    };
    const stores = [...new Set(roots)];
    for (const [storeIndex, root] of stores.entries()) {
      let remainingFiles = Math.floor(bounds.maxFiles / stores.length) + Number(storeIndex < bounds.maxFiles % stores.length);
      signal?.throwIfAborted();
      const rootSource = { directory: root, provider: 'copilot-vscode', status: 'ready' }; currentSource = rootSource;
      let workspaces;
      try { workspaces = await fs.readdir(root, { withFileTypes: true }); sources.push(rootSource); }
      catch (error) { sources.push({ directory: root, provider: 'copilot-vscode', status: error.code === 'ENOENT' ? 'missing' : 'unreadable' }); continue; }
      for (const workspace of workspaces.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const directory = path.join(root, workspace.name), inputs = [], revisions = [];
        let inputBytes = 0, workspaceStale = false;
        const staleFiles = new Set();
        usedWorkspaces.add(directory);
        const read = async (file, format = 'json', cwd) => {
          try {
            signal?.throwIfAborted();
            if (!used.has(file)) { if (remainingFiles-- <= 0) { rootSource.status = 'limited'; throw limitError('INGESTION_LIMIT'); } }
            used.add(file);
            const factory = format === 'json' ? () => { let value; return { push(content) { const parsed = parseJsonc(content); value = { folder: parsed.folder, workspace: parsed.workspace, folders: parsed.folders?.map(folder => ({ path: folder.path, uri: folder.uri })) }; }, snapshot: () => value }; }
              : format.startsWith('chat') ? () => createChatReducer(bounds, format === 'chat-json') : () => createEventReducer(format, cwd, bounds);
            const entry = await reader.read(file, factory, { json: format === 'json' || format === 'chat-json', projectJson: format === 'chat-json', signal, knownUnchanged: knownUnchanged?.(file) });
            inputBytes += Buffer.byteLength(JSON.stringify(entry.value) || '');
            if (inputBytes > bounds.maxCacheBytes / 2) { rootSource.status = 'limited'; throw limitError('CACHE_LIMIT'); }
            revisions.push(file + ':' + entry.revision); return entry.value;
          } catch (error) {
            signal?.throwIfAborted();
            if (error.code !== 'ENOENT') {
              fileIssues.add(file, error);
              if (format === 'json') workspaceStale = true; else staleFiles.add(file);
              if (error.code?.endsWith('LIMIT')) diagnostics.add(error.code);
              const known = reader.lastKnown(file);
              if (known) { unreadable++; revisions.push(file + ':' + known.revision + ':stale'); return known.value; }
            }
            throw error;
          } finally { if (format !== 'json') onProgress?.(); }
        };
        const failed = error => { signal?.throwIfAborted(); if (error.code !== 'ENOENT') { unreadable++; rootSource.status = error.code?.endsWith('LIMIT') ? 'limited' : 'unreadable'; } if (error.code?.endsWith('LIMIT')) diagnostics.add(error.code); };
        let cwd;
        try {
          const meta = await read(path.join(directory, 'workspace.json'));
          cwd = localPath(meta.folder);
          if (!cwd && localPath(meta.workspace)) {
            // Workspace configuration may live outside the watched VS Code store.
            externalWorkspaceFile = true;
            const workspaceFile = localPath(meta.workspace), config = await read(workspaceFile);
            const folders = (config.folders || []).map(folder => localPath(folder.uri) || (typeof folder.path === 'string' ? path.resolve(path.dirname(workspaceFile), folder.path) : undefined)).filter(Boolean);
            if (folders.length === 1) cwd = folders[0];
          }
        } catch (error) { failed(error); }
        for (const entry of (await directories(path.join(directory, 'chatSessions'))).filter(entry => entry.isFile() && /\.jsonl?$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
          const file = path.join(directory, 'chatSessions', entry.name);
          try { inputs.push({ kind: 'chat', file, value: await read(file, entry.name.endsWith('.jsonl') ? 'chat' : 'chat-json', cwd) }); } catch (error) { failed(error); }
        }
        for (const extension of ['GitHub.copilot-chat', 'github.copilot-chat']) {
          const base = path.join(directory, extension);
          try { const stat = await fs.lstat(base); if (!stat.isDirectory() || stat.isSymbolicLink()) continue; } catch (error) { failed(error); continue; }
          for (const entry of await directories(path.join(base, 'transcripts'))) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const file = path.join(base, 'transcripts', entry.name);
            try { inputs.push({ kind: 'transcript', file, value: await read(file, 'transcript', cwd) }); } catch (error) { failed(error); }
          }
          for (const sessionDir of await directories(path.join(base, 'debug-logs'))) {
            if (!sessionDir.isDirectory()) continue;
            for (const entry of await directories(path.join(base, 'debug-logs', sessionDir.name))) {
              if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
              const file = path.join(base, 'debug-logs', sessionDir.name, entry.name);
              try { inputs.push({ kind: 'debug', file, value: await read(file, 'debug', cwd) }); } catch (error) { failed(error); }
            }
          }
        }
        const signature = revisions.sort().join('\n'), cached = summaries.get(directory);
        if (cached?.signature === signature) { unreadable += cached.unreadable; fileIssues.merge(cached); sessions.push(...cached.sessions.map(session => ({ ...session }))); continue; }
        const beforeReduction = unreadable;
        const reductionIssues = createFileIssues();
        const groups = new Map();
        const group = id => { if (!groups.has(id)) groups.set(id, { id, cwd, transcript: [], debug: [] }); return groups.get(id); };
        for (const input of inputs) {
          const { value, file } = input;
          if (input.kind === 'chat') {
            if (!object(value) || !Array.isArray(value.requests) || !value.requests.length) continue;
            if (!/copilot/i.test(value.responderUsername || '') && !value.requests.some(request => /copilot/i.test(request.agent?.id || request.agent?.extensionId?.value || ''))) continue;
            const item = group(value.sessionId || path.basename(file).replace(/\.jsonl?$/, '')); item.chat = value; item.file = file; item.stale ||= staleFiles.has(file); item.cwd = localPath(value.workingDirectory) || cwd;
          } else if (input.kind === 'transcript') {
            const start = value.find(record => record.type === 'session.start');
            if (!value.length) continue;
            if (!start || start.data?.version !== 1) { unreadable++; reductionIssues.add(file, { code: 'UNSUPPORTED_FORMAT' }); continue; }
            const item = group(start.data.sessionId || path.basename(file, '.jsonl')); item.transcript = value; item.file ||= file; item.stale ||= staleFiles.has(file); item.cwd = localPath(start.data.context?.cwd) || item.cwd;
          } else for (const record of value) { const item = group(record.sid); item.debug.push(record); item.file ||= file; item.stale ||= staleFiles.has(file); }
        }
        const workspaceSessions = [];
      for (const item of [...groups.values()]) {
        for (const ref of item.debug.filter(record => record.type === 'child_session_ref')) {
          const childId = ref.attrs?.childSessionId;
          const parentTool = item.debug.find(record => record.type === 'tool_call' && record.spanId === ref.parentSpanId);
          const isAgent = /subagent/i.test(ref.attrs?.label || ref.name || '') || agentTool(parentTool?.name);
          if (typeof childId !== 'string' || !isAgent) continue;
          const child = group(childId); child.parentId = item.id; child.name = text(ref.attrs?.label || ref.name); child.cwd ||= item.cwd;
          if (!child.debug.length && !child.transcript.length && !child.chat) { child.missing = true; child.debug = [{ ...ref, type: 'session_start', sid: childId }]; }
        }
      }
      for (const item of groups.values()) {
        const start = item.debug.find(record => record.type === 'session_start');
        // Ignore ancillary title-generation/model-discovery child sessions.
        if (start?.attrs?.parentSessionId && !item.parentId) continue;
        try { workspaceSessions.push({ ...summarizeCopilot({ ...item, reduced: true }), sourceDirectory: root, ...(workspaceStale || item.stale ? { observationStale: true, currentTool: undefined } : {}) }); }
        catch (error) { unreadable++; reductionIssues.add(item.file, error); }
      }

        const issues = reductionIssues.snapshot(); fileIssues.merge(issues);
        const memory = Buffer.byteLength(JSON.stringify({ sessions: workspaceSessions, ...issues }));
        if (memory < bounds.maxSummaryBytes) summaries.set(directory, { signature, sessions: workspaceSessions, memory, unreadable: unreadable - beforeReduction, ...issues });
        sessions.push(...workspaceSessions.map(session => ({ ...session })));
      }
    }
    reader.prune(used);
    for (const [directory, entry] of summaries) {
      summaryBytes += entry.memory;
      if (!usedWorkspaces.has(directory) || summaryBytes > bounds.maxSummaryBytes) summaries.delete(directory);
    }
    await reader.saveIndex();
    return { sessions, sources, unreadable, ...(reader.deferredCount ? { deferredFiles: reader.deferredCount } : {}), ...(reader.progress ? { loadProgress: reader.progress } : {}), ...fileIssues.snapshot(), ...(diagnostics.size ? { diagnostics: [...diagnostics] } : {}) };
  } };
}

// Opt-in fixture export preserves protocol fields while replacing identifying
// text, paths and tool bodies. Export never marks a capture as verified.
function sanitizeFixture(records) {
  const { createHash } = require('node:crypto');
  const fields = new Set('kind k v i version sessionId workingDirectory creationDate responderUsername customTitle requests requestId timestamp responseTimestamp isCanceled modelState value completedAt message text agent id extensionId response toolCallId toolId isComplete startedAt resultError type data context cwd copilotVersion vscodeVersion content toolRequests toolName arguments success result output ts dur sid rIdx spanId parentSpanId name status attrs inputTokens cachedTokens outputTokens parentSessionId childSessionId label code'.split(' '));
  const identity = new Set('id sessionId requestId toolCallId sid spanId parentSpanId parentSessionId childSessionId'.split(' '));
  const protocol = new Set('session.start user.message assistant.turn_start assistant.message tool.execution_start tool.execution_complete assistant.turn_end session_start user_message turn_start turn_end tool_call child_session_ref llm_request error toolInvocationSerialized ok error'.split(' '));
  const knownTools = new Set('run_in_terminal terminal read_file read runSubagent run_subagent run_agent task request_user_input'.split(' '));
  const redact = (value, key = '') => {
    if (['args', 'arguments', 'output', 'result'].includes(key)) return typeof value === 'string' ? '[redacted tool body]' : { content: '[redacted tool body]' };
    if (Array.isArray(value)) return value.map(item => redact(item, key));
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([name]) => fields.has(name)).map(([name, item]) => [name, redact(item, name)]));
    if (typeof value === 'string') {
      if (identity.has(key)) return 'fixture-' + createHash('sha256').update(value).digest('hex').slice(0, 16);
      if (['cwd', 'workingDirectory'].includes(key)) return '/workspace/copilot-fixture';
      if (['copilotVersion', 'vscodeVersion'].includes(key)) return /^\d+[\w.-]{0,39}$/.test(value) ? value : 'unknown';
      if (['timestamp', 'startedAt', 'completedAt', 'responseTimestamp', 'creationDate'].includes(key)) return iso(value) || undefined;
      if (key === 'responderUsername') return /copilot/i.test(value) ? 'GitHub Copilot' : 'Agent';
      if (key === 'label') return /subagent/i.test(value) ? 'subagent' : 'Agent';
      if (['type', 'kind', 'status'].includes(key)) return protocol.has(value) ? value : 'unknown';
      if (['name', 'toolName', 'toolId'].includes(key)) return knownTools.has(value) ? value : 'tool';
      return '[Fixture] Redacted text';
    }
    return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null ? value : undefined;
  };
  return records.filter(record => !Array.isArray(record.k) || record.k.every(key => typeof key === 'number' || fields.has(key))).map(record => {
    const safe = redact(record);
    if (Array.isArray(record.k)) { safe.k = record.k; safe.v = redact(record.v, String(record.k.at(-1))); }
    return safe;
  });
}

function defaultRoots(rootFolder) {
  return [...copilotStorageRoots(), path.join(rootFolder, '.agentobs', 'copilot', 'workspaceStorage')];
}

module.exports = {
  id: 'copilot-vscode', label: 'Copilot', configKey: 'copilotRoots', cliFlag: '--copilot-storage',
  cliDescription: 'VS Code workspaceStorage (repeat for multiple stores)', defaultRoots, create,
  copilotStorageRoots, replayChatSession, summarizeCopilot, sanitizeFixture
};
