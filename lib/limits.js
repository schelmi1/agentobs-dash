'use strict';

const limits = Object.freeze({ maxFileBytes: 128 * 1024 * 1024, maxRecordBytes: 4 * 1024 * 1024,
  maxCacheBytes: 64 * 1024 * 1024, maxSummaryBytes: 16 * 1024 * 1024, maxFiles: 4096, maxAgents: 2000, maxDepth: 256,
  maxStateEntries: 10000, maxSnapshotBytes: 16 * 1024 * 1024, maxReadBytesPerScan: 256 * 1024 * 1024 });

function resourceLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('resourceLimits must be an object');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key] * 8) throw new Error('Invalid resource limit: ' + key);
  }
  return { ...limits, ...overrides };
}
function limitError(code = 'INGESTION_LIMIT') { return Object.assign(new Error(code), { code }); }
module.exports = { limits, resourceLimits, limitError };
