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
    return { sessions: ['one', 'two'].map(id => ({ id, cwd: '/demo/' + id, provider: 'fixture', providerLabel: 'Fixture', currentTask: 'Task ' + id, status: 'active', hasLifecycle: true, lastActivity: now })), sources: [], unreadable: 0 };
  } };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start(); browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
    await page.waitForFunction(() => document.querySelectorAll('.modern-graph-viewport').length === 2);
    for (const mode of ['cards', 'compact']) {
      if (mode === 'compact') await page.locator('.modern-run').first().getByRole('button', { name: 'Compact', exact: true }).click();
      const views = page.locator('.modern-graph-viewport'); const first = views.first(), second = views.nth(1);
      const otherZoom = await second.locator('.modern-graph').evaluate(node => node.style.transform);
      const box = await first.boundingBox(); await page.mouse.move(box.x + box.width - 35, box.y + 35);
      await page.keyboard.down('Alt'); await page.mouse.wheel(0, -400); await page.keyboard.up('Alt');
      await page.waitForFunction(() => document.querySelector('.modern-graph').style.transform !== 'scale(1)');
      await page.mouse.dblclick(box.x + box.width - 35, box.y + 35);
      await page.waitForFunction(() => document.querySelector('.modern-graph').style.transform === 'scale(1)');
      assert.equal(await second.locator('.modern-graph').evaluate(node => node.style.transform), otherZoom, mode + ' resets only its own workspace');
      assert.deepEqual(await first.evaluate(node => [node.scrollLeft, node.scrollTop]), [0, 0], mode + ' resets the viewport position');
    }
    assert.deepEqual(errors, []); console.log('PASS double-click resets card and compact workspace zoom independently');
  } finally { await browser?.close(); await dashboard.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
