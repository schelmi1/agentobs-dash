'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Observer } = require('./observer');
const { encodeSnapshot } = require('./wire-model');
const { resourceLimits } = require('./limits');
const { createSettings, MAX_BODY } = require('./settings');

function snapshotContent(encoded) {
  const wire = JSON.parse(encoded);
  delete wire.scannedAt; delete wire.scanDurationMs;
  if (wire.health) {
    delete wire.health.sequence; delete wire.health.lastSuccessAt;
    for (const provider of wire.health.providers || []) delete provider.lastSuccessAt;
  }
  return JSON.stringify(wire);
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/themes.css', ['themes.css', 'text/css; charset=utf-8']],
  ['/board.css', ['board.css', 'text/css; charset=utf-8']],
  ['/appearance.css', ['appearance.css', 'text/css; charset=utf-8']],
  ['/modern.css', ['modern.css', 'text/css; charset=utf-8']],
  ['/theme-shapes.css', ['theme-shapes.css', 'text/css; charset=utf-8']],
  ['/appearance.js', ['appearance.js', 'text/javascript; charset=utf-8']],
  ['/color-themes/index.js', ['color-themes/index.js', 'text/javascript; charset=utf-8']],
  ['/live-map.css', ['live-map.css', 'text/css; charset=utf-8']],
  ['/live-map.js', ['live-map.js', 'text/javascript; charset=utf-8']],
  ['/browser-host.js', ['browser-host.js', 'text/javascript; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/settings.css', ['settings.css', 'text/css; charset=utf-8']],
  ...['snapshot.js', 'preferences.js', 'selectors.js', 'agent-views.js', 'inspector.js', 'dom.js', 'status.js'].map(file => ['/' + file, [file, 'text/javascript; charset=utf-8']]),
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);

function createDashboard(config, { observer = new Observer(config) } = {}) {
  const bounds = resourceLimits(config.resourceLimits);
  const settings = createSettings(config);
  const clients = new Set();
  let timer, heartbeat, model, encoded, content, broadcast, lastHealth, startupProgress;
  const send = frame => {
    for (const client of clients) {
      if (client.writableLength + Buffer.byteLength(frame) > bounds.maxSnapshotBytes * 2) { clients.delete(client); client.destroy(); }
      else client.write(frame);
    }
  };
  const failed = code => {
    lastHealth = { status: 'error', code, lastSuccessAt: model?.health?.lastSuccessAt, checkedAt: new Date().toISOString() };
    send('event: observer-health\ndata: ' + JSON.stringify(lastHealth) + '\n\n');
  };
  const refresh = () => {
    if (broadcast) return broadcast;
    const startup = !encoded;
    let active = true, lastProgressSent = 0;
    if (startup) startupProgress = { filesProcessed: 0 };
    const onProgress = () => {
      if (!startup || !active) return;
      startupProgress.filesProcessed++;
      if (Date.now() - lastProgressSent >= 100) {
        lastProgressSent = Date.now();
        send('event: startup-progress\ndata: ' + JSON.stringify(startupProgress) + '\n\n');
      }
    };
    broadcast = Promise.resolve().then(() => observer.scan(onProgress)).then(next => {
      if (next[Symbol.for('agentobs.unchanged')] && encoded && !lastHealth) {
        model = next;
        send('event: observer-poll\ndata: ' + JSON.stringify({ scannedAt: next.scannedAt, health: next.health }) + '\n\n');
        return encoded;
      }
      const nextEncoded = encodeSnapshot(next, config.resourceLimits);
      const nextContent = snapshotContent(nextEncoded), changed = nextContent !== content || Boolean(lastHealth);
      model = next; encoded = nextEncoded; lastHealth = undefined;
      content = nextContent;
      if (changed) send('data: ' + encoded + '\n\n');
      else send('event: observer-poll\ndata: ' + JSON.stringify({ scannedAt: next.scannedAt, health: next.health }) + '\n\n');
      return encoded;
    }).catch(error => { failed(error.code === 'SNAPSHOT_LIMIT' ? 'SNAPSHOT_LIMIT' : 'SCAN_FAILED'); throw error;
    }).finally(() => { active = false; startupProgress = undefined; broadcast = undefined; });
    return broadcast;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    // Exact authority and same-origin checks prevent a website from accessing
    // local transcript summaries through DNS rebinding or cross-origin fetches.
    const authority = `127.0.0.1:${server.address()?.port}`;
    if (![authority, `localhost:${server.address()?.port}`].includes(req.headers.host)) { res.writeHead(403).end('Local access only'); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end('Cross-origin access denied'); return; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end('Cross-site access denied'); return; }
    try {
      const url = new URL(req.url, `http://${authority}`);
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        const data = await settings.describe(); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); return;
      }
      if (url.pathname === '/api/settings' && req.method === 'PUT') {
        if (req.headers.origin !== `http://${req.headers.host}` || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { res.writeHead(403).end('Same-origin JSON required'); return; }
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) { res.writeHead(413).end('Settings too large'); return; } chunks.push(chunk); }
        let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('Invalid JSON'); return; }
        try { const result = await settings.save(data); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); }
        catch (error) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message && /^(Invalid settings|Invalid provider settings|Monitored root must|Each path must)/.test(error.message) ? error.message : 'Could not save settings' })); }
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end('Method not allowed'); return; }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        if (encoded) { encoded = encodeSnapshot(model, config.resourceLimits); res.write('data: ' + encoded + '\n\n'); }
        else if (startupProgress) res.write('event: startup-progress\ndata: ' + JSON.stringify(startupProgress) + '\n\n');
        if (lastHealth) res.write('event: observer-health\ndata: ' + JSON.stringify(lastHealth) + '\n\n');
        clients.add(res);
        res.on('close', () => clients.delete(res));
        if (!encoded) refresh().catch(() => {});
        return;
      }
      if (url.pathname === '/api/snapshot') {
        await refresh();
        const snapshot = encodeSnapshot(model, config.resourceLimits); encoded = snapshot;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(snapshot); return;
      }
      const asset = assets.get(url.pathname);
      if (!asset) { res.writeHead(404).end('Not found'); return; }
      const content = await fs.readFile(path.join(__dirname, '..', 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1] }); res.end(content);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Dashboard could not read its local data');
    }
  });
  return {
    server, observer,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
      timer = setInterval(() => refresh().catch(() => {}), config.pollIntervalMs);
      heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      clearInterval(timer); clearInterval(heartbeat);
      await observer.close?.();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}

module.exports = { createDashboard };
