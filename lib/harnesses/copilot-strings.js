'use strict';

// Copilot can put entire tool outputs or encoded attachments in a single JSONL
// string. The reducer only uses short summaries; bound strings before buffering
// the record while continuing to validate their JSON escapes and controls.
function createStringLimiter(limit = 16 * 1024) {
  let inString = false, escaped = false, unicode = 0, length = 0, omitting = false;
  let slash = false, lineComment = false, blockComment = false, star = false;
  return chunk => {
    const parts = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      let keep = true;
      if (inString) {
        if (!omitting && length >= limit && !escaped && !unicode && byte !== 34 && (byte < 128 || byte >= 192)) omitting = true;
        keep = !omitting;
        if (unicode) {
          if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) throw new Error('MALFORMED_RECORD');
          unicode--;
        } else if (escaped) {
          if (byte === 117) unicode = 4;
          else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) throw new Error('MALFORMED_RECORD');
          escaped = false;
        } else if (byte === 92) escaped = true;
        else if (byte === 34) { inString = false; keep = true; }
        else if (byte < 32) throw new Error('MALFORMED_RECORD');
        if (keep && inString) length++;
      } else if (lineComment) {
        if (byte === 10 || byte === 13) lineComment = false;
      } else if (blockComment) {
        if (star && byte === 47) { blockComment = false; star = false; }
        else star = byte === 42;
      } else if (slash && (byte === 47 || byte === 42)) {
        lineComment = byte === 47; blockComment = byte === 42; slash = false;
      } else {
        slash = byte === 47;
        if (byte === 34) { inString = true; escaped = false; unicode = 0; length = 0; omitting = false; }
      }
      if (!keep && start >= 0) { parts.push(chunk.subarray(start, i)); start = -1; }
      else if (keep && start < 0) start = i;
    }
    if (start >= 0) parts.push(chunk.subarray(start));
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  };
}
module.exports = { createStringLimiter };
