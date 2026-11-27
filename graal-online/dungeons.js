'use strict';
const createDungeon = require('./dungeon');
const maps = [require('./dungeon_ruins.json'), require('./dungeon_castle.json')];
module.exports = function createDungeons(options) {
  const instances = new Map(maps.map(map => [map.id, createDungeon({ ...options, map })]));
  return {
    handle(player, message) {
      const id = message.map === undefined ? maps[0].id : message.map;
      if (typeof id !== 'string') return;
      instances.get(id)?.handle(player, message);
    },
    correct(player) {
      for (const dungeon of instances.values()) if (dungeon.contains(player)) dungeon.correct(player);
    },
    tick() { for (const dungeon of instances.values()) dungeon.tick(); }
  };
};
