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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-completed-nodes-'));
  let finishActive = false, finishNested = false, activeTool = { id: 'tool-1', name: 'exec_command', label: 'Exec · npm', status: 'in_progress' };
  const session = (id, extra = {}) => ({ id, currentTask: 'Task ' + id, agentName: id, cwd: root, provider: 'fixture', providerLabel: 'Fixture', status: 'active', hasLifecycle: true, lastActivity: new Date().toISOString(), ...extra });
  const adapter = { id: 'fixture', async scan() { return { sessions: [
    session('main'), session('finished', { parentId: 'main', status: 'completed' }),
    session('working', { parentId: 'main', ...(finishActive ? { status: 'completed' } : {}), ...(activeTool ? { currentTool: activeTool } : {}) }),
    session('parent', { parentId: 'main', status: 'completed' }),
    session('nested', { parentId: 'parent', ...(finishNested ? { status: 'completed' } : {}) }),
    session('past', { status: 'completed' }), session('past-child', { parentId: 'past', status: 'completed' })
  ], sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 250 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (!localStorage.getItem('agentobs.preferences')) localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'modern', modernSwarm: true })); });
    await page.goto(url); await page.waitForFunction(() => document.querySelectorAll('.modern-swarm-node').length === 5);
    const ids = () => page.locator('.modern-board:not(.modern-history-board) .modern-swarm-node').evaluateAll(nodes => nodes.map(node => JSON.parse(node.dataset.key)[0]));
    const hide = page.locator('.modern-board:not(.modern-history-board) .modern-hide-completed');
    assert.equal(await hide.getAttribute('aria-pressed'), 'false');
    await hide.click();
    assert.deepEqual((await ids()).sort(), ['main', 'nested', 'parent', 'working'], 'completed leaf is hidden while the path to a live descendant remains');
    const workingNode = page.locator('.modern-swarm-node').filter({ hasText: 'Task working' });
    assert.equal(await workingNode.evaluate(node => node.classList.contains('tool-color-18')), true, 'active node uses npm tool color');
    activeTool = { id: 'tool-2', name: 'apply_patch', label: 'Apply patch', status: 'in_progress' };
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-swarm-node')].some(node => node.textContent.includes('Task working') && node.classList.contains('tool-color-2')));
    activeTool = undefined;
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-swarm-node')].some(node => node.textContent.includes('Task working') && !node.classList.contains('has-current-tool')));
    assert.equal(await page.locator('.completed-history').count(), 1, 'completed runs remain in history');
    assert.match(await page.locator('.modern-board:not(.modern-history-board) .modern-graph-header').innerText(), /4 of 5 agents shown/);
    assert.equal(await page.locator('.modern-board:not(.modern-history-board) .modern-links path').count(), 3, 'visible agents retain their parent links');
    await page.reload(); await page.waitForSelector('.modern-swarm-node');
    assert.equal(await hide.getAttribute('aria-pressed'), 'true', 'node visibility preference survives reload');
    assert.deepEqual((await ids()).sort(), ['main', 'nested', 'parent', 'working']);
    await page.locator('.completed-history > summary').click();
    const history = page.locator('.completed-history .modern-run');
    const historyHide = history.locator('.modern-hide-completed');
    await history.locator('.modern-swarm-node').first().waitFor();
    assert.equal(await history.locator('.modern-swarm-node').count(), 2, 'another workspace keeps its completed nodes visible');
    assert.equal(await historyHide.getAttribute('aria-pressed'), 'false');
    await historyHide.click();
    assert.equal(await history.locator('.modern-swarm-node').count(), 0, 'completed-only run has no visible nodes when its own filter is enabled');
    assert.equal(await history.locator('.modern-swarm-empty').innerText(), 'No unfinished agents in this run');
    assert.equal(await hide.getAttribute('aria-pressed'), 'true', 'history control leaves the live workspace setting alone');
    await historyHide.click();
    assert.equal(await history.locator('.modern-swarm-node').count(), 2, 'showing completed agents restores the history graph');
    assert.equal(await page.locator('.completed-history').count(), 1, 'showing nodes does not change history');
    finishActive = true;
    await page.waitForFunction(() => ![...document.querySelectorAll('.modern-swarm-node')].some(node => JSON.parse(node.dataset.key)[0] === 'working'));
    finishNested = true;
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-board:not(.modern-history-board) .modern-swarm-node')].length === 1);
    assert.deepEqual(await ids(), ['main'], 'completed descendants disappear as their work finishes');
    await hide.click();
    assert.equal((await ids()).length, 5, 'completed nodes can be restored after live updates');
    assert.deepEqual(errors, []);
    console.log('PASS Compact completed-node visibility, live updates, history, ancestor context, and persistence');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
