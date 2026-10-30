'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createHarnessRunner } = require('./harness-runner');
const { retainUnavailable, staleObservation } = require('./observation-coverage');
const path = require('node:path');
const { buildSessionForest } = require('./hierarchy');
const { liveMapModel } = require('./live-map-model');
const { createHarnesses } = require('./harnesses');
const { validateScan } = require('./harnesses/contract');
const { resourceLimits } = require('./limits');
const { createFileIssues } = require('./file-issues');

function withinRoot(root, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const relative = path.relative(root, path.resolve(cwd));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

class Observer {
  constructor(config, harnesses = createHarnesses(config)) {
    this.config = config; this.harnesses = harnesses; this.pending = undefined;
    this.runHarness = createHarnessRunner(); this.instanceId = randomUUID();
    this.lastGood = new Map(); this.lastSuccessAt = undefined; this.sequence = 0;
    this.startupComplete = false;
    this.fastRaw = undefined; this.fastModel = undefined; this.fastAt = 0; this.fastUntil = 0; this.fastPolicy = '';
  }

  scan(onProgress) {
    // Polls and newly-connected clients share one scan, even on slow disks.
    if (this.pending) return this.pending;
    this.pending = this.scanNow(onProgress).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async close() { await this.pending?.catch(() => {}); await Promise.allSettled(this.harnesses.map(harness => harness.close?.())); }

  async scanNow(onProgress) {
    const started = Date.now();
    const sources = [], candidates = [];
    let unreadable = 0, succeeded = 0, deferredFiles = 0, loadProgress;
    const diagnostics = new Set(), providers = [];
    const fileIssues = createFileIssues();
    const bounds = resourceLimits(this.config.resourceLimits);
    const policy = JSON.stringify([this.config.rootFolder, this.config.staleAfterMs, this.config.inactiveAfterMs, this.config.failedInactiveAfterMs, this.config.quietHistoryAfterMs, this.config.resourceLimits]);
    const outcomes = await Promise.allSettled(this.harnesses.map(harness =>
      Array.isArray(harness.roots) && !harness.roots.length ? undefined
        : this.runHarness(harness, this.config.providerTimeoutMs ?? 5000, onProgress)));
    const reusable = this.fastRaw && this.fastModel && this.fastModel.health.status !== 'error' && this.fastModel.health.providers.every(provider => provider.status !== 'error') && policy === this.fastPolicy && started >= this.fastAt && started < this.fastUntil && outcomes.every((outcome, index) => {
      const harness = this.harnesses[index];
      return outcome.status === 'fulfilled' && (Array.isArray(harness.roots) && !harness.roots.length || harness.stableOnReference && outcome.value === this.fastRaw[index] && !outcome.value?.deferredFiles);
    });
    if (reusable) {
      const at = new Date(started).toISOString();
      for (const harness of this.harnesses) if (this.lastGood.has(harness)) this.lastGood.set(harness, { ...this.lastGood.get(harness), lastSuccessAt: at });
      this.lastSuccessAt = at;
      const health = { ...this.fastModel.health, sequence: ++this.sequence, lastSuccessAt: at, providers: this.fastModel.health.providers.map(provider => provider.status === 'disabled' ? provider : { ...provider, lastSuccessAt: at }) };
      const result = { ...this.fastModel, scannedAt: new Date().toISOString(), scanDurationMs: Date.now() - started, health };
      Object.defineProperty(result, Symbol.for('agentobs.unchanged'), { value: true });
      return result;
    }
    for (const [index, harness] of this.harnesses.entries()) {
      const id = harness.id || 'harness-' + index;
      if (Array.isArray(harness.roots) && !harness.roots.length) { providers.push({ id, status: 'disabled' }); continue; }
      try {
        const outcome = outcomes[index];
        if (outcome.status === 'rejected') throw outcome.reason;
        const result = validateScan(outcome.value, this.config.resourceLimits);
        deferredFiles += result.deferredFiles;
        loadProgress ||= result.loadProgress;
        const previous = this.lastGood.get(harness);
        const retained = { ...result, sessions: retainUnavailable(previous, result, bounds), lastSuccessAt: new Date(started).toISOString() };
        this.lastGood.set(harness, retained); succeeded++;
        sources.push(...result.sources); unreadable += result.unreadable;
        fileIssues.merge(result, id);
        for (const code of result.diagnostics) diagnostics.add(code);
        candidates.push(...retained.sessions);
        const sourceFailure = result.sources.some(source => ['unreadable', 'limited'].includes(source.status)) || retained.sessions.some(session => session.observationStale);
        if (sourceFailure) diagnostics.add('SOURCE_UNAVAILABLE');
        providers.push({ id, status: sourceFailure || result.unreadable || result.diagnostics.length ? 'degraded' : 'ok', lastSuccessAt: retained.lastSuccessAt });
      } catch (error) {
        const code = error.code === 'HARNESS_TIMEOUT' ? 'HARNESS_TIMEOUT' : 'HARNESS_SCAN_FAILED';
        diagnostics.add(code);
        const retained = this.lastGood.get(harness);
        for (const directory of harness.roots || retained?.sources.map(source => source.directory) || []) sources.push({ directory, provider: id, status: 'error', code });
        candidates.push(...(retained?.sessions || []).map(staleObservation));
        providers.push({ id, status: 'error', code, lastSuccessAt: retained?.lastSuccessAt });
      }
    }
    if (succeeded) this.lastSuccessAt = new Date(started).toISOString();
    if (unreadable) diagnostics.add('FILES_UNREADABLE');
    const canonicalPaths = new Map();
    const sessions = [];
    for (const candidate of candidates) {
      // Harness snapshots may reuse cached objects. Shared policy owns its annotations.
      const session = candidate.observationStale ? staleObservation(candidate) : { ...candidate };
      try {
        if (!session.cwd) continue;
        if (!canonicalPaths.has(session.cwd)) {
          canonicalPaths.set(session.cwd, await fs.realpath(session.cwd).catch(() => session.cwd));
        }
        if (!withinRoot(this.config.rootFolder, canonicalPaths.get(session.cwd))) continue;
        session.cwd = canonicalPaths.get(session.cwd);
        if (['active', 'waiting'].includes(session.status) && session.attentionState !== 'failed' && started - Date.parse(session.lastActivity) > this.config.staleAfterMs) {
          session.status = 'stale'; session.attentionState = 'stalled'; session.attentionDetail = 'No recent transcript activity';
        }
        sessions.push(session);
      } catch { unreadable++; }
    }
    sessions.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
    if (sessions.length > bounds.maxAgents) diagnostics.add('AGENT_LIMIT');
    const forest = buildSessionForest(sessions.slice(0, bounds.maxAgents), { maxDepth: bounds.maxDepth, maxNodes: bounds.maxAgents, onLimit: () => diagnostics.add('GRAPH_LIMIT') });
    const model = liveMapModel(forest, { inactiveAfterMs: this.config.inactiveAfterMs, failedInactiveAfterMs: this.config.failedInactiveAfterMs, quietHistoryAfterMs: this.config.quietHistoryAfterMs }, started);
    const workspaces = new Map();
    for (const agent of Object.values(model.agents)) {
      if (!workspaces.has(agent.cwd)) workspaces.set(agent.cwd, { cwd: agent.cwd, label: path.relative(this.config.rootFolder, agent.cwd) || path.basename(agent.cwd), agents: 0, live: 0 });
      const workspace = workspaces.get(agent.cwd);
      workspace.agents++;
      if (!agent.archived) workspace.live++;
    }
    const enabled = providers.filter(provider => provider.status !== 'disabled').length;
    const startupLoading = !this.startupComplete && deferredFiles > 0;
    if (!startupLoading) this.startupComplete = true;
    const result = {
      ...model, rootFolder: this.config.rootFolder, scannedAt: new Date().toISOString(),
      startupLoading, startupRemaining: startupLoading ? deferredFiles : 0, loadingFiles: deferredFiles > 0, loadingRemaining: deferredFiles, ...(deferredFiles && loadProgress ? { loadingFileProgress: loadProgress } : {}),
      scanDurationMs: Date.now() - started, pollIntervalMs: this.config.pollIntervalMs,
      sources, unreadableFiles: unreadable,
      health: { instanceId: this.instanceId, sequence: ++this.sequence, status: succeeded < enabled ? succeeded ? 'degraded' : 'error' : diagnostics.size ? 'degraded' : 'ok', lastSuccessAt: this.lastSuccessAt, providers, diagnostics: [...diagnostics], ...fileIssues.snapshot() },
      workspaces: [...workspaces.values()].sort((a, b) => b.live - a.live || a.label.localeCompare(b.label))
    };
    this.fastRaw = outcomes.every(outcome => outcome.status === 'fulfilled') && !startupLoading ? outcomes.map(outcome => outcome.value) : undefined;
    this.fastModel = result; this.fastAt = started; this.fastPolicy = policy;
    this.fastUntil = started + 5000;
    for (const session of sessions) {
      const activity = Date.parse(session.lastActivity || '');
      if (!Number.isFinite(activity)) continue;
      for (const duration of [this.config.staleAfterMs + 1, this.config.inactiveAfterMs ?? 3600000, this.config.failedInactiveAfterMs ?? 900000, this.config.quietHistoryAfterMs ?? 1800000]) {
        const boundary = activity + duration;
        if (Number.isFinite(boundary) && boundary > started) this.fastUntil = Math.min(this.fastUntil, boundary);
      }
    }
    return result;
  }
}

module.exports = { Observer, withinRoot };
