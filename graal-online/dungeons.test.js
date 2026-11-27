'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const createDungeons=require('./dungeons');
const {center}=require('./dungeon');
const ruins=require('./dungeon_ruins.json'),castle=require('./dungeon_castle.json');
const {createFixture,waitFor}=require('./dungeon_fixture');

test('dungeons have independent state and reject commands from another map',()=>{
  let time=1000;
  const players=new Map(),messages=new Map();
  for(const [id,map] of [[1,ruins],[2,castle]]){
    const spawn=center(map.spawn);
    players.set(id,{id,acc:'isolated-'+id,ok:true,in:true,ix:map.origin[0]+spawn.x,iy:map.origin[1]+spawn.y,hp:300,hm:300,ws:{id,readyState:1}});
    messages.set(id,[]);
  }
  const game=createDungeons({players,send:(ws,data)=>messages.get(ws.id).push(data),authorized:()=>true,now:()=>time});
  const command=(id,map,op,extra={})=>game.handle(players.get(id),{map:map.id,op,...extra});
  const state=(id,map)=>{command(id,map,'get');return messages.get(id).findLast(m=>m.op==='state'&&m.map===map.id);};
  assert.equal(state(1,ruins).inside,true);
  assert.equal(state(2,castle).inside,true);
  assert.equal(state(1,castle).inside,false);
  assert.notEqual(state(1,ruins).layout,state(2,castle).layout);
  for(const enemyId of ['guard_w','guard_e']){
    for(let hit=0;hit<12;hit++){
      const enemy=state(2,castle).enemies.find(e=>e.id===enemyId);
      if(enemy.hp<=0)break;
      const p=players.get(2);p.ix=castle.origin[0]+enemy.x;p.iy=castle.origin[1]+enemy.y+14;
      command(2,castle,'hit',{enemy:enemyId,weapon:'sword'});time+=1000;game.tick();
    }
  }
  assert.equal(state(2,castle).gates.guards_gate,true);
  assert.equal(state(1,ruins).gates.guards_gate,false);
  const key=center(castle.objects.find(o=>o.id==='key').cell),p=players.get(2);
  p.ix=castle.origin[0]+key.x;p.iy=castle.origin[1]+key.y+16;
  command(2,castle,'interact',{id:'key'});
  assert.equal(state(2,castle).key,true);
  assert.equal(state(1,ruins).key,false);
  command(1,castle,'interact',{id:'relic'});
  assert.equal(state(2,castle).relic,false);
  const count=messages.get(1).length;
  game.handle(players.get(1),{map:{id:castle.id},op:'get'});
  game.handle(players.get(1),{map:'unknown_dungeon',op:'get'});
  assert.equal(messages.get(1).length,count);
});

test('production WebSocket handler isolates explorers in different dungeons',{timeout:12000},async t=>{
  const f=await createFixture();t.after(()=>f.close());
  const first=await f.connect(ruins),second=await f.connect(castle);
  first.enter();second.enter();
  await waitFor(()=>first.state()?.inside&&second.state()?.inside);
  assert.equal(first.state().map,ruins.id);assert.equal(second.state().map,castle.id);
  first.send({map:castle.id,op:'get'});
  await waitFor(()=>first.messages.find(m=>m.t==='dungeon'&&m.map===castle.id&&m.op==='state'));
  assert.equal(first.messages.findLast(m=>m.map===castle.id&&m.op==='state').inside,false);
  first.send({map:castle.id,op:'interact',id:'key'});
  second.send({op:'get'});
  await waitFor(()=>second.state()?.inside);
  assert.equal(second.state().key,false);
});
