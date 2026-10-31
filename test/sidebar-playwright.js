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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url); await page.waitForSelector('.modern-agent');
    const edge = page.getByRole('separator', { name: 'Resize sidebar' });
    const initial = await page.locator('.dashboard-header').boundingBox();
    await page.mouse.move(initial.x + initial.width - 1, 300); await page.mouse.down();
    await page.mouse.move(initial.x + initial.width + 99, 300, { steps: 5 }); await page.mouse.up();
    assert.ok(Math.abs((await page.locator('.dashboard-header').boundingBox()).width - 340) <= 2, 'dragging the sidebar edge changes its width');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('agentobs.preferences')).sidebarWidth), 340);
    await page.reload(); await page.waitForSelector('.modern-agent');
    assert.equal(Math.round((await page.locator('.dashboard-header').boundingBox()).width), 340, 'sidebar width survives reload');
    await edge.focus(); await page.keyboard.press('End');
    assert.equal(Math.round((await page.locator('.dashboard-header').boundingBox()).width), 480, 'keyboard resize respects the maximum');
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForFunction(() => Math.round(document.querySelector('.dashboard-header').getBoundingClientRect().width) === 440);
    assert.equal(Math.round((await page.locator('.dashboard-header').boundingBox()).width), 440, 'narrow windows clamp width to leave workspace space');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => Math.round(document.querySelector('.dashboard-header').getBoundingClientRect().width) === 480);
    assert.equal(Math.round((await page.locator('.dashboard-header').boundingBox()).width), 480, 'returning to a wide window restores the saved width');
    await edge.focus(); await page.keyboard.press('Home');
    assert.equal(Math.round((await page.locator('.dashboard-header').boundingBox()).width), 190, 'keyboard resize respects the minimum');
    await page.evaluate(() => localStorage.removeItem('agentobs.preferences'));
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
