#!/usr/bin/env node
'use strict';

// Synthetic VS Code files only. Never writes into a real VS Code profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function createCopilotDemo(root, storage = path.join(root, '.agentobs/copilot/workspaceStorage')) {
  const cwd = path.join(root, '.agentobs/copilot/projects/web');
  const other = path.join(root, '.agentobs/copilot/projects/api');
  const workspace = path.join(storage, 'agentobs-demo-web');
  const apiWorkspace = path.join(storage, 'agentobs-demo-api');
  const base = path.join(workspace, 'GitHub.copilot-chat');
  const privateText = 'PRIVATE_COPILOT_DEMO_ARGUMENT_OUTPUT';
  const ids = { main: 'agentobs-demo-main', parser: 'agentobs-demo-parser', reviewer: 'agentobs-demo-reviewer', failed: 'agentobs-demo-failed' };
  let sequence = 0, timestamp = Date.now() - 30000;
  const previousEvent = new Map();
  const now = () => { timestamp = Math.max(timestamp + 1, Date.now()); return timestamp; };
  const line = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const fileFor = id => path.join(base, 'transcripts', id + '.jsonl');
  const logFor = id => path.join(base, 'debug-logs', ids.main, id === ids.main ? 'main.jsonl' : 'subagent-' + id + '.jsonl');
  const transcript = async (id, type, data) => {
    const eventId = 'demo-event-' + ++sequence;
    await fs.appendFile(fileFor(id), line([{ type, data, id: eventId, timestamp: new Date(now()).toISOString(), parentId: previousEvent.get(id) || null }]));
    previousEvent.set(id, eventId);
  };
  const debug = async (id, type, name, attrs = {}, extra = {}) => fs.appendFile(logFor(id), line([{ v: 1, ts: now(), dur: 0, sid: id, type, name, spanId: 'demo-span-' + ++sequence, status: 'ok', attrs, ...extra }]));
  const start = async (id, task) => {
    await fs.writeFile(fileFor(id), ''); await fs.writeFile(logFor(id), '');
    await transcript(id, 'session.start', { sessionId: id, version: 1, producer: 'copilot-chat', copilotVersion: '0.69.0', vscodeVersion: '1.141.0', startTime: new Date(now()).toISOString(), context: { cwd } });
    await debug(id, 'session_start', 'session_start', { copilotVersion: '0.69.0', ...(id !== ids.main ? { parentSessionId: id === ids.reviewer ? ids.parser : ids.main, label: 'subagent' } : {}) });
    await transcript(id, 'user.message', { content: '[Demo] ' + task });
    await transcript(id, 'assistant.turn_start', { turnId: 'demo-turn' });
  };
  const tool = async (id, call, name = 'run_in_terminal') => transcript(id, 'tool.execution_start', { toolCallId: call, toolName: name, arguments: { command: 'npm test ' + privateText } });
  const finishTool = async (id, call, success = true) => transcript(id, 'tool.execution_complete', { toolCallId: call, success, result: { content: privateText } });
  const usage = async (id, inputTokens, cachedTokens, outputTokens) => debug(id, 'llm_request', 'chat:demo-model', { model: 'demo-model', inputTokens, cachedTokens, outputTokens, inputMessages: privateText });
  const finish = async id => {
    await transcript(id, 'assistant.message', { messageId: 'demo-message-' + sequence, content: '[Demo] Checks complete.', toolRequests: [] });
    await transcript(id, 'assistant.turn_end', { turnId: 'demo-turn' });
  };
  // Only replace this generator's two named workspace directories.
  for (const directory of [workspace, apiWorkspace]) await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(path.join(base, 'transcripts'), { recursive: true });
  await fs.mkdir(path.join(base, 'debug-logs', ids.main), { recursive: true });
  await fs.mkdir(path.join(apiWorkspace, 'chatSessions'), { recursive: true });
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(cwd).href }));
  await fs.writeFile(path.join(apiWorkspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(other).href }));
  await start(ids.main, 'Copilot coordinator — build the dashboard');
  await tool(ids.main, 'delegate-parser', 'runSubagent');
  await debug(ids.main, 'child_session_ref', 'subagent: Parser', { childSessionId: ids.parser, childLogFile: 'subagent-' + ids.parser + '.jsonl', label: 'subagent: Parser' });
  await start(ids.parser, 'Parse Copilot transcripts');
  await tool(ids.parser, 'parser-tests');
  await debug(ids.parser, 'child_session_ref', 'subagent: Reviewer', { childSessionId: ids.reviewer, childLogFile: 'subagent-' + ids.reviewer + '.jsonl', label: 'subagent: Reviewer' });
  await start(ids.reviewer, 'Review the transcript parser');
  await tool(ids.reviewer, 'review-files', 'read_file');
  await finishTool(ids.reviewer, 'review-files');
  await usage(ids.reviewer, 2000, 1000, 300); await finish(ids.reviewer);
  await usage(ids.main, 12000, 8000, 900); await usage(ids.parser, 6000, 3000, 500);
  const failedChat = { version: 3, sessionId: ids.failed, creationDate: now(), responderUsername: 'GitHub Copilot', customTitle: '[Demo] Repair the API tests', requests: [{ requestId: 'demo-failed-request', timestamp: now(), message: { text: '[Demo] Repair the API tests' }, agent: { id: 'github.copilot.editsAgent' }, response: [{ kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: 'api-tests', isComplete: true, resultError: { message: '[Demo] Tests failed' } }], modelState: { value: 3, completedAt: now() } }] };
  await fs.writeFile(path.join(apiWorkspace, 'chatSessions', ids.failed + '.jsonl'), line([{ kind: 0, v: failedChat }]));
  return {
    root, storage, cwd, other, ids, fileFor, logFor, privateText, transcript, debug, tool, finishTool, usage, finish,
    async complete() { await finishTool(ids.parser, 'parser-tests'); await finish(ids.parser); await finishTool(ids.main, 'delegate-parser'); await finish(ids.main); },
    async resume() { await transcript(ids.parser, 'user.message', { content: '[Demo] Resume parser checks' }); await transcript(ids.parser, 'assistant.turn_start', { turnId: 'demo-resumed' }); await tool(ids.parser, 'resumed-tests'); }
  };
}

if (require.main === module) createCopilotDemo(path.resolve(process.argv[2] || process.cwd())).then(demo => {
  console.log(`Created clearly labeled Copilot demo sessions.\nStore: ${demo.storage}\nStart: node bin/agentobs.js --root ${JSON.stringify(demo.root)} --copilot-storage ${JSON.stringify(demo.storage)}\nRe-run this command to reset the demo. No Copilot model or subscription is needed.`);
}).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { createCopilotDemo };
