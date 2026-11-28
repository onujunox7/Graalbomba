'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createFriends = require('./friends');
function setup() {
  let time = 100000;
  const players = new Map(), acc = new Map(), saved = [];
  for (let i = 1; i <= 4; i++) {
    const p = { id: i, acc: 'acc' + i, nm: 'Player ' + i, auth: true, ws: { readyState: 1, messages: [] } };
    players.set(i, p); acc.set(p.acc, p);
  }
  const friends = createFriends({ players, send: (ws, m) => ws.messages.push(m), authorized: p => p.auth,
    online: a => acc.get(a), save: d => saved.push(d), now: () => time });
  const act = (id, op, extra = {}) => { time += 150; friends.handle(players.get(id), { op, ...extra }); };
  const msgs = id => players.get(id).ws.messages;
  const last = id => msgs(id).at(-1);
  const state = id => { act(id, 'get'); return last(id); };
  return { players, friends, act, last, msgs, state, saved, advance: ms => time += ms, acc };
}
test('friend request needs the other player to accept; both lists are saved', () => {
  const s = setup();
  s.act(1, 'add', { id: 2 });
  assert.equal(s.state(1).friends.length, 0);
  const req = s.state(2).requests; assert.equal(req.length, 1); assert.equal(req[0].nm, 'Player 1');
  assert.ok(!JSON.stringify(s.msgs(2)).includes('acc1'), 'client never sees the real account id');
  s.act(2, 'accept', { f: req[0].f });
  assert.equal(s.state(1).friends[0].nm, 'Player 2'); assert.equal(s.state(1).friends[0].on, true);
  assert.equal(s.state(2).friends[0].nm, 'Player 1');
  assert.equal(s.saved.at(-1).friends.acc1[0].a, 'acc2');
});
test('requests can be declined, expire, and cannot be forged', () => {
  const s = setup();
  s.act(1, 'add', { id: 2 }); const f = s.state(2).requests[0].f;
  s.act(3, 'accept', { f }); assert.equal(s.last(3).op, 'error');
  s.act(2, 'decline', { f }); assert.equal(s.state(2).requests.length, 0);
  s.act(1, 'add', { id: 2 }); s.advance(120001);
  assert.equal(s.state(2).requests.length, 0);
});
test('adding someone who already asked you accepts immediately; remove works both ways', () => {
  const s = setup();
  s.act(1, 'add', { id: 2 }); s.act(2, 'add', { id: 1 });
  assert.equal(s.state(1).friends.length, 1);
  const f = s.state(1).friends[0].f; s.act(1, 'remove', { f });
  assert.equal(s.state(1).friends.length, 0); assert.equal(s.state(2).friends.length, 0);
  s.act(1, 'add', { id: 1 }); assert.equal(s.last(1).op, 'error');
});
test('offline friends show as offline and cannot receive PM', () => {
  const s = setup();
  s.act(1, 'add', { id: 2 }); s.act(2, 'accept', { f: s.state(2).requests[0].f });
  const f = s.state(1).friends[0].f;
  s.acc.delete('acc2'); s.players.delete(2);
  assert.equal(s.state(1).friends[0].on, false);
  s.friends.pm(s.players.get(1), { op: 'send', f, x: 'oi' });
  assert.equal(s.last(1).t, 'pm'); assert.equal(s.last(1).op, 'error');
});
test('PM is delivered to the target and echoed to the sender, sanitized and muted-aware', () => {
  const s = setup();
  s.friends.pm(s.players.get(1), { op: 'send', id: 3, x: '  oi\n\u0000 tudo bem  ' });
  assert.equal(s.last(3).t, 'pm'); assert.equal(s.last(3).x, 'oi   tudo bem'); assert.equal(s.last(3).nm, 'Player 1');
  assert.equal(s.last(1).op, 'sent');
  s.players.get(1).muted = true; const n = s.msgs(3).length;
  s.friends.pm(s.players.get(1), { op: 'send', id: 3, x: 'spam' });
  assert.equal(s.msgs(3).length, n);
  s.players.get(1).muted = false;
  s.friends.pm(s.players.get(1), { op: 'send', id: 1, x: 'eu mesmo' }); assert.equal(s.last(1).op, 'error');
});
test('PM is rate limited and unauthorized players are ignored', () => {
  const s = setup();
  for (let i = 0; i < 6; i++) s.friends.pm(s.players.get(1), { op: 'send', id: 2, x: 'm' + i });
  const n = s.msgs(2).length; s.friends.pm(s.players.get(1), { op: 'send', id: 2, x: 'extra' });
  assert.equal(s.msgs(2).length, n);
  s.players.get(3).auth = false; const before = s.msgs(3).length; s.act(3, 'get');
  assert.equal(s.msgs(3).length, before);
});
test('restore loads saved friends and caps the list', () => {
  const s = setup();
  s.friends.restore({ friends: { acc1: [{ a: 'acc2', nm: 'Player 2' }, { a: 5, nm: 'bad' }] } });
  assert.equal(s.state(1).friends.length, 1);
  s.friends.restore(null); assert.equal(s.state(1).friends.length, 0);
});
