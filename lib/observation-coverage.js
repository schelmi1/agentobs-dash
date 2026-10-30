'use strict';

const path = require('node:path');
const identity = session => JSON.stringify([session.provider, session.id, session.agentPath || '', session.file || '']);
const contains = (directory, file) => typeof file === 'string' && (file === directory || file.startsWith(directory + path.sep));
const staleObservation = session => ({ ...session, observationStale: true, status: session.status === 'completed' ? 'completed' : 'stale', currentTool: undefined });

// Absence is deletion only where discovery and reads completed successfully.
// Provenance belongs to the adapter; older adapters may be inferred by file.
function retainUnavailable(previous, result, bounds) {
  const sessions = result.sessions.slice(), present = new Set(sessions.map(identity));
  const unavailable = result.sources.filter(source => source.status !== 'ready');
  const failedFiles = new Set((result.fileIssues || []).map(issue => issue.file));
  for (const session of previous?.sessions || []) {
    if (present.has(identity(session))) continue;
    const source = session.sourceDirectory || previous.sources.find(source => contains(source.directory, session.file))?.directory
      || (previous.sources.length === 1 ? previous.sources[0].directory : undefined);
    if (result.diagnostics?.some(code => ['SESSION_INVALID', 'STATE_LIMIT'].includes(code)) || result.omittedFileIssues || failedFiles.has(session.file) || unavailable.some(item => !source || item.directory === source)) sessions.push(staleObservation(session));
  }
  let bytes = 0;
  return sessions.filter(session => {
    bytes += Buffer.byteLength(JSON.stringify(session));
    return bytes <= bounds.maxSummaryBytes;
  }).slice(0, bounds.maxFiles);
}
module.exports = { retainUnavailable, staleObservation };
