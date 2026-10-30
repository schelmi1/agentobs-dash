'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { Observer } = require('../lib/observer');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');

async function main() {
  const config = { ...defaults, rootFolder: '/demo', port: 0, pollIntervalMs: 200 };
  const adapter = { id: 'fixture', async scan() {
    const now = new Date().toISOString();
    return { sessions: Array.from({ length: 15 }, (_, i) => ({ id: 'a' + i,
      ...(i ? { parentId: 'a' + (i <= 8 ? 0 : 1) } : {}), cwd: '/demo/project', provider: 'fixture',
      providerLabel: 'Fixture', currentTask: 'Task ' + i, agentName: 'Agent ' + i,
      status: 'active', hasLifecycle: true, lastActivity: now })), sources: [], unreadable: 0 };
  } };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) });
  let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 15);
    const view = page.locator('.modern-graph-viewport').first();
    const box = await view.boundingBox();
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.keyboard.down('Alt'); await page.mouse.wheel(0, 600); await page.keyboard.up('Alt');
    await page.waitForFunction(() => Number(document.querySelector('.modern-graph-viewport')?.dataset.columns) >= 2);
    const result = await view.evaluate(el => {
      const cards = [...el.querySelectorAll('.modern-agent')].map(node => node.getBoundingClientRect());
      const overlaps = cards.some((a, i) => cards.slice(i + 1).some(b => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5));
      return { width: el.clientWidth, span: Math.max(...cards.map(c => c.right)) - Math.min(...cards.map(c => c.left)), overlaps };
    });
    assert.ok(result.span > result.width * .4, `zoomed cards use workspace width: ${JSON.stringify(result)}`);
    assert.equal(result.overlaps, false, 'reflow preserves non-overlapping delegation cards');
    assert.deepEqual(errors, []);
    console.log('PASS ordinary delegation networks use available width after zooming out');
  } finally { await browser?.close(); await dashboard.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
