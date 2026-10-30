'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { resourceLimits, limitError } = require('./limits');

// Bounded append reader. Reducers retain format state, never whole raw files.
function createIngestion(overrides, { createProjection, indexFile, indexVersion } = {}) {
  const bounds = resourceLimits(overrides), cache = new Map(), summaries = new Map(), deferred = new Set();
  let summaryBytes = 0, bytes = 0, revision = 0, totalReadBytes = 0, scanReadBytes = 0, indexLoaded = false, indexDirty = false, lastIndexSave = 0;
  const remove = file => { const old = cache.get(file); if (old) bytes -= old.memory || 0; cache.delete(file); };
  const signatureMatches = (entry, stat) => entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs && entry.ino === stat.ino && entry.dev === stat.dev;
  const removeSummary = file => { const old = summaries.get(file); if (old) summaryBytes -= old.memory; summaries.delete(file); };
  async function read(file, factory, { json = false, signal, knownUnchanged = false } = {}) {
    signal?.throwIfAborted();
    // A new attempt replaces the old deferral even if the file now fails for
    // another reason; only a retryable budget limit should keep it pending.
    deferred.delete(file);
    if (knownUnchanged) {
      const known = cache.get(file) || summaries.get(file);
      if (known) { if (known.error) throw limitError(known.error); return known; }
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('NOT_REGULAR_FILE');
    if (stat.size > bounds.maxFileBytes) throw limitError('FILE_LIMIT');
    let entry = cache.get(file);
    if (signatureMatches(entry, stat)) {
      if (entry.error) throw limitError(entry.error);
      deferred.delete(file); return entry;
    }
    const known = summaries.get(file);
    if (!entry && signatureMatches(known, stat)) { deferred.delete(file); return known; }
    const estimatedRead = json || !entry || entry.error || entry.unterminated || stat.size <= entry.size || entry.ino !== stat.ino ? stat.size + 1024 : stat.size - entry.size + 1024;
    if (scanReadBytes + estimatedRead > bounds.maxReadBytesPerScan) {
      if (estimatedRead > bounds.maxReadBytesPerScan) throw limitError('READ_BUDGET_LIMIT');
      deferred.add(file);
      throw limitError('INGESTION_LIMIT');
    }
    const previousMemory = entry?.memory || 0;
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let readBytes = 0;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('FILE_CHANGED_DURING_READ');
      const sample = async (position, length) => {
        signal?.throwIfAborted();
        if (scanReadBytes + length > bounds.maxReadBytesPerScan) throw limitError('INGESTION_LIMIT');
        const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, position); readBytes += bytesRead; totalReadBytes += bytesRead; scanReadBytes += bytesRead; return buffer.subarray(0, bytesRead);
      };
      let reset = json || !entry || entry.error || entry.ino !== stat.ino || entry.dev !== stat.dev || stat.size <= entry.size || entry.unterminated;
      if (!reset) {
        const head = await sample(0, entry.head.length), tail = await sample(Math.max(0, entry.size - entry.guard.length), entry.guard.length);
        reset = !head.equals(entry.head) || !tail.equals(entry.guard);
      }
      if (reset) entry = { reducer: factory(), project: !json && createProjection?.(), offset: 0, pending: Buffer.alloc(0), size: 0 };
      const pushLine = (line, final = false) => {
        const text = line.toString('utf8').replace(/^\uFEFF/, '').trim();
        if (!text) return;
        let record;
        try { record = JSON.parse(text); } catch { if (final) return false; throw new Error('MALFORMED_RECORD'); }
        if (record && typeof record === 'object') entry.reducer.push(record);
        return true;
      };
      if (json) {
        if (stat.size > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
        const content = await sample(0, stat.size);
        entry.reducer.push(content.toString('utf8'));
      } else {
        let pending = entry.pending;
        while (entry.offset < stat.size) {
          const chunk = await sample(entry.offset, Math.min(64 * 1024, stat.size - entry.offset));
          if (!chunk.length) throw new Error('FILE_CHANGED_DURING_READ');
          entry.offset += chunk.length;
          pending = Buffer.concat([pending, entry.project ? entry.project(chunk) : chunk]);
          let at;
          while ((at = pending.indexOf(10)) !== -1) {
            if (at > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
            pushLine(pending.subarray(0, at)); pending = pending.subarray(at + 1);
          }
          if (pending.length > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
        }
        // Valid non-newline tails are visible now, then replayed if extended.
        entry.unterminated = pending.length > 0 && pushLine(pending, true) === true;
        entry.pending = entry.unterminated ? Buffer.alloc(0) : Buffer.from(pending);
      }
      entry.value = entry.reducer.snapshot(stat);
      const retained = entry.reducer.memory ? entry.reducer.memory() : Buffer.byteLength(JSON.stringify(entry.value) || '');
      entry.memory = retained + entry.pending.length;
      if (entry.memory > bounds.maxCacheBytes) throw limitError('CACHE_LIMIT');
      entry.head = await sample(0, Math.min(256, stat.size));
      entry.guard = await sample(Math.max(0, stat.size - 256), Math.min(256, stat.size));
      Object.assign(entry, { size: stat.size, offset: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, revision: ++revision, bytesRead: readBytes });
      cache.delete(file); bytes -= previousMemory;
      while (cache.size && (bytes + entry.memory > bounds.maxCacheBytes || cache.size >= bounds.maxFiles)) remove(cache.keys().next().value);
      cache.set(file, entry); bytes += entry.memory;
      entry.guardian = entry.reducer.guardian === true;
      const summary = { ...Object.fromEntries(['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev', 'revision', 'guardian'].map(key => [key, entry[key]])), value: structuredClone(entry.value) };
      summary.memory = Buffer.byteLength(JSON.stringify(summary));
      removeSummary(file);
      if (summary.memory <= bounds.maxSummaryBytes) {
        while (summaries.size && (summaryBytes + summary.memory > bounds.maxSummaryBytes || summaries.size >= bounds.maxFiles)) removeSummary(summaries.keys().next().value);
        summaries.set(file, summary); summaryBytes += summary.memory;
        indexDirty = true;
      }
      deferred.delete(file);
      return entry;
    } catch (error) {
      if (error.code === 'INGESTION_LIMIT' && estimatedRead <= bounds.maxReadBytesPerScan) deferred.add(file);
      cache.delete(file); bytes -= previousMemory;
      // Cache the signature of broken files to avoid reparsing on every poll.
      if (cache.size >= bounds.maxFiles) remove(cache.keys().next().value);
      if (error.code !== 'INGESTION_LIMIT') cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, error: ['FILE_LIMIT', 'RECORD_LIMIT', 'STATE_LIMIT', 'CACHE_LIMIT'].includes(error.code) ? error.code : 'MALFORMED_RECORD', memory: 0 });
      throw error;
    } finally { await handle.close(); }
  }
  return { read, beginScan() { scanReadBytes = 0; },
    has(file) { return cache.has(file) || summaries.has(file); },
    async loadIndex() {
      if (indexLoaded || !indexFile) return;
      indexLoaded = true;
      let handle;
      try {
        handle = await fs.open(indexFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > bounds.maxSummaryBytes + 1024 * 1024) return;
        const data = JSON.parse(await handle.readFile('utf8'));
        if (data.version !== indexVersion || !Array.isArray(data.entries)) return;
        for (const pair of data.entries.slice(-bounds.maxFiles)) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[1] || typeof pair[1] !== 'object') continue;
          const [file, summary] = pair;
          if (!['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev', 'revision'].every(key => Number.isFinite(summary[key])) || !summary.value || typeof summary.value !== 'object') continue;
          summary.memory = Buffer.byteLength(JSON.stringify(summary));
          if (summaryBytes + summary.memory > bounds.maxSummaryBytes) continue;
          summaries.set(file, summary); summaryBytes += summary.memory; revision = Math.max(revision, summary.revision);
        }
      } catch { /* An unavailable or incompatible index only costs a cold scan. */ }
      finally { await handle?.close(); }
    },
    async saveIndex({ force = false } = {}) {
      if (!indexFile || !indexDirty || !force && Date.now() - lastIndexSave < 5000) return;
      const path = require('node:path'), directory = path.dirname(indexFile);
      let temporary;
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        const data = JSON.stringify({ version: indexVersion, entries: [...summaries] });
        temporary = indexFile + '.' + process.pid + '.' + require('node:crypto').randomBytes(8).toString('hex') + '.tmp';
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, indexFile); indexDirty = false; lastIndexSave = Date.now();
      } catch { /* Index persistence is optional; keep ingestion operational. */ }
      finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
    },
    prioritize(files) { return [...files].sort((a, b) => Number(deferred.has(b)) - Number(deferred.has(a))); },
    lastKnown(file) { const summary = summaries.get(file); return summary && { ...summary, value: structuredClone(summary.value) }; },
    prune(used) {
      for (const file of cache.keys()) if (!used.has(file)) remove(file);
      for (const file of summaries.keys()) if (!used.has(file)) { removeSummary(file); indexDirty = true; }
      for (const file of deferred) if (!used.has(file)) deferred.delete(file);
    },
    get deferredCount() { return deferred.size; },
    get stats() { return { files: cache.size, bytes, summaryBytes, readBytes: totalReadBytes }; } };

}
module.exports = { createIngestion };
