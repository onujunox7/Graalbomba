'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const createDungeon=require('./dungeon');
const {center}=createDungeon;
const map=require('./dungeon_castle.json');
function fixture(model=map){
  let clock=1000;
  const at=center(model.spawn),messages=[];
  const p={id:1,acc:'responsiveness-test',ok:true,in:true,ix:model.origin[0]+at.x,iy:model.origin[1]+at.y,hp:300,hm:300,ws:{readyState:1}};
  const game=createDungeon({map:model,players:new Map([[1,p]]),authorized:()=>true,send:(_ws,data)=>messages.push({at:clock,...data}),now:()=>clock});
  const state=()=>game.state(p);
  const move=(x,y)=>{p.ix=model.origin[0]+x;p.iy=model.origin[1]+y;};
  return{game,p,messages,state,move,advance(ms){clock+=ms;game.tick();}};
}
test('decorative brazier pedestal blocks a real body, while its flame is not a wall',()=>{
  const f=fixture(),at=center(map.torches.find(cell=>!f.game.blocked(center(cell).x,center(cell).y-26)));
  assert(f.game.blocked(at.x,at.y-2),'player walks through decorative brazier base');
  assert.equal(f.game.blocked(at.x,at.y-26),false,'flame must not create a tall invisible wall');
});
test('all24 enemies and pillar bases start in usable geometry',()=>{
  const f=fixture();assert.equal(map.enemies.length,24);
  for(const enemy of map.enemies){const at=center(enemy.cell);assert.equal(f.game.blocked(at.x,at.y,enemy.scale),false,enemy.id+' starts inside a collider');}
  for(const pillar of map.pillars){const at=center(pillar.cell);assert.equal(f.game.blocked(at.x,at.y),true,'pillar has no base collision');}
  for(const room of ['guards','hall','key','torches','boss','relic'])assert(map.enemies.filter(e=>e.room===room).length>=3,room+' lacks an encounter');
});
test('enemy routes around a pedestal without clipping and hits promptly on arrival',()=>{
  const enemy={...map.enemies[0],id:'guard_w',room:'guards',cell:[3,8],speed:64,scale:1};
  const arena={...map,w:16,h:16,origin:[0,0],spawn:[12,8],s:Buffer.alloc(256).toString('base64'),gates:[],objects:[],
    rooms:[{id:'guards',rect:[0,0,16,16]},{id:'boss',rect:[0,0,16,16]}],collision:[{id:'pedestal',rect:[60,32,16,72]}],
    enemies:[enemy,{...enemy,id:'warden',room:'boss',cell:[2,2],hp:0}]};
  const f=fixture(arena);let firstWindup;
  for(let i=0;i<100;i++){
    f.advance(50);const view=f.state().enemies[0];
    assert.equal(f.game.blocked(view.x,view.y),false,'enemy clipped through pedestal');
    if(view.phase==='windup'&&firstWindup===undefined)firstWindup=i*50;
    if(f.messages.some(m=>m.op==='hurt')){assert(i*50-firstWindup<=350,'attack took too long after telegraph');return;}
  }
  assert.fail('enemy remained stuck behind pedestal');
});
test('chest and lectern collision covers their visible pedestal width',()=>{
  const f=fixture();
  for(const kind of ['chest','plaque']){
    const at=center(map.objects.find(o=>o.kind===kind).cell);
    assert(f.game.blocked(at.x+12,at.y-3),kind+' visible base has no collision');
  }
});
test('moving enemy snapshots reach clients at least every60ms',()=>{
  const f=fixture(),enemy=f.state().enemies[0];
  f.move(enemy.x+44,enemy.y+16);
  for(let i=0;i<8;i++)f.advance(50);
  const snapshots=f.messages.filter(m=>m.op==='state');
  assert(snapshots.length>=7,'only '+snapshots.length+' snapshots over400ms');
  for(let i=1;i<snapshots.length;i++)assert(snapshots[i].at-snapshots[i-1].at<=60);
});
