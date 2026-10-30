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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-large-cards-'));
  const now = new Date().toISOString();
  const sessions = Array.from({ length: 1000 }, (_, i) => {
    const parent = i === 0 ? null : i <= 20 ? 0 : i <= 120 ? 1 + (i - 21) % 20 : i <= 420 ? 21 + (i - 121) % 100 : 121 + (i - 421) % 300;
    const level = i === 0 ? 0 : i <= 20 ? 1 : i <= 120 ? 2 : i <= 420 ? 3 : 4;
    return { id: 'agent-' + i, ...(parent === null ? {} : { parentId: 'agent-' + parent }), currentTask: i === 2 ? 'A long delegated task title that wraps across multiple lines and needs to preserve the status, summary, and token footer' : 'Task agent-' + i, agentName: i === 0 ? 'Coordinator' : 'Agent ' + i, cwd: root, provider: 'fixture', providerLabel: 'Fixture', status: 'active', hasLifecycle: true, lastActivity: now, currentTool: { id: 'call-' + i, name: 'exec_command', label: 'Exec · ' + (i % 2 ? 'git' : 'npm'), status: 'in_progress', timestamp: now }, level };
  });
  const adapter = { id: 'fixture', async scan() { return { sessions, sources: [], unreadable: 0 }; } };
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 1000 };
  const dashboard = createDashboard(config, { observer: new Observer(config, [adapter]) }); let browser;
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('agentobs.preferences', JSON.stringify({ design: 'modern', modernSwarm: false })));
    await page.goto(url); await page.waitForSelector('.modern-agent');
    const run = page.locator('.modern-run').first(), view = run.locator('.modern-graph-viewport');
    const item = id => view.locator('.modern-item').filter({ has: page.locator('.modern-task', { hasText: new RegExp('^Task agent-' + id + '$') }) });
    const findOverlaps = () => view.evaluate(node => {
      const items = [...node.querySelectorAll('.modern-item')].map(item => ({ id: item.querySelector('.modern-agent').dataset.key, rects: [...item.querySelectorAll('.modern-agent, .modern-branch-toggle, .modern-completed-toggle')].map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, type: el.className }; }) }));
      const found = [];
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) for (const a of items[i].rects) for (const b of items[j].rects) if (a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5) found.push([items[i].id, a.type, items[j].id, b.type]);
      return found.slice(0, 5);
    });
    assert.equal(await view.locator('.modern-agent').count(), 21, 'large runs initially show the coordinator and L1 agents');
    assert.match(await run.locator('.modern-graph-header').innerText(), /21 of 1000 agents shown/);
    assert.match(await view.locator('.modern-branch-summary').first().innerText(), /delegated.*active/);
    const longCardFits = await view.locator('.modern-agent').filter({ hasText: 'A long delegated task title' }).evaluate(card => {
      const box = card.getBoundingClientRect();
      return [...card.children].every(child => { const rect = child.getBoundingClientRect(); return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 && rect.height > 0; });
    });
    assert.equal(longCardFits, true, 'long titles keep activity, summary and token values inside the card');
    const clippedLabels = await view.locator('.modern-node-context, .modern-branch-summary').evaluateAll(nodes => nodes.filter(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1).map(node => ({ text: node.textContent, height: node.clientHeight, scrollHeight: node.scrollHeight, width: node.clientWidth, scrollWidth: node.scrollWidth })));
    const initialBox = await view.boundingBox();
    await page.mouse.move(initialBox.x + 100, initialBox.y + 100);
    await page.keyboard.down('Alt'); await page.mouse.wheel(0, 600); await page.keyboard.up('Alt');
    await page.waitForFunction(() => Number(document.querySelector('.modern-graph-viewport').dataset.columns) > 8);
    const spaceUsage = await view.evaluate(node => ({ width: node.clientWidth, graph: node.querySelector('.modern-graph').getBoundingClientRect().width }));
    assert.ok(spaceUsage.graph >= spaceUsage.width * .65, 'zoomed-out large graph uses the available workspace width: ' + JSON.stringify(spaceUsage));
    await item(1).getByRole('button', { name: /Show .* delegated agents under Task agent-1$/ }).click();
    await item(3).getByRole('button', { name: /Show .* delegated agents under Task agent-3$/ }).click();
    assert.equal(await view.locator('.modern-agent').count(), 31, 'multiple branches can expand in the zoomed-out layout');
    assert.deepEqual(await findOverlaps(), [], 'zoomed-out expanded cards and controls do not overlap');
    const expandedUsage = await view.evaluate(node => {
      const cards = [...node.querySelectorAll('.modern-agent')].filter(card => /\/ L1$/.test(card.querySelector('.modern-node-id').textContent));
      const x = cards.map(card => card.getBoundingClientRect().left);
      return { span: Math.max(...x) - Math.min(...x), width: node.clientWidth };
    });
    assert.ok(expandedUsage.span > expandedUsage.width * .6, 'expanded branches use the width at the current zoom: ' + JSON.stringify(expandedUsage));
    const compactColumns = await view.evaluate(node => {
      const cards = [...node.querySelectorAll('.modern-agent')].filter(card => /\/ L1$/.test(card.querySelector('.modern-node-id').textContent));
      const groups = new Map();
      for (const card of cards) {
        const x = card.parentElement.style.left, y = parseFloat(card.parentElement.style.top);
        if (!groups.has(x)) groups.set(x, []);
        groups.get(x).push(y);
      }
      return [...groups.values()].some(ys => { ys.sort((a, b) => a - b); return ys.length > 1 && ys[1] - ys[0] <= 290; });
    });
    assert.ok(compactColumns, 'short branches fill the empty space beneath other short branches');
    if (process.env.AGENTOBS_SCREENSHOT_DIR) { await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR, { recursive: true }); await run.screenshot({ path: path.join(process.env.AGENTOBS_SCREENSHOT_DIR, 'large-card-wide-zoom.png') }); }
    if (process.env.AGENTOBS_SCREENSHOT_DIR) { await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR,{recursive:true}); await run.screenshot({path:path.join(process.env.AGENTOBS_SCREENSHOT_DIR,'large-card-overview.png')}); }
    await run.getByRole('button', { name: 'Fit agents in Task agent-0' }).click();
    const fitted = await view.locator('.modern-graph').evaluate(node => parseFloat(node.style.transform.match(/[\d.]+/)[0]));
    assert.ok(fitted >= .8, 'Fit maintains a readable overview for large runs');
    await item(1).getByRole('button', { name: /Show .* delegated agents under Task agent-1$/ }).click();
    assert.equal(await view.locator('.modern-agent').count(), 26, 'expanding one branch reveals its direct children');
    const coords = await view.evaluate(view => {
      const find = id => { const card = [...view.querySelectorAll('.modern-agent')].find(n => JSON.parse(n.dataset.key)[0] === 'agent-' + id); return { x: parseFloat(card.parentElement.style.left), y: parseFloat(card.parentElement.style.top), context: card.querySelector('.modern-node-context')?.textContent }; };
      return { parent: find(1), siblings: [21,41,61,81,101].map(find) };
    });
    assert.ok(coords.siblings.every(child => child.x > coords.parent.x && /L2 · under Agent 1/.test(child.context)), 'children have depth and parent context');
    const ys = coords.siblings.map(child => child.y).sort((a,b)=>a-b);
    assert.ok(ys.every((y,i) => i === 0 || y - ys[i-1] <= 240), 'direct siblings are adjacent instead of separated by subtrees');
    await item(21).getByRole('button', { name: /Show .* delegated agents under Task agent-21$/ }).click();
    const branchSpacing = await view.evaluate(view => {
      const y = id => parseFloat([...view.querySelectorAll('.modern-agent')].find(card => JSON.parse(card.dataset.key)[0] === 'agent-' + id).parentElement.style.top);
      return { parent: y(21), child: y(121), nextSibling: y(41) };
    });
    assert.ok(branchSpacing.parent < branchSpacing.child && branchSpacing.child < branchSpacing.nextSibling, 'expanding an L2 agent inserts space for its children before the next L2 sibling: ' + JSON.stringify(branchSpacing));
    const directYs = await view.evaluate(view => [21,41,61,81,101].map(id => { const n = [...view.querySelectorAll('.modern-agent')].find(card => JSON.parse(card.dataset.key)[0] === 'agent-' + id); return parseFloat(n.parentElement.style.top); }).sort((a,b)=>a-b));
    assert.ok(directYs.every((y,i) => i === 0 || y - directYs[i-1] >= 232), 'opening a deeper branch reserves distinct rows for siblings');
    await item(121).getByRole('button', { name: /Show .* delegated agents under Task agent-121$/ }).click();
    assert.match(await item(421).locator('.modern-node-context').innerText(), /L4 · under Agent 121/, 'L4 agents keep their parent and level context');
    const crossedCards = await view.evaluate(view => {
      const cards = [...view.querySelectorAll('.modern-agent')].map(card => ({ key: card.dataset.key, rect: card.getBoundingClientRect() }));
      const paths = [...view.querySelectorAll('.modern-links path')];
      const found = [];
      for (const path of paths) {
        const total = path.getTotalLength(), matrix = path.getScreenCTM();
        for (let offset = 5; offset < total - 5; offset += 5) {
          const point = path.getPointAtLength(offset).matrixTransform(matrix);
          const card = cards.find(({rect}) => point.x > rect.left + 2 && point.x < rect.right - 2 && point.y > rect.top + 2 && point.y < rect.bottom - 2);
          if (card) { found.push(card.key); break; }
        }
      }
      return found.slice(0, 8);
    });
    assert.deepEqual(crossedCards, [], 'connections avoid unrelated agent cards when branches expand');
    assert.deepEqual(await findOverlaps(), [], 'expanded cards and branch controls do not overlap');
    assert.deepEqual(clippedLabels, [], 'level and delegated labels remain fully readable');
    assert.equal(await view.locator('.modern-node-context, .modern-branch-summary').evaluateAll(nodes => nodes.filter(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1).length), 0, 'expanded deep-branch labels remain fully readable');
    const positions = await view.locator('.modern-item').evaluateAll(items => items.map(item => [item.style.left, item.style.top]));
    for (const [name, id] of [['Flat', 'flat'], ['Layered', 'layered'], ['Glass', 'glass']]) {
      await page.getByRole('button', { name: 'Choose theme' }).click();
      await page.getByRole('menuitemradio', { name, exact: true }).click();
      assert.equal(await page.locator('html').getAttribute('data-dashboard-theme'), id);
      assert.deepEqual(await view.locator('.modern-item').evaluateAll(items => items.map(item => [item.style.left, item.style.top])), positions, name + ' preserves large-graph positions');
      assert.deepEqual(await findOverlaps(), [], name + ' keeps expanded cards and controls apart');
      assert.equal(await view.locator('.modern-node-context, .modern-branch-summary').evaluateAll(nodes => nodes.filter(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1).length), 0, name + ' keeps hierarchy labels readable');
    }
    if (process.env.AGENTOBS_SCREENSHOT_DIR) { await fs.mkdir(process.env.AGENTOBS_SCREENSHOT_DIR,{recursive:true}); await run.screenshot({path:path.join(process.env.AGENTOBS_SCREENSHOT_DIR,'large-card-branches.png')}); }
    await run.getByRole('button', { name: 'Fit agents in Task agent-0' }).click();
    assert.equal(await view.locator('.modern-agent').count(), 21, 'Fit returns to the summarized overview');
    await item(1).locator('.modern-agent').click(); await page.getByRole('button', { name: 'Close ×' }).click();
    const scope = run.getByRole('combobox', { name: 'Tool activity scope for Task agent-0' });
    await scope.selectOption('agent');
    assert.equal(await run.locator('.modern-call').count(), 1, 'selected-agent scope shows that agent’s calls');
    assert.equal(await run.locator('.modern-call-actor').innerText(), 'Agent 1');
    await scope.selectOption('branch');
    assert.equal(await run.locator('.modern-call').count(), 12, 'branch results are bounded to one page');
    assert.match(await run.locator('.modern-calls-note').innerText(), /of 50 recent calls/);
    sessions[1].currentTool = { id: 'updated-tool', name: 'exec_command', label: 'Exec · python', status: 'in_progress', timestamp: now };
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-call-title strong')].some(node => node.textContent === 'Exec · python'));
    assert.equal(await scope.inputValue(), 'branch', 'tool scope survives live updates');
    assert.match(await run.locator('.modern-calls-note').innerText(), /of 50 recent calls/);
    const parentBefore = await item(1).locator('.modern-agent').boundingBox();
    sessions.push({ ...sessions[1], id: 'agent-1000', parentId: 'agent-1', agentName: 'Agent 1000', currentTask: 'Task agent-1000' });
    await page.waitForFunction(() => [...document.querySelectorAll('.modern-calls-note')].some(node => node.textContent.includes('of 51 recent calls')));
    assert.match(await item(1).locator('.modern-branch-summary').innerText(), /50 delegated/);
    const parentAfter = await item(1).locator('.modern-agent').boundingBox();
    assert.ok(Math.abs(parentBefore.x - parentAfter.x) < 2 && Math.abs(parentBefore.y - parentAfter.y) < 2, 'a new nested agent does not move the visible branch');
    const firstPage = await run.locator('.modern-call-actor').first().innerText();
    await run.getByRole('button', { name: 'Next tool calls for Task agent-0' }).click();
    assert.notEqual(await run.locator('.modern-call-actor').first().innerText(), firstPage, 'next page advances through the branch');
    assert.equal(await run.locator('.modern-call').count(), 12);
    await run.getByRole('button', { name: 'Previous tool calls for Task agent-0' }).click();
    await scope.selectOption('all');
    assert.match(await run.locator('.modern-calls-note').innerText(), /of 1001 recent calls/);
    await page.locator('input[type=search]').fill('Task agent-721');
    assert.equal(await view.locator('.modern-agent').count(), 5, 'search reveals a deep match with its ancestor path');
    assert.equal(await view.locator('.modern-task').filter({ hasText: 'Task agent-721' }).count(), 1);
    await page.locator('input[type=search]').fill('');
    await page.setViewportSize({ width: 390, height: 900 });
    await run.getByRole('button', { name: 'Fit agents in Task agent-0' }).click();
    assert.equal(await view.locator('.modern-graph').evaluate(node => parseFloat(node.style.transform.match(/[\d.]+/)[0])), 1, 'phone Fit keeps cards at readable scale');
    await item(1).getByRole('button', { name: /Show .* delegated agents under Task agent-1$/ }).click();
    await item(21).getByRole('button', { name: /Show .* delegated agents under Task agent-21$/ }).click();
    assert.deepEqual(await findOverlaps(), [], 'phone cards and branch controls do not overlap');
    assert.equal(await view.locator('.modern-node-context, .modern-branch-summary').evaluateAll(nodes => nodes.filter(node => node.scrollHeight > node.clientHeight + 1).length), 0, 'phone level and delegated labels are not vertically clipped');
    assert.ok(await run.locator('.modern-run-heading').evaluate(node => node.getBoundingClientRect().height) < 130, 'phone header does not reserve a 200px empty heading');
    if (process.env.AGENTOBS_SCREENSHOT_DIR) await run.screenshot({path:path.join(process.env.AGENTOBS_SCREENSHOT_DIR,'large-card-phone.png')});
    assert.deepEqual(errors, []);
    console.log('PASS 1,000-agent card overview, branch expansion, hierarchy context, bounded activity, and phone Fit');
  } finally { await browser?.close(); await dashboard.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
