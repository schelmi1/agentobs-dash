#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseLines, parseJsonc } = require('../lib/json-lines');
const { sanitizeFixture } = require('../lib/harnesses/copilot');
const { limits } = require('../lib/limits');

async function main(args) {
  const inputs = [], options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--input', '--out', '--format', '--origin', '--vscode-version', '--copilot-version'].includes(key) || !value) throw new Error('Use --input <file> (repeatable) --out <directory> --format transcript|debug|chat-jsonl|chat-json [--origin actual|synthetic]');
    if (key === '--input') inputs.push(path.resolve(value)); else options[key.slice(2)] = value;
  }
  if (!inputs.length || !options.out || !['transcript', 'debug', 'chat-jsonl', 'chat-json'].includes(options.format) || options.origin && !['actual', 'synthetic'].includes(options.origin)) throw new Error('Input, output and a supported format are required');
  const output = path.resolve(options.out); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const files = [];
  for (const [index, input] of inputs.entries()) {
    if ((await fs.stat(input)).size > limits.maxRecordBytes) throw new Error('Fixture input exceeds the 4 MiB export budget; select a smaller capture');
    const text = await fs.readFile(input, 'utf8'), records = options.format === 'chat-json' ? [{ kind: 0, v: parseJsonc(text) }] : parseLines(text);
    const sanitized = sanitizeFixture(records), name = 'capture-' + (index + 1) + '.jsonl';
    await fs.writeFile(path.join(output, name), sanitized.map(JSON.stringify).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    files.push({ name, records: sanitized.length });
  }
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ fixtureSchemaVersion: 1, origin: options.origin || 'synthetic', format: options.format === 'chat-json' ? 'chat-jsonl' : options.format, verified: false, versions: { vscode: options['vscode-version'] || 'unrecorded', copilot: options['copilot-version'] || 'unrecorded' }, files, checkpoints: [], note: 'Review redaction and record expected lifecycle checkpoints before marking a real capture verified.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Sanitized fixture exported. Verification remains pending: ' + path.join(output, 'manifest.json'));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
