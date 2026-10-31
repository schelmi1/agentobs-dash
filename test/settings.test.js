'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveConfig } = require('../lib/config');
const { createDashboard } = require('../lib/server');
const { createSettings } = require('../lib/settings');
async function fixture(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-settings-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const providers = { sessionRoots: null, copilotRoots: null, claudeRoots: null, opencodeRoots: null };
test('saved root and harness settings apply on restart while explicit overrides retain precedence', async t => {
  const root = await fixture(t), next = path.join(root, 'next'); await fs.mkdir(next);
  const active = await resolveConfig(root, { sessionRoots: [root] }, { explicitRoot: true });
  const settings = createSettings(active); const initial = await settings.describe();
  assert.equal(initial.root.source, 'command line'); assert.equal(initial.providers.find(x => x.key === 'sessionRoots').source, 'command line');
  const missing = path.join(root, 'not-created');
  const result = await settings.save({ monitoredRoot: next, finishingDurationSeconds: 75, providers: { ...providers, claudeRoots: [missing], opencodeRoots: [] } });
  assert.equal(result.statuses.claudeRoots[0].status, 'missing');
  const persisted = JSON.parse(await fs.readFile(path.join(root, '.agentobs', 'dashboard.json'))); assert.deepEqual(persisted.claudeRoots, [missing]); assert.deepEqual(persisted.opencodeRoots, []); assert.equal(Object.hasOwn(persisted, 'sessionRoots'), false);
  const applied = await resolveConfig(root); assert.equal(applied.rootFolder, next); assert.deepEqual(applied.claudeRoots, [missing]); assert.deepEqual(applied.opencodeRoots, []);
  const overridden = await resolveConfig(root, { claudeRoots: [root] }, { explicitRoot: true }); assert.equal(overridden.rootFolder, root); assert.deepEqual(overridden.claudeRoots, [root]);
  assert.equal((await settings.describe()).finishingDurationSeconds, 75);
  assert.equal((await resolveConfig(root, {}, { explicitRoot: false })).finishingDurationSeconds, 75);
  await assert.rejects(settings.save({ monitoredRoot: null, providers, finishingDurationSeconds: -1 }), /Finishing duration/);
  await assert.rejects(settings.save({ monitoredRoot: '/does-not-exist-agentobs', providers }), /existing readable/);
  await assert.rejects(settings.save({ monitoredRoot: null, providers: { ...providers, claudeRoots: ['relative'] } }), /absolute/);
});
test('settings API accepts only same-origin bounded JSON and preserves unrelated configuration', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, '.agentobs')); await fs.writeFile(path.join(root, '.agentobs', 'dashboard.json'), JSON.stringify({ pollIntervalMs: 1234 }));
  const config = await resolveConfig(root, { port: 0 }); const dashboard = createDashboard(config); t.after(() => dashboard.close()); const url = await dashboard.start();
  const initial = await fetch(url + '/api/settings'); assert.equal(initial.status, 200); assert.equal((await initial.json()).providers.length, 4);
  const body = JSON.stringify({ monitoredRoot: null, providers });
  assert.equal((await fetch(url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body })).status, 403);
  const headers = { 'Content-Type': 'application/json', Origin: url };
  assert.equal((await fetch(url + '/api/settings', { method: 'PUT', headers, body })).status, 200);
  assert.equal(JSON.parse(await fs.readFile(config.configFile)).pollIntervalMs, 1234);
  assert.equal((await fetch(url + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ monitoredRoot: null, providers, extra: true }) })).status, 400);
});

test('initialization preserves which resource limits were explicitly configured', async t => {
  const { initialize } = require('../lib/config');
  const root = await fixture(t);
  await initialize(root);
  let config = await resolveConfig(root);
  assert.deepEqual(config.resourceLimitOverrides, {}, 'default limits are not turned into explicit overrides');
  const file = path.join(root, '.agentobs', 'dashboard.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.resourceLimits = { maxFileBytes: 2048 }; await fs.writeFile(file, JSON.stringify(saved));
  config = await resolveConfig(root);
  assert.equal(config.resourceLimitOverrides.maxFileBytes, 2048, 'a user-defined file limit remains explicit');
});
