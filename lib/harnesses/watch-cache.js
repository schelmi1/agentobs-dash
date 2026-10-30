'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Watchers are hints only: periodically rescan and keep checking missing roots.
// An unavailable watcher falls back to ordinary polling for that root.
function watchCache(adapter, roots, { reconcileMs = 30000 } = {}) {
  const watchers = new Map(), missing = new Set(), unreliable = new Set();
  let generation = 0, cleanGeneration = -1, lastFull = 0, previous, uncertain = false;
  const dirtyFiles = new Set();
  const changed = () => { uncertain = true; generation++; };
  const watch = root => {
    if (watchers.has(root)) return;
    try {
      // On some platforms recursive watch accepts a missing path silently.
      if (!fs.statSync(root).isDirectory()) { unreliable.add(root); return; }
      const watcher = fs.watch(root, { recursive: true }, (type, filename) => {
        if (type !== 'change' || typeof filename !== 'string' || !filename || path.isAbsolute(filename)) uncertain = true;
        else {
          const file = path.resolve(root, filename), relative = path.relative(root, file);
          if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || adapter.knowsFile && !adapter.knowsFile(file)) uncertain = true;
          else dirtyFiles.add(file);
        }
        generation++;
      });
      watcher.unref();
      watcher.on('error', error => { watchers.delete(root); if (error.code === 'ENOENT') missing.add(root); else unreliable.add(root); watcher.close(); changed(); });
      watchers.set(root, watcher); missing.delete(root); unreliable.delete(root);
    } catch (error) {
      if (error.code === 'ENOENT') missing.add(root); else unreliable.add(root);
    }
  };
  for (const root of roots) watch(root);
  return {
    stableOnReference: true,
    async scan(options) {
      options?.signal?.throwIfAborted();
      // Let filesystem notifications queued by preceding writes run first.
      await new Promise(resolve => setImmediate(resolve));
      for (const root of [...missing]) {
        try { await fsp.lstat(root); missing.delete(root); watch(root); changed(); }
        catch (error) { if (error.code !== 'ENOENT') { missing.delete(root); unreliable.add(root); changed(); } }
      }
      const now = Date.now();
      if (previous && !previous.deferredFiles && adapter.canCache?.() !== false && !unreliable.size && generation === cleanGeneration && now - lastFull < reconcileMs) return previous;
      const started = generation;
      const incremental = previous && !previous.deferredFiles && adapter.canCache?.() !== false && !unreliable.size && !uncertain && generation !== cleanGeneration && now - lastFull < reconcileMs;
      const changedFiles = new Set(dirtyFiles); dirtyFiles.clear(); uncertain = false;
      try {
        const result = await adapter.scan({ ...options, ...(incremental ? { knownUnchanged: file => !changedFiles.has(file) } : {}) });
        previous = result; cleanGeneration = started;
        if (!incremental) lastFull = now;
        return result;
      } catch (error) { changed(); throw error; }
    },
    async close() { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); await adapter.close?.(); }
  };
}
module.exports = { watchCache };
