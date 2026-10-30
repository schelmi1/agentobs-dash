(() => {
  'use strict';
  const host = window.agentobsHost;
  const app = document.getElementById('app');
  const saved = window.agentobsPreferences.normalizePreferences(host.getState());
  const { element, button, reconcile } = window.agentobsDom;
  const { flatten, hasLive, historyGroupFor, completedBranch, allSubagentsCompleted, subagentGroups, filterTree, familyTokenUsage } = window.agentobsSelectors;
  const tokenFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const tokenCount = value => Number.isFinite(value) ? tokenFormatter.format(value).toLowerCase() : '—';
  const { themes, colors, normalizeAppearance, applyAppearance, createPicker } = window.agentobsThemes;
  const savedInspectorWidth = Number.isFinite(saved.inspectorWidth) && saved.inspectorWidth >= 220 && saved.inspectorWidth <= 480 ? Math.round(saved.inspectorWidth) : undefined;
  const ui = { search: saved.search || '', runKey: saved.runKey || '', attentionOnly: Boolean(saved.attentionOnly), collapsed: new Set(saved.collapsed || []), expandedCompleted: new Set(saved.expandedCompleted || []), shownCompleted: new Set(saved.shownCompleted || []), modernExpandedCompleted: new Set(saved.modernExpandedCompleted || []), inspectorWidth: savedInspectorWidth, ...normalizeAppearance(saved), modernWorkspaceArrangement: saved.modernWorkspaceArrangement, modernSwarm: saved.modernSwarm, modernHideCompletedRuns: new Set(saved.modernHideCompletedRuns || []), modernWorkspaceSizes: saved.modernWorkspaceSizes || {}, selected: undefined };
  const labels = { working: 'Working', tool: 'Running tool', input: 'Needs input', starting: 'Starting', quiet: 'Quiet', failed: 'Failed', interrupted: 'Interrupted', completed: 'Completed', unknown: 'Unknown' };
  let state;
  let lastHostSelection;
  const persist = () => host.setState({ search: ui.search, runKey: ui.runKey, attentionOnly: ui.attentionOnly, collapsed: [...ui.collapsed], expandedCompleted: [...ui.expandedCompleted], shownCompleted: [...ui.shownCompleted], modernExpandedCompleted: [...ui.modernExpandedCompleted], inspectorWidth: ui.inspectorWidth, modernWorkspaceArrangement: ui.modernWorkspaceArrangement, modernSwarm: ui.modernSwarm, modernHideCompletedRuns: [...ui.modernHideCompletedRuns], modernWorkspaceSizes: ui.modernWorkspaceSizes, design: ui.design, theme: ui.theme, colors: ui.colors });
  const badge = (agent) => element('span', 'status status-' + agent.displayState, labels[agent.displayState]);
  const welcomePreview = () => {
    const welcome = element('section', 'empty empty-welcome', undefined, 'welcome');
    welcome.append(element('strong', '', 'Ready when your agents are.'),
      element('p', '', 'Start a supported coding agent in the monitored root or any folder beneath it. Recorded activity will appear here automatically.'),
      element('p', '', 'No sessions found? Check Transcript sources in the bottom panel, or configure a session store with --sessions.'));
    return welcome;
  };

  const heading = element('header', 'heading');
  const headingText = element('div');
  const title = element('h2', '', 'Agent activity');
  headingText.append(title);
  const version = element('span', 'version');
  heading.append(headingText);
  document.querySelector('.footer-info').append(version);
  const summary = element('div', 'summary');
  summary.setAttribute('aria-label', 'Agent status summary');
  const toolbar = element('div', 'toolbar'); toolbar.id = 'activity-filters';
  const filtersToggle = button('Filters', 'filters-toggle', () => {
    const open = activityControls.dataset.filtersOpen !== 'true';
    activityControls.dataset.filtersOpen = String(open); filtersToggle.setAttribute('aria-expanded', String(open));
    renderContent();
  });
  filtersToggle.setAttribute('aria-controls', 'activity-filters'); filtersToggle.setAttribute('aria-expanded', 'false');
  filtersToggle.setAttribute('aria-label', 'Filters');
  heading.append(filtersToggle);
  const runLabel = element('label', 'run-control');
  runLabel.append(element('span', 'sr-only', 'Filter by run'));
  const runSelect = element('select');
  runSelect.onchange = () => { ui.runKey = runSelect.value; persist(); renderContent(); };
  runLabel.append(runSelect);
  const searchLabel = element('label', 'search-control');
  searchLabel.append(element('span', 'sr-only', 'Search tasks and agents'));
  const search = element('input'); search.type = 'search'; search.placeholder = 'Search tasks or agents…'; search.value = ui.search;
  search.oninput = () => { ui.search = search.value; persist(); renderContent(); };
  searchLabel.append(search);
  const attentionButton = button('Needs attention', 'toolbar-button', () => { ui.attentionOnly = !ui.attentionOnly; persist(); renderContent(); });
  const pickers = [['theme', themes], ['colors', colors]].map(([axis, entries]) =>
    createPicker(axis, entries, ui[axis], next => { ui[axis] = next; applyStyle(); persist(); renderContent(); }));
  const refreshButton = button('Refresh', 'toolbar-button sidebar-refresh', () => host.postMessage({ command: 'refresh' }));
  refreshButton.setAttribute('aria-label', 'Refresh');
  const applyStyle = () => {
    applyAppearance(document.documentElement, ui);
    app.dataset.agentMapTheme = ui.theme;
    ['theme', 'colors'].forEach((axis, index) => pickers[index].update(ui[axis]));
    syncHeaderSettings();
    if (state) { placeActivityControls(); syncModernChrome(); }
  };
  toolbar.append(runLabel, searchLabel, attentionButton);
  const headerSettings = element('div', 'header-settings'); headerSettings.id = 'dashboard-settings';
  headerSettings.setAttribute('role', 'toolbar'); headerSettings.setAttribute('aria-label', 'Appearance');
  headerSettings.append(...pickers.map(picker => picker.element));
  const sidebarActions = element('div', 'sidebar-actions');
  const settingsButton = document.getElementById('settings-open');
  settingsButton.setAttribute('aria-label', 'Settings');
  sidebarActions.append(refreshButton, settingsButton);
  const header = document.querySelector('.dashboard-header');
  const statsToggle = button('Stats', 'header-stats-toggle', () => {
    const open = header.dataset.statsOpen !== 'true'; header.dataset.statsOpen = String(open); statsToggle.setAttribute('aria-expanded', String(open)); renderContent();
  });
  statsToggle.setAttribute('aria-controls', 'mission-overview'); statsToggle.setAttribute('aria-expanded', 'false');
  function syncHeaderSettings() {
    headerSettings.removeAttribute('popover');
  }
  document.getElementById('topbar-actions').prepend(statsToggle, headerSettings, sidebarActions);
  applyStyle();
  document.querySelector('.overview').id = 'mission-overview';
  const layout = element('div', 'map-layout');
  const map = element('section', 'map-content'); map.setAttribute('aria-label', 'Agent hierarchy');
  const inspectorResizer = element('div', 'inspector-resizer'); inspectorResizer.hidden = true; inspectorResizer.tabIndex = 0; inspectorResizer.setAttribute('role', 'separator'); inspectorResizer.setAttribute('aria-orientation', 'vertical'); inspectorResizer.setAttribute('aria-label', 'Resize agent details');
  const inspector = element('aside', 'inspector'); inspector.hidden = true; inspector.setAttribute('aria-label', 'Selected agent details');
  layout.append(map, inspectorResizer, inspector);
  const activityControls = element('section', 'activity-controls');
  activityControls.setAttribute('aria-label', 'Agent activity controls');
  const attentionQueue = element('details', 'attention-queue');
  attentionQueue.hidden = true;
  activityControls.append(heading, summary, attentionQueue, toolbar);
  app.append(activityControls, layout);
  const placeActivityControls = () => {
    const focused = document.activeElement;
    app.prepend(activityControls);
    if (activityControls.contains(focused)) focused.focus({ preventScroll: true });
  };
  placeActivityControls();
  const modernDesktop = matchMedia('all');
  const headerInner = document.querySelector('.header-inner');
  const modernNavigation = element('nav', 'modern-navigation'); modernNavigation.setAttribute('aria-label', 'Workspace navigation');
  const navTitle = element('span', 'modern-nav-heading', 'EXPLORE');
  const navItem = (icon, title, action) => {
    const control = button('', 'modern-nav-item', action);
    const glyph = element('span', 'modern-nav-icon', icon); glyph.setAttribute('aria-hidden', 'true');
    const label = element('span', 'modern-nav-label', title);
    const count = element('span', 'modern-nav-count'); count.setAttribute('aria-hidden', 'true');
    control.append(glyph, label, count); return control;
  };
  const navLive = navItem('◈', 'Agent network', () => map.scrollIntoView({ block: 'start' }));
  navLive.classList.add('is-current'); navLive.setAttribute('aria-current', 'page');
  const navAttention = navItem('◉', 'Needs attention', () => {
    if (attentionQueue.hidden) return;
    attentionQueue.open = true; attentionQueue.scrollIntoView({ block: 'nearest' }); attentionQueue.querySelector('summary')?.focus({ preventScroll: true });
  });
  const navHistory = navItem('◷', 'History', () => {
    const section = map.querySelector('.run-history');
    if (!section) return;
    const group = ['quiet', 'completed', 'inactive'].find(key => section.classList.contains(key + '-history'));
    if (group) { openHistory.add(group); renderContent(); }
    const target = map.querySelector('.run-history');
    if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); target.querySelector('summary')?.focus({ preventScroll: true }); }
  });
  modernNavigation.append(navTitle, navLive, navAttention, navHistory); headerInner.append(modernNavigation);
  function syncModernChrome() {
    const useRail = ui.design === 'modern' && modernDesktop.matches;
    modernNavigation.hidden = !useRail;
  }
  modernDesktop.addEventListener('change', syncModernChrome);
  syncModernChrome();

  const inspectorWidthLimits = () => ({ min: 220, max: Math.max(220, Math.min(480, Math.floor(layout.clientWidth - 364))) });
  const syncInspectorResizer = () => {
    if (inspectorResizer.hidden) return;
    const { min, max } = inspectorWidthLimits();
    inspectorResizer.setAttribute('aria-valuemin', String(min));
    inspectorResizer.setAttribute('aria-valuemax', String(max));
    inspectorResizer.setAttribute('aria-valuenow', String(Math.round(inspector.getBoundingClientRect().width)));
  };
  const setInspectorWidth = (width) => {
    const { min, max } = inspectorWidthLimits();
    ui.inspectorWidth = Math.min(max, Math.max(min, Math.round(width)));
    layout.style.setProperty('--inspector-width', ui.inspectorWidth + 'px');
    syncInspectorResizer();
  };
  if (ui.inspectorWidth) layout.style.setProperty('--inspector-width', ui.inspectorWidth + 'px');
  let resizeStart;
  inspectorResizer.onpointerdown = (event) => {
    if (event.button !== 0 || window.matchMedia('(max-width: 760px)').matches) return;
    resizeStart = { pointerId: event.pointerId, x: event.clientX, width: inspector.getBoundingClientRect().width };
    inspectorResizer.setPointerCapture?.(event.pointerId);
    document.body.classList.add('is-resizing');
    event.preventDefault();
  };
  inspectorResizer.onpointermove = (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    setInspectorWidth(resizeStart.width - (event.clientX - resizeStart.x));
  };
  const finishResize = (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    resizeStart = undefined;
    document.body.classList.remove('is-resizing');
    persist();
  };
  inspectorResizer.onpointerup = finishResize;
  inspectorResizer.onpointercancel = finishResize;
  inspectorResizer.onkeydown = (event) => {
    if (window.matchMedia('(max-width: 760px)').matches) return;
    const { min, max } = inspectorWidthLimits();
    const current = inspector.getBoundingClientRect().width;
    const next = event.key === 'ArrowLeft' ? current + 20 : event.key === 'ArrowRight' ? current - 20 : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (next === undefined) return;
    setInspectorWidth(next); persist(); event.preventDefault();
  };
  window.addEventListener('resize', syncInspectorResizer);

  let keyboardSelection = false;
  map.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && event.target.closest('.agent')) keyboardSelection = true; }, true);
  const inspectorController = window.agentobsInspector.createController({ inspector, map, resizer: inspectorResizer,
    background: [document.querySelector('.dashboard-header'), activityControls, map, document.querySelector('.dashboard-footer')], onClose: () => closeInspector() });
  const selectAgent = (id, opener) => {
    inspectorController.opening(opener || [...map.querySelectorAll('.agent')].find(card => card.dataset.key === id), keyboardSelection);
    keyboardSelection = false;
    host.postMessage({ command: 'selectAgent', agentKey: id });
  };
  const closeInspector = () => {
    host.postMessage({ command: 'closeInspector' }); inspectorController.restoreFocus();
  };
  const { renderInspector: renderInspectorView } = window.agentobsViews.createViews({ getState: () => state, getUi: () => ui, actions: { closeInspector }, elements: { inspector, inspectorResizer, layout }, labels, badge, syncInspectorResizer });
  const renderInspector = () => { renderInspectorView(); inspectorController.sync(); };
  const openHistory = new Set();
  const liveOrder = new Map();
  let nextLiveSlot = 0;
  // Keep a row for each agent for the lifetime of a run. Appending a new
  // delegation must not move the rest of the graph under the user's pointer.
  const modernSlots = new Map();
  const modernCollapsed = new Set();
  const modernCallsPage = new Map();
  const modernToolScopes = new Map();
  const modernToolAgents = new Map();
  const modernExpandedLarge = new Set();
  const modernRunsCollapsed = new Set();
  const modernZoom = new Map();
  const modernSwarmZoom = new Map();
  const modernReflowTimers = new Map();
  const modernPhone = matchMedia('(max-width: 600px)');
  let modernGesture, suppressModernClick = false;
  const modernPointer = (viewport, event) => {
    const box = viewport.getBoundingClientRect(), left = box.left + viewport.clientLeft, top = box.top + viewport.clientTop;
    return { x: Math.max(left, Math.min(left + viewport.clientWidth, event.clientX)), y: Math.max(top, Math.min(top + viewport.clientHeight, event.clientY)) };
  };
  const setModernZoom = (viewport, next, x, y) => {
    const graph = viewport.querySelector('.modern-graph'), space = viewport.querySelector('.modern-graph-space');
    const zooms = viewport.dataset.swarm === 'true' ? modernSwarmZoom : modernZoom;
    const current = zooms.get(viewport.dataset.run) ?? 1, bounds = graph.getBoundingClientRect();
    next = Math.max(.001, Math.min(4, next));
    const pointX = (x - bounds.left) / current, pointY = (y - bounds.top) / current;
    zooms.set(viewport.dataset.run, next);
    space.style.width = parseFloat(graph.style.width) * next + 'px'; space.style.height = parseFloat(graph.style.height) * next + 'px';
    graph.style.transform = `scale(${next})`;
    if (viewport.dataset.swarm === 'true') viewport.style.setProperty('--swarm-zoom', String(next));
    const after = graph.getBoundingClientRect();
    viewport.scrollLeft += after.left + pointX * next - x; viewport.scrollTop += after.top + pointY * next - y;
    if (viewport.dataset.swarm !== 'true') {
      clearTimeout(modernReflowTimers.get(viewport.dataset.run));
      modernReflowTimers.set(viewport.dataset.run, setTimeout(() => {
        modernReflowTimers.delete(viewport.dataset.run);
        if (ui.design !== 'modern' || !viewport.isConnected) return;
        if (Number(viewport.dataset.columns) !== modernColumnsFor(Number(viewport.dataset.runCount), viewport.dataset.run, viewport.dataset.largeCards === 'true')) renderContent();
      }, 100));
    }
  };
  const fitModern = viewport => {
    const graph = viewport.querySelector('.modern-graph');
    if (!graph || !viewport.clientWidth || !viewport.clientHeight) return;
    const width = parseFloat(graph.style.width), height = parseFloat(graph.style.height);
    if (!(width > 0 && height > 0)) return;
    const bounds = viewport.getBoundingClientRect();
    const fit = Math.min(1, Math.max(1, viewport.clientWidth - 32) / width, Math.max(1, viewport.clientHeight - 32) / height);
    const zoom = viewport.dataset.largeCards === 'true' ? 1 : fit;
    setModernZoom(viewport, zoom, bounds.left + viewport.clientWidth / 2, bounds.top + viewport.clientHeight / 2);
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
  };
  map.addEventListener('dblclick', event => {
    const viewport = event.target.closest?.('.modern-graph-viewport');
    if (!viewport || event.target.closest?.('button, a, input, select, textarea')) return;
    const bounds = viewport.getBoundingClientRect();
    setModernZoom(viewport, 1, bounds.left + viewport.clientWidth / 2, bounds.top + viewport.clientHeight / 2);
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
    event.preventDefault();
  });
  map.addEventListener('wheel', event => {
    if (ui.design !== 'modern' || !event.altKey || !event.deltaY || !Number.isFinite(event.deltaY)) return;
    const viewport = event.target.closest?.('.modern-graph-viewport'); if (!viewport) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    const zooms = viewport.dataset.swarm === 'true' ? modernSwarmZoom : modernZoom;
    setModernZoom(viewport, (zooms.get(viewport.dataset.run) ?? 1) * Math.exp(-delta * .002), event.clientX, event.clientY);
  }, { passive: false });
  const resizeModernTools = (id, view, panel, graphHeight, toolHeight, desired) => {
    const total = Math.max(270, graphHeight + toolHeight);
    const min = Math.max(70, total - 1400), max = Math.min(1000, total - 200);
    const next = Math.round(Math.max(min, Math.min(max, desired)));
    const height = Math.round(total - next);
    ui.modernWorkspaceSizes[id] = { ...(ui.modernWorkspaceSizes[id] || {}), height, toolHeight: next };
    view.style.height = height + 'px'; view.style.maxHeight = 'none';
    panel.style.height = next + 'px'; panel.dataset.resized = 'true';
  };
  map.addEventListener('pointerdown', event => {
    if (ui.design !== 'modern') return;
    suppressModernClick = false;
    const handle = event.target.closest?.('.modern-resize'), toolsHandle = event.target.closest?.('.modern-tools-resize'), viewport = event.target.closest?.('.modern-graph-viewport');
    if (toolsHandle && event.button === 0) {
      const panel = toolsHandle.closest('.modern-run'), view = panel.querySelector('.modern-graph-viewport'), tools = panel.querySelector('.modern-tools-panel');
      modernGesture = { mode: 'tools-resize', id: panel.dataset.run, pointerId: event.pointerId, y: event.clientY, graphHeight: view.clientHeight, toolHeight: tools.getBoundingClientRect().height, view, tools };
    } else if (handle && event.button === 0) {
      const panel = handle.closest('.modern-run'), view = panel.querySelector('.modern-graph-viewport');
      modernGesture = { mode: 'resize', id: panel.dataset.run, pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: panel.getBoundingClientRect().width, height: view.clientHeight, boardWidth: panel.parentElement.clientWidth, panel, view };
    } else if (viewport && event.button === 1 && event.pointerType === 'mouse') {
      modernGesture = { mode: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, viewport };
    } else if (viewport && event.button === 0 && event.pointerType === 'mouse') {
      const start = modernPointer(viewport, event);
      if (start.x !== event.clientX || start.y !== event.clientY) return;
      modernGesture = { mode: 'box', pointerId: event.pointerId, start, end: start, viewport, active: false };
      return;
    } else return;
    event.preventDefault(); map.setPointerCapture(event.pointerId); document.body.classList.add(modernGesture.mode === 'tools-resize' ? 'is-modern-tools-resizing' : 'is-graph-panning');
  });
  window.addEventListener('pointermove', event => {
    const g = modernGesture; if (!g || event.pointerId !== g.pointerId) return;
    if (!(event.buttons & (g.mode === 'pan' ? 4 : 1))) return;
    if (g.mode === 'box') {
      if (!g.viewport.isConnected) { endModernGesture(); return; }
      g.end = modernPointer(g.viewport, event);
      if (!g.active && Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) < 6) return;
      event.preventDefault();
      if (!g.active) {
        g.active = true; map.setPointerCapture(event.pointerId);
        g.overlay = element('div', 'graph-selection-box'); g.overlay.setAttribute('aria-hidden', 'true');
        document.body.append(g.overlay); document.body.classList.add('is-graph-selecting');
      }
      Object.assign(g.overlay.style, { left: Math.min(g.start.x, g.end.x) + 'px', top: Math.min(g.start.y, g.end.y) + 'px', width: Math.abs(g.end.x - g.start.x) + 'px', height: Math.abs(g.end.y - g.start.y) + 'px' });
      return;
    }
    event.preventDefault();
    if (g.mode === 'pan') { g.viewport.scrollLeft = g.left - (event.clientX - g.x); g.viewport.scrollTop = g.top - (event.clientY - g.y); }
    else if (g.mode === 'tools-resize') resizeModernTools(g.id, g.view, g.tools, g.graphHeight, g.toolHeight, g.toolHeight - (event.clientY - g.y));
    else {
      const previous = ui.modernWorkspaceSizes[g.id] || {};
      const span = g.boardWidth < 680 ? previous.span : Math.max(3, Math.min(12, Math.round((g.width + event.clientX - g.x + 20) / (g.boardWidth + 20) * 12)));
      const height = Math.max(200, Math.min(1400, Math.round(g.height + event.clientY - g.y)));
      ui.modernWorkspaceSizes[g.id] = { ...previous, ...(span ? { span } : {}), height };
      if (span) { g.panel.style.setProperty('--modern-span', span); g.panel.dataset.span = span; }
      g.view.style.height = height + 'px'; g.view.style.maxHeight = 'none';
    }
  }, { passive: false });
  const endModernGesture = () => {
    const g = modernGesture; if (!g) return; modernGesture = undefined;
    g.overlay?.remove(); document.body.classList.remove('is-graph-panning', 'is-graph-selecting', 'is-modern-tools-resizing'); if (map.hasPointerCapture(g.pointerId)) map.releasePointerCapture(g.pointerId);
    if (g.mode === 'box' && g.active) suppressModernClick = true;
    if (g.mode === 'resize' || g.mode === 'tools-resize') { persist(); renderContent(); }
    return g;
  };
  window.addEventListener('pointerup', event => {
    if (modernGesture?.pointerId !== event.pointerId) return;
    if (modernGesture.mode === 'box') modernGesture.end = modernPointer(modernGesture.viewport, event);
    const g = endModernGesture();
    if (g.mode !== 'box' || !g.active || !g.viewport.isConnected) return;
    const width = Math.abs(g.end.x - g.start.x), height = Math.abs(g.end.y - g.start.y);
    if (width < 4 || height < 4) return;
    const viewport = g.viewport, graph = viewport.querySelector('.modern-graph');
    if (!graph) return;
    const zooms = viewport.dataset.swarm === 'true' ? modernSwarmZoom : modernZoom;
    const current = zooms.get(viewport.dataset.run) ?? 1;
    const x = (g.start.x + g.end.x) / 2, y = (g.start.y + g.end.y) / 2;
    const before = graph.getBoundingClientRect();
    const point = { x: (x - before.left) / current, y: (y - before.top) / current };
    const fit = () => Math.max(current, current * Math.min((viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height));
    setModernZoom(viewport, fit(), x, y);
    // Recalculate after scrollbars appear, then center the selected area.
    setModernZoom(viewport, fit(), x, y);
    const bounds = viewport.getBoundingClientRect(), after = graph.getBoundingClientRect(), next = zooms.get(viewport.dataset.run);
    viewport.scrollLeft += after.left + point.x * next - bounds.left - viewport.clientLeft - viewport.clientWidth / 2;
    viewport.scrollTop += after.top + point.y * next - bounds.top - viewport.clientTop - viewport.clientHeight / 2;
  }, { capture: true });
  window.addEventListener('pointercancel', endModernGesture); window.addEventListener('blur', endModernGesture);
  map.addEventListener('lostpointercapture', event => { if (modernGesture?.pointerId === event.pointerId) endModernGesture(); });
  map.addEventListener('click', event => { if (suppressModernClick) { suppressModernClick = false; event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && modernGesture?.mode === 'box') { event.preventDefault(); endModernGesture(); } }, true);
  map.addEventListener('auxclick', event => { if (ui.design === 'modern' && event.button === 1 && event.target.closest?.('.modern-graph-viewport')) event.preventDefault(); });
  map.addEventListener('keydown', event => {
    const viewport = event.target.closest?.('.modern-graph-viewport');
    if (ui.design !== 'modern' || !viewport || event.target !== viewport || !['+', '=', '-', '0'].includes(event.key)) return;
    const bounds = viewport.getBoundingClientRect(), zooms = viewport.dataset.swarm === 'true' ? modernSwarmZoom : modernZoom, current = zooms.get(viewport.dataset.run) ?? 1;
    setModernZoom(viewport, event.key === '0' ? 1 : current * (event.key === '-' ? .8 : 1.25), bounds.left + viewport.clientWidth / 2, bounds.top + viewport.clientHeight / 2); event.preventDefault();
  });
  const swarmPreview = element('div', 'modern-swarm-preview');
  swarmPreview.hidden = true; swarmPreview.setAttribute('aria-hidden', 'true'); document.body.append(swarmPreview);
  let previewNode;
  const hideSwarmPreview = () => {
    previewNode?.closest('.modern-graph-viewport')?.querySelectorAll('.modern-links .is-hovered').forEach(line => line.classList.remove('is-hovered'));
    previewNode = undefined; swarmPreview.hidden = true; swarmPreview.replaceChildren();
  };
  const showSwarmPreview = node => {
    if (!ui.modernSwarm || !node?.isConnected || !node.closest('.modern-graph-viewport[data-swarm="true"]')) { hideSwarmPreview(); return; }
    if (previewNode !== node) hideSwarmPreview();
    previewNode = node;
    node.closest('.modern-graph-viewport').querySelectorAll('.modern-links path').forEach(line => line.classList.toggle('is-hovered', line.dataset.parentId === node.dataset.key || line.dataset.childId === node.dataset.key));
    const statusClass = [...node.classList].find(name => name.startsWith('agent-')) || '';
    const preview = element('div', 'modern-preview-card ' + statusClass);
    preview.append(...[...node.children].map(child => child.cloneNode(true))); swarmPreview.replaceChildren(preview); swarmPreview.hidden = false;
    const anchor = node.getBoundingClientRect(), box = swarmPreview.getBoundingClientRect(), gap = 10;
    const left = anchor.right + gap + box.width <= innerWidth - 8 ? anchor.right + gap : anchor.left - gap - box.width;
    swarmPreview.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, left)) + 'px';
    swarmPreview.style.top = Math.max(8, Math.min(innerHeight - box.height - 8, anchor.top - box.height / 2 + anchor.height / 2)) + 'px';
  };
  map.addEventListener('pointerover', event => { const node = event.target.closest?.('.modern-swarm-node'); if (node) showSwarmPreview(node); });
  map.addEventListener('pointerout', event => { if (previewNode && event.target.closest?.('.modern-swarm-node') === previewNode && !previewNode.contains(event.relatedTarget)) hideSwarmPreview(); });
  map.addEventListener('focusin', event => { const node = event.target.closest?.('.modern-swarm-node'); if (node) showSwarmPreview(node); });
  map.addEventListener('focusout', event => { if (previewNode && event.target === previewNode) hideSwarmPreview(); });
  window.addEventListener('scroll', hideSwarmPreview, true); window.addEventListener('resize', hideSwarmPreview);
  let modernGraphIsCompact = false;
  const modernWidthFor = (count, id) => {
    const available = map.clientWidth, mode = ui.modernWorkspaceArrangement;
    const columns = available <= 679 || mode === 'column' ? 1 : mode === 'grid' ? 2 : available <= 1099 ? Math.min(2, count) : Math.min(4, count);
    const span = ui.modernWorkspaceSizes[id]?.span;
    return span && available > 679 ? (available + 20) * Math.max(available < 1100 ? 6 : 3, span) / 12 - 20 : (available - Math.max(0, columns - 1) * 20) / Math.max(1, columns);
  };
  const modernCompactFor = (count, id) => modernPhone.matches || modernWidthFor(count, id) < 620;
  const modernColumnsFor = (count, id, largeCards = false) => {
    const width = modernWidthFor(count, id);
    const scale = Math.min(1, modernZoom.get(id) ?? 1);
    const pitch = largeCards ? 360 : 328;
    return width / scale >= 900 ? Math.min(largeCards ? 32 : 8, Math.max(2, Math.floor((width / scale - 72) / pitch))) : 0;
  };
  modernPhone.addEventListener('change', () => { if (state && ui.design === 'modern') renderContent(); });
  const createModern = (roots, historyGroup, showControls = true) => {
    const board = element('div', 'modern-board' + (historyGroup ? ' modern-history-board' : ''), undefined, historyGroup ? 'modern-board:' + historyGroup : 'modern-board');
    const intro = element('header', 'modern-intro');
    const introCopy = element('div', 'modern-intro-copy');
    introCopy.append(element('h2', '', 'Agent network'));
    intro.append(introCopy);
    const arrangement = element('div', 'modern-arrangement', undefined, 'modern-arrangement');
    arrangement.setAttribute('role', 'group'); arrangement.setAttribute('aria-label', 'Arrange Modern workspaces');
    arrangement.setAttribute('aria-description', 'The selected arrangement is saved. Workspaces stack when there is not enough room.');
    arrangement.append(element('span', 'modern-arrangement-label', 'Workspaces'));
    for (const [mode, label] of [['row', 'Row'], ['column', 'Column'], ['grid', 'Grid']]) {
      const control = button(label, 'toolbar-button modern-arrangement-button', () => { ui.modernWorkspaceArrangement = mode; for (const size of Object.values(ui.modernWorkspaceSizes)) delete size.span; persist(); renderContent(); });
      control.setAttribute('aria-pressed', String(ui.modernWorkspaceArrangement === mode));
      control.title = mode === 'row' ? 'Arrange up to four workspaces across' : mode === 'grid' ? 'Arrange workspaces in two columns' : 'Stack full-width workspaces';
      arrangement.append(control);
    }
    const fitWorkspaces = button('Fit', 'toolbar-button modern-arrangement-button modern-fit-workspaces', () => {
      ui.modernWorkspaceSizes = {};
      persist(); renderContent();
    });
    fitWorkspaces.setAttribute('aria-label', 'Fit all workspaces');
    fitWorkspaces.title = 'Reset workspace sizes to fit the selected arrangement';
    arrangement.append(fitWorkspaces);
    const swarmToggle = button('Compact', 'toolbar-button modern-arrangement-button modern-swarm-toggle', () => { ui.modernSwarm = !ui.modernSwarm; hideSwarmPreview(); persist(); renderContent(); });
    swarmToggle.setAttribute('aria-pressed', String(ui.modernSwarm));
    swarmToggle.setAttribute('aria-description', 'Show agents as a compact status network; hover or focus a node for its card.');
    swarmToggle.title = 'Show the compact agent network'; arrangement.append(swarmToggle);
    intro.append(arrangement); if (showControls) board.append(intro);
    const runs = element('div', 'modern-runs', undefined, 'modern-runs');
    runs.dataset.arrangement = ui.modernWorkspaceArrangement;
    runs.style.setProperty('--modern-columns', String(Math.min(4, Math.max(1, roots.length))));
    for (const root of roots) {
      modernGraphIsCompact = modernCompactFor(roots.length, root.id);
      const family = flatten([root]);
      const hideCompletedAgents = ui.modernHideCompletedRuns.has(root.id);
      const largeCards = !ui.modernSwarm && family.length >= 300;
      const nodeHeight = largeCards ? 204 : state.compactDensity ? 136 : 164;
      const rowPitch = nodeHeight + 28;
      const horizontalColumns = modernColumnsFor(roots.length, root.id, largeCards);
      const needsAttention = family.filter(agent => agent.needsAttention).length;
      const run = element('section', 'modern-run', undefined, 'modern:' + root.id);
      run.dataset.run = root.id;
      const workspaceSize = ui.modernWorkspaceSizes[root.id];
      if (workspaceSize?.span) { run.dataset.span = String(workspaceSize.span); run.style.setProperty('--modern-span', workspaceSize.span); }
      run.setAttribute('aria-label', 'Run ' + root.title);
      const header = element('header', 'modern-run-header');
      const heading = element('div', 'modern-run-heading');
      const providerLabel = element('span', 'modern-eyebrow modern-provider-label', (root.providerLabel || 'CODEX').toUpperCase());
      providerLabel.dataset.provider = root.provider || 'codex';
      heading.append(providerLabel, element('h3', '', root.title), element('span', 'modern-workspace', root.cwd));
      const totals = element('div', 'modern-workspace-totals');
      totals.setAttribute('aria-label', 'Run token usage including all subagents');
      const usage = familyTokenUsage(state.agents[root.id] || root);
      for (const [field, label] of [['input', 'IN'], ['cachedInput', 'CACHED'], ['output', 'OUT']]) {
        const total = element('span', 'modern-workspace-token'); total.dataset.tokenField = field;
        total.append(element('span', 'modern-workspace-token-label', label), element('strong', '', tokenCount(usage[field])));
        total.title = Number.isFinite(usage[field]) ? usage[field].toLocaleString('en') + ' ' + label.toLowerCase() + ' tokens, including all subagents' : 'No ' + label.toLowerCase() + ' token counts recorded';
        totals.append(total);
      }
      heading.append(totals);
      const runInfo = element('div', 'modern-run-info');
      if (historyGroup) runInfo.append(element('span', 'modern-history-state', historyGroup === 'completed' ? 'Completed' : historyGroup === 'inactive' ? 'Inactive' : 'Quiet'));
      runInfo.append(element('span', 'modern-run-count', family.length + ' agent' + (family.length === 1 ? '' : 's')),
        element('span', needsAttention ? 'modern-attention' : 'modern-clear', needsAttention ? needsAttention + ' need attention' : 'No attention needed'));
      const runCollapsed = modernRunsCollapsed.has(root.id);
      const runToggle = button(runCollapsed ? 'Open run ▾' : 'Collapse run ▴', 'modern-run-toggle', () => {
        if (runCollapsed) modernRunsCollapsed.delete(root.id); else modernRunsCollapsed.add(root.id);
        renderContent();
      });
      runToggle.dataset.key = 'modern-run-toggle:' + root.id;
      runToggle.setAttribute('aria-label', (runCollapsed ? 'Expand run ' : 'Collapse run ') + root.title);
      runToggle.setAttribute('aria-expanded', String(!runCollapsed));
      if (!runCollapsed) {
        if (ui.modernSwarm) {
          const hideCompleted = button('Hide completed agents', 'toolbar-button modern-hide-completed', () => {
            if (ui.modernHideCompletedRuns.has(root.id)) ui.modernHideCompletedRuns.delete(root.id); else ui.modernHideCompletedRuns.add(root.id);
            hideSwarmPreview(); persist(); renderContent();
          });
          hideCompleted.setAttribute('aria-pressed', String(hideCompletedAgents));
          hideCompleted.setAttribute('aria-label', 'Hide completed agents in ' + root.title);
          hideCompleted.title = 'Hide completed agents in this workspace; retain ancestors of unfinished agents';
          runInfo.append(hideCompleted);
        }
        const fit = button('Fit', 'toolbar-button modern-fit', event => {
          const panel = event.currentTarget.closest('.modern-run');
          if (largeCards) {
            for (const agent of family) modernExpandedLarge.delete(agent.id);
            modernCollapsed.delete(root.id); renderContent();
          }
          const view = panel.querySelector('.modern-graph-viewport');
          if (view) fitModern(view);
        });
        fit.setAttribute('aria-label', 'Fit agents in ' + root.title);
        fit.title = largeCards ? 'Return to a readable overview and collapse expanded branches' : 'Fit the visible agent network in this workspace'; runInfo.append(fit);
      }
      runInfo.append(runToggle);
      header.append(heading, runInfo); run.append(header);
      if (runCollapsed) { runs.append(run); continue; }
      const graphHeader = element('div', 'modern-graph-header');
      const graphInfo = element('span', '', family.length + ' agent' + (family.length === 1 ? '' : 's') + (ui.modernSwarm ? ' · hover or focus a node for details · ' : ' · ') + 'drag to zoom · middle-drag to pan · Alt + wheel to zoom · double-click to reset');
      graphHeader.append(element('span', '', ui.modernSwarm ? 'COMPACT NETWORK' : 'DELEGATION NETWORK'), graphInfo);
      run.append(graphHeader);
      if (ui.modernSwarm) {
        const legend = element('div', 'modern-swarm-legend'); legend.setAttribute('aria-label', 'Agent activity and status key');
        for (const [status, label] of [['tool', 'Current tool color'], ['working', 'Thinking'], ['input', 'Needs input / starting'], ['failed', 'Failed / interrupted'], ['completed', 'Completed'], ['other', 'Other']]) {
          const entry = element('span', 'modern-swarm-key'); entry.append(element('span', 'modern-swarm-symbol is-' + status), document.createTextNode(label)); legend.append(entry);
        }
        const levels = element('span', 'modern-swarm-level-key');
        levels.setAttribute('aria-label', 'Node size indicates delegation level: main, level 1, level 2 and deeper');
        for (const [level, label] of [['main', 'Main'], ['one', 'L1'], ['deep', 'L2+']]) {
          const entry = element('span', 'modern-swarm-level-entry');
          entry.append(element('span', 'modern-swarm-level-mark is-' + level), document.createTextNode(label)); levels.append(entry);
        }
        legend.append(levels);
        run.append(legend);
      }
      const viewport = element('div', 'modern-graph-viewport', undefined, 'graph:' + root.id);
      viewport.dataset.run = root.id;
      viewport.dataset.runCount = String(roots.length);
      if (workspaceSize?.height) { viewport.style.height = workspaceSize.height + 'px'; viewport.style.maxHeight = 'none'; }
      viewport.dataset.compact = String(modernGraphIsCompact);
      viewport.dataset.swarm = String(ui.modernSwarm);
      viewport.dataset.largeCards = String(largeCards);
      viewport.dataset.columns = String(horizontalColumns);
      viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Delegation network for ' + root.title + ', scroll to explore'); viewport.setAttribute('aria-description', 'Drag a box to zoom; middle-drag to pan; Alt and mouse wheel zooms around the pointer. Double-click the background or focus the graph and press zero to reset.');
      const graph = element('div', 'modern-graph');
      const list = element('ul', 'modern-list'); list.setAttribute('aria-label', 'Agents in ' + root.title);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('modern-links'); svg.setAttribute('aria-hidden', 'true');
      let slots = modernSlots.get(root.id);
      if (!slots) { slots = { rows: new Map(), next: 0, levels: new Map(), freeSerial: [], freeLevels: new Map() }; modernSlots.set(root.id, slots); }
      const releaseLevel = slot => {
        if (!slots.freeLevels.has(slot.depth)) slots.freeLevels.set(slot.depth, []);
        const free = slots.freeLevels.get(slot.depth); free.push(slot.row); free.sort((a, b) => a - b);
      };
      const fullFamily = new Set(flatten([state.agents[root.id] || root]).map(agent => agent.id));
      for (const [id, slot] of slots.rows) if (!fullFamily.has(id)) {
        slots.rows.delete(id); releaseLevel(slot); slots.freeSerial.push(slot.serial);
      }
      slots.freeSerial.sort((a, b) => a - b);
      const takeLevel = depth => {
        const free = slots.freeLevels.get(depth);
        if (free?.length) return free.shift();
        const next = slots.levels.get(depth) || 0; slots.levels.set(depth, next + 1); return next;
      };
      const filtering = Boolean(ui.search.trim() || ui.attentionOnly || ui.runKey);
      let maxDepth = 0, maxRow = 0, filteredRow = 0, filteredSerial = 0; const filteredLevels = new Map();
      const positions = [];
      const add = (agent, depth, parent) => {
        let slot = slots.rows.get(agent.id);
        if (!slot) { slot = { serial: slots.freeSerial.length ? slots.freeSerial.shift() : slots.next++, depth, row: takeLevel(depth) }; slots.rows.set(agent.id, slot); }
        else if (slot.depth !== depth) { releaseLevel(slot); slot.depth = depth; slot.row = takeLevel(depth); }
        const filteredLevel = filteredLevels.get(depth) || 0; filteredLevels.set(depth, filteredLevel + 1);
        const row = filtering ? (modernGraphIsCompact ? filteredRow++ : filteredLevel) : (modernGraphIsCompact ? slot.serial : slot.row);
        const position = modernGraphIsCompact ? { x: 16 + depth * 16, y: 24 + row * rowPitch } : { x: 28 + depth * 370, y: 28 + row * rowPitch };
        positions.push({ agent, depth, parent, row, serial: filtering ? filteredSerial++ : slot.serial, ...position }); maxDepth = Math.max(maxDepth, depth); maxRow = Math.max(maxRow, row);
        const autoCollapsed = largeCards && depth > 0 && !ui.search.trim() && !ui.attentionOnly && !modernExpandedLarge.has(agent.id);
        if (filtering && (!largeCards || ui.search.trim() || ui.attentionOnly) || !modernCollapsed.has(agent.id) && !autoCollapsed) {
          const groups = subagentGroups(agent, state.agents);
          const children = filtering || ui.modernSwarm || ui.modernExpandedCompleted.has(agent.id) ? agent.children : groups.active;
          for (const child of children) if (!(ui.modernSwarm && hideCompletedAgents && completedBranch(state.agents[child.id] || child))) add(child, depth + 1, { ...position, id: agent.id, name: agent.name || 'Agent' });
        }
      };
      if (!(ui.modernSwarm && hideCompletedAgents && completedBranch(state.agents[root.id] || root))) add(root, 0);
      if (largeCards) graphInfo.textContent = positions.length + ' of ' + family.length + ' agents shown · expand branches to explore · drag to zoom · middle-drag to pan · Alt + wheel to zoom · double-click to reset';
      if (ui.modernSwarm && hideCompletedAgents) graphInfo.textContent = positions.length + ' of ' + family.length + ' agents shown · hover or focus a node for details · drag to zoom · middle-drag to pan · Alt + wheel to zoom · double-click to reset';
      const byId = new Map(positions.map(position => [position.agent.id, position]));
      let width = modernGraphIsCompact ? 16 + maxDepth * 16 + 278 : 28 + (maxDepth + 1) * 370;
      let height = (modernGraphIsCompact ? 24 : 28) + maxRow * rowPitch + nodeHeight + 28;
      if (ui.modernSwarm) {
        // Reserve a 3×3 cell block for each L1 branch. Descendants use their
        // branch's cells before claiming another block, including when spawned
        // later; unrelated L1 agents cannot occupy that reserved space.
        if (!slots.swarmCells) slots.swarmCells = new Map();
        if (!slots.swarmBlocks) slots.swarmBlocks = new Map();
        if (!slots.swarmBranches) slots.swarmBranches = new Map();
        for (const id of slots.swarmCells.keys()) if (!fullFamily.has(id)) { slots.swarmCells.delete(id); slots.swarmBranches.delete(id); }
        for (const [key, owner] of slots.swarmBlocks) if (!fullFamily.has(owner)) slots.swarmBlocks.delete(key);
        const cells = filtering ? new Map() : slots.swarmCells;
        const blocks = filtering ? new Map() : slots.swarmBlocks;
        const branches = filtering ? new Map() : slots.swarmBranches;
        for (const position of positions) {
          position.branch = position.depth === 0 ? position.agent.id : position.depth === 1 ? position.agent.id : byId.get(position.parent.id).branch;
          if (branches.has(position.agent.id) && branches.get(position.agent.id) !== position.branch) cells.delete(position.agent.id);
          branches.set(position.agent.id, position.branch);
        }
        const occupied = new Set([...cells.values()].map(cell => cell.x + ',' + cell.y));
        const blockKey = (x, y) => x + ',' + y;
        const claimBlock = (owner, origin) => {
          const ox = Math.round(origin.x / 3), oy = Math.round(origin.y / 3);
          for (let ring = 0; ; ring++) {
            let best, distance = Infinity;
            for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
              const x = ox + dx, y = oy + dy, d = (x * 3 - origin.x) ** 2 + (y * 3 - origin.y) ** 2;
              let free = !blocks.has(blockKey(x, y));
              for (let cx = -1; free && cx <= 1; cx++) for (let cy = -1; free && cy <= 1; cy++) free = !occupied.has(blockKey(x * 3 + cx, y * 3 + cy));
              if (d < distance && free) { best = { x, y }; distance = d; }
            }
            if (best) { blocks.set(blockKey(best.x, best.y), owner); return best; }
          }
        };
        const nearestFree = (owner, origin) => {
          let best, distance = Infinity;
          const find = () => {
            for (const [key, blockOwner] of blocks) if (blockOwner === owner) {
              const [bx, by] = key.split(',').map(Number);
              for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                const x = bx * 3 + dx, y = by * 3 + dy, d = (x - origin.x) ** 2 + (y - origin.y) ** 2;
                if (d < distance && !occupied.has(blockKey(x, y))) { best = { x, y }; distance = d; }
              }
            }
          };
          find();
          if (!best) { claimBlock(owner, origin); find(); }
          return best;
        };
        if (!blocks.has('0,0')) blocks.set('0,0', root.id);
        for (const position of positions) {
          let cell = cells.get(position.agent.id);
          if (!cell) {
            if (!position.parent) cell = { x: 0, y: 0 };
            else if (position.depth === 1) { const block = claimBlock(position.branch, { x: 0, y: 0 }); cell = { x: block.x * 3, y: block.y * 3 }; }
            else cell = nearestFree(position.branch, cells.get(position.parent.id));
            cells.set(position.agent.id, cell); occupied.add(blockKey(cell.x, cell.y));
          }
        }
        // Mark occupied blocks in branches with descendants; the outlines are
        // a visual boundary rather than a status color.
        const families = new Set(positions.filter(position => position.depth > 1).map(position => position.branch));
        const clusterBlocks = new Map();
        for (const position of positions) if (position.depth && families.has(position.branch)) {
          const cell = cells.get(position.agent.id), bx = Math.floor((cell.x + 1) / 3), by = Math.floor((cell.y + 1) / 3);
          clusterBlocks.set(blockKey(bx, by), { x: bx, y: by });
        }
        viewport.swarmClusterBlocks = [...clusterBlocks.values()];
        const visibleCells = positions.map(position => cells.get(position.agent.id));
        const radius = Math.max(1, ...visibleCells.map(cell => Math.max(Math.abs(cell.x), Math.abs(cell.y))));
        const center = Math.ceil((radius * 30 + 36) / 100) * 100;
        for (const position of positions) {
          const cell = cells.get(position.agent.id);
          position.x = center + cell.x * 30 - 10; position.y = center + cell.y * 30 - 10;
        }
        width = height = center * 2;
      } else {
        const layoutColumns = horizontalColumns || 1;
        // Pack each top-level branch as a unit instead of placing all L1s
        // before every L2. A child is therefore visible beside its parent.
        const children = new Map();
        for (const position of positions) if (position.parent) {
          if (!children.has(position.parent.id)) children.set(position.parent.id, []);
          children.get(position.parent.id).push(position);
        }
        const branches = children.get(root.id) || [];
        const rows = new Map();
        for (const branch of branches) {
          const members = [];
          if (largeCards) {
            const queue = [branch];
            for (let i = 0; i < queue.length; i++) { const position = queue[i]; members.push(position); queue.push(...(children.get(position.agent.id) || [])); }
          } else {
            const collect = position => { members.push(position); for (const child of children.get(position.agent.id) || []) collect(child); };
            collect(branch);
          }
          const row = Math.floor(branch.row / layoutColumns);
          if (!rows.has(row)) rows.set(row, []);
          rows.get(row).push({ branch, members });
        }
        const rootPosition = byId.get(root.id); rootPosition.x = 28; rootPosition.y = 28;
        let y = 28 + rowPitch + 40;
        {
          // Reserve a separate column for each visible depth of a branch.
          // A subtree occupies its full rectangle so later branches cannot
          // land on its descendants when an agent is expanded.
          const entries = [...rows.values()].flat().sort((a, b) => a.branch.row - b.branch.row);
          const spans = entries.map(({ members }) => layoutColumns === 1 ? 1 : Math.max(...members.map(member => member.depth)));
          const columnY = Array(Math.max(layoutColumns, ...spans, 1)).fill(y);
          entries.forEach(({ branch }, index) => {
            const span = spans[index];
            let column = 0, top = Infinity;
            for (let start = 0; start <= columnY.length - span; start++) {
              const candidate = Math.max(...columnY.slice(start, start + span));
              if (candidate < top) { column = start; top = candidate; }
            }
            const place = (position, nextY) => {
              position.x = layoutColumns === 1
                ? 28 + Math.min(3, position.depth - 1) * 8
                : 28 + (column + position.depth - 1) * (largeCards ? 360 : 328);
              position.y = nextY;
              let end = nextY + rowPitch;
              for (const child of children.get(position.agent.id) || []) end = place(child, end);
              return end;
            };
            const bottom = place(branch, top) + 40;
            for (let c = column; c < column + span; c++) columnY[c] = bottom;
          });
          y = Math.max(...columnY);
        }
        width = Math.max(modernGraphIsCompact ? 316 : 356, ...positions.map(position => position.x + (modernGraphIsCompact ? 288 : 328)));
        height = Math.max(y - 40 + 28, 28 + nodeHeight + 28);
      }
      graph.style.width = width + 'px'; graph.style.height = height + 'px';
      const zooms = ui.modernSwarm ? modernSwarmZoom : modernZoom;
      const autoZoom = ui.modernSwarm ? Math.max(.2, Math.min(1, (modernWidthFor(roots.length, root.id) - 32) / width, ((workspaceSize?.height || (modernPhone.matches ? 674 : 464)) - 32) / height)) : 1;
      const zoom = zooms.get(root.id) ?? autoZoom;
      if (ui.modernSwarm && !zooms.has(root.id)) zooms.set(root.id, zoom);
      if (ui.modernSwarm) viewport.style.setProperty('--swarm-zoom', String(zoom));
      graph.style.transform = `scale(${zoom})`;
      const space = element('div', 'modern-graph-space'); space.style.width = width * zoom + 'px'; space.style.height = height * zoom + 'px';
      svg.setAttribute('width', width); svg.setAttribute('height', height);
      if (ui.modernSwarm) {
        const center = width / 2;
        for (const block of viewport.swarmClusterBlocks || []) {
          const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          outline.classList.add('modern-swarm-cluster');
          outline.setAttribute('x', center + block.x * 90 - 44); outline.setAttribute('y', center + block.y * 90 - 44);
          outline.setAttribute('width', '88'); outline.setAttribute('height', '88'); outline.setAttribute('rx', '12');
          svg.append(outline);
        }
      }
      const lineage = new Set();
      for (let selected = byId.get(ui.selected); selected; selected = byId.get(selected.parent?.id)) lineage.add(selected.agent.id);
      for (const { agent, depth, parent, x, y } of positions) {
        if (parent) {
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          if (ui.modernSwarm) {
            const parentPosition = byId.get(parent.id);
            line.dataset.parentId = parent.id; line.dataset.childId = agent.id; line.dataset.level = String(depth);
            line.setAttribute('d', 'M ' + (parentPosition.x + 10) + ' ' + (parentPosition.y + 10) + ' L ' + (x + 10) + ' ' + (y + 10));
          } else {
            const parentPosition = byId.get(parent.id);
            const centerX = modernGraphIsCompact ? 130 : 150;
            const bend = parentPosition.y + nodeHeight + 14;
            line.setAttribute('d', 'M ' + (parentPosition.x + centerX) + ' ' + (parentPosition.y + nodeHeight) + ' V ' + bend + ' H ' + (x - 14) + ' V ' + (y - 14) + ' H ' + (x + centerX) + ' V ' + y);
          }
          if (lineage.has(agent.id)) line.classList.add('is-lineage');
          svg.append(line);
        }
        const item = element('li', 'modern-item' + (ui.modernSwarm ? ' modern-swarm-item' : ''), undefined, 'modern-item:' + agent.id);
        item.style.left = x + 'px'; item.style.top = y + 'px';
        const card = button('', 'agent modern-agent' + (ui.modernSwarm ? ' modern-swarm-node' : '') + ' agent-' + (ui.modernSwarm && agent.observationStale ? 'unknown' : agent.displayState) + (ui.selected === agent.id ? ' selected' : ''), () => { modernToolAgents.set(root.id, agent.id); selectAgent(agent.id); });
        card.dataset.key = agent.id; if (ui.modernSwarm) card.dataset.level = String(depth); card.setAttribute('aria-pressed', String(ui.selected === agent.id));
        if (ui.modernSwarm && agent.currentTool?.status === 'in_progress' && !agent.observationStale) {
          card.classList.add('has-current-tool', window.agentobsViews.toolColorClass(agent.currentTool));
        }
        const name = agent.name || 'Agent', status = agent.observationStale ? 'Observation unavailable' : labels[agent.displayState] || 'Unknown';
        const activity = agent.currentTool?.label || agent.currentTool?.name || agent.phaseLabel || 'No activity recorded';
        const usage = agent.tokenUsage || {};
        const toolState = tool => tool.status === 'in_progress' && agent.observationStale ? 'Last observed running' : ({ in_progress: 'Running', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', canceled: 'Cancelled', interrupted: 'Interrupted', unknown: 'Unknown' }[tool.status] || 'Unknown');
        card.setAttribute('aria-label', agent.title + ', ' + name + ', ' + status + (parent ? ', delegated by ' + parent.name : ', main agent') + '. Delegation level ' + depth + '. Current activity: ' + activity + '. Show agent details');
        const top = element('span', 'modern-node-top');
        top.append(element('span', 'modern-node-id', (depth ? '↳ ' + name : '✳ ' + name) + ' / L' + depth), element('span', 'modern-state status-' + agent.displayState, status));
        const task = element('span', 'modern-task', agent.title); task.title = agent.title;
        const execution = element('span', 'modern-execution' + (agent.currentTool ? ' has-tool ' + window.agentobsViews.toolColorClass(agent.currentTool) : ''));
        const executionCaption = agent.observationStale ? 'LAST OBSERVATION' : agent.currentTool ? (toolState(agent.currentTool) === 'Unknown' ? 'CURRENT TOOL' : toolState(agent.currentTool).toUpperCase() + ' TOOL') : 'CURRENT ACTIVITY';
        execution.append(element('span', 'modern-execution-caption', executionCaption), element('span', 'modern-action-text', activity));
        execution.title = agent.progress || activity;
        const footer = element('span', 'modern-node-footer');
        footer.append(element('span', 'modern-tokens', tokenCount(usage.input) + ' IN  ·  ' + tokenCount(usage.cachedInput) + ' CACHED  ·  ' + tokenCount(usage.output) + ' OUT'));
        footer.title = 'Tokens: ' + (usage.input ?? '—') + ' input, ' + (usage.cachedInput ?? '—') + ' cached, ' + (usage.output ?? '—') + ' output';
        card.append(top);
        if (largeCards && parent) { const context = element('span', 'modern-node-context', 'L' + depth + ' · under ' + parent.name); context.title = 'Delegated by ' + parent.name; card.append(context); }
        card.append(task, execution);
        const closedLarge = largeCards && depth > 0 && !ui.search.trim() && !ui.attentionOnly && !modernExpandedLarge.has(agent.id);
        if (largeCards && agent.children.length && (modernCollapsed.has(agent.id) || closedLarge)) {
          const descendants = flatten(agent.children), active = descendants.filter(child => !child.archived && ['working', 'tool', 'starting'].includes(child.displayState)).length, attention = descendants.filter(child => child.needsAttention).length;
          card.append(element('span', 'modern-branch-summary', descendants.length + ' delegated · ' + active + ' active' + (attention ? ' · ' + attention + ' need attention' : '')));
        }
        card.append(footer); item.append(card); list.append(item);
        const completedGroup = subagentGroups(agent, state.agents);
        if (!ui.modernSwarm && !filtering && !modernCollapsed.has(agent.id) && !closedLarge && completedGroup.completedCount) {
          const expanded = ui.modernExpandedCompleted.has(agent.id);
          const completed = button((expanded ? '▾ ' : '▸ ') + completedGroup.completedCount + ' completed', 'modern-completed-toggle', () => {
            if (expanded) ui.modernExpandedCompleted.delete(agent.id); else ui.modernExpandedCompleted.add(agent.id);
            persist(); renderContent();
          });
          completed.dataset.key = 'modern-completed:' + agent.id;
          completed.setAttribute('aria-expanded', String(expanded));
          completed.setAttribute('aria-label', (expanded ? 'Hide ' : 'Show ') + completedGroup.completedCount + ' completed agent' + (completedGroup.completedCount === 1 ? '' : 's') + ' under ' + agent.title);
          item.append(completed);
        }
        if (agent.children.length && (!filtering || largeCards && !ui.search.trim() && !ui.attentionOnly) && (!ui.modernSwarm || modernCollapsed.has(agent.id))) {
          const closed = modernCollapsed.has(agent.id) || (largeCards && depth > 0 && !ui.search.trim() && !ui.attentionOnly && !modernExpandedLarge.has(agent.id)), count = flatten(agent.children).length;
          const toggle = button(closed ? '+' + count : '−', 'modern-branch-toggle', () => {
            if (closed) { modernCollapsed.delete(agent.id); modernExpandedLarge.add(agent.id); } else { modernCollapsed.add(agent.id); modernExpandedLarge.delete(agent.id); }
            renderContent();
          });
          toggle.dataset.key = 'modern-toggle:' + agent.id;
          toggle.setAttribute('aria-label', (closed ? 'Show ' + count + ' delegated agent' + (count === 1 ? '' : 's') + ' under ' : 'Hide delegated agents under ') + agent.title);
          toggle.setAttribute('aria-expanded', String(!closed)); item.append(toggle);
        }
      }
      graph.append(svg, list);
      if (ui.modernSwarm && !positions.length) {
        const noAgents = element('p', 'modern-swarm-empty', 'No unfinished agents in this run');
        noAgents.setAttribute('role', 'status'); graph.append(noAgents);
      }
      space.append(graph); viewport.append(space);
      const body = element('div', 'modern-run-body');
      const toolsPanel = element('aside', 'modern-tools-panel'); toolsPanel.setAttribute('aria-label', 'Recorded tool activity for ' + root.title);
      if (workspaceSize?.toolHeight) { toolsPanel.style.height = workspaceSize.toolHeight + 'px'; toolsPanel.dataset.resized = 'true'; }
      const toolsHeader = element('div', 'modern-tools-header');
      const selectedToolId = modernToolAgents.get(root.id), selectedToolAgent = selectedToolId && fullFamily.has(selectedToolId) ? state.agents[selectedToolId] : undefined;
      let scope = modernToolScopes.get(root.id) || 'all';
      if (!selectedToolAgent && scope !== 'all') { scope = 'all'; modernToolScopes.delete(root.id); }
      const scopeSelect = element('select', 'modern-tool-scope', undefined, 'tool-scope:' + root.id);
      scopeSelect.setAttribute('aria-label', 'Tool activity scope for ' + root.title);
      for (const [value, label] of [['all', 'All agents'], ['agent', 'Selected agent'], ['branch', 'Selected branch']]) {
        const option = element('option', '', label); option.value = value; option.disabled = value !== 'all' && !selectedToolAgent; scopeSelect.append(option);
      }
      scopeSelect.value = scope;
      scopeSelect.title = selectedToolAgent ? 'Selected: ' + (selectedToolAgent.name || selectedToolAgent.title) : 'Select an agent to filter its activity';
      scopeSelect.onchange = event => { modernToolScopes.set(root.id, event.currentTarget.value); modernCallsPage.delete(root.id); renderContent(); };
      toolsHeader.append(element('span', 'modern-eyebrow', 'TOOL ACTIVITY'), scopeSelect);
      if (selectedToolAgent) { const selectedLabel = element('span', 'modern-tool-target', 'Selected: ' + (selectedToolAgent.name || selectedToolAgent.title)); selectedLabel.title = selectedToolAgent.title; toolsHeader.append(selectedLabel); }
      toolsPanel.append(toolsHeader);
      const scopeIds = scope === 'branch' && selectedToolAgent ? new Set(flatten([selectedToolAgent]).map(agent => agent.id)) : scope === 'agent' && selectedToolAgent ? new Set([selectedToolAgent.id]) : undefined;
      const scopedFamily = scopeIds ? family.filter(agent => scopeIds.has(agent.id)) : family;
      const calls = scopedFamily.flatMap(agent => agent.recentTools.map((tool, index) => ({ agent, tool, index, time: Date.parse(tool.completedAt || tool.startedAt || tool.timestamp || '') })))
        .sort((a, b) => Number(b.tool.status === 'in_progress' && !b.agent.observationStale) - Number(a.tool.status === 'in_progress' && !a.agent.observationStale)
          || Number(b.tool.status === 'failed' || b.tool.status === 'interrupted') - Number(a.tool.status === 'failed' || a.tool.status === 'interrupted')
          || (Number.isFinite(b.time) ? b.time : -Infinity) - (Number.isFinite(a.time) ? a.time : -Infinity));
      const callsList = element('ul', 'modern-calls');
      const pageSize = 12, pageCount = Math.max(1, Math.ceil(calls.length / pageSize));
      const callPage = Math.min(modernCallsPage.get(root.id) || 0, pageCount - 1), start = callPage * pageSize;
      const pageCalls = calls.slice(start, start + pageSize);
      for (const { agent, tool, index, time } of pageCalls) {
        const entry = element('li', 'modern-call ' + window.agentobsViews.toolColorClass(tool), undefined, 'call:' + agent.id + ':' + (tool.id || index));
        const call = button('', 'modern-call-button', event => {
          keyboardSelection = event.detail === 0;
          const opener = event.currentTarget;
          modernToolAgents.set(root.id, agent.id); ui.selected = agent.id; revealSelected(); renderContent(); selectAgent(agent.id, opener);
          requestAnimationFrame(() => [...map.querySelectorAll('.modern-agent')].find(card => card.dataset.key === agent.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        });
        const label = tool.label || tool.name || 'Tool';
        const outcome = tool.status === 'in_progress' && agent.observationStale ? 'Last observed running' : ({ in_progress: 'Running', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', canceled: 'Cancelled', interrupted: 'Interrupted', unknown: 'Unknown' })[tool.status] || 'Unknown';
        call.setAttribute('aria-label', label + ', ' + outcome + ', ' + (agent.name || 'Agent') + '. Show agent details');
        const line = element('span', 'modern-call-title'); line.append(element('strong', '', label), element('span', 'modern-call-outcome', outcome));
        call.append(line, element('span', 'modern-call-actor', agent.name || 'Agent'), element('span', 'modern-call-time', Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Time not recorded'));
        entry.append(call); callsList.append(entry);
      }
      if (calls.length) {
        toolsPanel.append(callsList, element('p', 'modern-calls-note', 'Showing ' + (start + 1) + '–' + (start + pageCalls.length) + ' of ' + calls.length + ' recent calls'));
        if (pageCount > 1) {
          const navigation = element('div', 'modern-calls-navigation');
          const previous = button('Previous', 'modern-calls-toggle', () => { modernCallsPage.set(root.id, Math.max(0, callPage - 1)); renderContent(); });
          const next = button('Next', 'modern-calls-toggle', () => { modernCallsPage.set(root.id, Math.min(pageCount - 1, callPage + 1)); renderContent(); });
          previous.disabled = callPage === 0; next.disabled = callPage >= pageCount - 1;
          previous.setAttribute('aria-label', 'Previous tool calls for ' + root.title); next.setAttribute('aria-label', 'Next tool calls for ' + root.title);
          navigation.append(previous, next); toolsPanel.append(navigation);
        }
      } else toolsPanel.append(element('p', 'modern-calls-empty', scope === 'all' ? 'No tool calls recorded for this run yet.' : 'No tool calls recorded for this selection.'));
      const resize = button('◢', 'workspace-resize modern-resize', () => {});
      resize.dataset.modernResize = root.id; resize.setAttribute('aria-label', 'Resize workspace ' + root.title); resize.title = 'Drag to resize; use arrow keys to adjust width and height';
      resize.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const panel = event.currentTarget.closest('.modern-run'), view = panel.querySelector('.modern-graph-viewport');
        const current = ui.modernWorkspaceSizes[root.id] || {};
        const defaultSpan = ui.modernWorkspaceArrangement === 'column' ? 12 : ui.modernWorkspaceArrangement === 'grid' ? 6 : Math.max(3, Math.floor(12 / roots.length));
        ui.modernWorkspaceSizes[root.id] = { ...current, span: Math.max(3, Math.min(12, (current.span || defaultSpan) + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0))), height: Math.max(200, Math.min(1400, (current.height || view.clientHeight) + (event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : 0))) };
        persist(); renderContent(); event.preventDefault();
      };
      const toolsResize = button('', 'modern-tools-resize', () => {});
      toolsResize.dataset.key = 'modern-tools-resize:' + root.id;
      toolsResize.setAttribute('aria-label', 'Resize tool activity for ' + root.title);
      toolsResize.setAttribute('aria-description', 'Drag vertically, or use the up and down arrow keys to adjust the tool activity height.');
      toolsResize.title = 'Drag to resize tool activity; use up and down arrows on the keyboard';
      toolsResize.onkeydown = event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const workspace = event.currentTarget.closest('.modern-run'), view = workspace.querySelector('.modern-graph-viewport'), panel = workspace.querySelector('.modern-tools-panel');
        const toolHeight = panel.getBoundingClientRect().height;
        resizeModernTools(root.id, view, panel, view.clientHeight, toolHeight, toolHeight + (event.key === 'ArrowUp' ? 40 : -40));
        persist(); renderContent(); event.preventDefault();
      };
      body.append(viewport, toolsResize, toolsPanel); run.append(body, resize); runs.append(run);
    }
    board.append(runs);
    for (const id of modernSlots.keys()) if (!state.agents[id]) { modernSlots.delete(id); modernCallsPage.delete(id); modernToolScopes.delete(id); modernToolAgents.delete(id); modernRunsCollapsed.delete(id); }
    return board;
  };
  const workspaceSizeObserver = new ResizeObserver(() => {
    if (ui.design === 'modern' && state && [...map.querySelectorAll('.modern-graph-viewport')].some(view => (view.dataset.compact === 'true') !== modernCompactFor(Number(view.dataset.runCount), view.dataset.run) || Number(view.dataset.columns) !== modernColumnsFor(Number(view.dataset.runCount), view.dataset.run, view.dataset.largeCards === 'true'))) renderContent();
  });
  workspaceSizeObserver.observe(map);

  const revealSelected = () => {
    if (!ui.selected) return;
    const find = (node, parents = []) => {
      if (node.id === ui.selected) return parents;
      for (const child of node.children) { const result = find(child, [...parents, { id: node.id, child: child.id }]); if (result) return result; }
    };
    for (const root of state.forest) {
      const parents = find(root);
      if (parents) {
        modernRunsCollapsed.delete(root.id);
        for (const { id: parent, child } of parents) {
          ui.collapsed.delete(parent);
          modernCollapsed.delete(parent); modernExpandedLarge.add(parent);
          if (state.agents[child] && completedBranch(state.agents[child])) ui.modernExpandedCompleted.add(parent);
          if (allSubagentsCompleted(state.agents[parent])) ui.expandedCompleted.add(parent);
          ui.shownCompleted.add(parent);
        }
        if (ui.runKey && ui.runKey !== root.runKey) ui.runKey = root.runKey;
        ui.search = ''; ui.attentionOnly = false; search.value = ''; persist();
        return;
      }
    }
  };
  function renderContent() {
    if (!state) return;
    const forest = state.forest.filter((root) => !ui.runKey || root.runKey === ui.runKey).map((node) => filterTree(node, ui)).filter(Boolean);
    const all = flatten(forest);
    const attention = flatten(state.forest).filter(agent => agent.needsAttention && !agent.archived && !agent.workspaceContext);
    attentionQueue.hidden = !attention.length;
    if (attention.length) {
      const entries = [element('summary', '', 'Needs attention · ' + attention.length)];
      const list = element('ul', 'attention-list');
      for (const agent of attention) {
        const item = element('li');
        const open = button(agent.title, 'attention-agent', event => {
          keyboardSelection = event.detail === 0;
          ui.selected = agent.id; revealSelected(); renderContent(); selectAgent(agent.id);
          requestAnimationFrame(() => [...map.querySelectorAll('.agent')].find(card => card.dataset.key === agent.id)?.scrollIntoView({ block: 'nearest' }));
        });
        open.setAttribute('aria-label', 'Show ' + agent.title + ', ' + labels[agent.displayState]);
        item.append(open, element('span', 'secondary', labels[agent.displayState])); list.append(item);
      }
      entries.push(list); reconcile(attentionQueue, entries);
    }
    const counts = { working: 0, input: 0, quiet: 0, failed: 0, completed: 0, inactive: 0, unknown: 0 };
    for (const agent of all) {
      if (agent.workspaceContext) continue;
      const key = agent.historyGroup === 'inactive' ? 'inactive'
        : ['working', 'tool', 'starting'].includes(agent.displayState) ? 'working' : agent.displayState === 'interrupted' ? 'failed' : agent.displayState;
      counts[key]++;
    }
    const countLabels = { working: 'working', input: 'need input', quiet: 'quiet', failed: 'failed / interrupted', completed: 'completed', inactive: 'inactive', unknown: 'unknown' };
    const pills = Object.entries(counts).filter(([key, count]) => count || key === 'working').map(([key, count]) => element('span', 'summary-pill status-' + key + (key === 'working' && count > 0 ? ' is-active' : ''), count + ' ' + countLabels[key], key));
    reconcile(summary, pills);
    const options = [element('option', '', 'All runs · ' + state.runs.length, 'all')]; options[0].value = '';
    for (const run of state.runs) { const option = element('option', '', run.title.slice(0, 65) + (run.shortId ? ' · ' + run.shortId : ''), run.id); option.value = run.id; options.push(option); }
    reconcile(runSelect, options); runSelect.value = ui.runKey;
    attentionButton.setAttribute('aria-pressed', String(ui.attentionOnly));
    const activeFilters = Number(Boolean(ui.search.trim())) + Number(Boolean(ui.runKey)) + Number(ui.attentionOnly);
    filtersToggle.textContent = activeFilters ? 'Filters · ' + activeFilters : 'Filters';
    filtersToggle.setAttribute('aria-description', activeFilters ? activeFilters + ' active filters' : 'No active filters');
    map.classList.toggle('compact', state.compactDensity);
    const currentLive = new Set(state.forest.filter(hasLive).map(root => root.id));
    for (const id of liveOrder.keys()) if (!currentLive.has(id)) liveOrder.delete(id);
    for (const id of currentLive) if (!liveOrder.has(id)) liveOrder.set(id, nextLiveSlot++);
    const live = forest.filter(hasLive);
    const archived = forest.filter(root => !hasLive(root));
    const attentionCount = flatten(state.forest).filter(agent => agent.needsAttention && !agent.archived && !agent.workspaceContext).length;
    navAttention.disabled = !attentionCount; navAttention.querySelector('.modern-nav-count').textContent = attentionCount ? String(attentionCount) : '';
    navHistory.disabled = !archived.length; navHistory.querySelector('.modern-nav-count').textContent = archived.length ? String(archived.length) : '';
    live.sort((a, b) => liveOrder.get(a.id) - liveOrder.get(b.id));
    const next = [];
    const sectionHeader = element('div', 'section-header', undefined, 'live-heading');
    sectionHeader.append(element('h2', '', ui.attentionOnly ? 'Needs attention' : 'Live workspace'), element('span', 'secondary', live.length + ' run' + (live.length === 1 ? '' : 's')));
    if (!live.length) next.push(sectionHeader);
    if (live.length) next.push(createModern(live));
    else {
      if (!state.runs.length && !ui.search && !ui.attentionOnly) next.push(welcomePreview());
      else {
        const empty = element('div', 'empty', undefined, 'empty');
        empty.append(element('strong', '', ui.search || ui.attentionOnly ? 'No matching live agents' : 'No agents are working'), element('p', '', ui.search || ui.attentionOnly ? archived.length ? 'Matching history is shown below.' : 'Try another search or clear the attention filter.' : 'New activity will appear here automatically. Past runs are in history below.'));
        next.push(empty);
      }
    }
    let historyControlsShown = false;
    for (const group of ['quiet', 'completed', 'inactive']) {
      const history = archived.filter(root => historyGroupFor(root) === group);
      if (!history.length) continue;
      const filtering = Boolean(ui.search.trim() || ui.attentionOnly);
      const details = element('details', 'run-history ' + group + '-history', undefined, group + (filtering ? '-filtered-history' : '-history'));
      const label = group === 'quiet' ? 'Quiet' : group === 'inactive' ? 'Inactive history' : 'Completed history';
      details.append(element('summary', '', label + ' · ' + history.length + ' run' + (history.length === 1 ? '' : 's') + ' · ' + flatten(history).length + ' agents'));
      details.open = filtering || openHistory.has(group);
      details.ontoggle = event => {
        if (filtering) return;
        const changed = event.currentTarget.open !== openHistory.has(group);
        if (event.currentTarget.open) openHistory.add(group); else openHistory.delete(group);
        if (changed) renderContent();
      };
      if (details.open) {
        const showControls = !live.length && !historyControlsShown;
        details.append(createModern(history, group, showControls));
        historyControlsShown ||= showControls;
      }
      next.push(details);
    }
    // Keep the card nearest the viewport center in place when another branch
    // grows and the rows below it must move.
    const modernAnchors = new Map([...map.querySelectorAll('.modern-graph-viewport[data-swarm="false"]')].flatMap(viewport => {
      const view = viewport.getBoundingClientRect();
      const cards = [...viewport.querySelectorAll('.modern-agent')].map(node => ({ node, box: node.getBoundingClientRect() }))
        .filter(({ box }) => box.bottom > view.top && box.top < view.bottom && box.right > view.left && box.left < view.right);
      cards.sort((a, b) => Math.abs(a.box.top + a.box.height / 2 - (view.top + view.height / 2)) - Math.abs(b.box.top + b.box.height / 2 - (view.top + view.height / 2)));
      const anchor = cards[0];
      return anchor ? [[viewport.dataset.run, { id: anchor.node.dataset.key, x: anchor.box.left - view.left, y: anchor.box.top - view.top, atLeft: viewport.scrollLeft < 1, atTop: viewport.scrollTop < 1 }]] : [];
    }));
    const swarmAnchors = new Map([...map.querySelectorAll('.modern-graph-viewport[data-swarm="true"]')].flatMap(viewport => {
      const node = viewport.querySelector('.modern-swarm-node'); if (!node) return [];
      const box = node.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      return [[viewport.dataset.run, { id: node.dataset.key, x: box.left - view.left, y: box.top - view.top }]];
    }));
    reconcile(map, next); renderInspector();
    for (const viewport of map.querySelectorAll('.modern-graph-viewport[data-swarm="true"]')) {
      const anchor = swarmAnchors.get(viewport.dataset.run);
      const node = anchor && [...viewport.querySelectorAll('.modern-swarm-node')].find(card => card.dataset.key === anchor.id);
      if (!node) continue;
      const box = node.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      viewport.scrollLeft += box.left - view.left - anchor.x; viewport.scrollTop += box.top - view.top - anchor.y;
    }
    for (const viewport of map.querySelectorAll('.modern-graph-viewport[data-swarm="false"]')) {
      const anchor = modernAnchors.get(viewport.dataset.run);
      const node = anchor && [...viewport.querySelectorAll('.modern-agent')].find(card => card.dataset.key === anchor.id);
      if (!node) continue;
      const box = node.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      if (!anchor.atLeft) viewport.scrollLeft += box.left - view.left - anchor.x;
      if (!anchor.atTop) viewport.scrollTop += box.top - view.top - anchor.y;
    }
    if (previewNode) showSwarmPreview(previewNode);
  }
  const revealSelectedDetails = () => {
    const root = state.forest.find(root => !hasLive(root) && flatten([root]).some(agent => agent.id === ui.selected));
    if (root) {
      openHistory.add(historyGroupFor(root));
      renderContent();
    }
    const selectedCard = [...map.querySelectorAll('.agent')].find((card) => card.dataset.key === ui.selected);
    if (selectedCard) {
      let parent = selectedCard.parentElement;
      while (parent && parent !== map) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
    }
  };
  window.addEventListener('agentobs:render', (event) => {
    if (event.detail?.type !== 'render') return;
    const wasArchived = state?.agents[ui.selected]?.archived;
    state = event.detail.model;
    const selectionChanged = state.selectedAgentKey !== lastHostSelection;
    // Host provenance also identifies local echoes that arrive after another card click.
    const externalSelection = selectionChanged && event.detail.selectionSource !== 'map';
    ui.selected = state.selectedAgentKey; lastHostSelection = state.selectedAgentKey;
    if (ui.runKey && !state.runs.some((run) => run.id === ui.runKey)) ui.runKey = '';
    let expansionChanged = false;
    for (const id of ui.expandedCompleted) {
      if (state.agents[id] && !allSubagentsCompleted(state.agents[id])) {
        ui.expandedCompleted.delete(id); expansionChanged = true;
      }
    }
    if (expansionChanged) persist();
    if (externalSelection && ui.selected) revealSelected();
    if (event.detail.selectionOnly) {
      renderContent(); return;
    }
    version.textContent = 'v' + state.version;
    const brand = document.querySelector('.brand');
    const brandVersion = document.querySelector('.brand-version');
    if (brandVersion) brandVersion.textContent = state.version;
    if (brand) brand.setAttribute('aria-label', 'agentobs home, version ' + state.version);
    renderContent();
    if (selectionChanged || (wasArchived === false && state.agents[ui.selected]?.archived)) revealSelectedDetails();
  });
  host.postMessage({ command: 'ready' });
})();
