'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeFixture, replayChatSession, summarizeCopilot } = require('../lib/harnesses/copilot');
const { parseLines } = require('../lib/json-lines');

test('fixture export redacts identifying fields, bodies and mutation values while retaining lifecycle schema', () => {
  const raw = [{ id: 'PRIVATE_ID', type: 'tool.execution_start', timestamp: '2026-10-27T00:00:00Z', data: { toolCallId: 'PRIVATE_CALL', toolName: 'run_in_terminal', arguments: { command: 'PRIVATE_COMMAND' }, context: { cwd: '/PRIVATE_PATH' }, content: 'PRIVATE_PROMPT' } }, { kind: 1, k: ['requests', 0, 'message', 'text'], v: 'PRIVATE_MUTATION' }];
  const clean = sanitizeFixture(raw);
  assert.equal(JSON.stringify(clean).includes('PRIVATE'), false);
  assert.equal(clean[0].type, 'tool.execution_start'); assert.equal(clean[0].data.toolName, 'run_in_terminal');
  assert.deepEqual(clean[1].k, ['requests', 0, 'message', 'text']);
  assert.equal(clean[0].data.context.cwd, '/workspace/copilot-fixture');
});

const directory = path.join(__dirname, 'fixtures', 'copilot');
const captures = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(directory, entry.name, 'manifest.json')).filter(file => fs.existsSync(file));
const verified = captures.map(file => ({ file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) })).filter(item => item.manifest.verified);
test('actual Copilot capture availability', { skip: verified.length ? false : 'No working model-backed capture is available; support remains best effort' }, () => assert.ok(verified.length));
for (const { file, manifest } of verified) test('actual Copilot lifecycle: ' + path.basename(path.dirname(file)), () => {
  assert.equal(manifest.origin, 'actual'); assert.ok(manifest.checkpoints.length);
  assert.notEqual(manifest.versions.vscode, 'unrecorded'); assert.notEqual(manifest.versions.copilot, 'unrecorded');
  const records = manifest.files.flatMap(input => parseLines(fs.readFileSync(path.join(path.dirname(file), input.name), 'utf8')));
  for (const checkpoint of manifest.checkpoints) {
    const prefix = records.slice(0, checkpoint.records);
    const input = manifest.format === 'chat-jsonl' ? { chat: replayChatSession(prefix) } : { [manifest.format === 'debug' ? 'debug' : 'transcript']: prefix };
    const summary = summarizeCopilot({ id: 'fixture', cwd: '/workspace/copilot-fixture', ...input });
    assert.equal(summary.status, checkpoint.status);
    if (checkpoint.currentTool) assert.equal(summary.currentTool?.name, checkpoint.currentTool);
    if (checkpoint.tokenUsage) assert.deepEqual(summary.tokenUsage, checkpoint.tokenUsage);
  }
});
