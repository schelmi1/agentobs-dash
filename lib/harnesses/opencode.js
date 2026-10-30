'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { Worker } = require('node:worker_threads');
const { resourceLimits } = require('../limits');
const { createFileIssues } = require('../file-issues');
function dbPath(env = process.env, home = os.homedir()) { return path.resolve(env.OPENCODE_DB || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'opencode.db')); }
function read(file, bounds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const worker = new Worker(path.join(__dirname, 'opencode-worker.js'), { workerData: { file, ...bounds } });
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); worker.terminate(); error ? reject(error) : resolve(result); };
    const abort = () => finish(signal.reason || new Error('Aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => message.error ? finish(Object.assign(new Error(message.error), { code: message.error })) : finish(null, message.result));
    worker.once('error', error => finish(error)); worker.once('exit', code => { if (!settled) finish(new Error(`SQLite worker exited (${code})`)); });
  });
}
function create({ roots = [], limits } = {}) {
  const bounds = resourceLimits(limits), envFile = dbPath(), cache = new Map();
  return { async scan({ signal } = {}) {
    const sessions = [], sources = [], issues = createFileIssues(), diagnostics = new Set(); let unreadable = 0;
    for (const directory of [...new Set(roots)]) {
      signal?.throwIfAborted();
      let stat; try { stat = await fs.lstat(directory); } catch (error) { sources.push({ directory, provider: 'opencode', status: error.code === 'ENOENT' ? 'missing' : 'unreadable' }); continue; }
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) { sources.push({ directory, provider: 'opencode', status: 'unreadable' }); continue; }
      const file = stat.isFile() ? directory : path.dirname(envFile) === directory ? envFile : path.join(directory, 'opencode.db');
      const remaining = bounds.maxFiles - sessions.length;
      if (!remaining) { sources.push({ directory, provider: 'opencode', status: 'limited' }); continue; }
      try {
        const dbstat = await fs.lstat(file); if (!dbstat.isFile() || dbstat.isSymbolicLink()) throw new Error('INVALID_DATABASE');
        const wal = await fs.stat(file + '-wal').catch(error => { if (error.code !== 'ENOENT') throw error; });
        const signature = [remaining, dbstat.dev, dbstat.ino, dbstat.size, dbstat.mtimeMs, dbstat.ctimeMs, wal?.ino, wal?.size, wal?.mtimeMs, wal?.ctimeMs].join(':');
        const previous = cache.get(file), now = Date.now();
        const result = previous && previous.signature === signature && now - previous.readAt < 30000 ? previous.result : await read(file, { ...bounds, maxFiles: remaining }, signal);
        if (result !== previous?.result) cache.set(file, { signature, readAt: now, result });
        unreadable += result.unreadable;
        sessions.push(...result.sessions.map(session => ({ ...structuredClone(session), sourceDirectory: directory })));
        sources.push({ directory, provider: 'opencode', status: result.limited ? 'limited' : 'ready' });
      } catch (error) {
        signal?.throwIfAborted(); cache.delete(file);
        if (error.code !== 'ENOENT') { unreadable++; issues.add(file, error); if (error.code?.endsWith('LIMIT')) diagnostics.add(error.code); }
        sources.push({ directory, provider: 'opencode', status: error.code === 'ENOENT' ? 'missing' : 'unreadable' });
      }
    }
    return { sessions, sources, unreadable, ...issues.snapshot(), ...(diagnostics.size ? { diagnostics: [...diagnostics] } : {}) };
  } };
}
module.exports = { id: 'opencode', label: 'OpenCode', configKey: 'opencodeRoots', cliFlag: '--opencode-storage', cliDescription: 'OpenCode database file or directory (repeat for multiple stores)', defaultRoots: () => [path.dirname(dbPath())], dbPath, create };
