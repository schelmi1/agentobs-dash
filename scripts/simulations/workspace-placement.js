'use strict';

// Demo-only presentation policy. Completion and attention states remain real;
// layoutHeld merely retains a completed run's slot during the experiment.
function createWorkspacePlacement(holdMs) {
  const slots = new Map();
  const live = node => !node.archived || node.children.some(live);
  return { setHoldMs(value) { holdMs = value; }, update(forest, now) {
    const current = new Map(forest.map(node => [node.id, node]));
    for (const node of forest) {
      if (live(node)) {
        if (!slots.has(node.id)) slots.set(node.id, {});
        slots.get(node.id).completedAt = undefined;
      }
    }
    for (const [id, slot] of slots) {
      const node = current.get(id);
      if (!node) { slots.delete(id); continue; }
      if (!live(node)) {
        slot.completedAt ??= now;
        if (now - slot.completedAt >= holdMs) slots.delete(id);
      }
    }
    const visible = [...slots.keys()].map(id => {
      const node = current.get(id);
      return live(node) ? node : { ...node, layoutHeld: true };
    });
    return { visible, forest: [...visible, ...forest.filter(node => !slots.has(node.id))] };
  } };
}

module.exports = { createWorkspacePlacement };
