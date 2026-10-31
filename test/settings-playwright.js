'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { resolveConfig } = require('../lib/config');
const { createDashboard } = require('../lib/server');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-settings-ui-')), target = path.join(root, 'projects'); await fs.mkdir(target);
  const config = await resolveConfig(root, { port: 0, sessionRoots: [], copilotRoots: [], claudeRoots: [], opencodeRoots: [] });
  const dashboard = createDashboard(config); let browser;
  try {
    const url = await dashboard.start(); browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(url); await page.getByRole('button', { name: 'Settings', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('heading', { name: 'Monitored root' }).waitFor(); assert.equal(await dialog.getByText(/command line/i).count(), 4);
    await dialog.locator('#settings-root').fill(target);
    const duration = dialog.getByLabel('Duration (seconds)'); assert.equal(await duration.inputValue(), '30'); await duration.fill('75');
    await dialog.getByRole('combobox', { name: 'Claude Code storage mode' }).selectOption('custom');
    const input = dialog.getByRole('textbox', { name: 'Claude Code storage path' }); await input.fill(path.join(root, 'future-store'));
    await dialog.getByRole('button', { name: 'Save settings' }).click(); await dialog.getByRole('status').getByText(/Saved\. Restart/).waitFor();
    assert.match(await dialog.getByRole('status').innerText(), /missing or unreadable/);
    const stored = JSON.parse(await fs.readFile(config.configFile)); assert.equal(stored.monitoredRoot, target); assert.deepEqual(stored.claudeRoots, [path.join(root, 'future-store')]); assert.equal(stored.finishingDurationSeconds, 75);
    if (process.env.AGENTOBS_SCREENSHOT_DIR) { await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'settings-desktop.png') }); }
    await dialog.getByRole('button', { name: 'Close settings' }).click(); await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await dialog.getByRole('heading', { name: 'Monitored root' }).waitFor();
    assert.equal(await dialog.getByLabel('Duration (seconds)').inputValue(), '75', 'saved duration is shown on reopening');
    assert.ok(await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    if (process.env.AGENTOBS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'settings-phone.png') });
    await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), false); assert.deepEqual(errors, []);
    console.log('PASS settings panel, local save, command-line precedence, missing paths, phone and Escape');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
