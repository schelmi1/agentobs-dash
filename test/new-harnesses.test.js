'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const claude = require('../lib/harnesses/claude');
const opencode = require('../lib/harnesses/opencode');

async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-new-harness-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
const line = record => JSON.stringify(record) + '\n';

test('Claude incrementally tracks tool outcomes, deduplicated usage, child files and truncated tails', async t => {
  const root = await fixture(t), store = path.join(root, 'projects'), project = path.join(store, 'encoded'), sub = path.join(project, 'run', 'subagents');
  await fs.mkdir(sub, { recursive: true }); const file = path.join(project, 'run.jsonl'), child = path.join(sub, 'agent-worker.jsonl');
  const at = new Date().toISOString(), base = { cwd: root, timestamp: at, sessionId: 'run', version: '2.0' };
  await fs.writeFile(file, line({ ...base, type: 'user', message: { content: 'Repair the issue' } }) + line({ ...base, type: 'assistant', message: { id: 'response', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 3 }, content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'git status SECRET' } }] } }) + line({ ...base, type: 'assistant', message: { id: 'response', usage: { output_tokens: 7 }, content: [] } }) + '{"type":');
  await fs.writeFile(child, line({ ...base, type: 'user', message: { content: 'Inspect a branch' } }));
  const adapter = claude.create({ roots: [store] }); t.after(() => adapter.close());
  let result = await adapter.scan(); assert.equal(result.sessions.length, 2); const main = result.sessions.find(s => !s.parentId), worker = result.sessions.find(s => s.parentId);
  assert.equal(worker.parentId, main.id); assert.equal(main.currentTool.label, 'Bash · git'); assert.deepEqual(main.tokenUsage, { input: 35, cachedInput: 20, output: 7 }); assert.ok(!JSON.stringify(result).includes('SECRET'));
  await fs.appendFile(file, '"user","timestamp":"' + at + '","message":{"content":[{"type":"tool_result","tool_use_id":"call","is_error":true}]}}\n' + line({ ...base, type: 'assistant', message: { id: 'final', content: [], stop_reason: 'end_turn' } }));
  result = await adapter.scan(); assert.equal(result.sessions.find(s => !s.parentId).status, 'completed'); assert.equal(result.sessions.find(s => !s.parentId).lastTool.status, 'failed');
  await fs.rm(child); assert.equal((await adapter.scan()).sessions.length, 1);
});

test('OpenCode v2 follows live WAL updates, preserves child IDs and does not expose tool input', async t => {
  const root = await fixture(t), file = path.join(root, 'opencode.db'), db = new Database(file); t.after(() => db.close()); db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const now = Date.now(); db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?)').run('root', null, root, 'Run', '2', now, 10, 4, 20, 5); db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?)').run('child', 'root', root, 'Child', '2', now, 2, 1, 0, 0);
  const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  add.run('user', 'root', 'user', 1, now, now, JSON.stringify({ text: 'Do the work' })); add.run('assistant', 'root', 'assistant', 2, now, now, JSON.stringify({ content: [{ type: 'tool', id: 'call', name: 'bash', state: { status: 'running', input: { command: 'git status SECRET' } } }] }));
  const adapter = opencode.create({ roots: [root] }); let result = await adapter.scan(); let main = result.sessions.find(s => s.id === 'opencode:root');
  assert.equal(result.sessions.find(s => s.id === 'opencode:child').parentId, main.id); assert.equal(main.status, 'active'); assert.equal(main.currentTool.status, 'in_progress'); assert.deepEqual(main.tokenUsage, { input: 35, cachedInput: 20, output: 4 }); assert.ok(!JSON.stringify(result).includes('SECRET'));
  main.toolHistory[0].name = 'mutated'; assert.equal((await adapter.scan()).sessions.find(s => s.id === main.id).toolHistory[0].name, 'bash');
  add.run('idle', 'root', 'idle', 3, now + 5, now + 5, JSON.stringify({ outcome: 'succeeded' })); result = await adapter.scan(); assert.equal(result.sessions.find(s => s.id === main.id).status, 'completed');
});

test('OpenCode v1 SQLite reads text, completed tools and per-message token totals', async t => {
  const root = await fixture(t), file = path.join(root, 'opencode.db'), db = new Database(file); t.after(() => db.close());
  db.exec('CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  const now = Date.now(); db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('legacy', null, root, 'Legacy', '1', now);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)'), part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  msg.run('m1', 'legacy', now, now, JSON.stringify({ role: 'user' })); part.run('p1', 'm1', 'legacy', now, JSON.stringify({ type: 'text', text: 'Inspect tests' }));
  msg.run('m2', 'legacy', now+1, now+1, JSON.stringify({ role: 'assistant', finish: 'stop', tokens: { input: 12, output: 3, cache: { read: 8, write: 2 } } })); part.run('p2', 'm2', 'legacy', now+1, JSON.stringify({ type: 'tool', callID: 'call', tool: 'read', state: { status: 'completed' } }));
  const result = await opencode.create({ roots: [root] }).scan(), session = result.sessions[0]; assert.equal(session.currentTask, 'Inspect tests'); assert.equal(session.status, 'completed'); assert.equal(session.lastTool.status, 'completed'); assert.deepEqual(session.tokenUsage, { input: 22, cachedInput: 8, output: 3 });
});

test('OpenCode v2 isolates invalid message and part records from healthy sessions', async t => {
  const root = await fixture(t), db = new Database(path.join(root, 'opencode.db')); t.after(() => db.close());
  db.exec('CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE session_part (message_id TEXT, ordinal INTEGER, data TEXT)');
  const now = Date.now(), session = db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?)'), msg = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)'), part = db.prepare('INSERT INTO session_part VALUES (?,?,?)');
  session.run('good', root, 'Healthy', now); session.run('bad', root, 'Damaged', now - 1);
  msg.run('good-user', 'good', 'user', 1, now, now, JSON.stringify({ text: 'Healthy task' }));
  msg.run('good-assistant', 'good', 'assistant', 2, now + 1, now + 1, '{}');
  part.run('good-assistant', 0, 'null'); part.run('good-assistant', 1, JSON.stringify({ type: 'tool', name: 'read', state: { status: 'running' } }));
  for (const [i, data] of ['null', '[]', '123', '"bad"', '{'].entries()) msg.run('bad-' + i, 'bad', 'user', i + 1, now, now, data);
  const adapter = opencode.create({ roots: [root] });
  const result = await adapter.scan();
  assert.equal(result.sources[0].status, 'ready'); assert.equal(result.sessions.length, 2);
  assert.equal((await adapter.scan()).sessions.length, 2, 'a repeated scan retains healthy sessions');
  const good = result.sessions.find(s => s.id === 'opencode:good');
  assert.equal(good.currentTask, 'Healthy task'); assert.equal(good.currentTool.name, 'read');
  assert.ok(result.unreadable >= 6, 'invalid records are surfaced in diagnostics');
  assert.equal(result.sessions.find(s => s.id === 'opencode:bad').status, 'unknown');
});

test('OpenCode v1 skips invalid message and part records while retaining valid tasks and tools', async t => {
  const root = await fixture(t), db = new Database(path.join(root, 'opencode.db')); t.after(() => db.close());
  db.exec('CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  const now = Date.now(), session = db.prepare('INSERT INTO session VALUES (?,?,?,?)'), msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)'), part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  session.run('good', root, 'Healthy', now); session.run('bad', root, 'Damaged', now - 1);
  msg.run('user', 'good', now, now, JSON.stringify({ role: 'user' }));
  part.run('bad-part', 'user', 'good', now, 'null'); part.run('good-part', 'user', 'good', now + 1, JSON.stringify({ type: 'text', text: 'Healthy task' }));
  msg.run('assistant', 'good', now + 1, now + 1, JSON.stringify({ role: 'assistant' }));
  part.run('bad-tool', 'assistant', 'good', now, '[]'); part.run('good-tool', 'assistant', 'good', now + 1, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'running' } }));
  msg.run('bad', 'bad', now, now, 'null');
  const adapter = opencode.create({ roots: [root] });
  const result = await adapter.scan();
  assert.equal(result.sources[0].status, 'ready'); assert.equal(result.sessions.length, 2);
  assert.equal((await adapter.scan()).sessions.length, 2, 'a repeated scan retains healthy sessions');
  const good = result.sessions.find(s => s.id === 'opencode:good');
  assert.equal(good.currentTask, 'Healthy task'); assert.equal(good.currentTool.name, 'read');
  assert.ok(result.unreadable >= 3, 'invalid records are surfaced in diagnostics');
});
