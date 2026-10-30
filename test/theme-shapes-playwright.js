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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-theme-shapes-'));
  const session = (id, parentId) => ({ id, ...(parentId ? { parentId } : {}), currentTask: 'Observe the agent workflow: ' + id, agentName: id, cwd: root, provider: 'fixture', providerLabel: 'Fixture', status: 'active', hasLifecycle: true, lastActivity: new Date().toISOString() });
  const sessions = [session('Coordinator'), session('Research', 'Coordinator'), session('Review', 'Coordinator'), session('Analysis', 'Research')];
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 500 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [{ id: 'fixture', async scan() { return { sessions, sources: [], unreadable: 0 }; } }]) });
  let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    for (const design of ['modern']) for (const theme of ['rounded', 'chamfered', 'terminal']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ design, theme }) => localStorage.setItem('agentobs.preferences', JSON.stringify({ design, theme })), { design, theme });
      await page.goto(url); await page.waitForSelector('.modern-agent');
      const result = await page.evaluate(design => {
        const selector = '.modern-agent';
        const card = document.querySelector(selector), cs = getComputedStyle(card);
        const panel = document.querySelector('.modern-run');
        const control = document.querySelector('.modern-run-toggle');
        return { radius: cs.borderRadius, clip: cs.clipPath, panel: panel && getComputedStyle(panel).borderRadius, control: getComputedStyle(control).borderRadius };
      }, design);
      if (theme === 'chamfered') {
        assert.equal(result.radius, '0px', design + ' chamfered card has sharp corners');
        assert.match(result.clip, /polygon/, design + ' chamfered card has cut corners');
        if (result.panel !== null) assert.equal(result.panel, '0px', design + ' chamfered workspace has sharp corners');
        assert.equal(result.control, '0px', design + ' chamfered control has sharp corners');
      } else if (theme === 'terminal') {
        assert.equal(result.radius, '0px', design + ' terminal card is square');
        assert.equal(result.clip, 'none', design + ' terminal card is not chamfered');
        if (result.panel !== null) assert.equal(result.panel, '0px', design + ' terminal workspace is square');
        assert.equal(result.control, '0px', design + ' terminal control is square');
      } else {
        assert.ok(parseFloat(result.radius) >= 8, design + ' rounded card is clearly rounded');
        assert.equal(result.clip, 'none', design + ' rounded card is not cut');
        if (result.panel !== null) assert.ok(parseFloat(result.panel) >= 8, design + ' rounded workspace is rounded');
        assert.ok(parseFloat(result.control) >= 6, design + ' rounded control is rounded');
      }
      if (design === 'modern' && process.env.AGENTOBS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'modern-' + theme + '.png') });
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS Rounded, Chamfered and Terminal shape treatment in Modern');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
