(function (root) {
  'use strict';
  const string = value => typeof value === 'string' ? value.slice(0, 2000) : '';
  const agentKey = value => {
    if (typeof value !== 'string') return value;
    try {
      const parts = JSON.parse(value);
      if (Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string')) return JSON.stringify([...parts, parts[0].startsWith('copilot-vscode:') ? 'copilot-vscode' : 'codex']);
    } catch { /* Non-agent preference keys remain valid. */ }
    return value;
  };
  const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string').slice(-10000).map(agentKey))] : [];
  function normalizePreferences(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    return { search: string(saved.search), runKey: agentKey(string(saved.runKey)), workspace: string(saved.workspace),
      attentionOnly: saved.attentionOnly === true, compactDensity: saved.compactDensity === true,
      collapsed: ids(saved.collapsed), expandedCompleted: ids(saved.expandedCompleted), shownCompleted: ids(saved.shownCompleted),
      modernWorkspaceArrangement: ['row', 'column', 'grid'].includes(saved.modernWorkspaceArrangement) ? saved.modernWorkspaceArrangement : 'column',
      modernSwarm: saved.modernSwarm === true,
      modernHideCompletedRuns: ids(saved.modernHideCompletedRuns),
      modernExpandedCompleted: ids(saved.modernExpandedCompleted),
      modernWorkspaceSizes: Object.fromEntries(Object.entries(saved.modernWorkspaceSizes && typeof saved.modernWorkspaceSizes === 'object' && !Array.isArray(saved.modernWorkspaceSizes) ? saved.modernWorkspaceSizes : {}).slice(-1000).filter(([id, size]) => id.length <= 2000 && size && typeof size === 'object').map(([id, size]) => [agentKey(id), { ...(Number.isFinite(size.span) ? { span: Math.max(3, Math.min(12, Math.round(size.span))) } : {}), ...(Number.isFinite(size.height) ? { height: Math.max(200, Math.min(1400, Math.round(size.height))) } : {}), ...(Number.isFinite(size.toolHeight) ? { toolHeight: Math.max(70, Math.min(1000, Math.round(size.toolHeight))) } : {}) }])),
      inspectorWidth: Number.isFinite(saved.inspectorWidth) && saved.inspectorWidth >= 220 && saved.inspectorWidth <= 480 ? Math.round(saved.inspectorWidth) : undefined,
      ...root.agentobsThemes.normalizeAppearance(saved) };
  }
  function createPreferenceStore(storage) {
    let value;
    try { value = JSON.parse(storage.getItem('agentobs.preferences') || '{}'); } catch { value = {}; }
    value = normalizePreferences(value);
    return { get: () => value, set(next) { value = normalizePreferences({ ...value, ...next }); try { storage.setItem('agentobs.preferences', JSON.stringify(value)); } catch {} return value; } };
  }
  const api = { normalizePreferences, createPreferenceStore };
  if (typeof module === 'object' && module.exports) { root = { agentobsThemes: require('./appearance') }; module.exports = api; } else root.agentobsPreferences = api;
})(globalThis);
