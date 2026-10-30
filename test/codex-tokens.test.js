'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { summarizeTranscript, create } = require('../lib/harnesses/codex');
const { validateScan } = require('../lib/harnesses/contract');
const { buildSessionForest } = require('../lib/hierarchy');
const { liveMapModel } = require('../lib/live-map-model');

const at = '2026-10-27T21:40:00Z';
const row = (type, payload) => ({ type, timestamp: at, payload });
const meta = (ordinal = 0) => row('session_meta', { id: 'child-thread', session_id: 'family', parent_thread_id: 'family', agent_path: '/root/research', cwd: '/workspace', cli_version: '0.162.0-alpha.17.2', subagent_history_start_ordinal: ordinal });
const usage = (input, cachedInput, output) => ({ input_tokens: input, cached_input_tokens: cachedInput, output_tokens: output });
const own = (counts, thread = 'child-thread') => row('token_usage_record', { thread_id: thread, session_id: 'family', thread_token_usage: counts });
const aggregate = counts => row('event_msg', { type: 'token_count', info: { total_token_usage: counts } });

test('child thread usage survives a history marker beyond the end of its rollout', () => {
  const result = summarizeTranscript([meta(6),
    row('event_msg', { type: 'task_started' }),
    row('response_item', { type: 'function_call', call_id: 'inherited', name: 'exec_command' }),
    own(usage(1000, 800, 10), 'parent-thread'),
    own(usage(120, 80, 12)), own(usage(250, 180, 25)), aggregate(usage(9000, 8000, 900))
  ], 'child.jsonl');
  assert.deepEqual(result.tokenUsage, { input: 250, cachedInput: 180, output: 25 });
  assert.equal(result.hasLifecycle, false);
  assert.equal(result.currentTool, undefined);
  assert.deepEqual(result.toolHistory, []);
});

test('generic parent totals cannot overwrite explicit child thread usage after the fork boundary', () => {
  const result = summarizeTranscript([meta(), own(usage(250, 180, 25)), aggregate(usage(9000, 8000, 900)),
    own(usage(300, 220, 35)), own(usage(12000, 10000, 1200), 'parent-thread'), aggregate(usage(15000, 12000, 1500))
  ], 'child.jsonl');
  assert.deepEqual(result.tokenUsage, { input: 300, cachedInput: 220, output: 35 });
});

test('unattributed or foreign usage before a child history boundary stays unknown', () => {
  for (const record of [aggregate(usage(9000, 8000, 900)), own(usage(1000, 800, 10), 'parent-thread'), row('token_usage_record', { thread_token_usage: usage(1000, 800, 10) })]) {
    assert.equal(summarizeTranscript([meta(100), record], 'child.jsonl').tokenUsage, undefined);
  }
});

test('legacy child token events still work when no explicit thread usage is available', () => {
  const result = summarizeTranscript([meta(), aggregate(usage(120, 80, 12)), aggregate(usage(250, 180, 25))], 'child.jsonl');
  assert.deepEqual(result.tokenUsage, { input: 250, cachedInput: 180, output: 25 });
});

test('explicit zero child usage is preserved and invalid counts cannot replace it', () => {
  const result = summarizeTranscript([meta(100), own(usage(0, 0, 0)), own(usage(-1, null, 'bad')), aggregate(usage(9000, 8000, 900))], 'child.jsonl');
  assert.deepEqual(result.tokenUsage, { input: 0, cachedInput: 0, output: 0 });
});

test('incremental scans retain child totals through validation, hierarchy and run aggregation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-child-tokens-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout-child.jsonl');
  const writeRows = rows => rows.map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(path.join(directory, 'rollout-root.jsonl'), writeRows([
    row('session_meta', { id: 'family', session_id: 'family', cwd: '/workspace', cli_version: '0.162.0-alpha.17.2' }),
    row('event_msg', { type: 'task_started' }), own(usage(5000, 4000, 500), 'family')
  ]));
  await fs.writeFile(file, writeRows([meta(100), own(usage(120, 80, 12)), aggregate(usage(9000, 8000, 900))]));
  const adapter = create({ roots: [directory] });
  const model = async () => liveMapModel(buildSessionForest(validateScan(await adapter.scan()).sessions)).forest[0];
  assert.deepEqual((await model()).subagents, { count: 1, reportingCount: 1, tokenUsage: { input: 120, cachedInput: 80, output: 12 } });
  await fs.appendFile(file, writeRows([own(usage(250, 180, 25)), aggregate(usage(15000, 12000, 1500))]));
  for (let scan = 0; scan < 2; scan++) {
    const run = await model();
    assert.deepEqual(run.tokenUsage, { input: 5000, cachedInput: 4000, output: 500 });
    assert.deepEqual(run.children[0].tokenUsage, { input: 250, cachedInput: 180, output: 25 });
    assert.deepEqual(run.subagents, { count: 1, reportingCount: 1, tokenUsage: { input: 250, cachedInput: 180, output: 25 } });
  }
});
