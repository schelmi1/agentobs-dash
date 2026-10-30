'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTranscript } = require('../lib/harnesses/codex');
const { buildSessionForest } = require('../lib/hierarchy');
const { validateScan } = require('../lib/harnesses/contract');

const at = '2026-10-27T12:00:00Z', before = '2026-10-27T11:00:00Z', later = '2026-10-27T13:00:00Z';
const record = (payload, timestamp = at) => ({ type: 'response_item', timestamp, payload });
const metadata = (agentPath, timestamp = at) => ({ type: 'session_meta', timestamp, payload: { id: 'family', cwd: '/workspace', cli_version: '0.164.0', ...(agentPath ? { agent_path: agentPath, parent_thread_id: 'family', timestamp } : {}) } });
const user = (text, timestamp = at, createdAt) => record({ type: 'message', role: 'user', content: [{ type: 'input_text', text }], ...(createdAt ? { internal_chat_message_metadata_passthrough: { create_time: Date.parse(createdAt) / 1000 } } : {}) }, timestamp);
const parent = message => [metadata(), user('Build the whole application', before),
  record({ type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn', arguments: JSON.stringify({ task_name: 'parser_review', message }) }, before),
  record({ type: 'function_call_output', call_id: 'spawn', output: JSON.stringify({ task_name: '/root/parser_review' }) }, before)];
const assigned = (text, extra = {}) => record({ type: 'agent_message', author: '/root', recipient: '/root/parser_review', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/parser_review\nSender: /root\nPayload:\n' + text }], ...extra });
function childTask(parentRows, childRows) {
  const sessions = [summarizeTranscript(parentRows, '/store/parent.jsonl'), summarizeTranscript(childRows, '/store/child.jsonl')].map(session => ({ ...session, provider: 'codex', providerLabel: 'Codex' }));
  const result = validateScan({ sessions, sources: [], unreadable: 0 });
  assert.equal(result.sessions.length, 2);
  return buildSessionForest(result.sessions)[0].children[0].session;
}

test('copied parent prompts with rewritten timestamps cannot override a child assignment', () => {
  const child = childTask(parent('Inspect parser edge cases'), [metadata('/root/parser_review'),
    user('Build the whole application', later, before)]);
  assert.equal(child.currentTask, 'Inspect parser edge cases');
  assert.equal(child.taskSource, 'parent_spawn');
});

test('encrypted spawn messages use their recorded subtask name instead of copied parent prompts', () => {
  const child = childTask(parent('gAAAA_ENCRYPTED_ASSIGNMENT'), [metadata('/root/parser_review'),
    user('Build the whole application', later, before)]);
  assert.equal(child.currentTask, 'Assigned subtask: parser review');
  assert.equal(JSON.stringify(child).includes('gAAAA'), false);
});

test('a newer genuine child user follow-up still takes precedence over the original assignment', () => {
  const child = childTask(parent('Inspect parser edge cases'), [metadata('/root/parser_review'),
    user('Build the whole application', at, before), user('Now verify incremental reads', later, later)]);
  assert.equal(child.currentTask, 'Now verify incremental reads');
  assert.equal(child.originalAssignment, 'Inspect parser edge cases');
});

test('a plaintext NEW_TASK addressed to the child supplies its actual subtask', () => {
  const child = childTask(parent('gAAAA_ENCRYPTED_ASSIGNMENT'), [metadata('/root/parser_review'),
    user('Build the whole application'), assigned('Inspect parser edge cases')]);
  assert.equal(child.currentTask, 'Inspect parser edge cases');
});

test('an encrypted NEW_TASK clears inherited prompts even when original creation times are unavailable', () => {
  const event = assigned(''); event.payload.content.push({ type: 'encrypted_content', encrypted_content: 'gAAAA_ENCRYPTED_ASSIGNMENT' });
  const child = childTask(parent('Inspect parser edge cases'), [metadata('/root/parser_review'),
    user('Build the whole application', later), { ...event, timestamp: later }]);
  assert.equal(child.currentTask, 'Inspect parser edge cases');
  assert.equal(JSON.stringify(child).includes('gAAAA'), false);
});

test('ordinary messages and assignments addressed to another agent cannot replace the child task', () => {
  const message = assigned('Unrelated conversation'); message.payload.content[0].text = message.payload.content[0].text.replace('NEW_TASK', 'MESSAGE');
  const other = assigned('Someone else\'s task', { recipient: '/root/other' });
  const child = childTask(parent('Inspect parser edge cases'), [metadata('/root/parser_review'), message, other]);
  assert.equal(child.currentTask, 'Inspect parser edge cases');
});
