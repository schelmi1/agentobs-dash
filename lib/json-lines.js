'use strict';

function parseLines(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const records = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try { const value = JSON.parse(line); if (value && typeof value === 'object') records.push(value); }
    catch { if (index !== lines.length - 1) throw new Error('Malformed transcript record'); }
  }
  return records;
}

// VS Code workspace files allow comments and trailing commas. Keep strings intact.
function parseJsonc(text) {
  const tokens = text.replace(/^\uFEFF/, '').match(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[^"/]+|\//g) || [];
  const clean = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*')).join('');
  return JSON.parse(clean.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token === ',' ? '' : token));
}

module.exports = { parseLines, parseJsonc };
