'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createIngestion } = require('../ingestion');
const { createFileIssues } = require('../file-issues');
const { resourceLimits, limitError } = require('../limits');
const { callDetails, commandCategory } = require('../tool-details');

const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : undefined;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const ns = id => 'claude-code:' + id;
function root(env = process.env, home = os.homedir()) { return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'); }
function reducer(file, childId, parentId, limits) {
  const bounds = resourceLimits(limits), tools = new Map(), usage = new Map();
  let cwd, version, id = parentId || path.basename(file, '.jsonl'), task, taskAt, lastActivity, status = 'unknown', turnStartedAt, failure, recognized = false;
  function push(record) {
    if (!record || typeof record !== 'object') return;
    const at = date(record.timestamp); if (at) lastActivity = at;
    if (path.isAbsolute(record.cwd || '')) cwd = record.cwd;
    if (typeof record.version === 'string') version = record.version.slice(0, 100);
    if (!parentId && typeof record.sessionId === 'string' && record.sessionId) id = record.sessionId;
    const message = record.message || {}, blocks = Array.isArray(message.content) ? message.content : [];
    if (record.type === 'user') {
      recognized = true;
      const prompt = typeof message.content === 'string' ? text(message.content) : text(blocks.filter(x => x?.type === 'text').map(x => x.text).join(' '));
      if (prompt && !record.isMeta && !record.isVisibleInTranscriptOnly) {
        for (const tool of tools.values()) if (tool.status === 'in_progress') { tool.status = 'interrupted'; tool.completedAt = at; }
        task = prompt; taskAt = at; status = 'active'; turnStartedAt = at; failure = undefined;
      }
      for (const part of blocks) if (part?.type === 'tool_result' && tools.has(part.tool_use_id)) {
        const tool = tools.get(part.tool_use_id); tool.status = part.is_error ? 'failed' : 'completed'; tool.completedAt = at;
      }
    }
    if (record.type === 'assistant') {
      recognized = true; status = 'active';
      for (const part of blocks) if (part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
        const name = part.name, canonical = /^bash$/i.test(name) ? 'exec_command' : name;
        const category = canonical === 'exec_command' ? commandCategory(part.input) : undefined;
        const label = category ? `${name} · ${category}` : name;
        if (!tools.has(part.id)) tools.set(part.id, { id: part.id, name, label, status: 'in_progress', timestamp: at, startedAt: at, details: callDetails(canonical, part.input, { cwd }) });
      }
      const u = message.usage;
      if (u && typeof u === 'object' && typeof message.id === 'string') {
        const previous = usage.get(message.id) || {}, next = {};
        for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
          const current = count(u[field]); next[field] = current === undefined ? previous[field] : Math.max(current, previous[field] || 0);
        }
        usage.set(message.id, next);
      }
      if (message.stop_reason === 'end_turn' && ![...tools.values()].some(t => t.status === 'in_progress')) status = 'completed';
      if (record.isApiErrorMessage || message.error) { failure = 'Claude request failed'; status = 'completed'; }
    }
    if (tools.size > bounds.maxStateEntries || usage.size > bounds.maxStateEntries) throw limitError('STATE_LIMIT');
  }
  function snapshot() {
    const tokenUsage = {}; for (const u of usage.values()) {
      const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens];
      if (parts.every(n => n !== undefined)) tokenUsage.input = (tokenUsage.input || 0) + parts.reduce((a,b) => a+b, 0);
      if (u.cache_read_input_tokens !== undefined) tokenUsage.cachedInput = (tokenUsage.cachedInput || 0) + u.cache_read_input_tokens;
      if (u.output_tokens !== undefined) tokenUsage.output = (tokenUsage.output || 0) + u.output_tokens;
    }
    const history = [...tools.values()].slice(-100), currentTool = [...tools.values()].reverse().find(t => t.status === 'in_progress');
    return { id: ns(childId ? `${parentId}:agent:${childId}` : id), ...(childId ? { parentId: ns(parentId), agentName: childId } : {}), cwd, file, cliVersion: version, supportLevel: recognized ? 'best_effort' : 'unsupported', compatibilityDetail: recognized ? 'Claude transcript schema is recognized but not version-verified' : 'Unrecognized Claude transcript', status, hasLifecycle: status !== 'unknown', lastActivity, currentTask: task, currentTaskAt: taskAt, turnStartedAt, attentionState: failure ? 'failed' : undefined, attentionDetail: failure, tokenUsage: Object.keys(tokenUsage).length ? tokenUsage : undefined, currentTool, lastTool: history.at(-1), toolHistory: history };
  }
  return { push, snapshot: () => structuredClone(snapshot()), memory: () => Buffer.byteLength(JSON.stringify(snapshot())) + (tools.size + usage.size) * 200 };
}
function create({ roots = [], limits, indexFile, indexVersion } = {}) {
  const bounds = resourceLimits(limits), reader = createIngestion(limits, { indexFile, indexVersion });
  return { knowsFile: file => reader.has(file), async close() { await reader.saveIndex({ force: true }); }, async scan({ signal, onProgress, knownUnchanged } = {}) {
    await reader.loadIndex(); reader.beginScan();
    const files = new Map(), sources = [], sessions = [], issues = createFileIssues(), diagnostics = new Set(); let unreadable = 0;
    for (const directory of [...new Set(roots)]) {
      let limited = false, broken = false;
      async function walk(dir, depth = 0) {
        signal?.throwIfAborted(); if (depth > 4) return;
        for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => b.name.localeCompare(a.name))) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) { try { await walk(file, depth + 1); } catch (error) { signal?.throwIfAborted(); broken = true; unreadable++; } }
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            if (files.size >= bounds.maxFiles) { limited = true; return; }
            const sub = path.basename(dir) === 'subagents' && /^agent-(.+)\.jsonl$/.exec(entry.name);
            if (sub) files.set(file, { directory, childId: sub[1], parentId: path.basename(path.dirname(dir)) });
            else if (depth === 1) files.set(file, { directory });
          }
        }
      }
      try { await walk(directory); sources.push({ directory, provider: 'claude-code', status: limited ? 'limited' : broken ? 'unreadable' : 'ready' }); }
      catch (error) { sources.push({ directory, provider: 'claude-code', status: error.code === 'ENOENT' ? 'missing' : 'unreadable' }); }
    }
    for (const file of reader.prioritize(files.keys())) {
      const meta = files.get(file); signal?.throwIfAborted();
      try { const entry = await reader.read(file, () => reducer(file, meta.childId, meta.parentId, limits), { signal, knownUnchanged: knownUnchanged?.(file) }); sessions.push({ ...entry.value, sourceDirectory: meta.directory, provider: 'claude-code', providerLabel: 'Claude Code' }); }
      catch (error) { signal?.throwIfAborted(); unreadable++; issues.add(file, error); if (error.code?.endsWith('LIMIT')) diagnostics.add(error.code); const last = reader.lastKnown(file); if (last && error.code !== 'ENOENT') sessions.push({ ...last.value, sourceDirectory: meta.directory, provider: 'claude-code', providerLabel: 'Claude Code', observationStale: true, currentTool: undefined }); }
      finally { onProgress?.(); }
    }
    const parents = new Map(sessions.filter(s => !s.parentId).map(s => [s.id, s]));
    for (const session of sessions) if (!session.cwd && session.parentId) session.cwd = parents.get(session.parentId)?.cwd;
    reader.prune(new Set(files.keys())); await reader.saveIndex();
    return { sessions, sources, unreadable, ...(reader.deferredCount ? { deferredFiles: reader.deferredCount } : {}), ...issues.snapshot(), ...(diagnostics.size ? { diagnostics: [...diagnostics] } : {}) };
  } };
}
module.exports = { id: 'claude-code', label: 'Claude Code', configKey: 'claudeRoots', cliFlag: '--claude-storage', cliDescription: 'Claude Code projects directory (repeat for multiple stores)', defaultRoots: () => [root()], root, create, reducer };
