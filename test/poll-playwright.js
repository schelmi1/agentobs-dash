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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-poll-browser-'));
  let task = 'Initial task'; const at = new Date().toISOString();
  const adapter = { id: 'fixture', async scan() { return { sessions: [{ id: 'agent', cwd: root, provider: 'fixture', providerLabel: 'Fixture', status: 'active', hasLifecycle: true, currentTask: task, lastActivity: at }], sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 100 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.addInitScript(() => { window.renderCount = 0; window.addEventListener('agentobs:render', () => window.renderCount++); });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.agent');
    const initial = await page.evaluate(() => window.renderCount);
    await page.waitForTimeout(11000);
    assert.equal(await page.evaluate(() => window.renderCount), initial, 'unchanged polls do not redraw the dashboard');
    assert.equal(await page.locator('#connection').textContent(), 'Live', 'lightweight polls keep observation freshness alive');
    task = 'Updated task';
    await page.waitForFunction(() => document.querySelector('.agent')?.textContent.includes('Updated task'));
    assert.ok(await page.evaluate(() => window.renderCount) > initial, 'changed observation redraws the dashboard');
    assert.deepEqual(errors, []);
    console.log('PASS idle polls avoid redraws, maintain freshness and deliver changes');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
