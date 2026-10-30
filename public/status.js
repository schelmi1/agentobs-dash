(function (root) {
  'use strict';
  const explanations = {
    FILE_LIMIT: 'A transcript file exceeds the configured file-size limit and was skipped.',
    RECORD_LIMIT: 'A transcript record exceeds the configured record-size limit and could not be read.',
    INGESTION_LIMIT: 'The scan reached its file-discovery or read budget. Some observations are deferred.',
    READ_BUDGET_LIMIT: 'This file cannot fit within the per-scan read budget. Increase the configured read budget to load it.',
    CACHE_LIMIT: 'Transcript data reached the configured memory budget. Some observations are unavailable.',
    STATE_LIMIT: 'A session exceeded the supported event-state budget and could not be fully observed.',
    SOURCE_UNAVAILABLE: 'A transcript store could not be read, or its scan was limited.',
    FILES_UNREADABLE: 'Some transcript files could not be read or parsed.',
    MALFORMED_RECORD: 'The file contains an invalid transcript record and could not be parsed.',
    FILE_ACCESS_DENIED: 'The observer does not have permission to read this file.',
    FILE_MISSING: 'The file disappeared before it could be read.',
    FILE_UNREADABLE: 'The file could not be read or summarized.',
    UNSUPPORTED_FORMAT: 'The file uses an unsupported transcript format or version.',
    SESSION_INVALID: 'A provider returned an invalid session summary. That session was excluded.',
    AGENT_LIMIT: 'The number of agents exceeded the configured limit. Some agents are omitted.',
    GRAPH_LIMIT: 'The agent hierarchy reached its size or depth limit. Some branches are omitted.',
    HISTORY_LIMIT: 'Tool and activity histories were shortened to fit the snapshot budget.',
    SNAPSHOT_LIMIT: 'The snapshot reached its size or hierarchy budget. It may be incomplete or unavailable.',
    HARNESS_TIMEOUT: 'A coding-harness scan exceeded its deadline. Healthy providers continue; this provider is retried after its pending scan stops.',
    HARNESS_SCAN_FAILED: 'A coding-harness scan failed. Its last successful observations may be out of date.',
    SCAN_FAILED: 'The observer could not build a new snapshot. Previously observed activity may be out of date.',
    SNAPSHOT_EXPIRED: 'Snapshots stopped advancing. Displayed activity may no longer be current.',
    CONNECTION_INTERRUPTED: 'The browser lost its connection to the local observer and is reconnecting automatically.',
    RENDER_FAILED: 'The browser could not display the observer snapshot. Try Refresh.'
  };
  const severities = {
    healthy: { label: 'None', description: 'Monitoring is current and the enabled providers are refreshing successfully.' },
    info: { label: 'Information', description: 'Waiting for the first observation. Monitoring has not been confirmed yet.' },
    warning: { label: 'Warning', description: 'Some monitoring data is incomplete. Available observations continue updating.' },
    high: { label: 'High', description: 'A provider, connection or fresh snapshot is unavailable. Some displayed activity may be out of date.' },
    critical: { label: 'Critical', description: 'The dashboard cannot provide a current reliable view. Previously observed data may still be shown.' }
  };
  const providerName = id => ({ codex: 'Codex', 'copilot-vscode': 'VS Code Copilot', 'claude-code': 'Claude Code', opencode: 'OpenCode' }[id] || id);
  function describeStatus({ state = 'Connecting', detail, model, code } = {}) {
    const severity = state === 'Error' ? 'critical'
      : ['Stale', 'Reconnecting'].includes(state) || state === 'Degraded' && model?.health?.providers?.some(provider => provider.status === 'error') ? 'high'
      : state === 'Degraded' || detail ? 'warning' : state === 'Live' ? 'healthy' : 'info';
    const codes = new Set(model?.health?.diagnostics || []);
    if (code) codes.add(code);
    if (state === 'Stale') codes.add('SNAPSHOT_EXPIRED');
    if (state === 'Reconnecting') codes.add('CONNECTION_INTERRUPTED');
    const fileIssues = model?.health?.fileIssues || [];
    const fileCodes = new Set(fileIssues.map(issue => issue.code));
    const reasons = [...codes].filter(value => !fileCodes.has(value)).map(value => {
      const known = Object.hasOwn(explanations, value);
      const code = typeof value === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(value) ? value : 'UNKNOWN_DIAGNOSTIC';
      return { code, text: known ? explanations[value] : 'The observer reported an issue. Some monitoring data may be unavailable.' };
    });
    if (model?.unreadableFiles) reasons.push({ text: model.unreadableFiles + ' transcript file' + (model.unreadableFiles === 1 ? '' : 's') + ' could not be read or parsed in the last scan.' });
    for (const issue of fileIssues) {
      reasons.push({ code: issue.code, text: (issue.provider ? providerName(issue.provider) + ': ' : '') + (explanations[issue.code] || explanations.FILE_UNREADABLE), path: issue.file });
    }
    if (model?.health?.omittedFileIssues) reasons.push({ text: model.health.omittedFileIssues + ' additional file issues are not listed.' });
    for (const source of model?.sources || []) {
      const problem = { unreadable: 'Store could not be read', limited: 'Store scan reached a resource limit', error: 'Provider scan failed' }[source.status];
      if (problem) reasons.push({ text: providerName(source.provider) + ': ' + problem + '.', path: source.directory });
    }
    if (!reasons.length) reasons.push({ text: state === 'Live' && !detail ? 'Fresh snapshots are arriving. No observation problems were reported.' : detail || 'Connecting to the local observer.' });
    return { state, severity, ...severities[severity], reasons,
      providers: (model?.health?.providers || []).map(provider => ({ name: providerName(provider.id), status: provider.status })),
      lastSuccessAt: model?.health?.lastSuccessAt };
  }
  function createStatus(document) {
    const get = id => document.getElementById(id);
    const picker = get('status-picker'), trigger = get('status-trigger'), panel = get('status-menu');
    const view = document.defaultView;
    const place = () => {
      if (panel.hidden) return;
      const box = trigger.getBoundingClientRect(), width = Math.min(420, document.documentElement.clientWidth - 32);
      panel.style.width = width + 'px'; panel.style.left = Math.max(16, Math.min(box.right - width, document.documentElement.clientWidth - width - 16)) + 'px';
      const margin = 16, gap = 8;
      const below = Math.max(0, view.innerHeight - margin - box.bottom - gap);
      const above = Math.max(0, box.top - gap - margin);
      panel.style.maxHeight = Math.max(0, Math.min(600, view.innerHeight - 2 * margin)) + 'px';
      const desiredHeight = panel.getBoundingClientRect().height;
      const openAbove = desiredHeight > below && above > below;
      const available = openAbove ? above : below;
      panel.style.maxHeight = Math.min(600, available) + 'px';
      const height = panel.getBoundingClientRect().height;
      panel.style.top = (openAbove ? Math.max(margin, box.top - gap - height) : Math.max(margin, Math.min(box.bottom + gap, view.innerHeight - margin - height))) + 'px';
    };
    const setOpen = open => { panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); place(); };
    trigger.onclick = event => { const open = panel.hidden; setOpen(open); if (open && event.detail === 0) panel.focus({ preventScroll: true }); };
    trigger.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); panel.focus({ preventScroll: true }); } };
    picker.onkeydown = event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus({ preventScroll: true }); } };
    picker.onfocusout = event => { if (!picker.contains(event.relatedTarget)) setOpen(false); };
    document.addEventListener('pointerdown', event => { if (!picker.contains(event.target)) setOpen(false); });
    view.addEventListener('resize', place); view.addEventListener('scroll', place, { passive: true });
    const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
    return { update(input) {
      const scrollTop = panel.scrollTop;
      const status = describeStatus(input);
      const loading = input.loading === true || ['Connecting', 'Loading'].includes(status.state);
      const count = Number.isSafeInteger(input.filesProcessed) && input.filesProcessed >= 0 ? input.filesProcessed : undefined;
      const remaining = Number.isSafeInteger(input.filesRemaining) && input.filesRemaining > 0 ? input.filesRemaining : undefined;
      const progress = remaining !== undefined ? `Loading transcripts: ${remaining} files deferred to the next scan` : count === undefined ? 'Loading transcripts' : `Loading transcripts: ${count} files checked`;
      trigger.dataset.loading = String(loading);
      get('status-loading-count').textContent = loading && remaining !== undefined ? `· ${remaining} left` : loading && count !== undefined ? `· ${count}` : '';
      picker.dataset.severity = status.severity; trigger.dataset.state = status.state;
      get('connection').textContent = loading ? progress : status.state; get('connection').dataset.state = status.state;
      trigger.title = loading ? progress + ' · Status: ' + status.state + ' · Severity: ' + status.label : 'Status: ' + status.state + ' · Severity: ' + status.label;
      trigger.setAttribute('aria-description', loading ? progress + '. Status: ' + status.state + '. Severity: ' + status.label : status.state + '. Severity: ' + status.label);
      get('status-name').textContent = status.state; get('status-severity').textContent = 'Severity: ' + status.label;
      get('status-summary').textContent = status.description;
      get('status-reasons').replaceChildren(...status.reasons.map(reason => {
        const item = element('li', 'status-reason', '');
        if (reason.code) item.append(element('code', 'status-code', reason.code));
        item.append(element('span', '', reason.text));
        if (reason.path) item.append(element('code', 'status-source-path', reason.path));
        return item;
      }));
      get('status-providers').replaceChildren(...status.providers.map(provider => {
        const item = element('li', 'status-provider', ''); item.dataset.state = provider.status;
        item.append(element('span', '', provider.name), element('span', '', { ok: 'Healthy', degraded: 'Incomplete', error: 'Unavailable', disabled: 'Disabled' }[provider.status] || 'Unknown'));
        return item;
      }));
      get('status-updated').textContent = status.lastSuccessAt ? 'Last successful observation: ' + new Date(status.lastSuccessAt).toLocaleString() : 'No successful observation recorded yet.';
      place();
      panel.scrollTop = scrollTop;
    } };
  }
  const api = { describeStatus, createStatus };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.agentobsStatus = api;
})(globalThis);
