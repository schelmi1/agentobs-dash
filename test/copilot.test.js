'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { replayChatSession, summarizeCopilot, copilotStorageRoots } = require('../lib/harnesses/copilot');
const { parseJsonc } = require('../lib/json-lines');
const { resolveConfig, defaults } = require('../lib/config');
const { Observer } = require('../lib/observer');
const { createCopilotDemo } = require('../scripts/copilot-demo');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-copilot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const demo = await createCopilotDemo(root);
  const config = { ...defaults, rootFolder: root, sessionRoots: [], copilotRoots: [demo.storage] };
  return { ...demo, config, observer: new Observer(config) };
}
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const find = (model, id) => Object.values(model.agents).find(agent => agent.id === JSON.stringify(['copilot-vscode:' + id, '', 'copilot-vscode']));

test('VS Code mutation replay handles updates, array truncation, deletion and replacement without mutating cached input', () => {
  const initial = { kind: 0, v: { sessionId: 'test', requests: [{ response: ['a', 'b'] }], title: 'old' } };
  const rows = [initial, { kind: 1, k: ['title'], v: 'new' }, { kind: 2, k: ['requests', 0, 'response'], i: 1, v: ['c'] }, { kind: 3, k: ['title'] }];
  assert.deepEqual(replayChatSession(rows), { sessionId: 'test', requests: [{ response: ['a', 'c'] }] });
  assert.equal(initial.v.title, 'old');
  assert.deepEqual(replayChatSession([...rows, { kind: 0, v: { requests: [] } }]), { requests: [] });
  for (const k of [['__proto__', 'polluted'], ['requests', 'constructor', 'polluted'], ['absent', 'property']]) assert.throws(() => replayChatSession([initial, { kind: 1, k, v: true }]));
  assert.throws(() => replayChatSession([{ kind: 1, k: ['requests'], v: [] }]), /Invalid/);
  assert.throws(() => replayChatSession([initial, { kind: 2, k: ['requests'], i: 100000000 }]), /Invalid/);
  assert.equal({}.polluted, undefined);
});

test('JSONC workspace parser preserves URL strings, escaped quotes and literal comment text', () => {
  assert.deepEqual(parseJsonc('\uFEFF{ // comment\n "folder": "file:///tmp/a", "text": "/*data*/,}\\\"", /* note */ "folders": [1,], }'), { folder: 'file:///tmp/a', text: '/*data*/,}"', folders: [1] });
});

test('Copilot storage defaults follow platform conventions and configuration accepts explicit roots', async t => {
  const { root } = await fixture(t);
  assert.equal(copilotStorageRoots({ XDG_CONFIG_HOME: '/custom' }, '/home/demo', 'linux')[0], '/custom/Code/User/workspaceStorage');
  assert.equal(copilotStorageRoots({}, '/Users/demo', 'darwin')[0], '/Users/demo/Library/Application Support/Code/User/workspaceStorage');
  const config = await resolveConfig(root, { copilotRoots: ['store', 'store'] });
  assert.deepEqual(config.copilotRoots, [path.join(root, 'store')]);
  await assert.rejects(resolveConfig(root, { copilotRoots: [null] }), /copilotRoots/);
});

test('observer reads tools, failures, nested agents and tokens without leaking raw arguments or output', async t => {
  const demo = await fixture(t), model = await demo.observer.scan();
  assert.equal(model.unreadableFiles, 0);
  assert.equal(model.forest.length, 2);
  assert.equal(model.workspaces.length, 2);
  const main = find(model, demo.ids.main), parser = find(model, demo.ids.parser), reviewer = find(model, demo.ids.reviewer);
  assert.equal(main.provider, 'copilot-vscode');
  assert.equal(main.children[0].id, parser.id);
  assert.equal(parser.children[0].id, reviewer.id);
  assert.equal(parser.currentTool.name, 'run_in_terminal');
  assert.equal(reviewer.displayState, 'completed');
  assert.equal(find(model, demo.ids.failed).displayState, 'failed');
  assert.equal(find(model, demo.ids.failed).tokenUsage, undefined);
  assert.deepEqual(main.tokenUsage, { input: 12000, cachedInput: 8000, output: 900 });
  assert.deepEqual(main.subagents.tokenUsage, { input: 8000, cachedInput: 4000, output: 800 });
  assert.equal(JSON.stringify(model).includes(demo.privateText), false);
  assert.deepEqual((await demo.observer.scan()).forest[0].subagents.tokenUsage, main.subagents.tokenUsage, 'cached scans do not add usage again');
});

test('live appends, failures, retries, completion, delegation and resume update cached sessions', async t => {
  const demo = await fixture(t);
  await demo.observer.scan();
  await demo.finishTool(demo.ids.parser, 'parser-tests', false);
  assert.equal(find(await demo.observer.scan(), demo.ids.parser).displayState, 'failed');
  await demo.transcript(demo.ids.parser, 'assistant.turn_start', { turnId: 'retry' });
  await demo.tool(demo.ids.parser, 'retry-tests');
  assert.equal(find(await demo.observer.scan(), demo.ids.parser).displayState, 'tool');
  await demo.finishTool(demo.ids.parser, 'retry-tests');
  await demo.complete();
  let model = await demo.observer.scan();
  assert.equal(find(model, demo.ids.main).displayState, 'completed');
  await demo.resume();
  model = await demo.observer.scan();
  assert.equal(find(model, demo.ids.parser).displayState, 'tool');
  assert.equal(find(model, demo.ids.main).status, 'delegating');
  await demo.usage(demo.ids.parser, 1000, 0, 100);
  assert.equal(find(await demo.observer.scan(), demo.ids.parser).tokenUsage.input, 7000);
});

test('an assistant loop iteration with requested tools does not finish the user task', () => {
  const at = new Date().toISOString();
  const transcript = [
    { type: 'assistant.turn_start', timestamp: at, data: {} },
    { type: 'assistant.message', timestamp: at, data: { toolRequests: [{ toolCallId: 'a' }] } },
    { type: 'assistant.turn_end', timestamp: at, data: {} }
  ];
  assert.equal(summarizeCopilot({ id: 'loop', cwd: '/workspace', transcript }).status, 'active');
});

test('new Copilot requests retire abandoned tools and clear earlier tool failures', () => {
  const rows = [
    { type: 'tool.execution_start', data: { toolCallId: 'failed', toolName: 'read_file' } },
    { type: 'tool.execution_complete', data: { toolCallId: 'failed', success: false } },
    { type: 'tool.execution_start', data: { toolCallId: 'abandoned', toolName: 'read_file' } },
    { type: 'user.message', data: { content: 'New request' } },
    { type: 'assistant.turn_start', data: {} }
  ].map((row, i) => ({ ...row, timestamp: new Date(1700000000000 + i).toISOString() }));
  const session = summarizeCopilot({ id: 'new-turn', cwd: '/workspace', transcript: rows });
  assert.equal(session.status, 'active');
  assert.equal(session.currentTool, undefined);
  assert.equal(session.attentionState, 'running');
  assert.equal(session.toolHistory.at(-1).status, 'interrupted');
});

test('duplicate spans are counted once per run and debug tools never duplicate transcript tools', async t => {
  const demo = await fixture(t);
  const log = await fs.readFile(demo.logFor(demo.ids.parser), 'utf8');
  await fs.appendFile(demo.logFor(demo.ids.parser), log);
  await demo.debug(demo.ids.parser, 'tool_call', 'run_in_terminal', { args: demo.privateText, result: demo.privateText }, { dur: 10 });
  const parser = find(await demo.observer.scan(), demo.ids.parser);
  assert.deepEqual(parser.tokenUsage, { input: 6000, cachedInput: 3000, output: 500 });
  assert.equal(parser.toolHistory.length, 1);
});

test('root scope excludes outside workspaces, refuses directory symlinks, and does not expose ancillary children', async t => {
  const demo = await fixture(t);
  const apiMeta = path.join(demo.storage, 'agentobs-demo-api', 'workspace.json');
  await fs.writeFile(apiMeta, JSON.stringify({ folder: pathToFileURL(demo.root + '-outside').href }));
  await fs.symlink(path.join(demo.storage, 'agentobs-demo-web'), path.join(demo.storage, 'linked-workspace'));
  await demo.debug('title-generator', 'session_start', 'session_start', { parentSessionId: demo.ids.main, label: 'title' });
  const model = await demo.observer.scan();
  assert.equal(model.forest.length, 1);
  assert.equal(Object.values(model.agents).length, 3);
  assert.equal(model.workspaces.length, 1);
  assert.equal(model.unreadableFiles, 0);
});

test('partial writes are tolerated, malformed records report warnings and replacement files invalidate cache', async t => {
  const demo = await fixture(t), file = demo.fileFor(demo.ids.main);
  await demo.observer.scan();
  await fs.appendFile(file, '{"type":');
  assert.equal((await demo.observer.scan()).unreadableFiles, 0);
  await fs.appendFile(file, 'broken}\n');
  for (let scan = 0; scan < 2; scan++) {
    const model = await demo.observer.scan();
    assert.equal(model.unreadableFiles, 1);
    assert.deepEqual(model.health.fileIssues, [{ file, code: 'MALFORMED_RECORD', provider: 'copilot-vscode' }]);
  }
  const rows = [{ type: 'session.start', timestamp: new Date().toISOString(), data: { version: 1, sessionId: demo.ids.main, context: { cwd: demo.cwd } } }, { type: 'user.message', timestamp: new Date().toISOString(), data: { content: '[Demo] Replacement task' } }];
  await fs.writeFile(file + '.new', lines(rows)); await fs.rename(file + '.new', file);
  const model = await demo.observer.scan();
  assert.equal(model.unreadableFiles, 0);
  assert.equal(model.health.fileIssues, undefined);
  assert.equal(find(model, demo.ids.main).title, '[Demo] Replacement task');
});

test('unsupported transcript versions retain file diagnostics in cached workspace summaries', async t => {
  const demo = await fixture(t), file = demo.fileFor('unsupported');
  await fs.writeFile(file, lines([{ type: 'session.start', data: { version: 999, sessionId: 'unsupported' } }]));
  for (let scan = 0; scan < 2; scan++) {
    const model = await demo.observer.scan();
    assert.equal(model.unreadableFiles, 1);
    assert.deepEqual(model.health.fileIssues, [{ file, code: 'UNSUPPORTED_FORMAT', provider: 'copilot-vscode' }]);
  }
  await fs.unlink(file);
  assert.equal((await demo.observer.scan()).health.fileIssues, undefined);
});

test('legacy JSON and mutation logs combine with transcript sessions without duplicate cards', async t => {
  const demo = await fixture(t);
  const dir = path.join(demo.storage, 'agentobs-demo-web', 'chatSessions');
  await fs.mkdir(dir);
  const state = { version: 3, sessionId: demo.ids.main, responderUsername: 'GitHub Copilot', requests: [{ requestId: 'main', timestamp: Date.now() - 60000, message: { text: 'Old task' } }] };
  await fs.writeFile(path.join(dir, demo.ids.main + '.json'), JSON.stringify(state));
  await fs.writeFile(path.join(dir, 'empty.jsonl'), lines([{ kind: 0, v: { ...state, sessionId: 'empty', requests: [] } }]));
  const model = await demo.observer.scan();
  assert.equal(Object.values(model.agents).length, 4);
  assert.match(find(model, demo.ids.main).title, /Copilot coordinator/);
});

test('missing child log creates a Starting placeholder and unrelated title children are ignored', async t => {
  const demo = await fixture(t);
  await demo.debug(demo.ids.main, 'child_session_ref', 'subagent: Pending', { childSessionId: 'pending', label: 'subagent: Pending' });
  await demo.debug(demo.ids.main, 'child_session_ref', 'title', { childSessionId: 'title', label: 'title' });
  const model = await demo.observer.scan();
  assert.equal(find(model, 'pending').displayState, 'starting');
  assert.equal(find(model, 'title'), undefined);
});

test('multi-root workspace uses recorded cwd and never guesses the first folder', async t => {
  const demo = await fixture(t);
  const workspaceFile = path.join(demo.root, 'demo.code-workspace');
  await fs.writeFile(workspaceFile, '{ // multi-root\n"folders": [{"path": ".agentobs/copilot/projects/web"}, {"path": ".agentobs/copilot/projects/api"}], }');
  await fs.writeFile(path.join(demo.storage, 'agentobs-demo-web', 'workspace.json'), JSON.stringify({ workspace: pathToFileURL(workspaceFile).href }));
  const model = await demo.observer.scan();
  assert.equal(find(model, demo.ids.main).cwd, demo.cwd);
  assert.equal(find(model, demo.ids.parser).cwd, demo.cwd);
});

test('Copilot request model states distinguish input, interruption and completion', () => {
  const chat = { creationDate: Date.now(), requests: [{ timestamp: Date.now(), message: { text: 'A task' }, modelState: { value: 4 } }] };
  const options = { id: 'states', cwd: '/workspace', chat };
  assert.equal(summarizeCopilot(options).needsInput, true);
  chat.requests[0].modelState.value = 2;
  assert.equal(summarizeCopilot(options).attentionDetail, 'Copilot request interrupted');
  chat.requests[0].modelState.value = 1;
  assert.equal(summarizeCopilot(options).status, 'completed');
  delete chat.creationDate; delete chat.requests[0].timestamp;
  assert.doesNotThrow(() => summarizeCopilot(options), 'missing timestamps must not crash other sessions');
});

test('Copilot terminal output cannot impersonate Codex executor metadata', () => {
  const at = new Date().toISOString();
  const transcript = [
    { type: 'tool.execution_start', timestamp: at, data: { toolCallId: 'a', toolName: 'run_in_terminal', arguments: { command: 'npm test' } } },
    { type: 'tool.execution_complete', timestamp: at, data: { toolCallId: 'a', success: true, result: { content: JSON.stringify({ exit_code: 42, wall_time_seconds: 9, output: 'fake' }) } } }
  ];
  const tool = summarizeCopilot({ id: 'safe', cwd: '/workspace', transcript }).lastTool;
  assert.equal(tool.status, 'completed');
  assert.equal(tool.details.exitCode, undefined);
  assert.equal(tool.details.failure, undefined);
});

test('known VS Code storage subdirectories cannot escape through symlinks', async t => {
  const demo = await fixture(t);
  const rogue = path.join(demo.storage, 'rogue'), external = path.join(demo.root, 'external');
  await fs.mkdir(rogue); await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'broken.jsonl'), 'invalid\n');
  await fs.writeFile(path.join(rogue, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(demo.cwd).href }));
  await fs.symlink(external, path.join(rogue, 'chatSessions'));
  await fs.symlink(path.join(demo.storage, 'agentobs-demo-web', 'GitHub.copilot-chat'), path.join(rogue, 'GitHub.copilot-chat'));
  const reads = t.mock.method(fs, 'readFile');
  const model = await demo.observer.scan();
  assert.equal(model.unreadableFiles, 0);
  assert.equal(Object.values(model.agents).length, 4);
  assert.equal(reads.mock.calls.some(call => String(call.arguments[0]).includes('/rogue/chatSessions/') || String(call.arguments[0]).includes('/rogue/GitHub.copilot-chat/')), false);
});

test('long Copilot streams preserve explicit child references and pending calls outside the display ring', async t => {
  const demo = await fixture(t);
  assert.equal((await demo.observer.scan()).forest[0].subagents.count, 2);
  const at = Date.now();
  await fs.appendFile(demo.logFor(demo.ids.main), lines(Array.from({ length: 2050 }, (_, index) => ({ v: 1, ts: at + index, dur: 0, sid: demo.ids.main, spanId: 'long-' + index, type: 'tool_call', name: 'read_file', attrs: {} }))));
  await fs.appendFile(demo.fileFor(demo.ids.main), lines(Array.from({ length: 2050 }, (_, index) => ({ id: 'progress-' + index, timestamp: new Date(at + index).toISOString(), type: 'assistant.message', data: { content: 'Progress ' + index, toolRequests: [] } }))));
  const model = await demo.observer.scan(), main = find(model, demo.ids.main);
  assert.equal(main.subagents.count, 2); assert.equal(main.currentTool.name, 'runSubagent');
  assert.equal(model.unreadableFiles, 0);
  assert.deepEqual(main.tokenUsage, { input: 12000, cachedInput: 8000, output: 900 });
});

test('capture tooling exports synthetic provenance without asserting actual Copilot verification', async t => {
  const demo = await fixture(t), output = path.join(demo.root, 'exported-fixture');
  await require('../scripts/copilot-fixture').main(['--input', demo.fileFor(demo.ids.main), '--format', 'transcript', '--out', output, '--origin', 'synthetic', '--vscode-version', '1.141.0', '--copilot-version', '0.69.0']);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.origin, 'synthetic'); assert.equal(manifest.verified, false);
  const serialized = await fs.readFile(path.join(output, manifest.files[0].name), 'utf8');
  for (const privateValue of [demo.privateText, demo.cwd, demo.ids.main]) assert.equal(serialized.includes(privateValue), false);
});

test('Copilot streams outlive 10000 events while retaining cumulative usage and recent deduplication', async t => {
  const demo = await fixture(t), at = Date.now();
  const events = Array.from({ length: 10050 }, (_, i) => ({ id: 'long-lived-' + i, timestamp: new Date(at + i).toISOString(), type: 'assistant.message', data: { content: 'Still working', toolRequests: [] } }));
  const calls = Array.from({ length: 10050 }, (_, i) => ({ v: 1, ts: at + i, dur: 0, sid: demo.ids.main, spanId: 'usage-' + i, type: 'llm_request', attrs: { inputTokens: 2, cachedTokens: 1, outputTokens: 1 } }));
  await fs.appendFile(demo.fileFor(demo.ids.main), lines([...events, events.at(-1)]));
  await fs.appendFile(demo.logFor(demo.ids.main), lines([...calls, calls.at(-1)]));
  let model = await demo.observer.scan();
  assert.equal(model.unreadableFiles, 0);
  assert.deepEqual(find(model, demo.ids.main).tokenUsage, { input: 32100, cachedInput: 18050, output: 10950 });
  model = await demo.observer.scan();
  assert.deepEqual(find(model, demo.ids.main).tokenUsage, { input: 32100, cachedInput: 18050, output: 10950 });
  await fs.appendFile(demo.logFor(demo.ids.main), 'bad JSON\n');
  model = await demo.observer.scan();
  assert.equal(find(model, demo.ids.main).observationStale, true);
  assert.deepEqual(find(model, demo.ids.main).tokenUsage, { input: 32100, cachedInput: 18050, output: 10950 });
});

test('large Copilot tool results do not make the workspace observation unavailable', async t => {
  const demo = await fixture(t);
  t.after(() => demo.observer.close());
  const before = await demo.observer.scan();
  assert.equal(find(before, demo.ids.parser).displayState, 'tool');
  await demo.transcript(demo.ids.parser, 'tool.execution_complete', { toolCallId: 'parser-tests', success: true, result: { content: 'x'.repeat(5 * 1024 * 1024) } });
  const model = await demo.observer.scan();
  assert.equal(model.unreadableFiles, 0);
  assert.equal(find(model, demo.ids.parser).observationStale, false);
  assert.notEqual(find(model, demo.ids.parser).displayState, 'stale');
  assert.equal(find(model, demo.ids.main).observationStale, false);
  assert.equal(JSON.stringify(model).includes('x'.repeat(1000)), false);
});

test('Copilot string limiting preserves valid JSON and Unicode across chunks and rejects malformed strings', () => {
  const { createStringLimiter } = require('../lib/harnesses/copilot-strings');
  const original = { type: 'tool.execution_complete', data: { toolCallId: 'tool', result: { content: 'abcé🛰️\\"\n'.repeat(3000) } }, id: 'end' };
  const input = Buffer.from(JSON.stringify(original));
  for (const chunkSize of [1, 13, 257, 65536]) {
    const limit = createStringLimiter(4096), chunks = [];
    for (let i = 0; i < input.length; i += chunkSize) chunks.push(limit(input.subarray(i, i + chunkSize)));
    const result = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(result.id, 'end');
    assert.equal(result.data.toolCallId, 'tool');
    assert.ok(original.data.result.content.startsWith(result.data.result.content));
    assert.ok(result.data.result.content.length < original.data.result.content.length);
    assert.ok(!result.data.result.content.includes('\ufffd'));
  }
  const bad = createStringLimiter(2);
  assert.throws(() => bad(Buffer.from('{"text":"long\\q"}')), /MALFORMED_RECORD/);
  assert.throws(() => createStringLimiter(2)(Buffer.from('{"text":"long\\uXX00"}')), /MALFORMED_RECORD/);
});

test('large Copilot legacy JSON chat content remains observable', async t => {
  const demo = await fixture(t);
  t.after(() => demo.observer.close());
  const chatDir = path.join(demo.storage, 'agentobs-demo-api', 'chatSessions');
  const jsonl = path.join(chatDir, demo.ids.failed + '.jsonl');
  const chat = JSON.parse((await fs.readFile(jsonl, 'utf8')).trim()).v;
  chat.requests[0].response.push({ kind: 'text', value: 'x'.repeat(5 * 1024 * 1024) });
  await fs.unlink(jsonl);
  await fs.writeFile(path.join(chatDir, demo.ids.failed + '.json'), JSON.stringify(chat));
  const model = await demo.observer.scan();
  assert.equal(model.unreadableFiles, 0);
  assert.equal(find(model, demo.ids.failed).displayState, 'failed');
  assert.equal(find(model, demo.ids.failed).observationStale, false);
});
