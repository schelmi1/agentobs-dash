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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-modern-'));
  let childCount = 2, toolFinished = false, designCompleted = false, researchInput = 12500;
  const session = (id, task, extra = {}) => ({ id, currentTask: task, cwd: root, provider: 'fixture', providerLabel: 'Codex', status: 'active', hasLifecycle: true, lastActivity: new Date().toISOString(), ...extra });
  const adapter = { id: 'fixture', async scan() { return { sessions: [
    session('main', 'Build the new customer onboarding experience', { agentName: 'Lead', tokenUsage: { input: 24800, cachedInput: 12000, output: 2100 }, currentTool: { id: 'main-exec', name: 'exec_command', label: 'Exec · npm', status: 'in_progress' }, toolHistory: [{ id: 'patch', name: 'apply_patch', label: 'Apply patch', status: 'completed' }, { id: 'read', name: 'read', label: 'Read', status: 'completed' }] }),
    session('research', 'Research existing onboarding flows', { parentId: 'main', agentName: 'Researcher', tokenUsage: { input: researchInput, cachedInput: 6200, output: 1300 }, ...(!toolFinished ? { currentTool: { id: 'search', name: 'web_search_call', label: 'Web search', status: 'in_progress' } } : {}), toolHistory: [{ id: 'lookup', name: 'exec_command', label: 'Exec · rg', status: 'completed' }, ...(toolFinished ? [{ id: 'search', name: 'web_search_call', label: 'Web search', status: 'completed' }] : [])] }),
    session('design', 'Explore interface directions', { parentId: 'main', agentName: 'Designer', ...(designCompleted ? { status: 'completed' } : { needsInput: true }) }),
    ...(childCount > 2 ? [session('review', 'Review accessibility and keyboard flow', { parentId: 'research', agentName: 'Reviewer' })] : []),
    ...(childCount > 3 ? Array.from({ length: 50 }, (_, index) => session('extra-' + index, 'Specialist task ' + index, { parentId: 'main', agentName: 'Specialist ' + index })) : []),
    session('second', 'Audit dashboard performance', { agentName: 'Lead' }),
    session('performance', 'Profile rendering under load', { parentId: 'second', agentName: 'Performance' })
  ], sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 400 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (!localStorage.getItem('agentobs.preferences')) localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'tree', theme: 'rounded', colors: 'dark' })); });
    await page.goto(url); await page.waitForSelector('.agent');
    assert.equal(await page.locator('html').getAttribute('data-design'), 'modern', 'old design preferences migrate to the agent network');
    assert.equal(await page.locator('.brand-version').innerText(), require('../package.json').version);
    assert.equal(await page.getByRole('button', { name: 'Choose design' }).count(), 0);
    await page.waitForSelector('.modern-run');
    assert.equal(await page.locator('.metric-token-heading .token-help').isVisible(), false, 'Modern sidebar omits token help');
    assert.equal(await page.locator('#metric-tokens [title], #metric-tokens[title]').count(), 0, 'Modern sidebar token values have no hover boxes');
    const checkStatusShape = async theme => {
      const shapes = await page.evaluate(() => ({ status: getComputedStyle(document.querySelector('#status-trigger')).borderRadius, control: getComputedStyle(document.querySelector('.theme-toggle')).borderRadius }));
      assert.equal(shapes.status, shapes.control, theme + ' status button matches sidebar control corners');
    };
    await checkStatusShape('Rounded');
    await page.setViewportSize({ width: 1920, height: 1080 });
    assert.equal(await page.locator('.header-identity').evaluate(node => getComputedStyle(node).display), 'flex', 'maximized Modern sidebar keeps its identity container');
    for (const selector of ['.header-identity', '.workspace-picker', '.modern-navigation', '.overview', '.topbar']) {
      assert.ok((await page.locator(selector).boundingBox()).width > 180, selector + ' uses the sidebar width when maximized');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Monitoring status', exact: true }).click();
    const statusTriggerBox = await page.locator('#status-trigger').boundingBox();
    const statusMenuBox = await page.locator('#status-menu').boundingBox();
    assert.ok(statusMenuBox.y >= 0 && statusMenuBox.y + statusMenuBox.height <= 1000, 'Modern status details fit within the viewport');
    assert.ok(statusMenuBox.y + statusMenuBox.height <= statusTriggerBox.y, 'status opens above the bottom sidebar control');
    const longStatus = await page.evaluate(() => {
      const panel = document.querySelector('#status-menu'), reasons = document.querySelector('#status-reasons');
      for (let i = 0; i < 60; i++) { const item = document.createElement('li'); item.className = 'status-reason'; item.textContent = 'Recorded issue ' + i; reasons.append(item); }
      window.dispatchEvent(new Event('resize'));
      panel.scrollTop = panel.scrollHeight;
      const rect = panel.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, scrollable: panel.scrollHeight > panel.clientHeight, scrolled: panel.scrollTop > 0 };
    });
    assert.ok(longStatus.top >= 0 && longStatus.bottom <= 1000 && longStatus.scrollable && longStatus.scrolled, 'long status details fit and can be scrolled');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Chamfered', exact: true }).click();
    await checkStatusShape('Chamfered');
    assert.equal(await page.locator('.dashboard-header .metric').first().evaluate(node => getComputedStyle(node).clipPath), 'none', 'Chamfered does not clip sidebar metrics');
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Rounded', exact: true }).click();
    await checkStatusShape('Rounded');
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Terminal', exact: true }).click();
    await checkStatusShape('Terminal');
    await page.getByRole('button', { name: 'Choose theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Rounded', exact: true }).click();
    assert.equal(await page.locator('.modern-run').count(), 2);
    const primaryRun = page.locator('.modern-run').filter({ hasText: 'Build the new customer onboarding experience' });
    const totals = primaryRun.locator('.modern-workspace-totals');
    assert.deepEqual(await totals.locator('.modern-workspace-token').allTextContents(), ['IN37.3k', 'CACHED18.2k', 'OUT3.4k'], 'workspace shows totals including subagents');
    assert.match(await totals.locator('[data-token-field="input"]').getAttribute('title'), /37,300/);
    const emptyTotals = page.locator('.modern-run').filter({ hasText: 'Audit dashboard performance' }).locator('.modern-workspace-totals');
    assert.deepEqual(await emptyTotals.locator('.modern-workspace-token').allTextContents(), ['IN—', 'CACHED—', 'OUT—'], 'unknown totals are not shown as zero');
    researchInput = 13000;
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-workspace-totals [data-token-field="input"]')].some(node => node.textContent === 'IN37.8k'));
    assert.equal(await page.locator('.modern-agent').count(), 5);
    const wideResearch = await page.locator('.modern-agent', { hasText: 'Research existing onboarding flows' }).boundingBox();
    const wideDesign = await page.locator('.modern-agent', { hasText: 'Explore interface directions' }).boundingBox();
    assert.equal(wideResearch.y, wideDesign.y, 'wide workspace places sibling agents side by side');
    assert.ok(wideDesign.x + wideDesign.width <= wideResearch.x || wideResearch.x + wideResearch.width <= wideDesign.x, 'wide siblings use the available horizontal space');
    const compactButton = primaryRun.getByRole('button', { name: 'Compact', exact: true });
    const checkBoxZoom = async label => {
      const viewport = primaryRun.locator('.modern-graph-viewport');
      await viewport.scrollIntoViewIfNeeded();
      const box = await viewport.boundingBox();
      const graph = viewport.locator('.modern-graph');
      const scale = () => graph.evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
      const before = await scale();
      await page.mouse.move(box.x + 60, box.y + 45); await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + 145, { steps: 4 });
      assert.equal(await page.locator('.graph-selection-box').count(), 1, label + ' draws the selection');
      await page.mouse.up();
      assert.ok(await scale() > before, label + ' zooms in on the selection');
      assert.equal(await page.locator('.graph-selection-box').count(), 0);
      await viewport.focus(); await page.keyboard.press('0');
      const reset = await scale();
      await page.mouse.move(box.x + 60, box.y + 45); await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + 145, { steps: 4 });
      await page.keyboard.press('Escape'); await page.mouse.up();
      assert.equal(await scale(), reset, label + ' Escape cancels the selection');
      assert.equal(await page.locator('.graph-selection-box').count(), 0);
    };
    await checkBoxZoom('Card graph');
    const normalHeight = (await page.locator('.modern-agent').first().boundingBox()).height;
    await compactButton.click();
    assert.equal(await compactButton.getAttribute('aria-pressed'), 'true');
    await checkBoxZoom('Compact graph');
    assert.ok((await page.locator('.modern-agent').first().boundingBox()).height < normalHeight - 15, 'Compact shows small swarm nodes');
    assert.equal(await page.locator('.modern-links path').count(), 3, 'swarm preserves parent-child connections');
    const toolColors = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.modern-swarm-node')];
      const findNode = text => nodes.find(node => node.textContent.includes(text));
      const calls = [...document.querySelectorAll('.modern-call')];
      const findCall = text => calls.find(call => call.querySelector('strong')?.textContent === text);
      const color = node => getComputedStyle(node).backgroundColor;
      return { npm: color(findNode('Build the new customer onboarding experience')), web: color(findNode('Research existing onboarding flows')),
        npmFeed: getComputedStyle(findCall('Exec · npm')).borderLeftColor, webFeed: getComputedStyle(findCall('Web search')).borderLeftColor,
        attention: color(findNode('Explore interface directions')) };
    });
    assert.equal(toolColors.npm, toolColors.npmFeed, 'Compact uses the same npm tool color as the feed');
    assert.equal(toolColors.web, toolColors.webFeed, 'Compact uses the same web-search color as the feed');
    assert.notEqual(toolColors.npm, toolColors.web, 'different active tools have different node colors');
    assert.notEqual(toolColors.web, toolColors.attention, 'agents without active tools keep their status color');
    assert.notEqual(await page.locator('.modern-swarm-node.agent-tool').first().evaluate(node => getComputedStyle(node).backgroundColor), await page.locator('.modern-swarm-node.agent-input').first().evaluate(node => getComputedStyle(node).backgroundColor), 'working and attention states have distinct node colors');
    const swarmNode = page.locator('.modern-swarm-node', { hasText: 'Research existing onboarding flows' });
    await swarmNode.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await swarmNode.hover();
    assert.equal(await page.locator('.modern-swarm-preview').isVisible(), true, 'hover reveals the full card');
    await swarmNode.focus();
    assert.equal(await page.locator('.modern-swarm-preview').isVisible(), true, 'keyboard focus reveals the full card');
    assert.match(await page.locator('.modern-swarm-preview').innerText(), /Research existing onboarding flows/);
    assert.match(await swarmNode.getAttribute('aria-label'), /Running tool/);
    assert.equal(await swarmNode.locator('xpath=ancestor::*[contains(@class,"modern-graph-viewport")]').locator('.modern-links path.is-hovered').count(), 1, 'focus highlights the agent connection');
    await swarmNode.click();
    assert.equal(await page.locator('.inspector h2').innerText(), 'Research existing onboarding flows', 'Compact nodes open agent details');
    await page.getByRole('button', { name: 'Close ×' }).click();
    await page.reload(); await page.waitForSelector('.modern-agent');
    assert.equal(await compactButton.getAttribute('aria-pressed'), 'true', 'Compact persists across reload');
    assert.ok((await page.locator('.modern-agent').first().boundingBox()).height < normalHeight - 15);
    await compactButton.click();
    assert.equal((await page.locator('.modern-agent').first().boundingBox()).height, normalHeight, 'turning Compact off restores full cards');
    const firstView = page.locator('.modern-graph-viewport').first();
    const secondView = page.locator('.modern-graph-viewport').nth(1);
    const viewBounds = await firstView.boundingBox();
    await page.mouse.move(viewBounds.x + 100, viewBounds.y + 100);
    await page.keyboard.down('Alt'); await page.mouse.wheel(0, -500); await page.keyboard.up('Alt');
    assert.ok(await firstView.locator('.modern-graph').evaluate(node => node.getBoundingClientRect().width > node.offsetWidth), 'Alt-wheel zooms the selected workspace');
    assert.equal(await secondView.locator('.modern-graph').evaluate(node => node.style.transform), 'scale(1)', 'other workspaces keep their zoom');
    await firstView.evaluate(node => { node.scrollLeft = 150; node.scrollTop = 100; });
    const scrollBeforePan = await firstView.evaluate(node => [node.scrollLeft, node.scrollTop]);
    await page.mouse.down({ button: 'middle' }); await page.mouse.move(viewBounds.x + 50, viewBounds.y + 50, { steps: 4 }); await page.mouse.up({ button: 'middle' });
    const scrollAfterPan = await firstView.evaluate(node => [node.scrollLeft, node.scrollTop]);
    assert.ok(scrollAfterPan[0] > scrollBeforePan[0] || scrollAfterPan[1] > scrollBeforePan[1], 'middle-drag pans the graph');
    assert.equal(await primaryRun.locator('.modern-run-info .modern-fit').count(), 1, 'graph Fit is beside the collapse control');
    await page.getByRole('button', { name: 'Fit agents in Build the new customer onboarding experience', exact: true }).click();
    const fit = await firstView.evaluate(view => { const graph = view.querySelector('.modern-graph').getBoundingClientRect(), box = view.getBoundingClientRect(); return { left: graph.left - box.left, top: graph.top - box.top, right: graph.right - box.right, bottom: graph.bottom - box.bottom }; });
    assert.ok(fit.left >= -1 && fit.top >= -1 && fit.right <= 1 && fit.bottom <= 1, 'Fit restores the whole card network to view: ' + JSON.stringify(fit));
    assert.equal(await secondView.locator('.modern-graph').evaluate(node => node.style.transform), 'scale(1)', 'Fit affects only its workspace');
    const split = page.getByRole('button', { name: 'Resize tool activity for Build the new customer onboarding experience', exact: true });
    const panel = primaryRun.locator('.modern-tools-panel');
    const beforeSplit = { graph: await firstView.evaluate(node => node.clientHeight), tools: await panel.evaluate(node => node.getBoundingClientRect().height), other: await secondView.evaluate(node => node.clientHeight) };
    await split.focus(); await page.keyboard.press('ArrowUp');
    assert.ok(Math.abs((await panel.evaluate(node => node.getBoundingClientRect().height)) - beforeSplit.tools - 40) < 2, 'keyboard expands tool activity');
    assert.ok(Math.abs((await firstView.evaluate(node => node.clientHeight)) - beforeSplit.graph + 40) < 2, 'keyboard resize takes space from graph');
    assert.equal(await secondView.evaluate(node => node.clientHeight), beforeSplit.other, 'tool resize affects only its workspace');
    assert.equal(await panel.locator('.modern-calls').evaluate(node => getComputedStyle(node).flexWrap), 'wrap', 'expanded activity uses additional rows');
    await split.scrollIntoViewIfNeeded();
    const divider = await split.boundingBox(), beforeDrag = await panel.evaluate(node => node.getBoundingClientRect().height);
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2); await page.mouse.down();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2 - 30, { steps: 4 }); await page.mouse.up();
    assert.ok(Math.abs((await panel.evaluate(node => node.getBoundingClientRect().height)) - beforeDrag - 30) < 2, 'dragging the divider expands tool activity');
    const savedToolHeight = await panel.evaluate(node => node.getBoundingClientRect().height);
    await page.reload(); await page.waitForSelector('.modern-agent');
    assert.ok(Math.abs((await panel.evaluate(node => node.getBoundingClientRect().height)) - savedToolHeight) < 2, 'tool height persists after reload');
    await page.getByRole('button', { name: 'Fit all workspaces', exact: true }).click();
    assert.ok(Math.abs((await panel.evaluate(node => node.getBoundingClientRect().height)) - beforeSplit.tools) < 2, 'Fit restores the default tool activity height');
    const resize = page.getByRole('button', { name: 'Resize workspace Build the new customer onboarding experience' });
    const initialViewHeight = await firstView.evaluate(node => node.clientHeight);
    await resize.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await firstView.evaluate(node => node.clientHeight), initialViewHeight + 40, 'keyboard resizes the workspace');
    const runWidth = (await resize.locator('xpath=..').boundingBox()).width;
    await page.keyboard.press('ArrowLeft');
    assert.ok((await resize.locator('xpath=..').boundingBox()).width < runWidth, 'keyboard changes workspace width');
    await page.reload(); await page.waitForSelector('.modern-agent');
    assert.equal(await firstView.evaluate(node => node.clientHeight), initialViewHeight + 40, 'workspace size persists across reload');
    assert.ok((await resize.locator('xpath=..').boundingBox()).width < runWidth, 'workspace width persists across reload');
    await resize.focus(); await page.keyboard.press('ArrowRight');
    await resize.scrollIntoViewIfNeeded();
    const resizeBounds = await resize.boundingBox();
    await page.mouse.move(resizeBounds.x + resizeBounds.width / 2, resizeBounds.y + resizeBounds.height / 2);
    await page.mouse.down(); await page.mouse.move(resizeBounds.x + resizeBounds.width / 2, resizeBounds.y + resizeBounds.height / 2 + 35, { steps: 4 }); await page.mouse.up();
    assert.equal(await firstView.evaluate(node => node.clientHeight), initialViewHeight + 75, 'dragging resizes the workspace');
    assert.equal(await page.locator('.modern-execution-caption', { hasText: 'RUNNING TOOL' }).count(), 2);
    assert.equal(await page.locator('.modern-tool-history').count(), 0, 'recent tool history is shown in the workspace feed instead of the cards');
    assert.equal(await page.locator('.modern-call', { hasText: 'Apply patch' }).count(), 1);
    assert.equal(await page.locator('.modern-calls .modern-call-button').count(), 5);
    const assertToolColors = async () => {
      const result = await page.evaluate(() => {
        const main = [...document.querySelectorAll('.modern-agent')].find(node => node.querySelector('.modern-task')?.textContent === 'Build the new customer onboarding experience');
        const research = [...document.querySelectorAll('.modern-agent')].find(node => node.querySelector('.modern-task')?.textContent === 'Research existing onboarding flows');
        const npm = main.querySelector('.modern-execution'), web = research.querySelector('.modern-execution.has-tool') || [...document.querySelectorAll('.modern-call')].find(node => node.querySelector('strong')?.textContent === 'Web search');
        const read = [...document.querySelectorAll('.modern-call')].find(node => node.querySelector('strong')?.textContent === 'Read');
        const patch = [...document.querySelectorAll('.modern-call')].find(node => node.querySelector('strong')?.textContent === 'Apply patch');
        const npmCall = [...document.querySelectorAll('.modern-call')].find(node => node.querySelector('strong')?.textContent === 'Exec · npm');
        const color = node => getComputedStyle(node).getPropertyValue('--tool-hue').trim();
        return { npm: color(npm), web: color(web), read: color(read), patch: color(patch), npmCall: color(npmCall),
          npmClass: npm.classList.contains(window.agentobsViews.toolColorClass({ name: 'exec_command', label: 'Exec · npm' })),
          readClass: read.classList.contains(window.agentobsViews.toolColorClass({ name: 'read', label: 'Read' })) };
      });
      assert.ok(result.npmClass && result.readClass, 'Modern uses the shared tool mapping');
      assert.equal(result.npm, result.npmCall, 'tool feed and node share the same color');
      assert.equal(new Set([result.npm, result.web, result.read, result.patch]).size, 4, 'different tools remain visually distinguishable');
    };
    await assertToolColors();
    assert.ok(await page.locator('.dashboard-header').evaluate(el => el.getBoundingClientRect().height > 700 && el.getBoundingClientRect().width < 300), 'desktop Modern uses the navigation rail');
    assert.equal(await page.getByRole('navigation', { name: 'Workspace navigation' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'History', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Needs attention', exact: true }).first().click();
    assert.equal(await page.locator('.attention-queue:not(.finishing-queue)').evaluate(node => node.open), true);
    await page.locator('.attention-queue:not(.finishing-queue) > summary').click();
    assert.equal(await page.getByRole('button', { name: 'Choose theme' }).isVisible(), true, 'theme is directly available');
    assert.equal(await page.getByRole('button', { name: 'Choose colors' }).isVisible(), true, 'colors are directly available');
    assert.equal(await page.locator('.modern-links path').count(), 3, 'one link for every parent-child relationship');
    assert.equal(await page.locator('.modern-state', { hasText: 'Needs input' }).count(), 1);
    assert.equal(await page.locator('.modern-agent', { hasText: 'Research existing onboarding flows' }).getAttribute('aria-label').then(s => s.includes('delegated by')), true);
    if (process.env.AGENTOBS_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'modern-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'Choose colors' }).click(); await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
      await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'modern-light.png'), fullPage: true });
      await page.getByRole('button', { name: 'Choose colors' }).click(); await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
    }
    const research = page.locator('.modern-agent', { hasText: 'Research existing onboarding flows' });
    await firstView.focus(); await page.keyboard.press('+');
    const zoomBeforeUpdate = await firstView.locator('.modern-graph').evaluate(node => node.style.transform);
    const before = await research.boundingBox();
    await research.focus(); childCount = 3;
    await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 6);
    const after = await research.boundingBox();
    assert.equal(await firstView.locator('.modern-graph').evaluate(node => node.style.transform), zoomBeforeUpdate, 'live updates preserve workspace zoom');
    assert.equal(after.x, before.x, 'existing node retains its horizontal position when a child spawns');
    assert.equal(after.y, before.y, 'existing node retains its vertical position when a child spawns');
    assert.equal(await page.evaluate(() => document.activeElement.querySelector('.modern-task')?.textContent), 'Research existing onboarding flows');
    assert.equal(await page.locator('#metric-tools-running').innerText(), '2', 'scope overview counts running tools');
    toolFinished = true;
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-call-button')].some(node => node.getAttribute('aria-label') === 'Web search, Done, Researcher. Show agent details'));
    assert.equal(await page.locator('#metric-tools-running').innerText(), '1', 'scope overview updates when a tool finishes');
    assert.equal(await research.locator('.modern-execution-caption').innerText(), 'CURRENT ACTIVITY');
    assert.equal(await page.getByRole('button', { name: 'Web search, Done, Researcher. Show agent details' }).count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.querySelector('.modern-task')?.textContent), 'Research existing onboarding flows');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.inspector h2').innerText(), 'Research existing onboarding flows');
    assert.equal(await page.locator('.modern-links path.is-lineage').count(), 1, 'selected agent highlights its parent link');
    await page.getByRole('button', { name: 'Close ×' }).click();
    const toolCall = page.getByRole('button', { name: 'Web search, Done, Researcher. Show agent details' });
    await toolCall.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.inspector h2').innerText(), 'Research existing onboarding flows');
    await page.keyboard.press('Escape');
    assert.equal(await toolCall.evaluate(node => document.activeElement === node), true, 'keyboard focus returns to the tool activity entry');
    await page.getByRole('button', { name: 'Hide delegated agents under Research existing onboarding flows' }).click();
    assert.equal(await page.locator('.modern-agent').count(), 5);
    await page.getByRole('button', { name: 'Show 1 delegated agent under Research existing onboarding flows' }).click();
    assert.equal(await page.locator('.modern-agent').count(), 6);
    await page.getByRole('button', { name: 'Hide delegated agents under Build the new customer onboarding experience' }).click();
    await page.locator('.attention-queue:not(.finishing-queue) > summary').click();
    await page.getByRole('button', { name: /Show Explore interface directions/ }).click();
    assert.equal(await page.locator('.inspector h2').innerText(), 'Explore interface directions');
    assert.equal(await page.locator('.modern-agent', { hasText: 'Explore interface directions' }).count(), 1, 'attention selection expands its graph path');
    await page.getByRole('button', { name: 'Close ×' }).click();
    await page.locator('input[type=search]').fill('accessibility');
    assert.equal(await page.locator('.modern-agent', { hasText: 'Review accessibility' }).count(), 1);
    await page.locator('input[type=search]').fill('');
    await page.reload(); await page.waitForSelector('.modern-run');
    assert.equal(await page.locator('html').getAttribute('data-design'), 'modern');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page-wide overflow on phone');
    assert.equal(await page.locator('.modern-state', { hasText: 'Needs input' }).isVisible(), true);
    const phoneHeight = (await primaryRun.locator('.modern-agent').first().boundingBox()).height;
    await compactButton.click();
    assert.ok((await primaryRun.locator('.modern-agent').first().boundingBox()).height < phoneHeight - 15, 'Compact shows swarm nodes on phone');
    const phonePanel = primaryRun.locator('.modern-tools-panel'), phoneSplit = primaryRun.getByRole('button', { name: 'Resize tool activity for Build the new customer onboarding experience' });
    const phoneToolHeight = await phonePanel.evaluate(node => node.getBoundingClientRect().height);
    await phoneSplit.focus(); await page.keyboard.press('ArrowUp');
    assert.ok((await phonePanel.evaluate(node => node.getBoundingClientRect().height)) > phoneToolHeight, 'tool activity can be resized in Compact on phone');
    await phoneSplit.focus(); await page.keyboard.press('ArrowDown');
    await compactButton.click();
    if (process.env.AGENTOBS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'modern-phone.png'), fullPage: true });
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.getByRole('button', { name: 'Choose colors' }).click(); await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-colors'), 'light');
    await assertToolColors();
    assert.equal(await page.locator('.modern-agent').count(), 6);
    for (const theme of ['Rounded', 'Chamfered', 'Terminal', 'Flat', 'Layered', 'Glass']) {
      await page.getByRole('button', { name: 'Choose theme' }).click(); await page.getByRole('menuitemradio', { name: theme, exact: true }).click();
      for (const color of ['Dark', 'Light', 'Dark+', 'Light+', 'Solarized Light', 'Monokai', 'Linux Mint', 'Ubuntu']) {
        await page.getByRole('button', { name: 'Choose colors' }).click(); await page.getByRole('menuitemradio', { name: color, exact: true }).click();
        assert.equal(await page.locator('.modern-agent').count(), 6, theme + ' / ' + color);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, theme + ' / ' + color + ' phone overflow');
      }
    }
    await page.getByRole('button', { name: 'Close sidebar' }).click();
    const viewport = page.locator('.modern-graph-viewport').first();
    await viewport.evaluate(node => { node.scrollTop = 100; });
    const scrollBefore = await viewport.evaluate(node => node.scrollTop);
    childCount = 51;
    await page.waitForFunction(() => document.querySelectorAll('.modern-agent').length === 56);
    assert.equal(await viewport.evaluate(node => node.scrollTop), scrollBefore, 'live additions do not reset the viewport');
    assert.equal(await page.locator('.modern-links path').count(), 54, 'large family preserves all real delegation links');
    assert.equal(await page.evaluate(() => {
      return [...document.querySelectorAll('.modern-run')].every(run => {
        const cards = [...run.querySelectorAll('.modern-agent')].map(node => node.getBoundingClientRect());
        return cards.every((box, i) => cards.slice(i + 1).every(other => box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom));
      });
    }), true, 'large graph nodes do not overlap');
    designCompleted = true;
    const completedToggle = page.getByRole('button', { name: 'Show 1 completed agent under Build the new customer onboarding experience' });
    await completedToggle.waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.modern-agent', { hasText: 'Explore interface directions' }).count(), 0, 'completed subagents collapse by default');
    assert.equal(await page.locator('.modern-agent', { hasText: 'Research existing onboarding flows' }).count(), 1, 'active siblings remain visible');
    await compactButton.click();
    assert.equal(await page.locator('.modern-swarm-node', { hasText: 'Explore interface directions' }).count(), 1, 'Compact includes completed agents as minimized nodes');
    await compactButton.click();
    assert.equal(await page.locator('.modern-agent', { hasText: 'Explore interface directions' }).count(), 0, 'leaving Compact restores completed-group visibility');
    await completedToggle.click();
    assert.equal(await page.locator('.modern-agent', { hasText: 'Explore interface directions' }).count(), 1, 'completed subagents can be expanded');
    await page.reload(); await page.waitForSelector('.modern-run');
    assert.equal(await page.locator('.modern-agent', { hasText: 'Explore interface directions' }).count(), 1, 'expanded completed subagents remain expanded after reload');
    await page.getByRole('button', { name: 'Hide 1 completed agent under Build the new customer onboarding experience' }).click();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.locator('input[type=search]').fill('interface directions');
    assert.equal(await page.locator('.modern-agent', { hasText: 'Explore interface directions' }).count(), 1, 'search reveals minimized completed subagents');
    await page.locator('input[type=search]').fill('');
    assert.deepEqual(errors, []);
    console.log('PASS Modern: hierarchy, live update and focus, selection, filtering, persistence, phone, all theme and palette combinations');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
