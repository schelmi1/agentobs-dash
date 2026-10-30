'use strict';

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Observer } = require('../lib/observer');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-production-browser-'));
  const artifacts = process.env.AGENTOBS_SCREENSHOT_DIR || path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  let broken = false, globalFailure = false, stalled = false, release, waiting = false;
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 500 };
  const provider = id => ({ id, roots: ['/store/' + id], async scan() {
    if (broken && id === 'one') throw new Error('PRIVATE_OBSERVER_ERROR');
    const session = number => ({ id: id + ':' + number, provider: id, providerLabel: id, cwd: root, status: number ? 'completed' : 'active', currentTask: number ? 'Completed task ' + number : 'Active ' + id, lastActivity: new Date().toISOString() });
    return { sessions: [session(0), ...(id === 'one' ? Array.from({ length: 180 }, (_, i) => session(i + 1)) : [])], sources: [{ directory: '/store/' + id, provider: id, status: 'ready' }], unreadable: 0 };
  } });
  const observer = new Observer(config, [provider('one'), provider('two')]);
  const dashboard = createDashboard(config, { observer: { async scan() {
    if (globalFailure) throw new Error('PRIVATE_GLOBAL_ERROR');
    if (stalled) { waiting = true; await new Promise(resolve => { release = resolve; }); waiting = false; }
    return observer.scan();
  } } });
  let browser;
  const checks = [], errors = [];
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem('agentobs.preferences', JSON.stringify({ collapsed: {}, expandedCompleted: 4, search: {}, workspace: [], design: 'tree', theme: 'blueprint', colors: 'light' })));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const check = async (name, predicate) => { await page.waitForFunction(predicate); checks.push(name); console.log('PASS ' + name); };
    await page.goto(url);
    await check('malformed preferences recover and independent selections survive', () => document.querySelector('#connection').textContent === 'Live' && document.documentElement.dataset.dashboardTheme === 'rounded' && document.querySelectorAll('.agent').length === 2);
    await check('180 closed history cards are not constructed', () => !document.querySelector('.completed-history .agent') && document.querySelector('.completed-history > summary').textContent.includes('180'));
    await page.locator('.completed-history > summary').click();
    await check('opening history builds 180 workspace cards', () => document.querySelectorAll('.completed-history .modern-run').length === 180 && document.querySelectorAll('.completed-history .modern-agent').length === 180);
    await page.locator('.completed-history > summary').click();
    await check('closing history releases its cards', () => !document.querySelector('.completed-history .agent') && !document.querySelector('.completed-history .modern-run'));
    const healthyColor = await page.locator('#status-trigger').evaluate(node => getComputedStyle(node, '::before').backgroundColor);
    broken = true;
    await check('one failed harness keeps healthy agents and marks retained observations stale', () => document.querySelector('#connection').textContent === 'Degraded' && document.querySelectorAll('.modern-agent').length === 2 && [...document.querySelectorAll('.modern-agent')].some(node => node.textContent.includes('Observation unavailable')) && document.querySelector('#status-picker').dataset.severity === 'high');
    await page.getByRole('button', { name: 'Monitoring status', exact: true }).click();
    await check('Status explains an unavailable provider with high severity', () => !document.querySelector('#status-menu').hidden && document.querySelector('#status-reasons').textContent.includes('HARNESS_SCAN_FAILED') && document.querySelector('#status-reasons').textContent.includes('/store/one') && document.querySelector('#status-severity').textContent === 'Severity: High');
    const highColor = await page.locator('#status-trigger').evaluate(node => getComputedStyle(node, '::before').backgroundColor);
    assert.notEqual(highColor, healthyColor);
    await page.screenshot({ path: path.join(artifacts, 'degraded.png'), fullPage: true });
    globalFailure = true;
    await check('whole-scan failure is reported over a still-open SSE connection', () => document.querySelector('#connection').textContent === 'Error' && document.querySelector('#status-reasons').textContent.includes('SCAN_FAILED') && document.querySelector('#status-picker').dataset.severity === 'critical');
    const criticalColor = await page.locator('#status-trigger').evaluate(node => getComputedStyle(node, '::before').backgroundColor);
    assert.notEqual(criticalColor, highColor); assert.notEqual(criticalColor, healthyColor);
    await page.screenshot({ path: path.join(artifacts, 'error.png'), fullPage: true });
    assert.equal((await page.locator('body').textContent()).includes('PRIVATE_'), false);
    globalFailure = false; broken = false;
    await check('successful observation clears stale data and restores Live', () => document.querySelector('#connection').textContent === 'Live' && ![...document.querySelectorAll('.modern-agent')].some(node => node.textContent.includes('Observation unavailable')));
    stalled = true;
    while (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
    await page.clock.install(); await page.clock.fastForward(12000);
    await check('freshness expires even while the transport remains open', () => document.querySelector('#connection').textContent === 'Stale' && document.querySelector('#status-reasons').textContent.includes('SNAPSHOT_EXPIRED') && document.querySelector('#status-picker').dataset.severity === 'high');
    await page.screenshot({ path: path.join(artifacts, 'stale.png'), fullPage: true });
    stalled = false; release(); await page.clock.resume();
    await check('fresh snapshots recover after a stalled observation', () => document.querySelector('#connection').textContent === 'Live');
    await page.keyboard.press('Escape');
    await check('Status closes on Escape', () => document.querySelector('#status-menu').hidden);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.getByRole('button', { name: 'Monitoring status', exact: true }).click();
    await check('Status dropdown fits a phone viewport', () => { const box = document.querySelector('#status-menu').getBoundingClientRect(); return box.left >= 0 && box.right <= document.documentElement.clientWidth && box.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth; });
    await page.mouse.click(2, 2);
    await check('Status closes on an outside click', () => document.querySelector('#status-menu').hidden);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(artifacts, 'production-report.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2));
    console.log(`Production Playwright passed ${checks.length} checks. Artifacts: ${artifacts}`);
  } finally { stalled = false; release?.(); if (browser) await browser.close(); await dashboard.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
