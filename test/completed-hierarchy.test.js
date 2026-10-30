'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionForest } = require('../lib/hierarchy');
const { liveMapModel } = require('../lib/live-map-model');

for (const status of ['active', 'completed']) test(status + ' agents with a shared session id retain their canonical delegation levels', () => {
  const forest = buildSessionForest([
    { id: 'run', status, spawnedAgentPaths: ['/root/team'] },
    { id: 'run', parentId: 'run', agentPath: '/root/team', status, spawnedAgentPaths: ['/root/team/worker'] },
    { id: 'run', parentId: 'run', agentPath: '/root/team/worker', status }
  ]);
  assert.equal(forest.length, 1);
  assert.equal(forest[0].children.length, 1, 'a grandchild must not be flattened into a direct child');
  assert.equal(forest[0].children[0].children[0].session.agentPath, '/root/team/worker');
  const model = liveMapModel(forest);
  assert.equal(model.forest[0].children[0].agentPath, '/root/team');
  assert.equal(model.forest[0].children[0].children[0].agentPath, '/root/team/worker');
});

test('a distinct explicit parent id remains authoritative when paths alone suggest another parent', () => {
  const forest = buildSessionForest([
    { id: 'main', status: 'completed', spawnedAgentPaths: ['/root/team'] },
    { id: 'team', parentId: 'main', agentPath: '/root/team', status: 'completed' },
    { id: 'worker', parentId: 'team', agentPath: '/root/worker', status: 'completed' }
  ]);
  assert.equal(forest[0].children.length, 1);
  assert.equal(forest[0].children[0].children[0].session.id, 'worker');
});
