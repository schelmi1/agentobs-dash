#!/usr/bin/env node
'use strict';

const { initialize, resolveConfig } = require('../lib/config');
const { createDashboard } = require('../lib/server');
const { harnesses } = require('../lib/harnesses');

const help = `agentobs — local agent dashboard

  agentobs init [root]        Save settings in <root>/.agentobs/dashboard.json
  agentobs [root] [options]   Monitor root and every workspace underneath it

Options:
  --root <directory>          Root to monitor (default: current directory)
${harnesses.map(harness => '  ' + (harness.cliFlag + ' <dir>').padEnd(27) + harness.cliDescription).join('\n')}
  --port <number>             Loopback HTTP port (default: 4317)
  --poll-ms <number>          Refresh interval, minimum 500 (default: 2000)
  --stale-ms <number>         Quiet cutoff (default: 900000)
  --inactive-ms <number>      Inactive history cutoff (default: 3600000)
  --failed-inactive-ms <n>     Failed/interrupted history cutoff (default: 900000)
  --quiet-history-ms <n>       Quiet dropdown cutoff (default: 1800000)
  --help                     Show usage

Harnesses: ${harnesses.map(harness => harness.label).join(', ')}. No agent control or uploads.
`;

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const init = args[0] === 'init';
  if (init) args.shift();
  let root;
  const overrides = {};
  const storageFlags = new Map(harnesses.map(harness => [harness.cliFlag, harness.configKey]));
  const flags = { '--port': 'port', '--poll-ms': 'pollIntervalMs', '--stale-ms': 'staleAfterMs', '--inactive-ms': 'inactiveAfterMs', '--failed-inactive-ms': 'failedInactiveAfterMs', '--quiet-history-ms': 'quietHistoryAfterMs' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--root' || storageFlags.has(arg) || Object.hasOwn(flags, arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--root') { if (root) throw new Error('Specify one root folder'); root = value; }
      else if (storageFlags.has(arg)) (overrides[storageFlags.get(arg)] ??= []).push(value);
      else overrides[flags[arg]] = Number(value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else { if (root) throw new Error('Specify one root folder'); root = arg; }
  }
  const explicitRoot = Boolean(root);
  root ??= process.cwd();
  const config = await (init ? initialize(root, overrides) : resolveConfig(root, overrides, { explicitRoot }));
  if (init) { console.log(`Dashboard initialized: ${config.configFile}\nStart: agentobs --root ${JSON.stringify(config.rootFolder)}`); return; }
  const dashboard = createDashboard(config);
  const url = await dashboard.start();
  const stores = harnesses.map(harness => (harness.label + ' stores').padEnd(19) + config[harness.configKey].join(', ')).join('\n');
  console.log(`agentobs  ${url}\nMonitoring         ${config.rootFolder}\n${stores}\nPress Ctrl+C to stop.`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await dashboard.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(`agentobs: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
