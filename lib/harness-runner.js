'use strict';

// One in-flight operation per adapter, even after a deadline. Cooperative
// adapters stop at IO boundaries; a non-cooperative adapter is quarantined
// until it settles. Late results never enter observation state.
function createHarnessRunner() {
  const running = new Map();
  return async function run(harness, timeoutMs, onProgress) {
    let job = running.get(harness);
    if (job?.expired) throw Object.assign(new Error('HARNESS_TIMEOUT'), { code: 'HARNESS_TIMEOUT' });
    if (!job) {
      job = { controller: new AbortController(), expired: false };
      job.promise = Promise.resolve().then(() => harness.scan({ signal: job.controller.signal, onProgress }));
      running.set(harness, job);
      const cleanup = () => { if (running.get(harness) === job) running.delete(harness); };
      job.promise.then(cleanup, cleanup);
    }
    let timer;
    try {
      return await Promise.race([job.promise, new Promise((_, reject) => {
        timer = setTimeout(() => { job.expired = true; job.controller.abort(); reject(Object.assign(new Error('HARNESS_TIMEOUT'), { code: 'HARNESS_TIMEOUT' })); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
}
module.exports = { createHarnessRunner };
