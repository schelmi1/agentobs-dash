#!/usr/bin/env node
'use strict';
// Capture four synthetic projects without reading local transcripts.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { createDashboard } = require('../lib/server');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');

const root = '/demo/agentobs';
const projects = [
  ['Atlas', 'Build the product API', 'codex', 'Codex'],
  ['Beacon', 'Design the dashboard', 'claude-code', 'Claude Code'],
  ['Horizon', 'Review release security', 'opencode', 'OpenCode'],
  ['Launchpad', 'Prepare the deployment', 'copilot-vscode', 'VS Code Copilot'],
];
const tools = [['exec_command', 'Exec · npm'], ['read', 'Read'], ['apply_patch', 'Apply patch'], ['exec_command', 'Exec · git'], ['web_search_call', 'Web search'], ['exec_command', 'Exec · rg']];
// Broad fan-out, gradually spawned specialist teams, deep binary delegation,
// and an uneven tree give each workspace a visibly different hierarchy.
const parentFor = [
  () => 0,
  i => {
    const leaders = [1, 5, 10, 16, 23];
    return leaders.includes(i) ? 0 : leaders.filter(leader => leader < i).at(-1);
  },
  i => Math.floor((i - 1) / 2),
  i => i <= 3 ? 0 : i <= 12 ? 1 : i <= 19 ? 2 : 3 + (i - 20) % 4,
];
let step = 0;
const adapter = { id: 'fixture', async scan() {
  const now = new Date().toISOString();
  const sessions = projects.flatMap(([project, task, provider, providerLabel], p) => {
    const count = Math.min([22, 29, 31, 25][p], 3 + Math.max(0, Math.floor((step - p * 3) / [3, 2, 2, 3][p])));
    return Array.from({ length: count }, (_, i) => {
      const [name, label] = tools[(i * 5 + p + Math.floor(step / 8)) % tools.length];
      return { id: `${project}-${i}`, ...(i ? { parentId: `${project}-${parentFor[p](i)}` } : {}),
        cwd: `${root}/${project.toLowerCase()}`, provider, providerLabel,
        agentName: i ? `Agent ${i}` : 'Coordinator', currentTask: i ? `Work on ${project}` : task,
        status: 'active', hasLifecycle: true, lastActivity: now,
        tokenUsage: { input: 12000 + i * 80, cachedInput: 7000 + i * 30, output: 900 + i * 4 },
        currentTool: { id: `${project}-tool-${i}-${Math.floor(step / 8)}`, name, label, status: 'in_progress', timestamp: now, startedAt: now } };
    });
  });
  return { sessions, sources: [], unreadable: 0 };
} };

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-multi-readme-'));
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 50 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) });
  let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
    await page.addInitScript(() => localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'modern', theme: 'rounded', colors: 'dark', modernSwarm: true, modernWorkspaceArrangement: 'grid' })));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelectorAll('.modern-run').length === 4 && document.querySelectorAll('.modern-swarm-node').length >= 12);
    const labels = await page.locator('.modern-provider-label').allTextContents();
    for (const label of ['CODEX', 'CLAUDE CODE', 'OPENCODE', 'VS CODE COPILOT']) if (!labels.includes(label)) throw new Error(`Missing harness label: ${label}`);
    const runs = page.locator('.modern-runs').first();
    const boxes = await page.locator('.modern-runs > .modern-run').evaluateAll(nodes => nodes.map(n => ({ x: n.offsetLeft, y: n.offsetTop })));
    if (!(boxes[0].y === boxes[1].y && boxes[2].y > boxes[0].y)) throw new Error('Expected a two-column grid');
    // Capture a fixed rectangle: content changes can slightly resize the grid,
    // and changing frame dimensions leaves stale pixels in an optimized GIF.
    step = 100;
    await page.waitForTimeout(300);
    const bounds = await runs.boundingBox();
    const clip = { x: bounds.x, y: bounds.y + await page.evaluate(() => window.scrollY), width: bounds.width, height: bounds.height };
    step = 0;
    await page.waitForTimeout(300);
    if (process.argv.includes('--verify-layout')) {
      const heights = () => page.locator('.modern-graph-viewport').evaluateAll(nodes => nodes.map(node => node.clientHeight));
      const geometry = () => page.locator('.modern-runs > .modern-run').evaluateAll(nodes => nodes.map(node => ({ y: node.offsetTop, height: node.offsetHeight, tools: node.querySelector('.modern-tools-panel').offsetHeight })));
      const before = await heights();
      const panelsBefore = await geometry();
      for (let value = 1; value <= 100; value++) {
        step = value;
        await page.waitForTimeout(65);
        const after = await heights(), panelsAfter = await geometry();
        if (new Set([...before, ...after]).size !== 1) throw new Error(`Graph viewport heights changed at step ${value}: ${before} -> ${after}`);
        if (JSON.stringify(panelsBefore) !== JSON.stringify(panelsAfter)) throw new Error(`Workspace geometry changed at step ${value}: ${JSON.stringify(panelsBefore)} -> ${JSON.stringify(panelsAfter)}`);
      }
      console.log(`PASS four stable workspaces and ${before[0]}px graph viewports throughout 100 updates`);
      return;
    }
    const frames = path.join(temp, 'frames'); await fs.mkdir(frames);
    for (let frame = 0; frame < 100; frame++) {
      step = frame;
      await page.waitForTimeout(100);
      await page.screenshot({ clip, path: path.join(frames, `${frame}`.padStart(3, '0') + '.png') });
    }
    const target = path.join(__dirname, '..', 'docs', 'assets', 'multi-project-grid.gif');
    const encoder = spawnSync('python3', [path.join(__dirname, 'encode-readme-gif.py'), frames, target, '100'], { encoding: 'utf8', env: { ...process.env, AGENTOBS_GIF_SIZE: '1000x1330' } });
    if (encoder.status !== 0) throw new Error(encoder.stderr || 'GIF encoding failed');
    console.log(encoder.stdout.trim());
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
