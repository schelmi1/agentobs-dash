'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');
const { create } = require('../lib/harnesses/codex');
const { createImageOmitter } = require('../lib/harnesses/codex-images');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-images-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'rollout-images.jsonl') };
}
const row = (type, payload) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n';
const start = root => row('session_meta', { id: 'main', cwd: root, cli_version: '0.164.0' })
  + row('event_msg', { type: 'task_started' })
  + row('response_item', { type: 'custom_tool_call', name: 'functions.exec', call_id: 'screenshot' });

test('a multi-image tool result over 4 MiB cannot hide a live Codex workspace', async t => {
  const { root, file } = await fixture(t);
  const result = row('response_item', { type: 'custom_tool_call_output', call_id: 'screenshot', output: [
    { type: 'input_text', text: 'Script completed' },
    ...Array.from({ length: 5 }, () => ({ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1024 * 1024) })),
    { type: 'input_text', text: JSON.stringify({ chunk_id: 'image', wall_time_seconds: 1, exit_code: 0, output: '' }) }
  ] });
  assert.ok(Buffer.byteLength(result) > 4 * 1024 * 1024);
  await fs.writeFile(file, start(root) + result + row('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'next' }));
  const observer = new Observer({ ...defaults, rootFolder: root, sessionRoots: [root], copilotRoots: [] });
  for (let poll = 0; poll < 2; poll++) {
    const snapshot = await observer.scan(), agent = Object.values(snapshot.agents).find(a => a.cwd === root);
    assert.ok(agent, 'the main agent remains discoverable after screenshots');
    assert.equal(agent.archived, false);
    assert.equal(agent.displayState, 'tool');
    assert.equal(agent.currentTool.name, 'apply_patch');
    assert.equal(agent.toolHistory[0].status, 'completed', 'the oversized tool result still closes its matching call');
    assert.equal(snapshot.unreadableFiles, 0);
    assert.equal(snapshot.health.status, 'ok');
    assert.equal(JSON.stringify(snapshot).includes('data:image'), false);
  }
  await fs.appendFile(file, row('response_item', { type: 'custom_tool_call_output', call_id: 'next', output: 'done' }));
  const agent = Object.values((await observer.scan()).agents)[0];
  assert.equal(agent.displayState, 'working', 'a later append cannot resurrect the old screenshot tool');
  assert.equal(agent.currentTool, undefined);
});

test('ordinary oversized Codex text records still enforce the record budget', async t => {
  const { root, file } = await fixture(t);
  await fs.writeFile(file, start(root) + row('response_item', { type: 'custom_tool_call_output', call_id: 'screenshot', output: 'X'.repeat(5000) }));
  const result = await create({ roots: [root], limits: { maxRecordBytes: 1024 } }).scan();
  assert.equal(result.unreadable, 1);
  assert.equal(result.fileIssues[0].code, 'RECORD_LIMIT');
});

test('image projection preserves JSON, Unicode, escaped quotes and text mentioning image_url at arbitrary chunk boundaries', () => {
  const record = { content: [
    { type: 'input_text', text: 'Screenshot é🛰️: {"image_url":"keep this text"}\n\\"' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAA\\"\t\u0000' },
    { type: 'input_image', image_url: '' },
    { image_url: { url: 'https://example.test/structured-value' } }
  ], call_id: 'keep', status: 'failed' };
  const raw = Buffer.from(JSON.stringify(record).replace('"image_url":', '"image\\u005furl" \t: \t'));
  const expected = structuredClone(record);
  expected.content[1].image_url = '';
  for (const size of [1, 2, 3, 7, 64, raw.length]) {
    const project = createImageOmitter(), chunks = [];
    for (let offset = 0; offset < raw.length; offset += size) chunks.push(project(raw.subarray(offset, offset + size)));
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), expected);
  }
});

test('malformed image strings cannot masquerade as successful tool results', async t => {
  const { root, file } = await fixture(t);
  const adapter = create({ roots: [root] });
  for (const invalid of ['bad\\q', 'bad\\u00xz', 'bad\tcontrol']) {
    await fs.writeFile(file, start(root) + '{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"screenshot","output":[{"image_url":"' + invalid + '"}]}}\n');
    const result = await adapter.scan();
    assert.equal(result.unreadable, 1);
    assert.equal(result.fileIssues[0].code, 'MALFORMED_RECORD');
    assert.equal(result.sessions.length, 0);
  }
});

test('partial oversized image writes resume across polls and reset after replacement', async t => {
  const { root, file } = await fixture(t);
  const adapter = create({ roots: [root], limits: { maxRecordBytes: 1024 } });
  await fs.writeFile(file, start(root) + '{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"screenshot","output":[{"image_url":"data:image/png;base64,' + 'A'.repeat(100000));
  let result = await adapter.scan();
  assert.equal(result.unreadable, 0);
  assert.equal(result.sessions[0].currentTool.id, 'screenshot', 'an unfinished result cannot close its tool');
  await fs.appendFile(file, 'A'.repeat(100000) + '"}]}}\n' + row('event_msg', { type: 'task_complete' }));
  result = await adapter.scan();
  assert.equal(result.unreadable, 0);
  assert.equal(result.sessions[0].status, 'completed');
  assert.equal(result.sessions[0].toolHistory[0].status, 'completed');
  await fs.writeFile(file, start(root));
  result = await adapter.scan();
  assert.equal(result.sessions[0].status, 'waiting');
  assert.equal(result.sessions[0].recordCount, 3);
});

test('image projection keeps inherited-history ordinals and child lifecycle intact', async t => {
  const { root, file } = await fixture(t);
  const rows = [
    row('session_meta', { id: 'main', cwd: root, agent_path: '/root/child', subagent_history_start_ordinal: 2, cli_version: '0.164.0' }),
    row('response_item', { type: 'custom_tool_call_output', call_id: 'inherited', output: [{ image_url: 'A'.repeat(5000) }] }),
    row('event_msg', { type: 'task_complete' }),
    row('event_msg', { type: 'task_started' }),
    row('response_item', { type: 'custom_tool_call', name: 'read', call_id: 'child-tool' })
  ];
  await fs.writeFile(file, rows.join(''));
  const result = await create({ roots: [root], limits: { maxRecordBytes: 1024 } }).scan();
  assert.equal(result.unreadable, 0);
  assert.equal(result.sessions[0].recordCount, 5);
  assert.equal(result.sessions[0].currentTool.id, 'child-tool');
  assert.equal(result.sessions[0].status, 'waiting');
});

test('a Codex transcript larger than 128 MiB loads across bounded scans and remains live after appends', async t => {
  const { root, file } = await fixture(t);
  const handle = await fs.open(file, 'w');
  try {
    await handle.write(start(root));
    const filler = row('event_msg', { type: 'unrelated', text: 'x'.repeat(1024 * 1024) });
    for (let i = 0; i < 129; i++) await handle.write(filler);
    await handle.write(row('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'latest' }));
  } finally { await handle.close(); }
  const { resolveConfig } = require('../lib/config');
  const config = await resolveConfig(root, { port: 0, sessionRoots: [root], copilotRoots: [], claudeRoots: [], opencodeRoots: [] });
  const observer = new Observer(config); t.after(() => observer.close());
  let result, attempts = 0, bytesRead = 0;
  while (attempts++ < 30) {
    result = await observer.scan();
    assert.equal(result.unreadableFiles, 0, 'bounded loading is not a read failure');
    if (result.loadingFileProgress) { assert.ok(result.loadingFileProgress.bytesRead >= bytesRead, 'byte progress does not go backwards'); bytesRead = result.loadingFileProgress.bytesRead; }
    assert.ok(!(result.health.fileIssues || []).some(issue => issue.code === 'FILE_LIMIT'), 'large Codex files must not be rejected');
    if (Object.values(result.agents).some(session => session.shortId === 'main')) break;
  }
  const session = Object.values(result.agents).find(item => item.shortId === 'main');
  assert.ok(session, 'main session appears after bounded loading using resolved configuration');
  assert.equal(session.displayState, 'tool'); assert.equal(session.currentTool.name, 'apply_patch');
  assert.ok(attempts > 1, 'large transcript is read over multiple scans');
  await fs.appendFile(file, row('event_msg', { type: 'task_complete' }));
  const updated = await observer.scan();
  assert.equal(Object.values(updated.agents).find(item => item.shortId === 'main')?.displayState, 'completed', 'new records update the cached transcript');
});

test('Codex loads a 24 MiB transcript without being throttled to an 8 MiB scan', async t => {
  const { root, file } = await fixture(t);
  const handle = await fs.open(file, 'w');
  try {
    await handle.write(start(root));
    const filler = row('event_msg', { type: 'unrelated', text: 'x'.repeat(1024 * 1024) });
    for (let i = 0; i < 24; i++) await handle.write(filler);
    await handle.write(row('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'latest' }));
  } finally { await handle.close(); }
  const adapter = create({ roots: [root] }); t.after(() => adapter.close());
  const result = await adapter.scan();
  assert.equal(result.deferredFiles || 0, 0, 'ordinary-sized transcript should finish in the first scan');
  assert.equal(result.sessions.find(session => session.id === 'main')?.currentTool.name, 'apply_patch');
});

test('a very large recently changed transcript does not delay other recent workspaces', async t => {
  const { root, file } = await fixture(t), small = path.join(root, 'rollout-other.jsonl');
  const records = id => row('session_meta', { id, cwd: root, cli_version: '0.166.0' }) + row('event_msg', { type: 'task_started' });
  await fs.writeFile(small, records('small'));
  const handle = await fs.open(file, 'w');
  try {
    await handle.write(records('large'));
    const filler = row('event_msg', { type: 'unrelated', text: 'x'.repeat(1024 * 1024) });
    for (let i = 0; i < 65; i++) await handle.write(filler);
  } finally { await handle.close(); }
  const now = Date.now() / 1000; await fs.utimes(small, now - 5, now - 5); await fs.utimes(file, now, now);
  const adapter = create({ roots: [root] }); t.after(() => adapter.close());
  const result = await adapter.scan();
  assert.ok(result.sessions.some(session => session.id === 'small'), 'another recent workspace is visible on the first scan');
  assert.ok(result.deferredFiles > 0, 'the large transcript continues loading');
});
