(function (root) {
  'use strict';
  function decodeSnapshot(wire) {
    if (wire?.protocolVersion !== 2 || !wire.agents || typeof wire.agents !== 'object' || !Array.isArray(wire.roots)) throw new Error('Unsupported snapshot protocol');
    const agents = Object.create(null), owners = new Set();
    for (const [id, record] of Object.entries(wire.agents)) {
      if (record.id !== id || !Array.isArray(record.childIds)) throw new Error('Invalid snapshot');
      const { childIds, ...fields } = record;
      agents[id] = { ...fields, children: [] };
    }
    for (const [id, record] of Object.entries(wire.agents)) for (const child of record.childIds) {
      if (!Object.hasOwn(agents, child) || owners.has(child)) throw new Error('Invalid snapshot links');
      owners.add(child); agents[id].children.push(agents[child]);
    }
    const visited = new Set();
    const visit = (id, depth) => {
      if (!Object.hasOwn(agents, id) || visited.has(id) || depth > 2048) throw new Error('Invalid snapshot graph');
      visited.add(id); for (const child of agents[id].children) visit(child.id, depth + 1);
    };
    for (const id of wire.roots) { if (owners.has(id)) throw new Error('Invalid snapshot root'); visit(id, 0); }
    if (visited.size !== Object.keys(agents).length) throw new Error('Disconnected snapshot');
    const { roots, ...metadata } = wire;
    return { ...metadata, agents, forest: roots.map(id => agents[id]) };
  }
  // HTTP refreshes may finish after a newer stream frame. One monotonic gate
  // owns both transports; an instance change permits a server sequence reset.
  function createSnapshotGate() {
    let current, generation = 0;
    const retired = new Set();
    return {
      capture: () => generation,
      accept(next, requestGeneration) {
        const epoch = next.health?.instanceId || 'legacy';
        const version = next.health?.sequence ?? Date.parse(next.scannedAt);
        if (!Number.isFinite(version)) return false;
        if (current) {
          if (epoch === current.epoch && version <= current.version) return false;
          if (epoch !== current.epoch) {
            if (retired.has(epoch) || requestGeneration !== undefined && requestGeneration !== generation) return false;
            retired.add(current.epoch);
            if (retired.size > 32) retired.delete(retired.values().next().value);
          }
        }
        current = { epoch, version }; generation++; return true;
      }
    };
  }
  const api = { decodeSnapshot, createSnapshotGate };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.agentobsSnapshot = api;
})(globalThis);
