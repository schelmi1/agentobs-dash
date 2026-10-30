'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { commandCategory, callDetails } = require('../tool-details');
const path = require('node:path');
const { file, maxFiles, maxStateEntries, maxRecordBytes, maxSummaryBytes, maxReadBytesPerScan } = workerData;
const ns = id => 'opencode:' + id;
const iso = n => Number.isFinite(n) && Math.abs(n) <= 8640000000000000 ? new Date(n).toISOString() : undefined;
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : undefined;
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : undefined;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = value => { try { const parsed = JSON.parse(value); return isObject(parsed) ? parsed : undefined; } catch { return undefined; } };
function tool(part, at, cwd) {
  const name = part.name || part.tool, state = part.state || {};
  if (typeof name !== 'string') return;
  const canonical = /^(bash|shell)$/i.test(name) ? 'exec_command' : name;
  const category = canonical === 'exec_command' ? commandCategory(state.input) : undefined;
  const status = ['running', 'pending', 'streaming'].includes(state.status) ? 'in_progress' : state.status === 'completed' ? 'completed' : state.status === 'error' ? 'failed' : 'unknown';
  const startedAt = iso(part.time?.ran || part.time?.start || part.time?.created || state.time?.start) || at;
  return { id: String(part.id || part.callID || '').slice(0, 4096), name: name.slice(0,240), label: (category ? `${name} · ${category}` : name).slice(0,240), status, timestamp: startedAt, startedAt, completedAt: iso(part.time?.completed || state.time?.end), details: callDetails(canonical, state.input, { cwd }) };
}
function execute() {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    db.pragma('query_only = ON'); db.exec('BEGIN');
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2','session_message','session_part','session','message','part')").all().map(x => x.name));
    const v2 = names.has('session_v2') && names.has('session_message');
    if (!v2 && !['session','message','part'].every(n => names.has(n))) throw new Error('UNSUPPORTED_SCHEMA');
    const table = v2 ? 'session_v2' : 'session';
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name));
    if (!['id','directory','time_updated'].every(x => cols.has(x))) throw new Error('UNSUPPORTED_SCHEMA');
    const columns = ['id','parent_id','directory','title','version','time_created','time_updated','time_idle','idle_outcome','tokens_input','tokens_output','tokens_cache_read','tokens_cache_write'].filter(x => cols.has(x));
    const rows = db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY time_updated DESC LIMIT ?`).all(maxFiles + 1);
    const limited = rows.length > maxFiles; rows.length = Math.min(rows.length, maxFiles);
    const result = []; let size = 0, unreadable = 0, readBytes = 0;
    const validPart = part => { if (!isObject(part)) { unreadable++; return false; } return true; };
    const parseParts = rows => rows.map(row => parse(row.data)).filter(validPart);
    const collect = (statement, ...args) => {
      const rows = [];
      for (const row of statement.iterate(...args)) {
        readBytes += typeof row.data === 'string' ? Buffer.byteLength(row.data) : 0;
        if (readBytes > maxReadBytesPerScan) throw new Error('READ_BUDGET_LIMIT');
        rows.push(row);
      }
      return rows;
    };
    for (const row of rows) {
      if (!path.isAbsolute(row.directory || '') || typeof row.id !== 'string') continue;
      const history = [], messages = v2
        ? collect(db.prepare('SELECT id, type, seq, time_created, time_updated, CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?'), maxRecordBytes, row.id, maxStateEntries + 1)
        : collect(db.prepare('SELECT id, time_created, time_updated, CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?'), maxRecordBytes, row.id, maxStateEntries + 1);
      if (messages.length > maxStateEntries) { unreadable++; continue; }
      messages.reverse(); let task, taskAt, lastActivity = iso(row.time_updated), state = 'unknown', failure, tokenUsage = {}, lastMessageAt;
      for (const message of messages) {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > maxRecordBytes) { unreadable++; continue; }
        const data = parse(message.data);
        if (!data) { unreadable++; continue; }
        const type = v2 ? message.type : data.role, at = iso(message.time_updated || message.time_created); if (at) lastMessageAt = at;
        if (type === 'user') { const prompt = text(data.text); if (prompt) { task = prompt; taskAt = at; } state = 'active'; failure = undefined; }
        if (type === 'idle') {
          state = 'completed';
          for (const call of history) if (call.status === 'in_progress') { call.status = 'interrupted'; call.completedAt = at; }
          if (data.outcome && !['completed','success','succeeded','idle'].includes(data.outcome)) failure = 'OpenCode task ended with an error';
        }
        if (type === 'assistant') {
          state = 'active';
          let parts = Array.isArray(data.content) ? data.content : [];
          if (v2 && names.has('session_part')) parts = parseParts(collect(db.prepare('SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data FROM session_part WHERE message_id = ? ORDER BY ordinal LIMIT ?'), maxRecordBytes, message.id, maxStateEntries));
          if (!v2) parts = parseParts(collect(db.prepare('SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data FROM part WHERE message_id = ? ORDER BY time_created, id LIMIT ?'), maxRecordBytes, message.id, maxStateEntries));
          for (const part of parts.filter(validPart)) if (part.type === 'tool') { const t = tool(part, at, row.directory); if (t) history.push(t); }
          if (!v2 && data.tokens && typeof data.tokens === 'object') {
            const t = data.tokens, a = [count(t.input), count(t.cache?.read), count(t.cache?.write)];
            if (a.every(n => n !== undefined)) tokenUsage.input = (tokenUsage.input || 0) + a.reduce((x,y) => x+y,0);
            if (a[1] !== undefined) tokenUsage.cachedInput = (tokenUsage.cachedInput || 0) + a[1];
            if (count(t.output) !== undefined) tokenUsage.output = (tokenUsage.output || 0) + t.output;
          }
          if (!v2 && data.finish && !['tool-calls','unknown'].includes(data.finish) && !history.some(t => t.status === 'in_progress')) state = 'completed';
          if (data.error) failure = 'OpenCode request failed';
        }
        if (!v2 && type === 'user') {
          const parts = collect(db.prepare('SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data FROM part WHERE message_id = ? ORDER BY time_created, id LIMIT ?'), maxRecordBytes, message.id, maxStateEntries);
          const value = parseParts(parts).filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p => p.text).join(' ');
          if (text(value)) { task = text(value); taskAt = at; }
        }
      }
      if (v2 && count(row.tokens_input) !== undefined && count(row.tokens_cache_read) !== undefined && count(row.tokens_cache_write) !== undefined) tokenUsage = { input: row.tokens_input + row.tokens_cache_read + row.tokens_cache_write, cachedInput: row.tokens_cache_read, ...(count(row.tokens_output) !== undefined ? { output: row.tokens_output } : {}) };
      const currentTool = [...history].reverse().find(t => t.status === 'in_progress');
      if (lastMessageAt && (!lastActivity || lastMessageAt > lastActivity)) lastActivity = lastMessageAt;
      const s = { id: ns(row.id), ...(row.parent_id ? { parentId: ns(row.parent_id) } : {}), cwd: row.directory, file, provider: 'opencode', providerLabel: 'OpenCode', status: state, hasLifecycle: state !== 'unknown', lastActivity, currentTask: task || text(row.title), currentTaskAt: taskAt, cliVersion: row.version || undefined, supportLevel: 'best_effort', compatibilityDetail: `OpenCode ${v2 ? 'v2' : 'v1'} database schema`, attentionState: failure ? 'failed' : undefined, attentionDetail: failure, tokenUsage: Object.keys(tokenUsage).length ? tokenUsage : undefined, currentTool, lastTool: history.at(-1), toolHistory: history.slice(-100) };
      size += Buffer.byteLength(JSON.stringify(s)); if (size > maxSummaryBytes) { unreadable++; break; } result.push(s);
    }
    db.exec('COMMIT'); return { sessions: result, unreadable, limited };
  } finally { db.close(); }
}
try { parentPort.postMessage({ result: execute() }); } catch (error) { parentPort.postMessage({ error: error.message === 'UNSUPPORTED_SCHEMA' ? 'UNSUPPORTED_FORMAT' : error.message === 'READ_BUDGET_LIMIT' ? 'READ_BUDGET_LIMIT' : 'DATABASE_READ_FAILED' }); }
