'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, waitFor } = require('./dungeon_fixture');
const { MAP, center } = require('./dungeon');

test('dois clientes comuns compartilham estado e rejeitam salto através da dungeon', { timeout: 12000 }, async t => {
  const f = await createFixture();
  t.after(() => f.close());
  const first = await f.connect(), second = await f.connect(), outside = await f.connect();
  first.enter(); second.enter(); outside.send({ op: 'get' });
  await waitFor(() => first.state()?.inside && second.state()?.inside);
  assert.equal(outside.state().inside, false);
  assert.equal(first.state().enemies.length, 3);
  assert.deepEqual(first.state().gates, second.state().gates);
  const enemy = first.state().enemies[0];
  first.send({ op: 'hit', enemy: enemy.id, damage: 999999, role: 2 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(first.state().enemies[0].hp, enemy.hp);
  first.update(84, 84);
  await waitFor(() => first.messages.some(message => message.op === 'position'));
  const spawn = center(MAP.spawn), player = f.players.get(first.id);
  assert.equal(player.ix, MAP.origin[0] + spawn.x);
  assert.equal(player.iy, MAP.origin[1] + spawn.y);
  first.send({ op: 'interact', id: 'key' });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(second.state().key, false);
});
