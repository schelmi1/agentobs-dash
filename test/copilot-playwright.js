'use strict';

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');
const { createCopilotDemo } = require('../scripts/copilot-demo');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-COPILOT-SIMULATION-'));
  const root = path.join(temporary, 'projects');
  const artifacts = process.env.AGENTOBS_SCREENSHOT_DIR || path.join(temporary, 'artifacts');
  await fs.mkdir(root); await fs.mkdir(artifacts, { recursive: true });
  const demo = await createCopilotDemo(root);
  const codex = path.join(root, 'codex-sessions'); await fs.mkdir(codex);
  const dashboard = createDashboard({ ...defaults, rootFolder: root, sessionRoots: [codex], copilotRoots: [demo.storage], pollIntervalMs: 500, port: Number(process.env.AGENTOBS_DEMO_PORT || 0) });
  let browser, context, page, traceSaved = false;
  const checks = [], errors = [];
  const report = status => fs.writeFile(path.join(artifacts, 'copilot-report.json'), JSON.stringify({ status, checks, errors }, null, 2));
  try {
    const url = await dashboard.start();
    browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: !process.argv.includes('--headed'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const chooseTheme = async name => {
      await page.getByRole('button', { name: 'Choose theme', exact: true }).click();
      await page.getByRole('menuitemradio', { name, exact: true }).click();
    };
    const check = async (label, predicate, argument) => {
      await page.waitForFunction(predicate, argument, { timeout: 10000 });
      checks.push(label); console.log('PASS ' + label);
    };
    const parser = () => page.locator('.agent').filter({ has: page.locator('.task-title', { hasText: /^\[Demo\] (?:Parse Copilot transcripts|Resume parser checks)$/ }) });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await check('Copilot demo loads through real observer and SSE', () => document.querySelector('#connection').textContent === 'Live' && document.querySelectorAll('.agent').length === 3 && document.querySelector('#metric-live').textContent === '2');
    await page.getByRole('button', { name: 'Expand agents under [Demo] Parse Copilot transcripts', exact: true }).click();
    await check('Copilot cards are clearly labeled and nested two levels', () => [...document.querySelectorAll('.agent-provider')].every(node => node.textContent === 'Copilot') && [...document.querySelectorAll('.task-title')].every(node => node.textContent.startsWith('[Demo]')) && document.querySelectorAll('.tree > .agent-node > .children > .agent-node > .children .agent').length === 1);
    await check('Copilot overview shows separate in, cached, out totals', () => document.querySelector('#metric-tokens-in').textContent === '20k' && document.querySelector('#metric-tokens-cache').textContent === '12k' && document.querySelector('#metric-tokens-out').textContent === '1.7k');
    await parser().click();
    await check('Copilot inspector shows running tool, provider and usage', () => document.querySelector('.inspector .tool-state')?.textContent === 'Running' && document.querySelector('.inspector').textContent.includes('Copilot') && document.querySelector('.inspector .token-stats')?.textContent.includes('6,000'));
    await demo.finishTool(demo.ids.parser, 'parser-tests', false);
    await check('live Copilot tool failure reaches card and inspector', () => document.querySelector('.inspector .tool-state')?.textContent === 'Failed' && document.querySelectorAll('.agent-failed').length === 2);
    await demo.transcript(demo.ids.parser, 'assistant.turn_start', { turnId: 'retry' });
    await demo.tool(demo.ids.parser, 'retry-tests');
    await check('retry clears failure and keeps inspector selected', () => document.querySelector('.inspector .tool-state')?.textContent === 'Running' && document.querySelectorAll('.agent-failed').length === 1);
    await demo.usage(demo.ids.parser, 1000, 0, 100);
    await check('appended usage updates exact inspector and overview numbers', () => document.querySelector('.inspector .token-stats')?.textContent.includes('7,000') && document.querySelector('#metric-tokens-in').textContent === '21k' && document.querySelector('#metric-tokens-out').textContent === '1.8k');
    await page.getByRole('button', { name: 'Close ×', exact: true }).click();
    const mixedFile = path.join(codex, 'rollout-mixed.jsonl');
    const row = (type, payload) => ({ type, timestamp: new Date().toISOString(), payload });
    await fs.writeFile(mixedFile, [row('session_meta', { session_id: demo.ids.main, cwd: demo.cwd, cli_version: '0.164.0' }), row('event_msg', { type: 'task_started' }), row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Demo] Codex alongside Copilot' }] })].map(JSON.stringify).join('\n') + '\n');
    await check('matching raw IDs remain distinct across Codex and Copilot', () => document.querySelectorAll('.agent').length === 5 && [...document.querySelectorAll('.agent-provider')].some(node => node.textContent === 'Codex') && document.querySelectorAll('.tree > .agent-node').length === 3);
    await fs.unlink(mixedFile);
    await check('removed Codex fixture disappears while Copilot remains', () => document.querySelectorAll('.agent').length === 4 && ![...document.querySelectorAll('.agent-provider')].some(node => node.textContent === 'Codex'));
    const snapshot = await context.request.get(url + '/api/snapshot');
    assert.equal((await snapshot.text()).includes(demo.privateText), false);
    checks.push('raw Copilot arguments, model messages and tool output never reach API');
    for (const theme of ['rounded', 'chamfered']) {
      if (theme === 'chamfered') await chooseTheme('Chamfered');
      await check(theme + ' Copilot active cards have green left bars', () => {
        const green = getComputedStyle(document.querySelector('.metric-dot.green')).backgroundColor;
        return [...document.querySelectorAll('.agent-tool')].every(card => getComputedStyle(card).borderLeftColor === green);
      });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await check(`${theme} Copilot dashboard fits ${width}px`, () => document.documentElement.scrollWidth <= innerWidth);
        await page.screenshot({ path: path.join(artifacts, `copilot-${theme}-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
    await page.getByRole('menu', { name: 'Workspaces', exact: true }).getByRole('menuitemradio').filter({ has: page.getByText('.agentobs/copilot/projects/api', { exact: true }) }).click();
    await check('workspace dropdown scopes Copilot cards and unknown usage', () => document.querySelectorAll('.agent').length === 1 && document.querySelector('.task-title').textContent === '[Demo] Repair the API tests' && document.querySelector('#metric-tokens-in').textContent === '—');
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
    await page.getByRole('menu', { name: 'Workspaces', exact: true }).getByRole('menuitemradio').filter({ has: page.getByText('All workspaces', { exact: true }) }).click();
    await demo.finishTool(demo.ids.parser, 'retry-tests'); await demo.complete();
    await check('completed Copilot descendants collapse automatically', () => Boolean(document.querySelector('.completed-history')) && [...document.querySelectorAll('.completed-history .children')].every(node => node.hidden));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await check('completed collapse survives reload', () => Boolean(document.querySelector('.completed-history')) && !document.querySelector('.completed-history').open && !document.querySelector('.completed-history .agent'));
    await demo.resume();
    await check('resuming a Copilot child restores its parent to live view', () => document.querySelectorAll('.tree .agent-working').length === 1 && [...document.querySelectorAll('.tree .agent-tool')].some(card => card.textContent.includes('Resume parser checks')) && !document.querySelector('.tree > .agent-node > .children').hidden);
    const failedFile = path.join(demo.storage, 'agentobs-demo-api', 'chatSessions', demo.ids.failed + '.jsonl');
    const failedState = JSON.parse((await fs.readFile(failedFile, 'utf8')).trim());
    const old = Date.now() - 16 * 60000;
    failedState.v.creationDate = old;
    failedState.v.requests[0].timestamp = old;
    failedState.v.requests[0].modelState.completedAt = old;
    await fs.writeFile(failedFile, JSON.stringify(failedState) + '\n');
    await check('failed run older than 15 minutes moves to inactive history', () => Boolean(document.querySelector('.inactive-history')) && !document.querySelector('.inactive-history .agent') && !document.querySelector('.inactive-history').open && !document.querySelector('.tree .agent-failed') && document.querySelector('#metric-attention').textContent === '0');
    await fs.appendFile(failedFile, JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'api-retry', timestamp: Date.now(), message: { text: '[Demo] Retry the API tests' }, modelState: { value: 0 } }] }) + '\n');
    await check('new activity returns an inactive failed run to the live view', () => [...document.querySelectorAll('.tree .agent-working')].some(card => card.textContent.includes('[Demo] Retry the API tests')) && !document.querySelector('.inactive-history'));
    const quietChatFile = path.join(path.dirname(failedFile), 'quiet-copilot.jsonl');
    const quietCodexFile = path.join(codex, 'rollout-quiet.jsonl');
    const writeQuiet = async minutes => {
      const at = Date.now() - minutes * 60000;
      await fs.writeFile(quietChatFile, JSON.stringify({ kind: 0, v: { version: 3, sessionId: 'quiet-copilot', creationDate: at, responderUsername: 'GitHub Copilot', requests: [{ requestId: 'quiet-request', timestamp: at, message: { text: '[Demo] Quiet Copilot' }, modelState: { value: 0 } }] } }) + '\n');
      await fs.writeFile(quietCodexFile, [
        { type: 'session_meta', payload: { session_id: 'quiet-codex', cwd: demo.cwd, cli_version: '0.164.0' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'quiet-turn' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Demo] Quiet Codex' }] } }
      ].map(row => JSON.stringify({ ...row, timestamp: new Date(at).toISOString() })).join('\n') + '\n');
    };
    await writeQuiet(29);
    await check('quiet Codex and Copilot runs remain in live view before 30 minutes', () => document.querySelectorAll('.tree .agent-quiet').length === 2 && !document.querySelector('.quiet-history'));
    await writeQuiet(31);
    await check('30-minute quiet runs move into their own collapsed dropdown', () => Boolean(document.querySelector('.quiet-history')) && !document.querySelector('.quiet-history .agent-quiet') && !document.querySelector('.quiet-history').open && !document.querySelector('.tree .agent-quiet') && !document.querySelector('.inactive-history') && document.querySelector('.quiet-history > summary').textContent.startsWith('Quiet · 2 runs'));
    await page.locator('.quiet-history > summary').click();
    await demo.usage(demo.ids.main, 0, 0, 0);
    await check('expanded Quiet dropdown survives live updates', () => document.querySelector('.quiet-history').open && document.querySelectorAll('.quiet-history .agent').length === 2);
    await page.locator('.quiet-history .agent').filter({ has: page.getByText('[Demo] Quiet Copilot', { exact: true }) }).click();
    await check('quiet dropdown cards remain inspectable', () => document.querySelector('.inspector-phase').textContent === 'No recent transcript activity');
    await fs.appendFile(quietChatFile, JSON.stringify({ kind: 1, k: ['requests', 0, 'timestamp'], v: Date.now() }) + '\n');
    await check('resumed quiet Copilot run returns to live view with selection intact', () => document.querySelectorAll('.quiet-history .agent').length === 1 && [...document.querySelectorAll('.tree .agent-working')].some(card => card.textContent.includes('[Demo] Quiet Copilot')) && document.querySelector('.inspector-phase').textContent === 'Thinking');
    await page.getByRole('button', { name: 'Close ×', exact: true }).click();
    for (const theme of ['rounded', 'chamfered']) {
      await chooseTheme(theme === 'rounded' ? 'Rounded' : 'Chamfered');
      await page.screenshot({ path: path.join(artifacts, `quiet-dropdown-${theme}.png`), fullPage: true });
    }
    await fs.appendFile(quietCodexFile, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'quiet-resumed' } }) + '\n');
    await check('Quiet dropdown disappears after its last run resumes', () => !document.querySelector('.quiet-history') && [...document.querySelectorAll('.tree .agent-working')].some(card => card.textContent.includes('[Demo] Quiet Codex')));
    await page.screenshot({ path: path.join(artifacts, 'copilot-resumed.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await report('passed');
    await context.tracing.stop({ path: path.join(artifacts, 'copilot-trace.zip') }); traceSaved = true;
    console.log(`Copilot Playwright passed ${checks.length} checks. Artifacts: ${artifacts}`);
    if (process.argv.includes('--keep-open')) {
      console.log(`COPILOT SIMULATION READY ${url} — no Copilot subscription or model needed. Ctrl+C stops it.`);
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); browser.once('disconnected', resolve); });
    }
  } catch (error) {
    errors.push(error.message); await report('failed');
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'copilot-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (context && !traceSaved) await context.tracing.stop({ path: path.join(artifacts, 'copilot-trace.zip') }).catch(() => {});
    if (browser) await browser.close();
    await dashboard.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
