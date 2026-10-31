(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const header = document.querySelector('.dashboard-header');
  const railToggle = $('sidebar-toggle');
  const setRailOpen = open => {
    header.dataset.railOpen = String(open);
    if (open) header.querySelector('.header-inner').scrollTop = 0;
    railToggle.setAttribute('aria-expanded', String(open));
    railToggle.setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar');
    railToggle.textContent = open ? '×' : '☰';
  };
  railToggle.addEventListener('click', () => setRailOpen(header.dataset.railOpen !== 'true'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && header.dataset.railOpen === 'true' && !event.defaultPrevented && !document.querySelector('dialog[open], :popover-open')) {
      setRailOpen(false); railToggle.focus();
    }
  });
  const headerSize = new ResizeObserver(() => document.documentElement.style.setProperty('--dashboard-header-height', header.getBoundingClientRect().height + 'px'));
  headerSize.observe(header);
  let storage;
  try { storage = localStorage; } catch { storage = { getItem: () => null, setItem: () => {} }; }
  const preferences = window.agentobsPreferences.createPreferenceStore(storage);
  let saved = preferences.get();
  const snapshotGate = window.agentobsSnapshot.createSnapshotGate();
  let model, selected, source, ready = false, lastReceived, freshnessTimer, observationError;
  let workspace = saved.workspace, compact = saved.compactDensity;
  const persist = () => { saved = preferences.set({ ...saved, workspace, compactDensity: compact }); };
  const sidebarResize = $('sidebar-resize');
  const sidebarLimits = () => ({ min: 190, max: Math.max(190, Math.min(480, innerWidth - 360)) });
  const syncSidebarWidth = () => {
    const { min, max } = sidebarLimits();
    const width = Math.min(max, Math.max(min, saved.sidebarWidth ?? 240));
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
    sidebarResize.setAttribute('aria-valuemin', String(min)); sidebarResize.setAttribute('aria-valuemax', String(max)); sidebarResize.setAttribute('aria-valuenow', String(width));
  };
  const setSidebarWidth = width => {
    const { min, max } = sidebarLimits();
    saved.sidebarWidth = Math.round(Math.min(max, Math.max(min, width)));
    syncSidebarWidth();
  };
  let sidebarDrag;
  sidebarResize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || matchMedia('(max-width: 760px)').matches) return;
    sidebarDrag = { id: event.pointerId, x: event.clientX, width: header.getBoundingClientRect().width };
    sidebarResize.setPointerCapture(event.pointerId); document.body.classList.add('is-resizing-sidebar'); event.preventDefault();
  });
  sidebarResize.addEventListener('pointermove', event => {
    if (sidebarDrag?.id === event.pointerId) setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
  });
  const finishSidebarResize = event => {
    if (sidebarDrag?.id !== event.pointerId) return;
    sidebarDrag = undefined; document.body.classList.remove('is-resizing-sidebar'); persist();
  };
  sidebarResize.addEventListener('pointerup', finishSidebarResize);
  sidebarResize.addEventListener('pointercancel', finishSidebarResize);
  sidebarResize.addEventListener('lostpointercapture', finishSidebarResize);
  sidebarResize.addEventListener('keydown', event => {
    const { min, max } = sidebarLimits(), current = header.getBoundingClientRect().width;
    const next = event.key === 'ArrowLeft' ? current - 20 : event.key === 'ArrowRight' ? current + 20 : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (next === undefined) return;
    setSidebarWidth(next); persist(); event.preventDefault();
  });
  window.addEventListener('resize', syncSidebarWidth); syncSidebarWidth();
  const shortCount = count => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count).toLowerCase();
  const text = (id, value) => { $(id).textContent = value; };
  const syncTokenHints = () => {
    const modern = document.documentElement.dataset.design === 'modern';
    for (const node of document.querySelectorAll('.metric-token-values[data-token-hint], .metric-token-values [data-token-hint]')) {
      if (modern) node.removeAttribute('title'); else node.title = node.dataset.tokenHint;
    }
  };
  const status = window.agentobsStatus.createStatus(document);
  const connection = (state, detail, code) => status.update({ state, detail, code, model, loading: (model?.startupLoading || model?.loadingFiles) && ['Live', 'Degraded'].includes(state), filesRemaining: model?.loadingRemaining ?? model?.startupRemaining, fileProgress: model?.loadingFileProgress });
  connection('Connecting');
  const workspacePicker = $('workspaces');
  const workspaceTrigger = $('workspace-trigger');
  const workspaceMenu = $('workspace-menu');
  const setWorkspaceMenu = open => {
    if (open) {
      const rect = workspaceTrigger.getBoundingClientRect(), width = Math.min(360, innerWidth - 16);
      workspaceMenu.style.width = width + 'px';
      workspaceMenu.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
      workspaceMenu.style.top = Math.min(rect.bottom + 4, innerHeight - 80) + 'px';
      workspaceMenu.style.maxHeight = Math.max(64, Math.min(360, innerHeight - parseFloat(workspaceMenu.style.top) - 8)) + 'px';
    }
    workspacePicker.dataset.open = String(open);
    workspaceTrigger.setAttribute('aria-expanded', String(open));
    workspaceMenu.setAttribute('aria-hidden', String(!open));
    workspaceMenu.inert = !open;
  };
  workspaceTrigger.onclick = event => {
    const open = workspacePicker.dataset.open !== 'true';
    setWorkspaceMenu(open);
    if (open && event.detail === 0) (workspaceMenu.querySelector('[aria-checked="true"]') || workspaceMenu.firstElementChild)?.focus();
  };
  workspacePicker.onkeydown = event => {
    if (event.key === 'Escape' && workspacePicker.dataset.open === 'true') {
      event.preventDefault(); event.stopPropagation(); workspaceTrigger.focus(); setWorkspaceMenu(false); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); setWorkspaceMenu(true);
    const options = [...workspaceMenu.children];
    if (!options.length) return;
    const current = options.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : current === -1 ? event.key === 'ArrowUp' ? options.length - 1 : 0
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[index].focus();
  };
  workspacePicker.onfocusout = event => { if (!workspacePicker.contains(event.relatedTarget)) setWorkspaceMenu(false); };
  document.addEventListener('pointerdown', event => { if (!workspacePicker.contains(event.target)) setWorkspaceMenu(false); });
  // A manual move is a presentation choice, scoped to this browser. Any new
  // activity in the run invalidates it so a resumed agent becomes visible again.
  const activitySignature = root => {
    const entries = window.agentobsSelectors.flatten([root]).map(agent => [agent.id, agent.lastActivity || '']).sort((a, b) => a[0].localeCompare(b[0]));
    const value = JSON.stringify(entries); let a = 2166136261, b = 0x9e3779b9;
    for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519); }
    return (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
  };
  const manuallyArchive = node => ({ ...node, archived: true, historyGroup: 'completed', needsAttention: false, layoutHeld: false, children: node.children.map(manuallyArchive) });
  const emit = (selectionOnly = false) => {
    if (!model || !ready) return;
    let changed = false;
    const presented = model.forest.map(root => {
      const signature = saved.manuallyCompleted[root.id];
      if (!signature) return root;
      if (activitySignature(root) !== signature) { delete saved.manuallyCompleted[root.id]; changed = true; return root; }
      return { ...manuallyArchive(root), manuallyCompleted: true };
    });
    if (changed) persist();
    const { forest, memberIds, contextIds } = window.agentobsSelectors.projectWorkspace(presented, workspace);
    const agents = Object.create(null);
    const visit = node => { agents[node.id] = node; node.children.forEach(visit); };
    forest.forEach(visit);
    if (!agents[selected]) selected = undefined;
    window.dispatchEvent(new CustomEvent('agentobs:render', { detail: {
      type: 'render', selectionSource: 'map', selectionOnly,
      model: { ...model, forest, agents, scopeMemberIds: memberIds, scopeContextIds: contextIds, runs: model.runs.filter(run => forest.some(root => root.id === run.id)), selectedAgentKey: selected, compactDensity: compact }
    } }));
    renderOverview([...memberIds].map(id => agents[id]), forest);
  };
  const renderOverview = (agents, forest) => {
    $('metric-tokens').dataset.tokenHint = 'Cached input is included in input. Missing values are excluded.';
    const live = agents.filter(agent => ['working', 'tool', 'starting'].includes(agent.displayState) && !agent.archived).length;
    text('metric-live', live);
    text('metric-attention', agents.filter(agent => agent.needsAttention).length);
    text('metric-workspaces', forest.filter(window.agentobsSelectors.hasLive).length);
    text('metric-tools-running', agents.filter(agent => agent.currentTool?.status === 'in_progress' && !agent.observationStale).length);
    for (const [field, id, label] of [['input', 'in', 'Input'], ['cachedInput', 'cache', 'Cached input'], ['output', 'out', 'Output']]) {
      const counts = agents.map(agent => agent.tokenUsage?.[field]).filter(Number.isFinite);
      const total = counts.reduce((sum, value) => sum + value, 0);
      text('metric-tokens-' + id, counts.length ? shortCount(total) : '—');
      $('metric-tokens-' + id).dataset.tokenHint = counts.length ? `${total.toLocaleString()} ${label.toLowerCase()} tokens · ${counts.length} agents reporting` : `No ${label.toLowerCase()} tokens recorded`;
    }
    syncTokenHints();
    text('scope-name', workspace ? model.workspaces.find(item => item.cwd === workspace)?.label || workspace : 'All workspaces');
  };
  const renderWorkspaces = () => {
    if (workspace && !model.workspaces.some(item => item.cwd === workspace)) { workspace = ''; persist(); }
    const entries = [{ cwd: '', label: 'All workspaces', agents: Object.keys(model.agents).length }, ...model.workspaces];
    const usage = new Map();
    for (const agent of Object.values(model.agents)) {
      const values = [agent.tokenUsage?.input, agent.tokenUsage?.output].filter(Number.isFinite);
      for (const key of new Set(['', agent.cwd])) {
        if (!values.length) continue;
        usage.set(key, (usage.get(key) || 0) + values.reduce((sum, value) => sum + value, 0));
      }
    }
    const tokens = cwd => usage.has(cwd) ? shortCount(usage.get(cwd)) : '—';
    const tokenTitle = cwd => usage.has(cwd) ? usage.get(cwd).toLocaleString() + ' tokens observed (input + output; cached input is already included). Missing values are excluded.' : 'No input or output tokens recorded';
    const previous = new Map([...workspaceMenu.children].map(button => [button.dataset.workspace, button]));
    const focused = document.activeElement;
    const scrollTop = workspaceMenu.scrollTop;
    const nextKeys = new Set(entries.map(item => item.cwd));
    for (const [cwd, button] of previous) if (!nextKeys.has(cwd)) button.remove();
    entries.forEach((item, index) => {
      let button = previous.get(item.cwd);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button'; button.className = 'workspace-button'; button.tabIndex = -1;
        button.setAttribute('role', 'menuitemradio'); button.dataset.workspace = item.cwd;
        for (const [className, value] of [['workspace-icon', item.cwd ? '↳' : '◈'], ['workspace-name', item.label], ['workspace-total', ''], ['workspace-tokens', '']]) {
          const span = document.createElement('span'); span.className = className; span.textContent = value; button.append(span);
        }
        button.onclick = () => {
          workspace = item.cwd; selected = undefined; persist(); renderWorkspaces(); emit();
          workspaceTrigger.focus({ preventScroll: true }); setWorkspaceMenu(false);
        };
      }
      button.title = item.cwd || model.rootFolder;
      button.setAttribute('aria-pressed', String(workspace === item.cwd));
      button.setAttribute('aria-checked', String(workspace === item.cwd));
      button.querySelector('.workspace-name').textContent = item.label;
      button.querySelector('.workspace-total').textContent = item.agents;
      button.querySelector('.workspace-total').title = item.agents + ' observed agents';
      button.querySelector('.workspace-tokens').textContent = tokens(item.cwd) + ' tokens';
      button.querySelector('.workspace-tokens').title = tokenTitle(item.cwd);
      if (workspaceMenu.children[index] !== button) workspaceMenu.insertBefore(button, workspaceMenu.children[index] || null);
    });
    if (focused?.isConnected && workspaceMenu.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
    workspaceMenu.scrollTop = scrollTop;
    text('workspace-selection', workspace ? model.workspaces.find(item => item.cwd === workspace)?.label || workspace : 'All workspaces');
    workspaceTrigger.setAttribute('aria-description', 'Current: ' + (workspace ? model.workspaces.find(item => item.cwd === workspace)?.label || workspace : 'All workspaces'));
    text('workspace-trigger-count', entries.find(item => item.cwd === workspace)?.agents ?? Object.keys(model.agents).length);
    text('workspace-trigger-tokens', tokens(workspace));
    $('workspace-trigger-tokens').title = tokenTitle(workspace);
  };
  const accept = (next, requestGeneration) => {
    const decoded = window.agentobsSnapshot.decodeSnapshot(next);
    if (!snapshotGate.accept(decoded, requestGeneration)) return;
    lastReceived = performance.now();
    model = decoded; observationError = undefined;
    text('root-folder', model.rootFolder); $('root-folder').title = model.rootFolder;
    text('scan-status', `Updated ${new Date(model.scannedAt).toLocaleTimeString()} · ${model.pollIntervalMs / 1000}s refresh`);
    $('sources').replaceChildren(...model.sources.map(item => {
      const li = document.createElement('li'); li.textContent = item.directory + ' · ' + item.status; return li;
    }));
    renderWorkspaces(); emit();
    if (performance.now() - lastReceived > Math.max(10000, model.pollIntervalMs * 3)) { connection('Stale', 'The observer snapshot is no longer advancing. Code: SNAPSHOT_EXPIRED'); return; }
    const unavailable = model.sources.filter(item => ['unreadable', 'limited', 'error'].includes(item.status)).length;
    if (model.health?.status !== 'ok' && model.health) {
      connection(model.health.status === 'error' ? 'Error' : 'Degraded', `${model.unreadableFiles} transcript files and ${unavailable} stores could not be read. Some observations are unavailable or limited. Showing available data. Codes: ` + model.health.diagnostics.join(', '));
      return;
    }
    connection('Live', model.unreadableFiles || unavailable ? `${model.unreadableFiles} transcript files and ${unavailable} stores could not be read. Other sessions remain visible.` : undefined);
  };
  const refresh = async () => {
    const generation = snapshotGate.capture();
    try {
      const response = await fetch('/api/snapshot');
      if (!response.ok) throw new Error('Snapshot request failed');
      accept(await response.json(), generation);
    } catch { connection('Reconnecting', 'Cannot reach the local observer. Showing the last snapshot; activity may be out of date.'); }
  };
  // A small host interface keeps the original, independently-tested map renderer
  // separate from browser persistence, root scope, and server transport.
  window.agentobsHost = {
    getState: () => saved,
    setState: next => { saved = preferences.set(next); persist(); syncTokenHints(); },
    postMessage: message => {
      if (message.command === 'ready') {
        ready = true;
        source = new EventSource('/api/events');
        source.onmessage = event => { try { accept(JSON.parse(event.data)); } catch { connection('Error', 'Could not render the observer snapshot. Try refreshing.', 'RENDER_FAILED'); } };
        source.addEventListener('observer-poll', event => {
          try {
            const update = JSON.parse(event.data);
            if (!model || update.health?.instanceId !== model.health?.instanceId || !snapshotGate.accept(update)) return;
            lastReceived = performance.now(); observationError = undefined;
            model.scannedAt = update.scannedAt; model.health = update.health;
            text('scan-status', `Updated ${new Date(model.scannedAt).toLocaleTimeString()} · ${model.pollIntervalMs / 1000}s refresh`);
            const unavailable = model.sources.filter(item => ['unreadable', 'limited', 'error'].includes(item.status)).length;
            if (model.health?.status !== 'ok') connection(model.health.status === 'error' ? 'Error' : 'Degraded', `${model.unreadableFiles} transcript files and ${unavailable} stores could not be read. Some observations are unavailable or limited. Showing available data. Codes: ` + model.health.diagnostics.join(', '));
            else connection('Live', model.unreadableFiles || unavailable ? `${model.unreadableFiles} transcript files and ${unavailable} stores could not be read. Other sessions remain visible.` : undefined);
          } catch { /* A malformed heartbeat does not replace a valid snapshot. */ }
        });
        source.addEventListener('startup-progress', event => {
          if (model) return;
          try {
            const { filesProcessed } = JSON.parse(event.data);
            if (Number.isSafeInteger(filesProcessed) && filesProcessed >= 0) status.update({ state: 'Loading', filesProcessed });
          } catch { /* Ignore invalid progress updates. */ }
        });
        source.addEventListener('observer-health', event => {
          try { observationError = JSON.parse(event.data).code; } catch { observationError = 'SCAN_FAILED'; }
          connection('Error', 'Observation failed. Showing the last snapshot; recorded activity may be out of date.', observationError);
        });
        freshnessTimer = setInterval(() => {
          if (!observationError && lastReceived !== undefined && performance.now() - lastReceived > Math.max(10000, (model?.pollIntervalMs || 2000) * 3)) connection('Stale', 'No new observer snapshot has arrived. Showing the last snapshot; activity may be out of date. Code: SNAPSHOT_EXPIRED');
        }, 1000);
        source.onerror = () => connection('Reconnecting', 'Connection interrupted. Showing the last snapshot; reconnecting automatically.');
      } else if (message.command === 'archiveAttentionWorkspace') {
        const root = model?.forest.find(item => item.id === message.runKey);
        if (root && window.agentobsSelectors.flatten([root]).some(agent => agent.needsAttention && !agent.archived)) {
          saved.manuallyCompleted[root.id] = activitySignature(root); persist(); emit();
        }
      } else if (message.command === 'restoreAttentionWorkspace') {
        delete saved.manuallyCompleted[message.runKey]; persist(); emit();
      } else if (message.command === 'refresh') refresh();
      else if (message.command === 'selectAgent') { selected = message.agentKey; emit(true); }
      else if (message.command === 'closeInspector') { selected = undefined; emit(true); }
      else if (message.command === 'toggleDensity') { compact = !compact; persist(); emit(); }
    }
  };
  window.addEventListener('pagehide', () => { source?.close(); clearInterval(freshnessTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
