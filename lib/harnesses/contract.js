'use strict';

const { createFileIssues } = require('../file-issues');
const { resourceLimits } = require('../limits');
const path = require('node:path');

const statuses = new Set(['active', 'waiting', 'completed', 'starting', 'unknown']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const usageValid = usage => usage === undefined || object(usage) && Object.entries(usage).every(([key, value]) => ['input', 'cachedInput', 'output'].includes(key) && Number.isSafeInteger(value) && value >= 0);
const short = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : undefined;
const detailNumbers = 'exitCode durationMs patchFiles patchLinesAdded patchLinesRemoved linesRead bytesRead matches matchedFiles testsTotal testsPassed testsFailed testsSkipped agentsStarted agentsFinished attempt maxAttempts outputBytes outputLines'.split(' ');
function safeTool(tool) {
  if (!object(tool) || typeof tool.name !== 'string') return undefined;
  const details = {};
  for (const key of detailNumbers) {
    const value = tool.details?.[key];
    if (key === 'exitCode' ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 : key === 'durationMs' ? Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER : Number.isSafeInteger(value) && value >= 0) details[key] = value;
  }
  for (const [key, values] of Object.entries({ failure: ['timeout', 'permission', 'cancelled', 'process', 'tool'], execution: ['default', 'elevated'], directoryScope: ['workspace', 'external'] })) if (values.includes(tool.details?.[key])) details[key] = tool.details[key];
  if (/^(git|rg|npm|pnpm|yarn|node|npx|sed|find|ls|cat|head|tail|curl|docker|python3?|cargo|go|make|code)( (status|diff|log|show|test|build|check|lint|ci|install|audit|run|--test|pytest)){0,2}$/.test(tool.details?.command || '')) details.command = tool.details.command;
  if (tool.details?.outputTruncated === true) details.outputTruncated = true;
  const status = ['in_progress', 'completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'unknown'].includes(tool.status) ? tool.status : 'unknown';
  return { id: short(tool.id, 4096), name: short(tool.name), label: short(tool.label), status, timestamp: short(tool.timestamp), startedAt: short(tool.startedAt), completedAt: short(tool.completedAt), details };
}

const validText = value => typeof value === 'string' && value.length <= 4096;
const timestamp = value => value === undefined || typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const agentPath = value => validText(value) && value.startsWith('/') && !value.includes('\\') && value.split('/').slice(1).every(part => part && part !== '.' && part !== '..');
const filePath = value => validText(value) && path.isAbsolute(value);
function validateEvidence(session, bounds) {
  let entries = 0;
  const list = (value, validate) => value === undefined || Array.isArray(value) && (entries += value.length) <= bounds.maxStateEntries && value.every(validate);
  const paths = value => list(value, agentPath);
  return ['agentPath'].every(key => session[key] === undefined || agentPath(session[key]))
    && ['file', 'sourceDirectory'].every(key => session[key] === undefined || filePath(session[key]))
    && ['id', 'parentId'].every(key => session[key] === undefined || validText(session[key]))
    && ['lastActivity', 'turnStartedAt', 'currentTaskAt'].every(key => timestamp(session[key]))
    && paths(session.spawnedAgentPaths) && paths(session.completedAgentPaths)
    && list(session.spawnedAgents, item => object(item) && agentPath(item.agentPath) && typeof item.task === 'string' && timestamp(item.timestamp))
    && list(session.agentReports, item => object(item) && agentPath(item.agentPath) && paths(item.spawnedAgentPaths) && paths(item.completedAgentPaths))
    && list(session.agentObservations, item => object(item) && agentPath(item.agentPath) && statuses.has(item.status) && timestamp(item.timestamp))
    && list(session.toolHistory, item => object(item) && typeof item.name === 'string' && ['timestamp', 'startedAt', 'completedAt'].every(key => timestamp(item[key])))
    && list(session.activityTimeline, item => object(item) && timestamp(item.timestamp) && timestamp(item.completedAt))
    && (session.currentProgress === undefined || object(session.currentProgress) && typeof session.currentProgress.text === 'string' && timestamp(session.currentProgress.timestamp));
}

/** Project normalized adapter snapshots before shared policy touches evidence. */
function validateScan(result, overrides) {
  const bounds = resourceLimits(overrides);
  if (!object(result) || !Array.isArray(result.sessions) || !Array.isArray(result.sources)
    || result.sessions.length > bounds.maxFiles || result.sources.length > bounds.maxFiles
    || !Number.isSafeInteger(result.unreadable) || result.unreadable < 0
    || result.deferredFiles !== undefined && (!Number.isSafeInteger(result.deferredFiles) || result.deferredFiles < 0 || result.deferredFiles > bounds.maxFiles)
    || result.diagnostics !== undefined && (!Array.isArray(result.diagnostics) || result.diagnostics.length > bounds.maxStateEntries)
    || result.fileIssues !== undefined && (!Array.isArray(result.fileIssues) || result.fileIssues.length > bounds.maxStateEntries)) throw new Error('HARNESS_CONTRACT_INVALID');
  if (result.sources.some(source => !object(source) || !filePath(source.directory)
    || !['ready', 'missing', 'unreadable', 'limited'].includes(source.status))) throw new Error('HARNESS_CONTRACT_INVALID');
  const sessions = [], diagnostics = [...new Set((result.diagnostics || []).filter(code => ['INGESTION_LIMIT', 'READ_BUDGET_LIMIT', 'CACHE_LIMIT', 'FILE_LIMIT', 'RECORD_LIMIT', 'STATE_LIMIT'].includes(code)))];
  let retainedBytes = 0;
  for (const session of result.sessions) {
    // Unsupported files without a recorded workspace are intentionally omitted.
    if (!session?.cwd) continue;
    if (!object(session) || !validText(session.id) || !session.id || !filePath(session.cwd)
      || !validText(session.provider) || !validText(session.providerLabel)
      || (!statuses.has(session.status) && session.status !== undefined) || !usageValid(session.tokenUsage)
      || !validateEvidence(session, bounds)) {
      if (!diagnostics.includes('SESSION_INVALID')) diagnostics.push('SESSION_INVALID');
      continue;
    }
    const safe = {};
    for (const key of 'id cwd provider providerLabel file sourceDirectory parentId agentPath lastActivity turnStartedAt currentTaskAt currentTurnId'.split(' ')) if (session[key] !== undefined) safe[key] = session[key];
    for (const key of 'agentName shortId cliVersion supportLevel compatibilityDetail compatibilityResolution unsupportedReason attentionState attentionDetail completionSource'.split(' ')) if (session[key] !== undefined) safe[key] = short(session[key]);
    for (const key of ['hasLifecycle', 'needsInput', 'observationStale']) if (session[key] !== undefined) safe[key] = session[key] === true;
    safe.status = session.status;
    safe.tokenUsage = session.tokenUsage ? { ...session.tokenUsage } : undefined;
    safe.currentTask = short(session.currentTask, 500);
    safe.currentProgress = session.currentProgress ? { text: short(session.currentProgress.text, 500), timestamp: session.currentProgress.timestamp, source: short(session.currentProgress.source) } : undefined;
    for (const key of ['spawnedAgentPaths', 'completedAgentPaths']) safe[key] = [...(session[key] || [])];
    safe.spawnedAgents = (session.spawnedAgents || []).map(item => ({ agentPath: item.agentPath, task: short(item.task, 500), timestamp: item.timestamp, kind: item.kind === 'followup' ? 'followup' : 'spawn' }));
    safe.agentReports = (session.agentReports || []).map(item => ({ agentPath: item.agentPath, spawnedAgentPaths: [...(item.spawnedAgentPaths || [])], completedAgentPaths: [...(item.completedAgentPaths || [])] }));
    safe.agentObservations = (session.agentObservations || []).map(item => ({ agentPath: item.agentPath, status: item.status, timestamp: item.timestamp }));
    safe.toolHistory = (session.toolHistory || []).slice(-100).map(safeTool).filter(Boolean);
    safe.currentTool = safeTool(session.currentTool); safe.lastTool = safeTool(session.lastTool);
    safe.activityTimeline = (session.activityTimeline || []).slice(-100).map(event => ({ kind: short(event.kind), label: short(event.label), status: short(event.status), timestamp: event.timestamp, completedAt: event.completedAt, target: short(event.target, 4096) }));
    retainedBytes += Buffer.byteLength(JSON.stringify(safe));
    if (retainedBytes > bounds.maxSummaryBytes) { diagnostics.push('STATE_LIMIT'); break; }
    sessions.push(safe);
  }
  const issues = createFileIssues(); issues.merge(result);
  return { sessions, unreadable: result.unreadable, deferredFiles: result.deferredFiles || 0, ...issues.snapshot(), sources: result.sources.map(source => ({ directory: source.directory, provider: short(source.provider), status: source.status })), diagnostics };
}
module.exports = { validateScan };
