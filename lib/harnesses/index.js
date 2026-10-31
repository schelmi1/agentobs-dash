'use strict';

/**
 * Harness interface and normalized session contract:
 * id / label identify the provider; configKey / cliFlag / cliDescription declare
 * its existing configuration surface; defaultRoots(rootFolder) supplies paths.
 * create({ roots }) owns one observer's cache and returns { scan() }.
 * scan() resolves { sessions, sources, unreadable }; expected file errors become
 * source statuses/counts. Unexpected errors reject and may be retried next poll.
 * Sessions contain safe summaries, never raw tool arguments/output or records.
 * Disabled roots stay disabled. Root filtering and lifecycle aging are shared.
 */
// Explicit registration keeps executable modules under repository control.
// Storage defaults, CLI flags and observer instances all use this same catalog.
const harnesses = [require('./codex'), require('./copilot'), require('./claude'), require('./opencode')];
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { watchCache } = require('./watch-cache');

// Parser and reduction changes invalidate persisted summaries, including during
// development when the package version has not changed.
function parserVersion() {
  const hash = crypto.createHash('sha256');
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) hash.update(path.relative(__dirname, file)).update(fs.readFileSync(file));
    }
  };
  walk(path.dirname(__dirname));
  return hash.digest('hex');
}

function createHarnesses(config) {
  const version = parserVersion();
  return harnesses.map(harness => {
    const roots = config[harness.configKey] || [];
    const indexVersion = crypto.createHash('sha256').update(JSON.stringify([version, harness.id, roots, config.resourceLimits || {}])).digest('hex');
    const indexFile = config.rootFolder && roots.length ? path.join(config.rootFolder, '.agentobs', 'index-' + harness.id + '-' + indexVersion.slice(0, 16) + '.json') : undefined;
    const adapter = harness.create({ roots, limits: config.resourceLimitOverrides ?? config.resourceLimits, indexFile, indexVersion });
    return { id: harness.id, roots, ...watchCache(adapter, roots) };
  });
}

module.exports = { harnesses, createHarnesses };
