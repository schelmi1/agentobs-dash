'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentobs-package-'));
  const repository = path.resolve(__dirname, '..');
  const run = (command, args, cwd = repository) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, npm_config_update_notifier: 'false' } }); let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('exit', code => code ? reject(new Error(output)) : resolve(output));
  });
  let server;
  try {
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', root]);
    const archive = (await fs.readdir(root)).find(file => file.endsWith('.tgz'));
    const installation = path.join(root, 'installation');
    await run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefix', installation, path.join(root, archive)]);
    const installed = path.join(installation, 'node_modules', 'agentobs-dash'), cli = path.join(installed, 'bin', 'agentobs.js');
    await assert.rejects(fs.access(path.join(installed, 'test')));
    await assert.rejects(fs.access(path.join(installed, '.agentobs')));
    assert.match(await run(process.execPath, [cli, '--help'], root), /Harnesses: Codex, Copilot/);
    const projects = path.join(root, 'projects'), sessions = path.join(root, 'sessions');
    await fs.mkdir(projects); await fs.mkdir(sessions);
    await run(process.execPath, [cli, 'init', projects, '--sessions', sessions, '--copilot-storage', sessions, '--port', '0'], root);
    server = spawn(process.execPath, [cli, projects], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const url = await new Promise((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(new Error('Installed CLI startup timed out')), 10000);
      server.stdout.on('data', data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
      server.once('error', reject); server.once('exit', code => { clearTimeout(timeout); reject(new Error('Installed CLI exited ' + code)); });
    });
    const response = await fetch(url + '/api/snapshot'); assert.equal(response.status, 200);
    const wire = await response.json(); assert.equal(wire.protocolVersion, 2); assert.deepEqual(wire.roots, []);
    for (const asset of ['/', '/board.css', '/modern.css', '/theme-shapes.css', '/color-themes/index.js', '/status.js', '/settings.js', '/settings.css', '/preferences.js', '/snapshot.js', '/agent-views.js', '/inspector.js']) assert.equal((await fetch(url + asset)).status, 200);
    console.log('Package smoke test passed: offline production install, init, CLI start and HTTP assets.');
  } finally {
    if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
