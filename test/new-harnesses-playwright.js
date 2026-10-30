'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');
const { Observer } = require('../lib/observer');
const { createDashboard } = require('../lib/server');
const { defaults } = require('../lib/config');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-harness-ui-'));
  const projects = path.join(root, 'claude', 'project'), store = path.join(root, 'open'); await fs.mkdir(projects, { recursive: true }); await fs.mkdir(store);
  const at = new Date().toISOString(), file = path.join(projects, 'claude-run.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'user', sessionId: 'claude-run', cwd: root, timestamp: at, message: { content: 'Claude dashboard task' } }) + '\n');
  const db = new Database(path.join(store, 'opencode.db')); db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const now = Date.now(); db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('open-run', null, root, 'OpenCode dashboard task', now);
  const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)'); add.run('u', 'open-run', 'user', 1, now, now, JSON.stringify({ text: 'OpenCode dashboard task' }));
  const config = { ...defaults, rootFolder: root, port: 0, pollIntervalMs: 500, sessionRoots: [], copilotRoots: [], claudeRoots: [path.dirname(projects)], opencodeRoots: [store] };
  const observer = new Observer(config), dashboard = createDashboard(config, { observer }); let browser;
  try {
    const url = await dashboard.start(); browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] });
    const page = await browser.newPage(); await page.goto(url);
    await page.getByText('Claude dashboard task', { exact: true }).first().waitFor(); await page.getByText('OpenCode dashboard task', { exact: true }).first().waitFor();
    assert.ok(await page.locator('.modern-eyebrow').filter({ hasText: /^CLAUDE CODE$/ }).count()); assert.ok(await page.locator('.modern-eyebrow').filter({ hasText: /^OPENCODE$/ }).count());
    await fs.appendFile(file, JSON.stringify({ type: 'assistant', timestamp: at, message: { id: 'a', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: 'PRIVATE-FILE' } }] } }) + '\n');
    add.run('assistant', 'open-run', 'assistant', 2, now + 10, now + 10, JSON.stringify({ content: [{ type: 'tool', id: 'tool', name: 'bash', state: { status: 'running', input: { command: 'npm test PRIVATE-COMMAND' } } }] }));
    await page.getByText('Bash · npm', { exact: false }).first().waitFor({ timeout: 10000 }); await page.getByText('Read', { exact: true }).first().waitFor({ timeout: 10000 });
    assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-COMMAND')); assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-FILE'));
    console.log('PASS mixed Claude Code and OpenCode dashboard with live tool updates');
  } finally { await browser?.close(); await dashboard.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
