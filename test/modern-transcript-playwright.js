'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-modern-transcript-'));
  const root = path.join(base, 'projects'), store = path.join(base, 'sessions');
  await fs.mkdir(root); await fs.mkdir(store);
  const row = (type, payload) => ({ type, timestamp: new Date().toISOString(), payload });
  const file = (run, agent) => path.join(store, `rollout-${run}-${agent}.jsonl`);
  const append = (run, agent, ...rows) => fs.appendFile(file(run, agent), rows.map(JSON.stringify).join('\n') + '\n');
  const create = async (run, agent, agentPath) => append(run, agent,
    row('session_meta', { session_id: 'sim-' + run, agent_path: agentPath, agent_nickname: agent, cwd: root, cli_version: '0.166.0' }),
    row('event_msg', { type: 'task_started', turn_id: 'turn-' + run }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${run} ${agent} investigate the workspace` }] }),
    row('token_usage_record', { usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 } }),
    row('response_item', { type: 'function_call', call_id: 'tool-' + agent, name: 'exec_command', arguments: JSON.stringify({ cmd: agent === 'Worker2' ? 'rg --files' : 'npm test' }) }));
  const dashboard = createDashboard({ ...defaults, rootFolder: root, sessionRoots: [store], copilotRoots: [], port: 0, pollIntervalMs: 200 });
  let browser;
  try {
    for (const run of ['One', 'Two']) {
      await create(run, 'Lead', '/root');
      for (let n = 1; n <= 3; n++) await create(run, 'Worker' + n, '/root/worker' + n);
    }
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.agent');
    await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 8);
    assert.equal(await page.locator('.modern-run').count(), 2);
    assert.equal(await page.locator('.modern-links path').count(), 6);
    assert.equal(await page.locator('.modern-execution-caption', { hasText: 'RUNNING TOOL' }).count(), 8);
    await append('One', 'Worker2', row('response_item', { type: 'function_call_output', call_id: 'tool-Worker2', output: JSON.stringify({ exit_code: 0 }) }));
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-run')].some(run => run.querySelector('.modern-run-heading h3')?.textContent.includes('One Lead') && [...run.querySelectorAll('.modern-call-button')].some(node => /rg, Done, Worker2/.test(node.getAttribute('aria-label')))));
    await create('One', 'Nested', '/root/worker2/nested');
    await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 9);
    assert.equal(await page.locator('.modern-links path').count(), 7);
    assert.deepEqual(errors, []);
    console.log('PASS real Codex 0.166 synthetic transcripts: two runs, nested agents, tool completion and live spawn');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
