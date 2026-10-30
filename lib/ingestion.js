'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { resourceLimits, limitError } = require('./limits');
const { createHash } = require('node:crypto');
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const digest = data => createHash('sha256').update(data).digest('hex');

// Bounded append reader. Reducers retain format state, never whole raw files.
function createIngestion(overrides, { createProjection, indexFile, indexVersion, resumable = false } = {}) {
  const bounds = resourceLimits(overrides), cache = new Map(), summaries = new Map(), deferred = new Set();
  // Keep compressed, reduced summaries when the hot summary LRU fills. Without
  // this overflow, scans can replay and evict each other forever under pressure.
  const archived = new Map(), uncached = new Map();
  const archiveLimit = resumable ? Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, bounds.maxCacheBytes)) : 0;
  let archiveBytes = 0;
  const partial = new Map(), progressEntries = new Map();
  const trackProgress = (file, total, read) => {
    if (resumable && Number.isSafeInteger(total) && total >= 0) progressEntries.set(file, { total, read: Math.max(0, Math.min(total, read || 0)) });
  };
  let partialBytes = 0;
  const dropPartial = file => { const old = partial.get(file); if (old) partialBytes -= old.checkpointMemory || 0; partial.delete(file); };
  const scanLimit = resumable ? Math.min(bounds.maxReadBytesPerScan, 8 * 1024 * 1024) : bounds.maxReadBytesPerScan;
  let summaryBytes = 0, bytes = 0, revision = 0, totalReadBytes = 0, scanReadBytes = 0, indexLoaded = false, indexDirty = false, lastIndexSave = 0;
  const remove = file => { const old = cache.get(file); if (old) bytes -= old.memory || 0; cache.delete(file); };
  const signatureMatches = (entry, stat) => entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs && entry.ino === stat.ino && entry.dev === stat.dev;
  const removeSummary = file => {
    const old = summaries.get(file); if (old) summaryBytes -= old.memory; summaries.delete(file);
    const packed = archived.get(file); if (packed) archiveBytes -= packed.length; archived.delete(file); uncached.delete(file);
  };
  const archiveSummary = (file, summary) => {
    if (!resumable) return;
    const packed = deflateRawSync(Buffer.from(JSON.stringify(summary)));
    if (archiveBytes + packed.length > archiveLimit) {
      uncached.set(file, { size: summary.size, mtimeMs: summary.mtimeMs, ctimeMs: summary.ctimeMs, ino: summary.ino, dev: summary.dev, error: 'CACHE_LIMIT' });
      return;
    }
    archived.set(file, packed); archiveBytes += packed.length;
  };
  const evictSummary = file => {
    const old = summaries.get(file); if (!old) return;
    summaries.delete(file); summaryBytes -= old.memory; archiveSummary(file, old);
  };
  const getSummary = file => {
    const hot = summaries.get(file); if (hot) return hot;
    const packed = archived.get(file); if (!packed) return undefined;
    try { return JSON.parse(inflateRawSync(packed, { maxOutputLength: bounds.maxCacheBytes + bounds.maxSummaryBytes + 4096 }).toString('utf8')); }
    catch { archiveBytes -= packed.length; archived.delete(file); return undefined; }
  };
  const createSummary = (entry, json) => {
    const summary = { ...Object.fromEntries(['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev', 'revision', 'guardian'].map(key => [key, entry[key]])), value: structuredClone(entry.value) };
    if (resumable && !json && !entry.unterminated && !entry.pending.length && entry.reducer.checkpoint) {
      summary.checkpoint = structuredClone(entry.reducer.checkpoint());
      summary.headHash = digest(entry.head); summary.guardHash = digest(entry.guard);
    }
    summary.memory = Buffer.byteLength(JSON.stringify(summary)); return summary;
  };
  async function read(file, factory, { json = false, projectJson = false, signal, knownUnchanged = false } = {}) {
    signal?.throwIfAborted();
    // A new attempt replaces the old deferral even if the file now fails for
    // another reason; only a retryable budget limit should keep it pending.
    deferred.delete(file);
    if (knownUnchanged) {
      const known = cache.get(file) || getSummary(file);
      if (known) { if (known.error) { progressEntries.delete(file); throw limitError(known.error); } trackProgress(file, known.size, known.size); return known; }
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) { progressEntries.delete(file); throw new Error('NOT_REGULAR_FILE'); }
    trackProgress(file, stat.size, partial.get(file)?.offset || 0);
    if (stat.size > (resumable && !overrides?.maxFileBytes ? 1024 * 1024 * 1024 : bounds.maxFileBytes)) { progressEntries.delete(file); throw limitError('FILE_LIMIT'); }
    let entry = cache.get(file);
    if (signatureMatches(entry, stat)) {
      if (entry.error) { progressEntries.delete(file); throw limitError(entry.error); }
      trackProgress(file, stat.size, stat.size); deferred.delete(file); dropPartial(file); return entry;
    }
    const known = getSummary(file);
    if (!entry && !known && signatureMatches(uncached.get(file), stat)) { progressEntries.delete(file); throw limitError('CACHE_LIMIT'); }
    if (!entry && signatureMatches(known, stat)) { trackProgress(file, stat.size, stat.size); deferred.delete(file); dropPartial(file); return known; }
    if (resumable && !entry && !json && known?.checkpoint && stat.size > known.size && stat.ino === known.ino && stat.dev === known.dev) {
      try {
        const reducer = factory(), head = Buffer.alloc(Math.min(256, known.size)), guard = Buffer.alloc(Math.min(256, known.size));
        if (!reducer.restore || !/^[a-f0-9]{64}$/.test(known.headHash || '') || !/^[a-f0-9]{64}$/.test(known.guardHash || '')) throw new Error('INVALID_CHECKPOINT');
        reducer.restore(known.checkpoint);
        entry = { reducer, project: createProjection?.(), offset: known.size, size: known.size, ino: known.ino, dev: known.dev, pending: Buffer.alloc(0), head, guard, headHash: known.headHash, guardHash: known.guardHash };
        entry.memory = reducer.memory ? reducer.memory() : Buffer.byteLength(JSON.stringify(reducer.snapshot(stat)) || '');
        if (entry.memory > bounds.maxCacheBytes) throw new Error('INVALID_CHECKPOINT');
        while (cache.size && (bytes + entry.memory > bounds.maxCacheBytes || cache.size >= bounds.maxFiles)) remove(cache.keys().next().value);
        cache.set(file, entry); bytes += entry.memory;
      } catch { entry = undefined; }
    }
    const estimatedRead = json || !entry || entry.error || entry.unterminated || stat.size <= entry.size || entry.ino !== stat.ino ? stat.size + 1024 : stat.size - entry.size + 1024;
    if (resumable && (partial.has(file) || scanReadBytes + estimatedRead > scanLimit)) return readPartial(file, factory, { stat, json, projectJson, signal });
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
        reset = entry.headHash ? digest(head) !== entry.headHash || digest(tail) !== entry.guardHash : !head.equals(entry.head) || !tail.equals(entry.guard);
      }
      if (reset && resumable && scanReadBytes + stat.size + 1024 > scanLimit) {
        // A failed append guard may turn a small append into a full replay.
        // Defer that replay so the current scan remains bounded.
        if (known?.checkpoint) { delete known.checkpoint; delete known.headHash; delete known.guardHash; indexDirty = true; }
        deferred.add(file); throw limitError('INGESTION_LIMIT');
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
        if (!projectJson && stat.size > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
        const project = projectJson && createProjection?.();
        const chunks = []; let projectedBytes = 0;
        for (let offset = 0; offset < stat.size;) {
          const chunk = await sample(offset, Math.min(64 * 1024, stat.size - offset));
          if (!chunk.length) throw new Error('FILE_CHANGED_DURING_READ');
          offset += chunk.length;
          const projected = project ? project(chunk) : chunk;
          projectedBytes += projected.length;
          if (projectedBytes > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
          chunks.push(projected);
        }
        entry.reducer.push(Buffer.concat(chunks).toString('utf8'));
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
      delete entry.headHash; delete entry.guardHash;
      entry.head = await sample(0, Math.min(256, stat.size));
      entry.guard = await sample(Math.max(0, stat.size - 256), Math.min(256, stat.size));
      Object.assign(entry, { size: stat.size, offset: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, revision: ++revision, bytesRead: readBytes });
      cache.delete(file); bytes -= previousMemory;
      while (cache.size && (bytes + entry.memory > bounds.maxCacheBytes || cache.size >= bounds.maxFiles)) remove(cache.keys().next().value);
      cache.set(file, entry); bytes += entry.memory;
      entry.guardian = entry.reducer.guardian === true;
      const summary = createSummary(entry, json);
      removeSummary(file);
      if (summary.memory <= bounds.maxSummaryBytes) {
        while (summaries.size && (summaryBytes + summary.memory > bounds.maxSummaryBytes || summaries.size >= bounds.maxFiles)) evictSummary(summaries.keys().next().value);
        summaries.set(file, summary); summaryBytes += summary.memory;
        indexDirty = true;
      } else archiveSummary(file, summary);
      trackProgress(file, stat.size, stat.size); deferred.delete(file);
      return entry;
    } catch (error) {
      if (error.code === 'INGESTION_LIMIT' && estimatedRead <= bounds.maxReadBytesPerScan) deferred.add(file);
      else if (error.code !== 'INGESTION_LIMIT') progressEntries.delete(file);
      cache.delete(file); bytes -= previousMemory;
      // Cache the signature of broken files to avoid reparsing on every poll.
      if (cache.size >= bounds.maxFiles) remove(cache.keys().next().value);
      if (error.code !== 'INGESTION_LIMIT') cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, error: ['FILE_LIMIT', 'RECORD_LIMIT', 'STATE_LIMIT', 'CACHE_LIMIT'].includes(error.code) ? error.code : 'MALFORMED_RECORD', memory: 0 });
      throw error;
    } finally { await handle.close(); }
  }
  // Progress is retained only in memory. A persisted complete summary remains
  // usable after restart; unfinished streams restart safely after a restart.
  async function readPartial(file, factory, { stat, json, projectJson, signal }) {
    if (scanLimit - scanReadBytes <= 1024) { deferred.add(file); throw limitError('INGESTION_LIMIT'); }
    let p = partial.get(file);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const sample = async (offset, length) => {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(length), result = await handle.read(buffer, 0, length, offset);
      scanReadBytes += result.bytesRead; totalReadBytes += result.bytesRead;
      return buffer.subarray(0, result.bytesRead);
    };
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('FILE_CHANGED_DURING_READ');
      if (p && (p.ino !== stat.ino || p.dev !== stat.dev || stat.size < p.offset)) p = undefined;
      if (p && p.offset) {
        const head = await sample(0, p.head.length);
        const tail = await sample(p.offset - p.guard.length, p.guard.length);
        if (!head.equals(p.head) || !tail.equals(p.guard)) p = undefined;
      }
      if (!p) p = { reducer: factory(), project: (!json || projectJson) && createProjection?.(), offset: 0, pending: Buffer.alloc(0), chunks: [], projected: 0, ino: stat.ino, dev: stat.dev };
      // Leave enough budget for prefix and boundary guards at the checkpoint.
      while (p.offset < stat.size && scanLimit - scanReadBytes > 512) {
        const amount = Math.min(64 * 1024, stat.size - p.offset, scanLimit - scanReadBytes - 512);
        const chunk = await sample(p.offset, amount);
        if (!chunk.length) throw new Error('FILE_CHANGED_DURING_READ');
        p.offset += chunk.length;
        const projected = p.project ? p.project(chunk) : chunk;
        if (json) {
          p.projected += projected.length;
          if (p.projected > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
          p.chunks.push(projected);
        } else {
          p.pending = Buffer.concat([p.pending, projected]);
          let at;
          while ((at = p.pending.indexOf(10)) !== -1) {
            if (at > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
            const line = p.pending.subarray(0, at).toString('utf8').replace(/^\uFEFF/, '').trim();
            if (line) { let record; try { record = JSON.parse(line); } catch { throw new Error('MALFORMED_RECORD'); } if (record && typeof record === 'object') p.reducer.push(record); }
            p.pending = p.pending.subarray(at + 1);
          }
          if (p.pending.length > bounds.maxRecordBytes) throw limitError('RECORD_LIMIT');
        }
      }
      p.head = await sample(0, Math.min(256, p.offset));
      p.guard = await sample(Math.max(0, p.offset - 256), Math.min(256, p.offset));
      if (p.offset < stat.size) {
        const memory = (p.reducer.memory ? p.reducer.memory() : Buffer.byteLength(JSON.stringify(p.reducer.snapshot(stat)) || '')) + p.pending.length + p.projected;
        if (memory > bounds.maxCacheBytes) throw limitError('CACHE_LIMIT');
        const oldMemory = partial.get(file)?.checkpointMemory || 0;
        while (cache.size && bytes + partialBytes - oldMemory + memory > bounds.maxCacheBytes) remove(cache.keys().next().value);
        if (bytes + partialBytes - oldMemory + memory > bounds.maxCacheBytes) throw limitError('CACHE_LIMIT');
        partialBytes += memory - oldMemory; p.checkpointMemory = memory;
        p.total = stat.size; partial.set(file, p); trackProgress(file, stat.size, p.offset); deferred.add(file); throw limitError('INGESTION_LIMIT');
      }
      if (json) p.reducer.push(Buffer.concat(p.chunks).toString('utf8'));
      else if (p.pending.length) {
        const text = p.pending.toString('utf8').replace(/^\uFEFF/, '').trim();
        if (text) { let record; try { record = JSON.parse(text); } catch { /* An unfinished tail is resumed when more bytes arrive. */ } if (record && typeof record === 'object') { p.reducer.push(record); p.unterminated = true; p.pending = Buffer.alloc(0); } }
      }
      p.value = p.reducer.snapshot(stat);
      p.memory = (p.reducer.memory ? p.reducer.memory() : Buffer.byteLength(JSON.stringify(p.value) || '')) + p.pending.length;
      if (p.memory > bounds.maxCacheBytes) throw limitError('CACHE_LIMIT');
      Object.assign(p, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, revision: ++revision, bytesRead: p.offset });
      delete p.chunks; delete p.projected;
      remove(file);
      while (cache.size && (bytes + p.memory > bounds.maxCacheBytes || cache.size >= bounds.maxFiles)) remove(cache.keys().next().value);
      cache.set(file, p); bytes += p.memory;
      p.guardian = p.reducer.guardian === true;
      const summary = createSummary(p, json);
      removeSummary(file);
      if (summary.memory <= bounds.maxSummaryBytes) {
        while (summaries.size && (summaryBytes + summary.memory > bounds.maxSummaryBytes || summaries.size >= bounds.maxFiles)) evictSummary(summaries.keys().next().value);
        summaries.set(file, summary); summaryBytes += summary.memory; indexDirty = true;
      } else archiveSummary(file, summary);
      trackProgress(file, stat.size, stat.size); dropPartial(file); deferred.delete(file); return p;
    } catch (error) {
      if (error.code !== 'INGESTION_LIMIT') {
        dropPartial(file); deferred.delete(file); progressEntries.delete(file);
        const code = ['RECORD_LIMIT', 'STATE_LIMIT', 'CACHE_LIMIT'].includes(error.code) ? error.code : error.message === 'MALFORMED_RECORD' ? 'MALFORMED_RECORD' : undefined;
        if (code && !signal?.aborted) { remove(file); while (cache.size >= bounds.maxFiles) remove(cache.keys().next().value); cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, error: code, memory: 0 }); }
      }
      throw error;
    } finally { await handle.close(); }
  }
  return { read, beginScan() { scanReadBytes = 0; if (!deferred.size) progressEntries.clear(); },
    has(file) { return cache.has(file) || summaries.has(file) || archived.has(file) || uncached.has(file); },
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
    lastKnown(file) { const summary = getSummary(file); return summary && { ...summary, value: structuredClone(summary.value) }; },
    prune(used) {
      for (const file of cache.keys()) if (!used.has(file)) remove(file);
      for (const file of summaries.keys()) if (!used.has(file)) { removeSummary(file); indexDirty = true; }
      for (const file of archived.keys()) if (!used.has(file)) removeSummary(file);
      for (const file of uncached.keys()) if (!used.has(file)) uncached.delete(file);
      for (const file of deferred) if (!used.has(file)) deferred.delete(file);
      for (const file of partial.keys()) if (!used.has(file)) dropPartial(file);
      for (const file of progressEntries.keys()) if (!used.has(file)) progressEntries.delete(file);
    },
    get deferredCount() { return deferred.size; },
    get progress() {
      let bytesRead = 0, bytesTotal = 0;
      for (const progress of progressEntries.values()) { bytesRead += progress.read; bytesTotal += progress.total; }
      return deferred.size && bytesTotal > 0 ? { bytesRead, bytesTotal } : undefined;
    },
    get stats() { return { files: cache.size, bytes, summaryBytes, archiveBytes, readBytes: totalReadBytes }; } };

}
module.exports = { createIngestion };
