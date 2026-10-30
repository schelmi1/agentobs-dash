'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { harnesses } = require('./harnesses');
const { constants } = require('node:fs');
const MAX_BODY = 65536;
const isPath = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !value.includes('\0');
async function readSaved(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_BODY) throw new Error('Invalid settings file');
    const saved = JSON.parse(await handle.readFile('utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings file');
    return saved;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  finally { await handle?.close(); }
}
async function pathStatus(file, allowFile = false) {
  try { const s = await fs.stat(file); if (!s.isDirectory() && !(allowFile && s.isFile())) return 'invalid'; await fs.access(file, constants.R_OK); return 'ready'; }
  catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
}
async function storePath(provider, p) {
  if (provider.id !== 'opencode') return p;
  const stat = await fs.stat(p).catch(() => undefined), envFile = require('./harnesses/opencode').dbPath();
  return stat?.isFile() ? p : path.dirname(envFile) === p ? envFile : path.join(p, 'opencode.db');
}
function envSource(id) {
  return ({ codex: process.env.CODEX_HOME ? 'environment' : 'default', 'copilot-vscode': process.platform === 'win32' ? process.env.APPDATA ? 'environment' : 'default' : process.platform !== 'darwin' && process.env.XDG_CONFIG_HOME ? 'environment' : 'default', 'claude-code': process.env.CLAUDE_CONFIG_DIR ? 'environment' : 'default', opencode: process.env.OPENCODE_DB || process.env.XDG_DATA_HOME ? 'environment' : 'default' })[id] || 'default';
}
function createSettings(config) {
  const anchor = config.configRoot || config.rootFolder;
  const configFile = config.configFile || path.join(anchor, '.agentobs', 'dashboard.json');
  const overrides = config.settingsOverrides || {};
  let pending = Promise.resolve();
  async function describe() {
    const saved = await readSaved(configFile), startup = config.settingsSavedAtStart || saved;
    const providers = await Promise.all(harnesses.map(async h => {
      const active = config[h.configKey] || [];
      const source = Object.hasOwn(overrides, h.configKey) ? 'command line' : Object.hasOwn(startup, h.configKey) ? 'saved setting' : envSource(h.id);
      const defaults = h.defaultRoots(config.rootFolder);
      const resolved = await Promise.all(active.map(p => storePath(h, p)));
      return { id: h.id, label: h.label, key: h.configKey, source, flag: h.cliFlag, active: await Promise.all(resolved.map(async p => ({ path: p, status: await pathStatus(p, h.id === 'opencode') }))), saved: Array.isArray(saved[h.configKey]) ? saved[h.configKey] : null, defaults, overridden: Object.hasOwn(overrides, h.configKey) };
    }));
    return { root: { active: config.rootFolder, saved: typeof saved.monitoredRoot === 'string' ? saved.monitoredRoot : null, source: config.explicitRoot ? 'command line' : startup.monitoredRoot ? 'saved setting' : 'working directory', overridden: Boolean(config.explicitRoot), configRoot: anchor }, providers };
  }
  async function save(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['monitoredRoot','providers'].includes(key))) throw new Error('Invalid settings');
    if (value.monitoredRoot !== null && !isPath(value.monitoredRoot)) throw new Error('Monitored root must be an absolute directory path');
    if (value.monitoredRoot !== null && await pathStatus(value.monitoredRoot) !== 'ready') throw new Error('Monitored root must be an existing readable directory');
    if (!value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) throw new Error('Invalid provider settings');
    const keys = new Set(harnesses.map(h => h.configKey));
    if (Object.keys(value.providers).length !== keys.size || Object.keys(value.providers).some(key => !keys.has(key))) throw new Error('Invalid provider settings');
    const statuses = {};
    for (const h of harnesses) {
      const entries = value.providers[h.configKey];
      if (entries !== null && (!Array.isArray(entries) || entries.length > 32 || entries.some(p => !isPath(p)))) throw new Error('Each path must be absolute; at most 32 paths per harness');
      if (entries) statuses[h.configKey] = await Promise.all(entries.map(async p => ({ path: p, status: await pathStatus(await storePath(h, p), h.id === 'opencode') })));
    }
    const dir = path.dirname(configFile); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid settings directory');
    const saved = await readSaved(configFile);
    if (value.monitoredRoot === null) delete saved.monitoredRoot; else saved.monitoredRoot = value.monitoredRoot;
    for (const h of harnesses) { const entries = value.providers[h.configKey]; if (entries === null) delete saved[h.configKey]; else saved[h.configKey] = [...new Set(entries)]; }
    const temporary = configFile + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    try { await fs.writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, configFile); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    return { restartRequired: true, statuses };
  }
  return { describe, save(value) { const result = pending.then(() => save(value)); pending = result.catch(() => {}); return result; } };
}
module.exports = { createSettings, MAX_BODY };
