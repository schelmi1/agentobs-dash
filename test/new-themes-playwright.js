'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { Observer } = require('../lib/observer');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-new-themes-'));
  const at = new Date().toISOString();
  const session = (id, task, extra = {}) => ({ id, cwd: root, provider: 'fixture', providerLabel: 'Codex', status: 'active', hasLifecycle: true, lastActivity: at, currentTask: task, agentName: id, ...extra });
  const adapter = { id: 'fixture', async scan() { return { sessions: [
    session('Coordinator', 'Coordinate the release and review the agent work', { currentTool: { id: 'main', name: 'exec_command', label: 'Exec · npm', status: 'in_progress' }, tokenUsage: { input: 45000, cachedInput: 30000, output: 2400 } }),
    session('Researcher', 'Investigate the production incident', { parentId: 'Coordinator', currentTool: { id: 'web', name: 'web_search_call', label: 'Web search', status: 'in_progress' } }),
    session('Builder', 'Implement the dashboard fixes', { parentId: 'Coordinator', currentTool: { id: 'patch', name: 'apply_patch', label: 'Apply patch', status: 'in_progress' } }),
    session('Reviewer', 'Review the resulting changes', { parentId: 'Builder', needsInput: true }),
    session('Analyst', 'Compare throughput and latency', { parentId: 'Coordinator', attentionState: 'failed' })
  ], sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 1000 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.modern-agent');
    const graph = page.locator('.modern-graph-viewport').first();
    const geometry = () => graph.locator('.modern-item').evaluateAll(items => items.map(item => [item.style.left, item.style.top]));
    const initial = await geometry();
    for (const [name, id] of [['Flat', 'flat'], ['Layered', 'layered'], ['Glass', 'glass']]) {
      await page.getByRole('button', { name: 'Choose theme' }).click(); await page.getByRole('menuitemradio', { name, exact: true }).click();
      assert.equal(await page.locator('html').getAttribute('data-dashboard-theme'), id);
      assert.deepEqual(await geometry(), initial, name + ' preserves graph geometry');
      assert.equal(await page.locator('.modern-links path').count(), 4);
      assert.equal(await page.locator('.modern-call').count(), 3);
      if (process.env.AGENTOBS_SCREENSHOT_DIR) { await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, id + '.png') }); }
      await page.reload(); await page.waitForSelector('.modern-agent');
      assert.equal(await page.locator('html').getAttribute('data-dashboard-theme'), id, name + ' survives reload');
    }
    await page.locator('.modern-agent').first().click();
    if (process.env.AGENTOBS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'glass-inspector.png') });
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await page.locator('.inspector').evaluate(node => getComputedStyle(node).backdropFilter), 'none', 'Glass has a solid forced-colors fallback');
    await page.emulateMedia({ forcedColors: 'none' });
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Glass fits the phone viewport');
    await page.getByRole('button', { name: 'Close ×' }).click();
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    assert.equal(await page.locator('.modern-swarm-node').count(), 5, 'Compact retains all agents under Glass');
    assert.deepEqual(errors, []);
    console.log('PASS Flat, Layered and Glass geometry, persistence, fallback, phone and Compact');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
