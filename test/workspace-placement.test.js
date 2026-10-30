'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspacePlacement } = require('../scripts/simulations/workspace-placement');

const agent = (id, archived = false, children = []) => ({ id, archived, children });
const ids = result => result.visible.map(node => node.id);

test('demo placement keeps admission order despite changing activity order', () => {
  const placement = createWorkspacePlacement(15000);
  placement.update([agent('a')], 0);
  assert.deepEqual(ids(placement.update([agent('b'), agent('a')], 3000)), ['a', 'b']);
  assert.deepEqual(ids(placement.update([agent('a'), agent('b')], 6000)), ['a', 'b']);
});

test('a completed run retains its position and actual completed state until the deadline', () => {
  const placement = createWorkspacePlacement(15000);
  placement.update([agent('a'), agent('b')], 0);
  const completed = agent('a', true);
  const held = placement.update([agent('b'), completed], 3000).visible[0];
  assert.equal(held.archived, true); assert.equal(held.layoutHeld, true);
  assert.equal(completed.layoutHeld, undefined);
  assert.deepEqual(ids(placement.update([agent('b'), completed], 17999)), ['a', 'b']);
  assert.deepEqual(ids(placement.update([agent('b'), completed], 18000)), ['b']);
});

test('resuming within the hold retains the slot and resets the completion deadline', () => {
  const placement = createWorkspacePlacement(15000);
  placement.update([agent('a'), agent('b')], 0);
  placement.update([agent('b'), agent('a', true)], 3000);
  assert.deepEqual(ids(placement.update([agent('b'), agent('a')], 9000)), ['a', 'b']);
  placement.update([agent('b'), agent('a', true)], 12000);
  assert.deepEqual(ids(placement.update([agent('b'), agent('a', true)], 26000)), ['a', 'b']);
  assert.deepEqual(ids(placement.update([agent('b'), agent('a', true)], 27000)), ['b']);
});

test('resuming after expiry admits the run at the end rather than moving other slots', () => {
  const placement = createWorkspacePlacement(15000);
  placement.update([agent('a'), agent('b')], 0);
  placement.update([agent('a', true), agent('b')], 1000);
  placement.update([agent('b'), agent('a', true)], 16000);
  assert.deepEqual(ids(placement.update([agent('a'), agent('b')], 17000)), ['b', 'a']);
});

test('live descendants keep a completed main run in place without starting its hold', () => {
  const placement = createWorkspacePlacement(0);
  assert.deepEqual(ids(placement.update([agent('a', true, [agent('child')])], 0)), ['a']);
  assert.deepEqual(ids(placement.update([agent('a', true, [agent('child')])], 30000)), ['a']);
  assert.deepEqual(ids(placement.update([agent('a', true, [agent('child', true)])], 30001)), []);
});

test('zero hold archives completion immediately and removed transcripts release slots', () => {
  const placement = createWorkspacePlacement(0);
  placement.update([agent('a'), agent('b')], 0);
  assert.deepEqual(ids(placement.update([agent('a', true), agent('b')], 1)), ['b']);
  assert.deepEqual(ids(placement.update([], 2)), []);
});

test('changing demo hold duration applies to the original completion time', () => {
  const placement = createWorkspacePlacement(15000);
  placement.update([agent('a'), agent('b')], 0);
  placement.update([agent('a', true), agent('b')], 1000);
  placement.setHoldMs(30000);
  assert.deepEqual(ids(placement.update([agent('b'), agent('a', true)], 20000)), ['a', 'b']);
  placement.setHoldMs(5000);
  assert.deepEqual(ids(placement.update([agent('b'), agent('a', true)], 20001)), ['b']);
});
