'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { defaults, initialize, resolveConfig } = require('../lib/config');
const { Observer, withinRoot } = require('../lib/observer');
const { createDashboard } = require('../lib/server');

const stamp = () => new Date().toISOString();
const record = (type, payload) => ({ type, timestamp: stamp(), payload });
function rollout(id, cwd, extra = []) {
  return [record('session_meta', { session_id: id, cwd, cli_version: '0.164.0' }),
    record('event_msg', { type: 'task_started', turn_id: 'turn' }),
    record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Implement ' + id }] }), ...extra];
}
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'root');
  const store = path.join(temporary, 'sessions');
  await fs.mkdir(root); await fs.mkdir(store);
  const write = async (name, records) => {
    const file = path.join(store, 'rollout-' + name + '.jsonl');
    await fs.writeFile(file, records.map(value => JSON.stringify(value)).join('\n') + '\n');
    return file;
  };
  return { root, store, write, config: { ...defaults, rootFolder: root, sessionRoots: [store], port: 0, pollIntervalMs: 500 } };
}

test('root containment rejects prefix siblings and parent traversal', () => {
  assert.equal(withinRoot('/project', '/project'), true);
  assert.equal(withinRoot('/project', '/project/nested/repo'), true);
  assert.equal(withinRoot('/project', '/project-other'), false);
  assert.equal(withinRoot('/project', '/project/../private'), false);
  assert.equal(withinRoot('/project', 'relative'), false);
  assert.equal(withinRoot('/', '/project'), true);
});

test('init saves reusable configuration without overwriting existing settings', async t => {
  const { root, store } = await fixture(t);
  const first = await initialize(root, { sessionRoots: [store], port: 4567 });
  assert.equal((await resolveConfig(root)).port, 4567);
  await initialize(root, { port: 9876 });
  assert.equal((await resolveConfig(root)).port, 4567);
  assert.equal((await resolveConfig(root, { port: 8765 })).port, 8765);
  assert.equal(JSON.parse(await fs.readFile(first.configFile, 'utf8')).sessionRoots[0], store);
  await assert.rejects(resolveConfig(root, { pollIntervalMs: 0 }), /pollIntervalMs/);
  await assert.rejects(resolveConfig(root, { port: 99999 }), /port/);
  assert.equal((await resolveConfig(root)).failedInactiveAfterMs, 900000);
  await assert.rejects(resolveConfig(root, { failedInactiveAfterMs: 0 }), /failedInactiveAfterMs/);
  assert.equal((await resolveConfig(root)).quietHistoryAfterMs, 1800000);
  await assert.rejects(resolveConfig(root, { quietHistoryAfterMs: 0 }), /quietHistoryAfterMs/);
});

test('observer discovers nested workspaces, excludes outsiders and guardians, and refreshes cached lifecycle', async t => {
  const { root, store, write, config } = await fixture(t);
  const first = await write('a', rollout('alpha', path.join(root, 'a')));
  await write('b', rollout('beta', path.join(root, 'nested', 'b')));
  await write('outside', rollout('outside', root + '-other'));
  await write('guardian', [record('session_meta', { session_id: 'alpha', cwd: root, source: { subagent: { other: 'guardian' } } }), record('event_msg', { type: 'task_complete' })]);
  const observer = new Observer(config);
  const reads = t.mock.method(fs, 'open');
  const readsOfFirst = () => reads.mock.calls.filter(call => call.arguments[0] === first).length;
  let model = await observer.scan();
  assert.equal(model.runs.length, 2);
  assert.equal(model.workspaces.length, 2);
  assert.equal(readsOfFirst(), 1);
  model = await observer.scan();
  assert.equal(readsOfFirst(), 1, 'unchanged transcripts reuse summaries without reading again');
  await fs.appendFile(first, JSON.stringify(record('event_msg', { type: 'task_complete', turn_id: 'turn' })) + '\n');
  model = await observer.scan();
  assert.equal(Object.values(model.agents).find(agent => agent.shortId === 'alpha').displayState, 'completed');
  assert.equal(readsOfFirst(), 2, 'changed transcripts are read again');
  await fs.unlink(first);
  model = await observer.scan();
  assert.equal(model.runs.length, 1);
  assert.equal(readsOfFirst(), 2, 'deleted transcripts are no longer read');
  assert.equal(model.sources[0].directory, store);
});

test('observer preserves parent/child hierarchy and excludes raw tool payloads', async t => {
  const { root, write, config } = await fixture(t);
  const hidden = 'PRIVATE_ARGUMENT_AND_OUTPUT';
  await write('parent', rollout('family', root, [
    record('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn', arguments: JSON.stringify({ task_name: 'child', message: 'Review the parser' }) }),
    record('response_item', { type: 'function_call_output', call_id: 'spawn', output: JSON.stringify({ task_name: '/root/child' }) })
  ]));
  const child = rollout('family', root, [record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'cmd', arguments: JSON.stringify({ cmd: 'echo ' + hidden }) }), record('response_item', { type: 'function_call_output', call_id: 'cmd', output: hidden })]);
  child[0].payload.agent_path = '/root/child';
  await write('child', child);
  const model = await new Observer(config).scan();
  assert.equal(model.forest.length, 1);
  assert.equal(model.forest[0].children.length, 1);
  assert.equal(model.forest[0].children[0].agentPath, '/root/child');
  assert.equal(JSON.stringify(model).includes(hidden), false);
});

test('cached sessions still become quiet and move into the quiet section as time passes', async t => {
  const { root, write, config } = await fixture(t);
  const records = rollout('quiet', root);
  for (const row of records) row.timestamp = new Date(Date.now() - 20000).toISOString();
  await write('quiet', records);
  const observer = new Observer({ ...config, staleAfterMs: 10000, quietHistoryAfterMs: 15000 });
  const model = await observer.scan();
  assert.equal(model.forest[0].displayState, 'quiet');
  assert.equal(model.forest[0].historyGroup, 'quiet');
  observer.config.staleAfterMs = 60000;
  assert.equal((await observer.scan()).forest[0].displayState, 'working', 'quiet policy does not mutate cached base status');
});

test('failed unfinished turns retain their failure and archive after 15 minutes instead of becoming quiet', async t => {
  const { root, write, config } = await fixture(t);
  const rows = rollout('failure', root, [
    record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'failed-test', arguments: '{"cmd":"npm test"}' }),
    record('response_item', { type: 'function_call_output', call_id: 'failed-test', output: { exit_code: 1, output: 'Test failed' } })
  ]);
  for (const row of rows) row.timestamp = new Date(Date.now() - 900001).toISOString();
  await write('failure', rows);
  const observer = new Observer(config);
  for (let scan = 0; scan < 2; scan++) {
    const agent = (await observer.scan()).forest[0];
    assert.equal(agent.displayState, 'failed');
    assert.equal(agent.historyGroup, 'inactive');
    assert.equal(agent.needsAttention, false);
  }
  const custom = (await new Observer({ ...config, failedInactiveAfterMs: 1800000 }).scan()).forest[0];
  assert.equal(custom.displayState, 'failed');
  assert.equal(custom.archived, false);
});

test('partial trailing lines, corrupt files, missing stores, and symlinks are handled', async t => {
  const { root, store, write, config } = await fixture(t);
  const file = await write('partial', rollout('partial', root));
  await fs.appendFile(file, '{"type":');
  await fs.writeFile(path.join(store, 'rollout-bad.jsonl'), 'not JSON\n');
  const escaped = path.join(path.dirname(store), 'escape');
  await fs.mkdir(escaped);
  await fs.writeFile(path.join(escaped, 'rollout-secret.jsonl'), rollout('secret', root).map(JSON.stringify).join('\n'));
  await fs.symlink(escaped, path.join(store, 'linked'));
  const model = await new Observer({ ...config, sessionRoots: [store, path.join(store, 'missing')] }).scan();
  assert.equal(model.runs.length, 1);
  assert.equal(model.unreadableFiles, 1);
  assert.equal(model.sources[1].status, 'missing');
});

test('canonical root scoping includes a workspace reached through a symlink alias', async t => {
  const { root, store, write, config } = await fixture(t);
  await fs.symlink(root, path.join(path.dirname(store), 'alias'));
  await write('alias', rollout('alias', path.join(path.dirname(store), 'alias')));
  const model = await new Observer(config).scan();
  assert.equal(model.runs.length, 1);
  assert.equal(model.forest[0].cwd, root);
});

test('HTTP serves dashboard, read-only scoped API, and live SSE lifecycle changes', async t => {
  const { root, write, config } = await fixture(t);
  const file = await write('http', rollout('http', root));
  const dashboard = createDashboard(config);
  const url = await dashboard.start();
  t.after(() => dashboard.close());
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Mission control/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(url + '/api/snapshot')).status, 200);
  assert.equal((await fetch(url + '/api/snapshot', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(url + '/api/snapshot', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(url + '/api/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + '/package.json')).status, 404);
  assert.equal((await fetch(url + '/%2e%2e/.codex/auth.json')).status, 404);
  const forbidden = await new Promise((resolve, reject) => {
    const request = http.get(url + '/api/snapshot', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(forbidden, 403);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(url + '/api/events', { signal: controller.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"displayState":"working"/);
  await fs.appendFile(file, JSON.stringify(record('event_msg', { type: 'task_complete', turn_id: 'turn' })) + '\n');
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    while (!text.includes('"displayState":"completed"')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"displayState":"completed"/);
  } finally { clearTimeout(deadline); controller.abort(); }
});

test('startup stream reports transcript progress before the first snapshot', async t => {
  const { root, write, config } = await fixture(t);
  await write('startup', rollout('startup', root));
  const realObserver = new Observer(config);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const observer = { async scan(onProgress) { onProgress(); await gate; return realObserver.scan(); } };
  const dashboard = createDashboard(config, { observer });
  const url = await dashboard.start();
  const controller = new AbortController();
  t.after(async () => { release(); controller.abort(); await dashboard.close(); });
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url + '/api/events', { signal: controller.signal });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: startup-progress')) received += decoder.decode((await reader.read()).value);
    assert.match(received, /"filesProcessed":1/);
    assert.doesNotMatch(received, /"protocolVersion"/);
    release();
    while (!received.includes('"protocolVersion"')) received += decoder.decode((await reader.read()).value);
    assert.match(received, /"displayState":"working"/);
  } finally { clearTimeout(deadline); }
});

test('CLI rejects invalid options and can initialize an arbitrary root', async t => {
  const { root, store } = await fixture(t);
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../bin/agentobs.js'), ...args]);
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  assert.equal((await run(['--help'])).code, 0);
  assert.equal((await run(['--bad'])).code, 1);
  const copilotStores = [path.join(store, 'copilot-first'), path.join(store, 'copilot-second')];
  const result = await run(['init', root, '--sessions', store, '--copilot-storage', copilotStores[0], '--copilot-storage', copilotStores[1], '--port', '4321']);
  assert.equal(result.code, 0, result.output);
  assert.equal((await resolveConfig(root)).port, 4321);
  assert.deepEqual((await resolveConfig(root)).sessionRoots, [store]);
  assert.deepEqual((await resolveConfig(root)).copilotRoots, copilotStores, 'registry-defined CLI flags remain repeatable and persist their stores');
});

module.exports = { rollout, record };
