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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-modern-hierarchy-'));
  const session = (id, parentId) => ({ id, ...(parentId ? { parentId } : {}), currentTask: 'Task ' + id, agentName: 'Agent ' + id, cwd: root, provider: 'fixture', providerLabel: 'Fixture', status: 'active', hasLifecycle: true, lastActivity: new Date().toISOString() });
  const sessions = [session('main')];
  for (let i = 0; i < 120; i++) sessions.push(session('child-' + i, 'main'));
  for (let i = 0; i < 70; i++) sessions.push(session('nested-' + i, 'child-' + i));
  sessions.push(session('deep', 'nested-50'));
  const adapter = { id: 'fixture', async scan() { return { sessions, sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 500 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) });
  let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'modern' })));
    await page.goto(url); await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 192);
    const measure = () => page.locator('.modern-graph-viewport').evaluate(view => {
      const find = id => { const el = [...view.querySelectorAll('.modern-agent')].find(e => JSON.parse(e.dataset.key)[0] === id); if (!el) throw Error(id + ': ' + [...view.querySelectorAll('.modern-agent')].slice(0, 4).map(e => e.dataset.key)); return {x: parseFloat(el.parentElement.style.left), y: parseFloat(el.parentElement.style.top)}; };
      const parent = find('child-50'), child = find('nested-50'), deep = find('deep');
      return { parent, child, deep, distance: Math.hypot(child.x-parent.x, child.y-parent.y), deepDistance: Math.hypot(deep.x-child.x, deep.y-child.y) };
    });
    if (process.env.AGENTOBS_SCREENSHOT_DIR) { await page.locator('.modern-graph-viewport').evaluate(view => { view.scrollTop = 220; }); await page.locator('.modern-run').screenshot({path:path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'cards.png')}); }
    const cards = await measure();
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(() => document.querySelector('.modern-graph-viewport')?.dataset.compact === 'true');
    const narrow = await measure();
    assert.ok(narrow.distance < 450 && narrow.deepDistance < 450, 'narrow workspaces keep descendants close to their parents');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => document.querySelector('.modern-graph-viewport')?.dataset.compact === 'false');
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    if (process.env.AGENTOBS_SCREENSHOT_DIR) await page.locator('.modern-run').screenshot({path:path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'compact.png')});
    const compact = await measure();
    console.log(JSON.stringify({ cards, compact }));
    assert.ok(cards.distance < 450 && cards.deepDistance < 450, 'card descendants stay close to their parent');
    assert.ok(compact.distance < 90 && compact.deepDistance < 90, 'compact descendants stay close to their parent');
    assert.equal(await page.locator('.modern-links path').count(), 191, 'all hierarchy links remain visible');
    sessions.push(session('new-nested', 'child-50'));
    await page.waitForFunction(() => document.querySelectorAll('.modern-swarm-node').length === 193);
    const after = await measure();
    assert.deepEqual(after.parent, compact.parent, 'existing compact positions survive a live addition');
    assert.deepEqual(after.child, compact.child, 'existing descendants survive a live addition');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
