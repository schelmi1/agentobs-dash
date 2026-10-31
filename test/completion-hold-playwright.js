'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { Observer } = require('../lib/observer');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');

async function main() {
  let done = false;
  const config = { ...defaults, rootFolder: '/demo', port: 0, pollIntervalMs: 200 };
  const adapter = { id: 'fixture', async scan() { return { sessions: [
    { id: 'new', cwd: '/demo', provider: 'fixture', providerLabel: 'Fixture', currentTask: 'Current work', status: done ? 'completed' : 'active', hasLifecycle: true, lastActivity: new Date().toISOString() },
    { id: 'past', cwd: '/demo', provider: 'fixture', providerLabel: 'Fixture', currentTask: 'Old work', status: 'completed', hasLifecycle: true, lastActivity: new Date().toISOString() }
  ], sources: [], unreadable: 0 }; } };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start(); browser = await chromium.launch({ args: ['--no-sandbox'], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const page = await browser.newPage({ reducedMotion: 'reduce' }); const errors = [];
    page.setDefaultTimeout(5000); page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
    await page.goto(url); await page.waitForSelector('.modern-agent');
    assert.equal(await page.locator('.modern-run[data-completion-held]').count(), 0, 'old history does not pulse on startup');
    assert.equal(await page.locator('#metric-finishing').innerText(), '0');
    assert.equal(await page.locator('.metric-finishing').getAttribute('data-active'), 'false');
    await page.clock.install();
    done = true; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const run = page.locator('.modern-run[data-completion-held=true]'); await run.waitFor();
    assert.match(await run.locator('.modern-completion-notice').innerText(), /Completed/);
    assert.equal(await run.evaluate(node => getComputedStyle(node).animationName), 'none', 'reduced motion stops pulsing');
    assert.equal(await page.locator('#metric-workspaces').innerText(), '0', 'completed workspaces are not counted active during the hold');
    assert.equal(await page.locator('#metric-finishing').innerText(), '1', 'finishing count reflects held workspaces');
    assert.equal(await page.locator('.metric-finishing').getAttribute('data-active'), 'true', 'the finishing statistic is highlighted');
    const alignment = await page.evaluate(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect();
      return { label: bounds('.metric-finishing > span').left - document.querySelector('#metric-attention').previousElementSibling.getBoundingClientRect().left, value: bounds('#metric-finishing').right - bounds('#metric-attention').right };
    });
    assert.ok(Math.abs(alignment.label) <= 1 && Math.abs(alignment.value) <= 1, 'finishing label and value align with other statistics: ' + JSON.stringify(alignment));
    await page.getByRole('button', { name: /FINISHING/ }).click();
    assert.equal(await page.locator('#finishing-queue').evaluate(node => node.open), true, 'finishing count opens the workspace list');
    await page.getByRole('button', { name: 'Show finishing workspace Current work' }).click();
    assert.equal(await run.locator('.modern-run-toggle').evaluate(node => document.activeElement === node), true, 'choosing a workspace reveals it');
    await page.reload(); await page.waitForSelector('.modern-run[data-completion-held=true]');
    await page.clock.fastForward(29000);
    assert.equal(await run.count(), 1, 'completed workspace stays live before the deadline');
    await page.clock.fastForward(1100);
    await page.waitForFunction(() => !document.querySelector('.modern-run[data-completion-held=true]'));
    assert.equal(await page.locator('#metric-finishing').innerText(), '0', 'finishing count clears at expiry');
    assert.equal(await page.locator('.metric-finishing').getAttribute('data-active'), 'false');
    assert.equal(await page.locator('.metric-finishing').isDisabled(), true);
    assert.match(await page.locator('.completed-history > summary').innerText(), /2 runs/, 'workspace enters completed history after 30 seconds');
    assert.deepEqual(errors, []); console.log('PASS completion hold, history, reload, active count and reduced motion');
  } finally { await browser?.close(); await dashboard.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
