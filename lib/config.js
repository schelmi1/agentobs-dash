'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { harnesses } = require('./harnesses');
const { resourceLimits } = require('./limits');

const defaults = { finishingDurationSeconds: 30, port: 4317, providerTimeoutMs: 5000, pollIntervalMs: 2000, staleAfterMs: 900000, inactiveAfterMs: 3600000, failedInactiveAfterMs: 900000, quietHistoryAfterMs: 1800000 };

function validate(settings) {
  for (const [key, min, max] of [['finishingDurationSeconds', 0, 3600], ['port', 0, 65535], ['providerTimeoutMs', 10, 3600000], ['pollIntervalMs', 500, 3600000], ['staleAfterMs', 10000, Number.MAX_SAFE_INTEGER], ['inactiveAfterMs', 10000, Number.MAX_SAFE_INTEGER], ['failedInactiveAfterMs', 10000, Number.MAX_SAFE_INTEGER], ['quietHistoryAfterMs', 10000, Number.MAX_SAFE_INTEGER]]) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  for (const { configKey } of harnesses) {
    if (!Array.isArray(settings[configKey]) || settings[configKey].some(value => typeof value !== 'string' || !value)) throw new Error(`${configKey} must be an array of directory paths`);
  }
  return settings;
}

async function resolveConfig(root, overrides = {}, { explicitRoot = false } = {}) {
  const configRoot = await fs.realpath(path.resolve(root));
  if (!(await fs.stat(configRoot)).isDirectory()) throw new Error('The monitored root must be a directory');
  const configFile = path.join(configRoot, '.agentobs', 'dashboard.json');
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read ${configFile}: ${error.message}`); }
  const configuredRoot = !explicitRoot && typeof saved.monitoredRoot === 'string' ? path.resolve(configRoot, saved.monitoredRoot) : configRoot;
  const rootFolder = await fs.realpath(configuredRoot);
  if (!(await fs.stat(rootFolder)).isDirectory()) throw new Error('The monitored root must be a directory');
  const settings = { ...defaults, ...saved, ...overrides };
  for (const harness of harnesses) settings[harness.configKey] ??= harness.defaultRoots(rootFolder);
  validate(settings);
  const resourceLimitOverrides = { ...(settings.resourceLimits || {}) };
  settings.resourceLimits = resourceLimits(settings.resourceLimits);
  for (const { configKey } of harnesses) settings[configKey] = [...new Set(settings[configKey].map(dir => path.resolve(rootFolder, dir)))];
  return { ...settings, rootFolder, configFile, configRoot, settingsOverrides: { ...overrides }, settingsSavedAtStart: { ...saved }, resourceLimitOverrides, explicitRoot };
}

async function initialize(root, overrides = {}) {
  const config = await resolveConfig(root, overrides);
  const saved = Object.fromEntries([...Object.keys(defaults), 'resourceLimits', ...harnesses.map(harness => harness.configKey)].map(key => [key, key === 'resourceLimits' ? config.resourceLimitOverrides : config[key]]));
  await fs.mkdir(path.dirname(config.configFile), { recursive: true });
  // Initialization never overwrites existing settings.
  try { await fs.writeFile(config.configFile, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return config;
}

module.exports = { defaults, resolveConfig, initialize };
