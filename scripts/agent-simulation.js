#!/usr/bin/env node
'use strict';

// Writes clearly labelled synthetic transcripts into a temporary store. Tool
// names/arguments are display fixtures; none of the described commands execute.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-NESTED-SIMULATION-'));
  const root = path.join(temporary, 'projects'), sessions = path.join(temporary, 'sessions'), artifacts = path.join(temporary, 'artifacts');
  await Promise.all([root, sessions, artifacts].map(directory => fs.mkdir(directory)));
  const family = 'simulation-' + Date.now(), duration = 3000, errors = [], checks = [], timings = [];
  const row = (type, payload) => ({ type, timestamp: new Date().toISOString(), payload });
  const append = (agent, ...rows) => fs.appendFile(path.join(sessions, 'rollout-' + agent.name + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const call = (id, name, args, namespace) => row('response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) });
  const result = (id, output = { exit_code: 0 }) => row('response_item', { type: 'function_call_output', call_id: id, output });
  const progress = (agent, text) => append(agent, row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Simulation] ' + text }] }));
  const usage = (agent, round) => row('token_usage_record', { usage: { input_tokens: 1000 + agent.index * 250 + round * 1000, cached_input_tokens: 500 + agent.index * 100 + round * 500, output_tokens: 100 + agent.index * 25 + round * 100 } });
  const coordinator = { name: 'Coordinator', agentPath: '/root', index: 0 };
  const children = ['Parser', 'UI', 'Tests', 'Research', 'Review'].map((name, index) => ({ name, agentPath: '/root/' + name.toLowerCase(), index: index + 1, parent: coordinator }));
  const nested = children.flatMap((parent, index) => ['Worker', 'Checker'].map((role, offset) => ({ name: parent.name + '-' + role, agentPath: parent.agentPath + '/' + role.toLowerCase(), index: 6 + index * 2 + offset, parent })));
  const agents = [coordinator, ...children, ...nested];
  const start = agent => append(agent,
    row('session_meta', { session_id: family, agent_path: agent.agentPath, agent_nickname: agent.name, cwd: root, cli_version: '0.164.0' }),
    row('event_msg', { type: 'task_started', turn_id: 'simulation-turn' }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Simulation] ' + (agent === coordinator ? 'Coordinate five teams and their nested agents' : agent.name + ': demonstrate varied three-second tool activity') }] }), usage(agent, 0));
  const finish = agent => append(agent, row('event_msg', { type: 'task_complete', turn_id: 'simulation-turn' }));
  const tools = [
    ['exec_command', { cmd: 'npm test' }], ['read', {}], ['apply_patch', {}],
    ['exec_command', { cmd: 'git diff' }], ['web_search_call', {}], ['exec_command', { cmd: 'rg --files' }]
  ];
  const dashboard = createDashboard({ ...defaults, rootFolder: root, sessionRoots: [sessions], copilotRoots: [], pollIntervalMs: 500, port: Number(process.env.AGENTOBS_DEMO_PORT || 4321) });
  let browser, closed = false;
  const close = async () => { if (closed) return; closed = true; if (browser) await browser.close(); await dashboard.close(); };
  const onSignal = () => close().then(() => process.exit(0));
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const url = await dashboard.start();
    console.log('SIMULATION STARTING ' + url + '\nFive direct subagents, two nested agents each; each tool lasts three seconds.\nArtifacts: ' + artifacts);
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: process.argv.includes('--headless'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'orbit', theme: 'rounded', colors: 'dark+' })));
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url);
    const check = async (label, predicate, argument) => { await page.waitForFunction(predicate, argument, { timeout: 10000 }); checks.push(label); console.log('PASS ' + label); };
    const hold = async started => {
      // Timers may wake just before their deadline; keep the full three-second
      // window for even the last file written in a concurrent batch.
      while (Date.now() - started < duration) await new Promise(resolve => setTimeout(resolve, Math.max(1, duration - (Date.now() - started))));
    };
    const spawn = async group => {
      const started = Date.now();
      for (const agent of group) await append(agent.parent, call('spawn-' + agent.name, 'spawn_agent', { task_name: agent.name, message: '[Simulation] ' + agent.name + ' team task' }, 'collaboration'));
      const writtenAt = Date.now();
      await check('Spawn tools are running on the delegating agents', count => document.querySelectorAll('.orbit-node .is-current').length === count, new Set(group.map(agent => agent.parent)).size);
      await hold(writtenAt);
      for (const agent of group) await append(agent.parent, result('spawn-' + agent.name, JSON.stringify({ task_name: agent.agentPath })));
      timings.push({ phase: 'spawn', agents: group.map(agent => agent.name), durationMs: Date.now() - started });
      await check('Spawn placeholders visible for ' + group.length + ' agents', count => document.querySelectorAll('.orbit-node.agent-starting').length === count, group.length);
      await Promise.all(group.map(start));
    };
    await start(coordinator);
    await check('Coordinator appears live in Orbit', () => document.querySelectorAll('.orbit-node').length === 1);
    await spawn(children);
    await check('Five direct subagents replace their placeholders', () => document.querySelectorAll('.orbit-node').length === 6 && !document.querySelector('.agent-starting'));
    await spawn(nested);
    await check('All sixteen agents are visible', () => document.querySelectorAll('.orbit-node').length === 16 && !document.querySelector('.agent-starting'));
    for (let zoom = 0; zoom < 4; zoom++) await page.getByRole('button', { name: 'Zoom out [Simulation] Coordinate five teams and their nested agents', exact: true }).click();
    for (let round = 0; round < tools.length; round++) {
      const started = Date.now();
      await Promise.all(agents.map(async agent => {
        const [name, args] = tools[(agent.index + round) % tools.length];
        await append(agent, call('activity-' + round + '-' + agent.name, name, args), usage(agent, round + 1));
        await progress(agent, name + ' · activity ' + (round + 1) + '/6 · three seconds');
      }));
      const writtenAt = Date.now();
      await check('Round ' + (round + 1) + ': varied tools stream on all sixteen cards', () => document.querySelectorAll('.orbit-node .is-current').length === 16 && new Set([...document.querySelectorAll('.orbit-node .is-current')].map(chip => chip.textContent)).size >= 5);
      if (round === 4) {
        await check('Five tool badges and tokens are visible on every card', () => [...document.querySelectorAll('.orbit-node')].every(card => card.querySelectorAll('.orbit-current-activity .tool-badge').length === 5 && card.querySelector('.orbit-node-tokens')?.textContent.includes(' cached ')));
        await page.screenshot({ path: path.join(artifacts, 'nested-agents-working.png'), fullPage: true });
      }
      await hold(writtenAt);
      await Promise.all(agents.map(agent => append(agent, result('activity-' + round + '-' + agent.name))));
      timings.push({ phase: 'tools', round: round + 1, agents: agents.length, durationMs: Date.now() - started });
    }
    const snapshot = await (await page.request.get(url + '/api/snapshot')).json();
    assert.equal(snapshot.roots.length, 1);
    const rootAgent = snapshot.agents[snapshot.roots[0]];
    assert.equal(rootAgent.childIds.length, 5);
    assert.ok(rootAgent.childIds.every(id => snapshot.agents[id].childIds.length === 2));
    checks.push('API confirms five direct children with two nested children per team');
    await Promise.all(nested.map(finish));
    await check('Completed nested agents hide behind five count buttons', () => document.querySelectorAll('.orbit-node').length === 6 && [...document.querySelectorAll('.orbit-branch-toggle')].filter(button => button.textContent.includes('2 completed')).length === 5);
    await new Promise(resolve => setTimeout(resolve, duration));
    await Promise.all(children.map(finish));
    await progress(coordinator, 'Simulation complete: 5 teams, 10 nested agents, 6 tool activities per agent. Expand completed agents to inspect their history.');
    await check('All fifteen completed subagents collapse behind their count', () => document.querySelectorAll('.orbit-node').length === 1 && document.querySelector('.orbit-branch-toggle')?.textContent.includes('15 completed'));
    await page.screenshot({ path: path.join(artifacts, 'completed-agents-collapsed.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.ok(timings.every(timing => timing.durationMs >= duration));
    await context.tracing.stop({ path: path.join(artifacts, 'trace.zip') });
    await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', url, agents: agents.length, directSubagents: 5, nestedSubagents: 10, toolsPerAgent: tools.length, toolDurationMs: duration, checks, timings, errors }, null, 2));
    console.log('SIMULATION COMPLETE: 16 agents, 96 timed tool calls, 15 completed subagents.\nDashboard remains available at ' + url + '\nReport: ' + path.join(artifacts, 'report.json'));
    if (process.argv.includes('--close')) await close();
    else browser.once('disconnected', () => close().catch(() => {}));
  } catch (error) { await close(); throw error; }
}

if (require.main === module) {
  const index = process.argv.indexOf('--scenario');
  const scenario = index < 0 ? 'workspaces' : process.argv[index + 1];
  const run = scenario === 'nested' ? main : scenario === 'workspaces' ? require('./simulations/workspaces').runWorkspaceSimulation : async () => { throw new Error('--scenario must be workspaces or nested'); };
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
