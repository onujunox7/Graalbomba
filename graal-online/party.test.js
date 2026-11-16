'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createParties = require('./party');
function setup() {
  let time = 100000;
  const players = new Map(Array.from({length: 8}, (_, i) => [i + 1, {id: i + 1, nm: 'Player ' + (i + 1), auth: true, ws: {readyState: 1, messages: []}}]));
  const parties = createParties({players, send: (ws, m) => ws.messages.push(m), authorized: p => p.auth, now: () => time});
  const act = (id, op, extra = {}) => { time += 150; parties.handle(players.get(id), {op, ...extra}); };
  const last = id => players.get(id).ws.messages.at(-1);
  const state = id => { act(id, 'get'); return last(id).party; };
  const join = (leader, target) => { act(leader, 'invite', {id: target}); act(target, 'accept', {from: leader}); };
  return {players, parties, act, last, state, join, advance: ms => time += ms};
}
test('create, invite, accept, promote, kick and leave are server authoritative', () => {
  const s = setup(); s.act(1, 'create'); s.join(1, 2);
  assert.equal(s.state(2).members.length, 2);
  s.act(2, 'kick', {id: 1}); assert.equal(s.last(2).op, 'error');
  s.act(1, 'promote', {id: 2}); assert.equal(s.state(1).leader, 2);
  s.act(2, 'kick', {id: 1}); assert.equal(s.state(1), null);
  s.act(2, 'leave'); assert.equal(s.state(2), null);
});
test('invites require recipient consent, expire and can be declined', () => {
  const s = setup(); s.act(1, 'create'); s.act(1, 'invite', {id: 2});
  s.act(3, 'accept', {from: 1}); assert.equal(s.state(3), null);
  s.act(2, 'accept', {from: 3}); assert.equal(s.state(2), null);
  s.advance(60001); s.parties.tick(); s.act(2, 'accept', {from: 1}); assert.equal(s.state(2), null);
  s.act(1, 'invite', {id: 2}); s.act(2, 'decline', {from: 1});
  assert.equal(s.last(1).op, 'notice'); assert.equal(s.state(2), null);
});
test('capacity rechecked on acceptance; cannot belong to two groups', () => {
  const s = setup(); s.act(1, 'create');
  for (let id = 2; id <= 6; id++) s.act(1, 'invite', {id});
  for (let id = 2; id <= 6; id++) s.act(id, 'accept', {from: 1});
  assert.equal(s.state(1).members.length, 5); assert.equal(s.state(6), null);
  s.act(7, 'create'); s.act(7, 'invite', {id: 2}); assert.equal(s.last(7).op, 'error');
  s.act(2, 'create'); assert.equal(s.state(2).leader, 1);
});
test('disconnect transfers leadership and cancels invitations; reconnect is fresh', () => {
  const s = setup(); s.act(1, 'create'); s.join(1, 2); s.act(1, 'invite', {id: 3});
  s.parties.disconnect(1); s.players.delete(1);
  assert.equal(s.state(2).leader, 2); s.act(3, 'accept', {from: 1}); assert.equal(s.state(3), null);
  s.parties.disconnect(2); s.parties.disconnect(2); assert.equal(s.state(2), null);
});
test('leadership change cancels old invitations', () => {
  const s = setup(); s.act(1, 'create'); s.join(1, 2); s.act(1, 'invite', {id: 3});
  s.act(1, 'promote', {id: 2}); s.act(3, 'accept', {from: 1}); assert.equal(s.state(3), null);
});
test('rejects spoofed sessions, invalid targets, hidden players and unauthenticated requests', () => {
  const s = setup(); s.players.get(1).auth = false; s.act(1, 'create');
  assert.equal(s.last(1), undefined); s.players.get(1).auth = true;
  s.parties.handle({...s.players.get(1)}, {op: 'create'}); assert.equal(s.last(1), undefined);
  s.act(1, 'create');
  for (const id of [1, '2', 2.5, -1, {}, 99]) { s.act(1, 'invite', {id}); assert.equal(s.last(1).op, 'error'); }
  s.players.get(2).hid = 1; s.act(1, 'invite', {id: 2}); assert.equal(s.last(1).op, 'error');
});
test('invitation spam cannot replace an existing invitation and bursts are bounded', () => {
  const s = setup(); s.act(1, 'create'); s.act(2, 'create');
  s.act(1, 'invite', {id: 3}); s.act(2, 'invite', {id: 3}); assert.equal(s.last(2).op, 'error');
  assert.equal(s.players.get(3).ws.messages.at(-1).invitation.from, 1);
  s.advance(1000); const before = s.players.get(1).ws.messages.length;
  for (let i = 0; i < 100; i++) s.parties.handle(s.players.get(1), {op: 'get'});
  assert.equal(s.players.get(1).ws.messages.length - before, 8);
});
test('profile invitation creates a party atomically and recipient still must accept', () => {
  const s = setup(); s.act(1, 'invite', {id: 2});
  assert.equal(s.state(1).leader, 1);
  assert.equal(s.state(1).members.length, 1);
  assert.equal(s.state(2), null);
  s.act(2, 'accept', {from: 1}); assert.equal(s.state(2).members.length, 2);
});
test('invalid profile invitations do not create groups or discard pending invitations', () => {
  const s = setup(); s.act(3, 'invite', {id: 1});
  s.act(1, 'invite', {id: 99}); assert.equal(s.state(1), null);
  assert.equal(s.last(1).invitation.from, 3);
  s.act(1, 'invite', {id: 3}); assert.equal(s.state(1), null);
  s.act(1, 'invite', {id: 2}); assert.equal(s.state(1).leader, 1);
  assert.equal(s.last(1).invitation, null);
});
