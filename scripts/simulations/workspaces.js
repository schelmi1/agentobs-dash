'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { Observer } = require('../../lib/observer');
const { createDashboard } = require('../../lib/server');
const { defaults } = require('../../lib/config');
const { createWorkspacePlacement } = require('./workspace-placement');

async function runWorkspaceSimulation() {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : Number(process.argv[index + 1]);
  };
  const speed = argument('--speed', 1);
  const cycles = argument('--cycles', process.argv.includes('--loop') ? Infinity : 1);
  const verifyLayout = process.argv.includes('--headless') || process.argv.includes('--close');
  let holdSeconds = argument('--hold-seconds', 15);
  if (!Number.isFinite(speed) || speed < .25 || speed > 30) throw new Error('--speed must be between 0.25 and 30');
  if (cycles !== Infinity && (!Number.isInteger(cycles) || cycles < 1 || cycles > 1000)) throw new Error('--cycles must be an integer between 1 and 1000');
  if (!Number.isFinite(holdSeconds) || holdSeconds < 0 || holdSeconds > 300) throw new Error('--hold-seconds must be between 0 and 300');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-WORKSPACE-SIMULATION-'));
  const root = path.join(temporary, 'projects'), sessions = path.join(temporary, 'sessions'), artifacts = path.join(temporary, 'artifacts');
  await Promise.all([root, sessions, artifacts].map(directory => fs.mkdir(directory)));
  const stamp = Date.now(), duration = 3000 / speed, checks = [], errors = [], timeline = [], samples = [], timings = [];
  const plans = [
    { name: 'Frontend', workspace: 'web', teams: ['Parser', 'UI', 'Tests', 'Research', 'Review'], nested: true, periods: [[0, 6], [8, 14], [22, 26]] },
    { name: 'API', workspace: 'api', teams: ['Routes', 'Database'], periods: [[1, 9], [13, 19], [26, 29]] },
    { name: 'Docs', workspace: 'docs', teams: ['Examples'], periods: [[2, 5], [16, 18], [27, 30]] },
    { name: 'QA', workspace: 'web', teams: ['Browser', 'Accessibility'], periods: [[3, 11], [20, 24], [28, 31]] }
  ];
  let index = 0;
  for (const plan of plans) {
    plan.cwd = path.join(root, plan.workspace); await fs.mkdir(plan.cwd, { recursive: true });
    plan.id = 'simulation-' + stamp + '-' + plan.name.toLowerCase(); plan.active = false; plan.turn = 0;
    const agent = (name, agentPath, parent) => ({ name, agentPath, parent, plan, index: index++, started: false });
    plan.main = agent(plan.name, '/root/' + plan.name.toLowerCase());
    plan.children = plan.teams.map(name => agent(plan.name + '-' + name, plan.main.agentPath + '/' + name.toLowerCase(), plan.main));
    plan.nestedAgents = plan.nested ? plan.children.flatMap(parent => ['Worker', 'Checker'].map(role => agent(parent.name + '-' + role, parent.agentPath + '/' + role.toLowerCase(), parent))) : [];
    plan.agents = [plan.main, ...plan.children, ...plan.nestedAgents];
  }
  const row = (type, payload) => ({ type, timestamp: new Date().toISOString(), payload });
  const append = (agent, ...rows) => fs.appendFile(path.join(sessions, 'rollout-' + agent.name + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const call = (id, name, args, namespace) => row('response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) });
  const result = (id, output = { exit_code: 0 }) => row('response_item', { type: 'function_call_output', call_id: id, output });
  const progress = text => row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Simulation] ' + text }] });
  const title = agent => '[Simulation] ' + agent.name + ' · overlapping workspace activity';
  const start = async plan => {
    plan.active = true; plan.turn++;
    for (const agent of plan.agents) {
      if (!agent.started) {
        await append(agent, row('session_meta', { session_id: plan.id, agent_path: agent.agentPath, agent_nickname: agent.name, cwd: plan.cwd, cli_version: '0.164.0' }));
        agent.started = true;
        if (agent.parent) {
          const id = 'spawn-' + agent.name;
          await append(agent.parent, call(id, 'spawn_agent', { task_name: agent.name }, 'collaboration'), result(id, JSON.stringify({ task_name: agent.agentPath })));
        }
      }
      await append(agent, row('event_msg', { type: 'task_started', turn_id: 'turn-' + plan.turn }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: title(agent) }] }), progress((plan.turn > 1 ? 'Resumed' : 'Started') + ' turn ' + plan.turn + '. Watch this workspace position.'));
    }
  };
  const finish = async plan => {
    plan.active = false;
    for (const agent of [...plan.agents].reverse()) await append(agent, progress('Turn ' + plan.turn + ' complete. This run will resume later in the scenario.'), row('event_msg', { type: 'task_complete', turn_id: 'turn-' + plan.turn }));
  };
  const tools = [['exec_command', { cmd: 'npm test' }], ['read', {}], ['apply_patch', {}], ['exec_command', { cmd: 'git diff' }], ['web_search_call', {}], ['exec_command', { cmd: 'rg --files' }]];
  const usage = agent => row('token_usage_record', { usage: { input_tokens: agent.calls * 1000 + agent.index * 250, cached_input_tokens: agent.calls * 500, output_tokens: agent.calls * 100 } });
  const placement = createWorkspacePlacement(holdSeconds * 1000 / speed);
  const comparisons = new Map([0, 5, 15, 30, 60].map(seconds => [seconds, { policy: createWorkspacePlacement(seconds * 1000 / speed), previous: [], moves: 0, removals: 0 }]));
  const baseline = { previous: [], moves: 0, removals: 0 };
  const movement = (state, next) => {
    state.moves += next.filter((id, position) => state.previous.includes(id) && state.previous.indexOf(id) !== position).length;
    state.removals += state.previous.filter(id => !next.includes(id)).length;
    state.previous = next;
  };
  const config = { ...defaults, rootFolder: root, sessionRoots: [sessions], copilotRoots: [], port: Number(process.env.AGENTOBS_DEMO_PORT || 4321), pollIntervalMs: Math.max(25, Math.round(500 / speed)) };
  const observer = new Observer(config);
  let began = Date.now(), latest, browser, closed = false, dashboard;
  const realLive = node => !node.archived || node.children.some(realLive);
  const preview = { async scan() {
    const model = await observer.scan(), now = Date.now();
    movement(baseline, model.forest.filter(realLive).map(node => node.id));
    for (const state of comparisons.values()) movement(state, state.policy.update(model.forest, now).visible.map(node => node.id));
    const layout = placement.update(model.forest, now);
    const ranks = new Map(); layout.visible.forEach(node => { if (!ranks.has(node.cwd)) ranks.set(node.cwd, ranks.size); });
    const agents = { ...model.agents }; for (const node of layout.forest) agents[node.id] = node;
    latest = { simulatedSeconds: (now - began) * speed / 1000, raw: model.forest.filter(realLive).map(node => node.name), visible: layout.visible.map(node => ({ id: node.id, name: node.name, held: Boolean(node.layoutHeld) })) };
    return { ...model, agents, forest: layout.forest, runs: layout.forest.map(node => model.runs.find(run => run.id === node.id)), workspaces: [...model.workspaces].sort((a, b) => (ranks.get(a.cwd) ?? Infinity) - (ranks.get(b.cwd) ?? Infinity) || a.label.localeCompare(b.label)) };
  } };
  dashboard = createDashboard(config, { observer: preview });
  const close = async () => { if (closed) return; closed = true; if (browser) await browser.close(); await dashboard.close(); };
  const onSignal = () => close().then(() => process.exit(0)); process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const url = await dashboard.start();
    console.log('WORKSPACE SIMULATION ' + url + '\n4 main runs / 3 workspaces / 20 subagents. Completion hold: ' + holdSeconds + 's; speed: ' + speed + 'x.\nEach cycle is about 99 simulated seconds. Artifacts: ' + artifacts);
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: process.argv.includes('--headless'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    browser.once('disconnected', () => close().catch(() => {}));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.exposeFunction('agentobsDemoSetHold', seconds => {
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) throw new Error('Invalid demo hold');
      holdSeconds = seconds; placement.setHoldMs(seconds * 1000 / speed); return seconds;
    });
    await context.addInitScript(({ hold, speed }) => {
      localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'orbit', theme: 'rounded', colors: 'dark-plus' }));
      window.addEventListener('agentobs:render', event => {
        const model = event.detail?.model; if (!model) return;
        const visible = node => node.layoutHeld || !node.archived || node.children.some(visible);
        window.agentobsDemoFrame = { sequence: model.health.sequence, panels: model.forest.filter(visible).map(node => node.id) };
      });
      window.addEventListener('DOMContentLoaded', () => {
        const panel = document.createElement('div'); panel.id = 'simulation-controls'; panel.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 0;color:var(--muted);font-size:11px';
        panel.dataset.holdSeconds = hold;
        const label = document.createElement('label'); label.textContent = 'Simulation · keep completed workspace in place: ';
        const select = document.createElement('select'); select.id = 'simulation-hold'; select.style.cssText = 'width:auto;min-height:28px';
        for (const value of [...new Set([0, 5, 15, 30, 60, hold])].sort((a, b) => a - b)) { const option = document.createElement('option'); option.value = value; option.textContent = value + 's'; select.append(option); }
        select.value = hold; select.onchange = async () => { try { panel.dataset.holdSeconds = await window.agentobsDemoSetHold(Number(select.value)); } catch (error) { select.value = panel.dataset.holdSeconds; console.error(error); } };
        label.append(select); const phase = document.createElement('span'); phase.id = 'simulation-phase'; phase.textContent = 'Preparing · speed ' + speed + 'x';
        panel.append(label, phase); document.querySelector('#app').before(panel);
      });
    }, { hold: holdSeconds, speed });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await page.goto(url);
    const check = async (label, predicate, value) => { await page.waitForFunction(predicate, value, { timeout: 10000 }); checks.push(label); if (checks.length > 5000) checks.shift(); };
    const hold = async deadline => { while (!closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now()))); };
    const initialHold = holdSeconds;
    await page.locator('#simulation-hold').selectOption('30');
    await check('Demo hold dropdown updates the presentation policy', () => document.querySelector('#simulation-controls').dataset.holdSeconds === '30');
    assert.equal(holdSeconds, 30);
    await page.locator('#simulation-hold').selectOption(String(initialHold));
    await check('Demo hold dropdown restores the selected experiment', expected => document.querySelector('#simulation-controls').dataset.holdSeconds === String(expected), initialHold);
    began = Date.now();
    let cycle = 0;
    do {
      cycle++;
      for (let tick = 0; tick <= 32 && !closed; tick++) {
        const actions = [];
        for (const plan of plans) {
          if (plan.periods.some(([, end]) => end === tick)) { await finish(plan); actions.push(plan.name + ' completed'); }
          if (plan.periods.some(([start]) => start === tick)) { await start(plan); actions.push(plan.name + (plan.turn > 1 ? ' resumed' : ' started')); }
        }
        const active = plans.filter(plan => plan.active).flatMap(plan => plan.agents);
        for (const agent of active) {
          const [name, args] = tools[(agent.index + tick) % tools.length]; agent.calls = (agent.calls || 0) + 1; agent.currentCall = 'activity-' + cycle + '-' + tick + '-' + agent.name;
          await append(agent, call(agent.currentCall, name, args), usage(agent), progress(name + ' · turn ' + agent.plan.turn + ' · ' + 3 + ' simulated seconds'));
        }
        const written = Date.now(), phase = 'Cycle ' + cycle + ' · ' + tick * 3 + 's · ' + (actions.join(', ') || active.length + ' agents using tools');
        console.log(phase);
        await page.evaluate(text => { document.querySelector('#simulation-phase').textContent = text; }, phase);
        // Interactive demos permit filters, collapsed branches and other designs.
        // Automated runs additionally assert the full unfiltered Orbit layout.
        if (verifyLayout) await check(phase, expected => [...document.querySelectorAll('.orbit-node .is-current')].length === expected, active.length);
        if (tick === 3) {
          if (verifyLayout) await check('Four overlapping main runs across three workspace paths', () => document.querySelectorAll('.orbit-run').length === 4 && document.querySelector('#metric-workspaces').textContent === '3');
          const snapshot = await (await page.request.get(url + '/api/snapshot')).json();
          assert.equal(snapshot.roots.length, 4); assert.equal(Object.keys(snapshot.agents).length, 24);
          const frontend = Object.values(snapshot.agents).find(agent => agent.name === 'Frontend');
          assert.equal(frontend.childIds.length, 5); assert.ok(frontend.childIds.every(id => snapshot.agents[id].childIds.length === 2));
          await page.screenshot({ path: path.join(artifacts, 'overlapping-main-agents.png'), fullPage: true });
        }
        for (const plan of plans.filter(plan => actions.includes(plan.name + ' resumed'))) {
          const snapshot = await (await page.request.get(url + '/api/snapshot')).json();
          const main = Object.values(snapshot.agents).find(agent => agent.name === plan.name);
          assert.equal(main.id, JSON.stringify([plan.id, plan.main.agentPath]));
          assert.equal(main.archived, false); assert.ok(main.childIds.length); checks.push(plan.name + ' resumed with its original main ID');
        }
        const snapshot = await (await page.request.get(url + '/api/snapshot')).json();
        if (verifyLayout) await check('Rendered panel order follows the selected hold policy at ' + tick * 3 + 's', sequence => {
          const frame = window.agentobsDemoFrame;
          return frame?.sequence >= sequence && [...document.querySelectorAll('.orbit-run')].map(panel => panel.dataset.key).join('|') === frame.panels.join('|');
        }, snapshot.health.sequence);
        for (const agent of Object.values(snapshot.agents).filter(agent => agent.layoutHeld)) { assert.equal(agent.archived, true); assert.equal(agent.displayState, 'completed'); }
        const positions = await page.locator('.orbit-run').evaluateAll(panels => panels.map(panel => ({ id: panel.dataset.key, top: Math.round(panel.getBoundingClientRect().top + scrollY), held: panel.dataset.layoutHeld === 'true' })));
        const previous = samples.at(-1)?.positions;
        if (verifyLayout && previous && previous.map(panel => panel.id).join('|') === positions.map(panel => panel.id).join('|')) assert.ok(positions.every((panel, index) => Math.abs(panel.top - previous[index].top) <= 1), 'Panels must not shift when the same workspace slots remain present');
        samples.push({ cycle, tick, holdSeconds, ...latest, positions }); if (samples.length > 5000) samples.shift();
        timeline.push({ cycle, simulatedSeconds: tick * 3, actions, activeAgents: active.length }); if (timeline.length > 5000) timeline.shift();
        if (actions.some(action => action.endsWith('completed'))) await page.screenshot({ path: path.join(artifacts, 'completion-hold-latest.png'), fullPage: true });
        await hold(written + duration);
        if (closed) break;
        timings.push({ cycle, tick, activeAgents: active.length, durationMs: Date.now() - written }); if (timings.length > 5000) timings.shift();
        await Promise.all(active.map(agent => append(agent, result(agent.currentCall))));
      }
      if (closed) break;
      assert.deepEqual(errors, []);
      assert.ok(timings.every(timing => timing.durationMs >= duration));
      const report = { status: 'passed', url, cycle, mainRuns: 4, workspaces: 3, totalAgents: 24, holdSeconds, speed, toolDurationMs: duration, checks, errors, comparison: { activitySorted: { panelMoves: baseline.moves, removals: baseline.removals }, ...Object.fromEntries([...comparisons].map(([seconds, state]) => [seconds + 's', { panelMoves: state.moves, removals: state.removals }])) }, timeline, samples, timings };
      await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
      await context.tracing.stop({ path: path.join(artifacts, 'trace-cycle-' + cycle + '.zip') });
      console.log('CYCLE COMPLETE: ' + checks.length + ' checks passed. Movement comparison: ' + JSON.stringify(report.comparison) + '\nReport: ' + path.join(artifacts, 'report.json'));
      if (cycle < cycles && !closed) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    } while (cycle < cycles && !closed);
    if (process.argv.includes('--close')) await close();
    else if (!closed) console.log('Dashboard remains open. Use --loop for repeated activity; close the browser or press Ctrl+C to stop.');
  } catch (error) { if (!closed) { await close(); throw error; } }
}

module.exports = { runWorkspaceSimulation };
