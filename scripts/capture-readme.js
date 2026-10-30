#!/usr/bin/env node
'use strict';
// Capture an isolated, synthetic swarm; no real transcripts are read.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { createDashboard } = require('../lib/server');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');
const output = path.join(__dirname, '..', 'docs', 'assets');
const root = '/demo/agentobs';
const tools = [['exec_command','Exec · npm'], ['read','Read'], ['apply_patch','Apply patch'], ['exec_command','Exec · git'], ['web_search_call','Web search'], ['exec_command','Exec · rg'], ['send_message','Send message'], ['view_image','View image']];
const names = ['Research', 'API', 'Interface', 'Tests', 'Security', 'Performance', 'Documentation', 'Release'];
const agents = Array.from({ length: 145 }, (_, i) => {
  const parent = i === 0 ? null : i <= 8 ? 0 : i <= 48 ? 1 + (i - 9) % 8 : 9 + (i - 49) % 40;
  const level = i === 0 ? 0 : i <= 8 ? 1 : i <= 48 ? 2 : 3;
  const name = i === 0 ? 'Coordinator' : i <= 8 ? names[i-1] : i <= 48 ? names[(i-9)%8] + ' specialist ' + (1 + Math.floor((i-9)/8)) : 'Worker ' + (i - 48);
  const task = i === 0 ? 'Coordinate a product release' : i <= 8 ? ['Research the requirements','Build the API','Design the interface','Verify the release','Review security','Improve performance','Write documentation','Prepare the release'][i-1] : 'Investigate and complete delegated work';
  return { id: 'demo-' + i, ...(parent === null ? {} : { parentId: 'demo-' + parent }), cwd: root, provider: 'fixture', providerLabel: 'Simulation', agentName: name, currentTask: task, hasLifecycle: true, level };
});
let count = 1, phase = 0, cardExample = false;
const adapter = { id: 'fixture', async scan() {
  const now = new Date().toISOString();
  const visible = cardExample ? [0, 1, 2, 9, 17].map(i => agents[i]) : agents.slice(0, count);
  return { sessions: visible.map((agent, i) => {
    const [name, label] = tools[(i * 5 + phase) % tools.length], active = i === 0 || (i * 13 + phase * 7) % 10 < 8;
    const call = { id: 'tool-' + i + '-' + phase, name, label, status: active ? 'in_progress' : 'completed', timestamp: now, startedAt: now, ...(!active ? { completedAt: now } : {}) };
    return { ...agent, status: 'active', lastActivity: now, tokenUsage: { input: 12000 + i * 80, cachedInput: 7000 + i * 30, output: 900 + i * 4 }, ...(active ? { currentTool: call } : { toolHistory: [call] }) };
  }), sources: [], unreadable: 0 };
} };
async function main() {
  const swarmOnly = process.argv.includes('--swarm-only');
  const detailsOnly = process.argv.includes('--details-only');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-readme-')); await fs.mkdir(output, { recursive: true });
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 50 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start(); browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'modern', theme: 'rounded', colors: 'dark', modernSwarm: false, modernWorkspaceArrangement: 'column' })));
    count = 9; await page.goto(url); await page.waitForSelector('.modern-agent');
    await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 9);
    if (!swarmOnly && !detailsOnly) {
      await page.screenshot({ path: path.join(output, 'agent-network.png') });
      cardExample = true;
      await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 5);
      const resize = page.getByRole('button', { name: 'Resize workspace Coordinate a product release' });
      for (let i = 0; i < 9; i++) { await resize.focus(); await page.keyboard.press('ArrowDown'); }
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: path.join(output, 'delegation-cards.png'), fullPage: true });
      for (let i = 0; i < 9; i++) { await resize.focus(); await page.keyboard.press('ArrowUp'); }
      await page.evaluate(() => window.scrollTo(0, 0));
      cardExample = false;
    }
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    await page.waitForSelector('.modern-swarm-node');
    const run = page.locator('.modern-run').first();
    // Fit once at full size so the animation does not jump between zoom levels.
    count = 145; await page.waitForFunction(() => document.querySelectorAll('.modern-swarm-node').length === 145);
    await run.getByRole('button', { name: 'Fit agents in Coordinate a product release' }).click();
    const encodeArgs = [path.join(__dirname, 'encode-readme-gif.py')];
    if (!detailsOnly) {
      count = 1; await page.waitForFunction(() => document.querySelectorAll('.modern-swarm-node').length === 1);
      const frames = path.join(temp, 'frames'); await fs.mkdir(frames);
      for (let frame = 0; frame < 180; frame++) {
        count = Math.min(145, 1 + frame); phase = Math.floor(frame / 20);
        await page.waitForFunction(expected => document.querySelectorAll('.modern-swarm-node').length === expected, count);
        await page.screenshot({ path: path.join(frames, String(frame).padStart(3, '0') + '.png') });
      }
      encodeArgs.push(frames, path.join(output, 'compact-swarm.gif'), '50');
    }
    await page.waitForFunction(() => document.querySelectorAll('.modern-swarm-node').length === 145);
    await run.getByRole('button', { name: 'Fit agents in Coordinate a product release' }).click();
    if (!swarmOnly && !detailsOnly) await page.screenshot({ path: path.join(output, 'compact-network.png') });
    // Hover different levels to reveal each agent's real preview card.
    if (!swarmOnly) {
      const detailFrames = path.join(temp, 'detail'); await fs.mkdir(detailFrames);
      let frame = 0;
      for (const index of [0, 1, 9, 20, 50]) {
        await page.mouse.move(280, 200);
        const node = run.locator('.modern-swarm-node').nth(index);
        await node.hover();
        await page.locator('.modern-swarm-preview').waitFor({ state: 'visible' });
        for (let i = 0; i < 6; i++) {
          await page.waitForTimeout(150);
          await page.screenshot({ path: path.join(detailFrames, String(frame++).padStart(3, '0') + '.png') });
        }
      }
      encodeArgs.push(detailFrames, path.join(output, 'compact-details.gif'), '150');
    }
    const encoder = spawnSync('python3', encodeArgs, { encoding: 'utf8' });
    if (encoder.status !== 0) throw new Error(encoder.stderr || 'GIF encoding failed');
    console.log(encoder.stdout.trim());
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
