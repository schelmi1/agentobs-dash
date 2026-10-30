'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createDashboard } = require('../lib/server');
const { Observer } = require('../lib/observer');
const { defaults } = require('../lib/config');

async function main() {
  const config = { ...defaults, rootFolder: '/demo', port: 0, pollIntervalMs: 100 };
  const adapter = { id: 'fixture', async scan() {
    return { sessions: [{ id: 'root', cwd: '/demo/project', provider: 'fixture', providerLabel: 'Fixture',
      currentTask: 'Build dashboard', status: 'active', hasLifecycle: true, lastActivity: new Date().toISOString() }], sources: [], unreadable: 0 };
  } };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) });
  let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const [width, height] of [[1440, 900], [1024, 600], [768, 1024], [390, 844], [320, 568], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.goto(url); await page.waitForSelector('.modern-agent');
      const geometry = await page.evaluate(() => {
        const sidebar = document.querySelector('.dashboard-header').getBoundingClientRect();
        const main = document.querySelector('.dashboard-main').getBoundingClientRect();
        return { sidebar: sidebar.toJSON(), main: main.toJSON(), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(geometry.sidebar.left, 0, `${width}: sidebar is at the left edge`);
      assert.ok(geometry.main.left >= geometry.sidebar.width, `${width}: workspace is beside the sidebar`);
      assert.ok(geometry.sidebar.height >= height - 1, `${width}: sidebar spans the viewport height`);
      assert.equal(geometry.overflow, false, `${width}: no page-wide horizontal overflow`);
      if (width <= 760) {
        await page.getByRole('button', { name: 'Open sidebar' }).click();
        assert.equal(await page.locator('.brand-slogan').isVisible(), true);
        await page.getByRole('button', { name: 'Choose workspace' }).click();
        await page.locator('#workspace-menu [data-workspace=""]').click();
        await page.getByRole('button', { name: 'Monitoring status' }).click();
        assert.equal(await page.locator('#status-menu').isVisible(), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#status-menu').isVisible(), false);
        await page.getByRole('button', { name: 'Close sidebar' }).click();
      }
      await page.locator('.modern-agent').first().click();
      const inspector = await page.locator('.inspector').boundingBox();
      assert.ok(inspector && inspector.y >= 0 && inspector.y + inspector.height <= height + 1, `${width}: inspector fits`);
      await page.getByRole('button', { name: 'Close ×' }).click();
    }
    assert.deepEqual(errors, []);
    console.log('PASS sidebar, menus and inspector across desktop, tablet, phone and short windows');
  } finally { await browser?.close(); await dashboard.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
