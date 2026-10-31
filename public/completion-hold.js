(function (root) {
  'use strict';
  // Only transitions observed in this tab are held; old history never flashes.
  function createCompletionHold(storage, selectors, duration = 30000) {
    const key = 'agentobs.completion-holds';
    let previous = new Map(), deadlines = {};
    try { const value = JSON.parse(storage.getItem(key) || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) deadlines = value; } catch {}
    return {
      update(forest, now, holdDuration = duration) {
        const next = new Map(), present = new Set();
        for (const node of forest) {
          present.add(node.id);
          const live = selectors.hasLive(node), completed = !live && !node.manuallyCompleted && selectors.completedBranch(node);
          if (completed && previous.get(node.id) === true) deadlines[node.id] = now + holdDuration;
          if (!completed || !Number.isFinite(deadlines[node.id]) || deadlines[node.id] <= now) delete deadlines[node.id];
          next.set(node.id, live && !node.manuallyCompleted);
        }
        for (const id of Object.keys(deadlines)) if (!present.has(id)) delete deadlines[id];
        previous = next;
        try { storage.setItem(key, JSON.stringify(deadlines)); } catch {}
        const held = forest.map(node => deadlines[node.id] ? { ...node, layoutHeld: true, completionHeld: true } : node);
        const due = Object.values(deadlines).filter(Number.isFinite);
        return { forest: held, nextExpiry: due.length ? Math.min(...due) : undefined };
      }
    };
  }
  const api = { createCompletionHold };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.agentobsCompletionHold = api;
})(globalThis);
