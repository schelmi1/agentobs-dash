'use strict';

// The observer never uses image URLs. Remove their string bodies before the
// JSONL reader buffers a record, so screenshots cannot exhaust its text budget.
// This is a byte-stream projection, not a JSON parser: JSON.parse still checks
// each projected record. Validate omitted string escapes as well, so projection
// cannot turn a malformed image record into an apparently valid tool result.
function createImageOmitter() {
  let inString = false, escaped = false, unicode = 0, omit = false;
  let candidate = '', afterImageKey = false, imageValue = false;
  return chunk => {
    const parts = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      let keep = true;
      if (inString) {
        keep = !omit;
        if (unicode) {
          if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) throw new Error('MALFORMED_RECORD');
          unicode--;
        } else if (escaped) {
          if (byte === 117) unicode = 4;
          else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) throw new Error('MALFORMED_RECORD');
          escaped = false;
        } else if (byte === 92) escaped = true;
        else if (byte === 34) {
          inString = false; keep = true;
          afterImageKey = !omit && candidate.length < 128 && JSON.parse('"' + candidate + '"') === 'image_url';
        } else if (byte < 32) throw new Error('MALFORMED_RECORD');
        if (inString && !omit && candidate.length < 128) candidate += String.fromCharCode(byte);
      } else if (byte === 34) {
        inString = true; omit = imageValue; candidate = '';
        imageValue = false; afterImageKey = false;
      } else if (![9, 10, 13, 32].includes(byte)) {
        imageValue = afterImageKey && byte === 58;
        afterImageKey = false;
      }
      if (!keep && start >= 0) { parts.push(chunk.subarray(start, index)); start = -1; }
      else if (keep && start < 0) start = index;
    }
    if (start >= 0) parts.push(chunk.subarray(start));
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  };
}

module.exports = { createImageOmitter };
