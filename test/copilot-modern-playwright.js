'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');
const { createCopilotDemo } = require('../scripts/copilot-demo');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-copilot-modern-'));
  const demo = await createCopilotDemo(root);
  const dashboard = createDashboard({ ...defaults, rootFolder: root, sessionRoots: [], copilotRoots: [demo.storage], pollIntervalMs: 250, port: 0 });
  let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.modern-agent');
    await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Live' && document.querySelectorAll('.modern-run').length > 0);
    assert.ok(await page.locator('.modern-eyebrow', { hasText: 'COPILOT' }).count() > 0, 'Copilot runs identify their provider');
    assert.equal(await page.locator('#metric-tokens-in').innerText(), '20k');
    const parser = page.locator('.modern-agent').filter({ has: page.locator('.modern-task', { hasText: '[Demo] Parse Copilot transcripts' }) });
    await parser.click();
    assert.equal(await page.locator('.inspector .tool-state').innerText(), 'Running');
    await demo.finishTool(demo.ids.parser, 'parser-tests', false);
    await page.waitForFunction(() => document.querySelector('.inspector .tool-state')?.textContent === 'Failed');
    await demo.transcript(demo.ids.parser, 'assistant.turn_start', { turnId: 'retry' });
    await demo.tool(demo.ids.parser, 'retry-tests');
    await page.waitForFunction(() => document.querySelector('.inspector .tool-state')?.textContent === 'Running');
    await demo.usage(demo.ids.parser, 1000, 0, 100);
    await page.waitForFunction(() => document.querySelector('#metric-tokens-in')?.textContent === '21k');
    const snapshot = await page.request.get(url + '/api/snapshot');
    assert.equal((await snapshot.text()).includes(demo.privateText), false, 'private tool payloads stay out of snapshots');
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.AGENTOBS_SCREENSHOT_DIR) { await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'copilot-modern.png'), fullPage: true }); }
    assert.deepEqual(errors, []);
    console.log('PASS Copilot agent network, live tools and token updates, privacy, and phone layout');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
