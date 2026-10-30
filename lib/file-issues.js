'use strict';

const path = require('node:path');
const MAX_FILE_ISSUES = 100;
const codes = new Set(['FILE_LIMIT', 'RECORD_LIMIT', 'INGESTION_LIMIT', 'READ_BUDGET_LIMIT', 'CACHE_LIMIT', 'STATE_LIMIT', 'MALFORMED_RECORD', 'FILE_ACCESS_DENIED', 'FILE_MISSING', 'FILE_UNREADABLE', 'UNSUPPORTED_FORMAT']);

// Only scanner-owned paths and fixed codes cross the wire, never error messages
// (parsers may include transcript contents in their exception text).
function fileErrorCode(error) {
  if (codes.has(error?.code)) return error.code;
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'FILE_ACCESS_DENIED';
  if (error?.code === 'ENOENT') return 'FILE_MISSING';
  if (error?.message === 'MALFORMED_RECORD') return 'MALFORMED_RECORD';
  return 'FILE_UNREADABLE';
}

function createFileIssues() {
  const issues = [], seen = new Set();
  let omitted = 0;
  return {
    add(file, error, provider) {
      if (typeof file !== 'string' || file.length > 4096 || !(path.isAbsolute(file) || path.win32.isAbsolute(file))) return;
      const code = fileErrorCode(error), key = JSON.stringify([provider, file, code]);
      if (seen.has(key)) return;
      if (issues.length >= MAX_FILE_ISSUES) { omitted++; return; }
      seen.add(key);
      issues.push({ file, code, ...(typeof provider === 'string' ? { provider: provider.slice(0, 240) } : {}) });
    },
    merge(result, provider) {
      if (Array.isArray(result.fileIssues)) for (const issue of result.fileIssues) {
        if (issue && codes.has(issue.code)) this.add(issue.file, issue, provider);
      }
      if (Number.isSafeInteger(result.omittedFileIssues) && result.omittedFileIssues > 0) omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + result.omittedFileIssues);
    },
    snapshot() { return { ...(issues.length ? { fileIssues: issues.slice() } : {}), ...(omitted ? { omittedFileIssues: omitted } : {}) }; }
  };
}

module.exports = { createFileIssues, MAX_FILE_ISSUES };
