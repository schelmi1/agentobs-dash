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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-multi-modern-'));
  const dashboards = []; let browser;
  try {
    const instances = [];
    for (const label of ['Alpha', 'Beta']) {
      const root = path.join(base, label); await fs.mkdir(root);
      let generation = 0, onlyHistory = false;
      const now = Date.now();
      const make = (id, currentTask, extra = {}) => ({ id, currentTask, cwd: root, provider: 'fixture', providerLabel: 'Codex', status: 'active', hasLifecycle: true, lastActivity: new Date(now).toISOString(), ...extra });
      const adapter = { id: 'fixture', async scan() {
        const sessions = [];
        for (let run = 0; run < 3; run++) {
          const id = label + '-run-' + run;
          const history = Array.from({ length: 5 }, (_, i) => ({ id: 'finished-' + i, name: 'exec_command', label: 'Exec · git', status: 'completed', timestamp: new Date(now + i * 1000).toISOString(), completedAt: new Date(now + i * 1000).toISOString() }));
          sessions.push(make(id, label + ' mission ' + run, { agentName: 'Coordinator ' + run, toolHistory: run === 0 ? history : [] }));
          for (let child = 0; child < 6; child++) sessions.push(make(id + '-child-' + child, label + ' specialist task ' + run + '-' + child, { parentId: id, agentName: 'Specialist ' + child, ...(run === 2 && child === 5 ? { cwd: path.join(root, 'nested') } : {}), needsInput: run === 1 && child === 5, currentTool: { id: 'running-' + child, name: 'exec_command', label: 'Exec · ' + ['npm', 'rg', 'node', 'git', 'python', 'ls'][child], status: 'in_progress', startedAt: new Date(now - 60000 - child * 1000).toISOString() }, ...(child === 1 && run === 0 ? { toolHistory: Array.from({ length: 5 }, (_, i) => ({ id: 'read-' + i, name: 'read', label: 'Read ' + i, status: 'completed', timestamp: new Date(now - 30000 - i * 1000).toISOString() })) } : {}) }));
          sessions.push(make(id + '-nested', label + ' nested review ' + run, { parentId: id + '-child-0', agentName: 'Reviewer', currentTool: { id: 'unknown', name: 'search', label: 'Search', status: 'unknown' }, toolHistory: [{ id: 'error', name: 'exec_command', label: 'Exec · npm', status: 'failed', timestamp: new Date(now - 120000).toISOString() }] }));
        }
        sessions.push(make(label + '-past', label + ' completed investigation', { status: 'completed' }));
        sessions.push(make(label + '-past-child', label + ' completed worker', { status: 'completed', parentId: label + '-past', agentName: 'Past worker', toolHistory: [{ id: 'past-read', name: 'read', label: 'Read', status: 'completed' }] }));
        sessions.push(make(label + '-quiet', label + ' quiet investigation', { status: 'active', lastActivity: new Date(now - 7200000).toISOString() }));
        sessions.push(make(label + '-inactive', label + ' inactive investigation', { status: 'unknown', attentionState: 'failed', lastActivity: new Date(now - 7200000).toISOString() }));
        if (generation) sessions.push(make(label + '-ephemeral-' + generation, label + ' transient ' + generation, { parentId: label + '-run-0', agentName: 'Transient' }));
        return { sessions: onlyHistory ? sessions.filter(session => /-(past|past-child|quiet|inactive)$/.test(session.id)) : sessions, sources: [], unreadable: 0 };
      } };
      const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 150 };
      const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); dashboards.push(dashboard);
      instances.push({ label, url: await dashboard.start(), setGeneration(value) { generation = value; }, showOnlyHistory() { onlyHistory = true; } });
    }
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true, args: ['--no-sandbox'] });
    const contexts = await Promise.all(instances.map(() => browser.newContext({ viewport: { width: 1440, height: 900 } })));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const errors = []; for (const page of pages) page.on('pageerror', error => errors.push(error.message));
    for (const [i, page] of pages.entries()) {
      await page.goto(instances[i].url); await page.waitForSelector('.agent');
      await page.waitForSelector('.modern-run');
      assert.equal(await page.locator('.modern-run').count(), 3);
      assert.equal(await page.locator('.modern-agent').count(), 24);
      assert.equal(await page.locator('.modern-links path').count(), 21);
      const wideRun = page.locator('.modern-run').first();
      const sibling0 = await wideRun.locator('.modern-agent', { hasText: instances[i].label + ' specialist task 0-0' }).boundingBox();
      const sibling1 = await wideRun.locator('.modern-agent', { hasText: instances[i].label + ' specialist task 0-1' }).boundingBox();
      assert.equal(sibling0.y, sibling1.y, 'wide workspaces place siblings in a horizontal row');
      assert.ok(sibling1.x > sibling0.x, 'sibling cards do not overlap');
      assert.equal(await page.locator('.overview #metric-tools-running').innerText(), '18', 'unknown tool outcomes are not counted as running');
      assert.equal(await page.locator('.modern-intro').getByText('tools running', { exact: false }).count(), 0, 'running tools are reported only in the scope overview');
      await page.getByRole('button', { name: 'Choose workspace' }).click();
      await page.locator('#workspace-menu [data-workspace]').filter({ hasText: 'nested' }).click();
      assert.equal(await page.locator('#metric-tools-running').innerText(), '1', 'running tools count only actual members of the selected workspace');
      await page.getByRole('button', { name: 'Choose workspace' }).click();
      await page.locator('#workspace-menu [data-workspace=""]').click();
      assert.equal(await page.locator('#metric-tools-running').innerText(), '18', 'returning to all workspaces restores the full count');
      const controls = page.getByRole('group', { name: 'Arrange Modern workspaces' });
      const fitAll = controls.getByRole('button', { name: 'Fit all workspaces', exact: true });
      for (const mode of ['Row', 'Column', 'Grid']) {
        await controls.getByRole('button', { name: mode, exact: true }).click();
        const runs = page.locator('.modern-runs > .modern-run');
        const initial = await runs.evaluateAll(nodes => nodes.slice(0, 2).map(node => ({ width: Math.round(node.getBoundingClientRect().width), height: node.querySelector('.modern-graph-viewport').clientHeight })));
        for (let index = 0; index < 2; index++) {
          await runs.nth(index).locator('.modern-resize').focus();
          await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowDown');
        }
        assert.equal(Object.keys(await page.evaluate(() => JSON.parse(localStorage.getItem('agentobs.preferences')).modernWorkspaceSizes)).length, 2, mode + ' records both custom sizes');
        await fitAll.click();
        const fitted = await runs.evaluateAll(nodes => nodes.slice(0, 2).map(node => ({ width: Math.round(node.getBoundingClientRect().width), height: node.querySelector('.modern-graph-viewport').clientHeight })));
        assert.deepEqual(fitted, initial, mode + ' Fit restores both workspace dimensions');
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('agentobs.preferences')).modernWorkspaceSizes), {}, 'Fit persists the restored sizes');
        assert.equal(await controls.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'), 'true', 'Fit retains the selected arrangement');
      }
      await page.setViewportSize({ width: 1100, height: 900 });
      await controls.getByRole('button', { name: 'Column', exact: true }).click();
      const columnWidths = await page.locator('.modern-runs').first().evaluate(node => ({ grid: node.getBoundingClientRect().width, runs: [...node.children].map(run => run.getBoundingClientRect().width) }));
      assert.ok(columnWidths.runs.every(width => Math.abs(width - columnWidths.grid) < 1), 'Column fills the available width at intermediate viewport sizes');
      await page.setViewportSize({ width: 1440, height: 900 });
      const geometry = () => page.locator('.modern-runs > .modern-run').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y }; }));
      await controls.getByRole('button', { name: 'Row', exact: true }).focus(); await page.keyboard.press('Enter');
      let boxes = await geometry(); assert.ok(boxes.every(box => Math.abs(box.y - boxes[0].y) < 1), 'Row lays out the three workspaces across');
      assert.equal(await page.locator('.modern-graph-viewport[data-compact=true]').count(), 3, 'narrow workspaces use readable vertical graphs');
      const narrowFit = await page.locator('.modern-run').first().evaluate(run => {
        const view = run.querySelector('.modern-graph-viewport').getBoundingClientRect();
        return { view: view.toJSON(), cards: [...run.querySelectorAll('.modern-agent')].slice(0, 2).map(card => card.getBoundingClientRect().toJSON()) };
      });
      assert.ok(narrowFit.cards.every(box => box.left >= narrowFit.view.left && box.right <= narrowFit.view.right && box.top >= narrowFit.view.top && box.bottom <= narrowFit.view.bottom), 'root and first child fit within a row workspace: ' + JSON.stringify(narrowFit));
      assert.equal(await controls.getByRole('button', { name: 'Row', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('agentobs.preferences')).modernWorkspaceArrangement), 'row');
      assert.equal(await controls.getByRole('button', { name: 'Row', exact: true }).evaluate(node => document.activeElement === node), true, 'arrangement retains keyboard focus');
      if (process.env.AGENTOBS_SCREENSHOT_DIR && i === 0) { await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'modern-row.png') }); }
      await controls.getByRole('button', { name: 'Grid', exact: true }).click();
      boxes = await geometry(); assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 1 && boxes[2].y > boxes[0].y, 'Grid uses two columns');
      if (process.env.AGENTOBS_SCREENSHOT_DIR && i === 0) await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'modern-grid.png') });
      await page.reload(); await page.waitForSelector('.modern-run');
      assert.equal(await controls.getByRole('button', { name: 'Grid', exact: true }).getAttribute('aria-pressed'), 'true', 'arrangement survives reload');
      await controls.getByRole('button', { name: 'Column', exact: true }).click();
      boxes = await geometry(); assert.ok(boxes[1].y > boxes[0].y && boxes.every(box => Math.abs(box.x - boxes[0].x) < 1), 'Column stacks workspaces');
      const run = page.locator('.modern-run').filter({ hasText: instances[i].label + ' mission 0' });
      assert.equal(await run.locator('.modern-call-outcome', { hasText: 'Running' }).count(), 6, 'all six live tools remain visible despite more recent completed calls');
      assert.equal(await run.locator('.modern-call-outcome', { hasText: 'Failed' }).count(), 1, 'a failed tool is not hidden behind running calls');
      await run.getByRole('button', { name: /Next tool calls for/ }).click();
      assert.ok(await run.locator('.modern-call').count() <= 12, 'activity pages stay bounded');
      await run.getByRole('button', { name: /Previous tool calls for/ }).click();
      await page.getByRole('button', { name: 'History', exact: true }).click();
      assert.equal(await page.locator('.quiet-history').evaluate(node => node.open), true, 'history navigation opens the first history section');
      assert.equal(await page.locator('.quiet-history .modern-history-state').innerText(), 'Quiet');
      await page.locator('.completed-history > summary').click();
      const completed = page.locator('.completed-history .modern-run');
      assert.equal(await completed.locator('.modern-history-state').innerText(), 'Completed');
      assert.equal(await completed.locator('.modern-agent').count(), 1, 'completed child starts minimized');
      assert.equal(await completed.locator('.modern-call', { hasText: 'Read' }).count(), 1, 'historical tool activity is available');
      await completed.getByRole('button', { name: /Show 1 completed agent under/ }).click();
      assert.equal(await completed.locator('.modern-agent').count(), 2, 'historical completed agents can be expanded');
      assert.equal(await completed.locator('.modern-links path').count(), 1, 'historical delegation link is shown');
      await completed.locator('.modern-agent', { hasText: 'completed worker' }).click();
      assert.equal(await page.locator('.inspector h2').innerText(), instances[i].label + ' completed worker');
      await page.getByRole('button', { name: 'Close ×' }).click();
      await page.locator('.inactive-history > summary').click();
      assert.equal(await page.locator('.inactive-history .modern-history-state').innerText(), 'Inactive');
      for (const group of ['quiet', 'completed', 'inactive']) await page.locator('.' + group + '-history > summary').click();
      assert.equal(await page.getByRole('navigation', { name: 'Workspace navigation' }).isVisible(), true, 'the workspace rail remains available');
      if (process.env.AGENTOBS_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR, { recursive: true });
        await page.evaluate(() => { window.scrollTo(0, 0); for (const viewport of document.querySelectorAll('.modern-graph-viewport')) { viewport.scrollLeft = 0; viewport.scrollTop = 0; } for (const list of document.querySelectorAll('.modern-calls')) list.scrollLeft = 0; });
        await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, instances[i].label + '.png'), fullPage: true });
      }
    }
    const alphaRun = pages[0].locator('.modern-run').filter({ hasText: 'Alpha mission 0' });
    const collapse = alphaRun.getByRole('button', { name: 'Collapse run Alpha mission 0' });
    assert.equal(await collapse.count(), 1, 'run offers a collapse control');
    await collapse.focus(); await pages[0].keyboard.press('Enter');
    assert.equal(await alphaRun.locator('.modern-graph-viewport').count(), 0, 'run can be compacted');
    assert.equal(await alphaRun.locator('.modern-run-count').innerText(), '8 agents');
    assert.equal(await pages[0].evaluate(() => document.activeElement.getAttribute('aria-label')), 'Expand run Alpha mission 0', 'run toggle retains keyboard focus');
    await pages[0].keyboard.press('Enter');
    assert.equal(await alphaRun.locator('.modern-graph-viewport').count(), 1);
    const attentionRun = pages[0].locator('.modern-run').filter({ hasText: 'Alpha mission 1' });
    await attentionRun.getByRole('button', { name: 'Collapse run Alpha mission 1' }).click();
    await pages[0].locator('.attention-queue > summary').click();
    await pages[0].getByRole('button', { name: /Show Alpha specialist task 1-5/ }).click();
    assert.equal(await attentionRun.locator('.modern-graph-viewport').count(), 1, 'attention selection reopens a collapsed run');
    assert.equal(await pages[0].locator('.inspector h2').innerText(), 'Alpha specialist task 1-5');
    await pages[0].getByRole('button', { name: 'Close ×' }).click();
    const viewport = alphaRun.locator('.modern-graph-viewport');
    assert.equal(await viewport.evaluate(node => getComputedStyle(node).overscrollBehaviorY), 'auto', 'page scrolling continues at graph boundary');
    await alphaRun.getByRole('button', { name: /Exec · ls, Running, Specialist 5/ }).click();
    await pages[0].waitForFunction(() => {
      const card = document.querySelector('.modern-agent.selected'), view = card?.closest('.modern-graph-viewport');
      if (!view) return false;
      const a = card.getBoundingClientRect(), b = view.getBoundingClientRect();
      return a.top >= b.top && a.bottom <= b.bottom && a.left >= b.left && a.right <= b.right;
    }, null, { timeout: 1500 });
    await pages[0].getByRole('button', { name: 'Close ×' }).click();
    await pages[0].waitForFunction(() => document.querySelector('.modern-graph-viewport')?.dataset.columns === '3');
    const stable = alphaRun.locator('.modern-agent', { hasText: 'Alpha specialist task 0-0' });
    const before = await stable.boundingBox();
    for (let i = 1; i <= 20; i++) {
      instances[0].setGeneration(i);
      await pages[0].waitForFunction(n => [...document.querySelectorAll('.modern-task')].some(node => node.textContent === 'Alpha transient ' + n), i);
    }
    const after = await stable.boundingBox(); assert.equal(after.x, before.x); assert.equal(after.y, before.y);
    assert.ok(await viewport.evaluate(node => node.scrollHeight) < 2600, 'replaced agents do not leave unbounded empty rows');
    assert.equal(await pages[1].locator('.modern-run').count(), 3); assert.equal(await pages[1].locator('.modern-agent').count(), 24);
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [844, 390], [1440, 900], [1920, 1080]]) {
      await pages[0].setViewportSize({ width, height });
      if (width <= 760) await pages[0].getByRole('button', { name: 'Open sidebar' }).click();
      assert.equal(await pages[0].locator('.brand-slogan').isVisible(), true, width + ' slogan is visible in the sidebar');
      if (width <= 760) await pages[0].getByRole('button', { name: 'Close sidebar' }).click();
      if (width === 390 && process.env.AGENTOBS_SCREENSHOT_DIR) {
        await pages[0].evaluate(() => { window.scrollTo(0, 0); for (const viewport of document.querySelectorAll('.modern-graph-viewport')) { viewport.scrollLeft = 0; viewport.scrollTop = 0; } });
        await pages[0].screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'multi-phone.png'), fullPage: true });
        await alphaRun.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'multi-phone-run.png') });
      }
      assert.equal(await pages[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, width + ' page overflow');
      if (width === 390) {
        const controls = pages[0].getByRole('group', { name: 'Arrange Modern workspaces' });
        await controls.getByRole('button', { name: 'Grid', exact: true }).click();
        const boxes = await pages[0].locator('.modern-runs > .modern-run').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y }; }));
        assert.ok(boxes[1].y > boxes[0].y && boxes.every(box => Math.abs(box.x - boxes[0].x) < 1), 'Grid stacks on a narrow screen');
        await controls.getByRole('button', { name: 'Column', exact: true }).click();
      }
      const card = pages[0].locator('.modern-agent').first(); await card.focus(); await pages[0].keyboard.press('Enter');
      const inspect = await pages[0].locator('.inspector').evaluate(node => {
        const rect = node.getBoundingClientRect(), close = node.querySelector('.inspector-header button'), box = close.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, clickable: close.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), focused: node.contains(document.activeElement) };
      });
      assert.ok(inspect.left >= 0 && inspect.right <= width && inspect.top >= 0 && inspect.bottom <= height && inspect.clickable && inspect.focused, width + ' inspector: ' + JSON.stringify(inspect));
      await pages[0].keyboard.press('Escape');
      assert.equal(await card.evaluate(node => document.activeElement === node), true, width + ' focus restoration');
    }
    await pages[0].setViewportSize({ width: 1101, height: 701 });
    assert.equal(await pages[0].getByRole('button', { name: 'Choose colors' }).isVisible(), true);
    const statusBounds = await pages[0].locator('#status-trigger').boundingBox();
    assert.ok(statusBounds.y >= 0 && statusBounds.y + statusBounds.height <= 701, 'expanded customization keeps monitoring status reachable');
    await pages[0].getByRole('button', { name: 'Choose colors' }).click();
    await pages[0].getByRole('menuitemradio', { name: 'Light', exact: true }).click();
    assert.equal(await pages[0].locator('html').getAttribute('data-colors'), 'light');
    instances[1].showOnlyHistory();
    await pages[1].waitForFunction(() => !document.querySelector('.modern-board:not(.modern-history-board)'));
    if (!await pages[1].locator('.completed-history').evaluate(node => node.open)) await pages[1].locator('.completed-history > summary').click();
    await pages[1].locator('.completed-history .modern-run').waitFor();
    assert.equal(await pages[1].locator('.completed-history .modern-run').count(), 1, 'completed workspaces remain available without live runs');
    assert.equal(await pages[1].getByRole('group', { name: 'Arrange Modern workspaces' }).count(), 1, 'history-only view offers arrangement controls');
    if (!await pages[1].locator('.inactive-history').evaluate(node => node.open)) await pages[1].locator('.inactive-history > summary').click();
    assert.equal(await pages[1].getByRole('group', { name: 'Arrange Modern workspaces' }).count(), 1, 'multiple history groups share arrangement controls');
    await pages[1].getByRole('group', { name: 'Arrange Modern workspaces' }).getByRole('button', { name: 'Compact', exact: true }).click();
    const historyHide = pages[1].locator('.completed-history .modern-hide-completed');
    await historyHide.click();
    assert.equal(await pages[1].locator('.completed-history').count(), 1, 'hiding completed nodes keeps completed runs available');
    assert.equal(await pages[1].locator('.completed-history .modern-swarm-node').count(), 0, 'completed history nodes are hidden');
    assert.equal(await historyHide.isVisible(), true, 'history-only mode retains the control');
    await historyHide.click();
    assert.equal(await pages[1].locator('.completed-history .modern-swarm-node').count(), 2, 'history-only mode can restore completed nodes');
    assert.deepEqual(errors, []);
    console.log('PASS two independent dashboard instances, six runs, 48 agents, concurrent tools, churn and phone');
  } finally { await browser?.close(); for (const dashboard of dashboards) await dashboard.close(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
