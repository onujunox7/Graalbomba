'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const create=require('./capture-flag'),{fixture}=require('./capture_flag_fixture');
const {OBSTACLES,BASES}=create.RULES;

test('ponds are swimmable while stones and curved arena boundary remain solid',()=>{
 for(const pond of OBSTACLES.filter(o=>o.kind==='pond'))assert.equal(create.isBlocked({x:pond.x+pond.w/2,y:pond.y+pond.h/2}),false,'server still blocks a pond accepted by the native client');
 const stone=OBSTACLES.find(o=>o.kind==='boulder');assert.equal(create.isBlocked({x:stone.x+stone.w/2,y:stone.y+stone.h/2}),true);
 assert.equal(create.isBlocked({x:0,y:0}),true);
});

test('native visible sword contact damages the carrier and drops the flag for both teams',()=>{
 for(const carrier of [1,2]){
  const f=fixture();f.start();const attacker=carrier===1?2:1,enemyTeam=carrier===1?1:0;
  f.route(carrier,BASES[enemyTeam]);assert.equal(f.latest().flags[enemyTeam].carrier,carrier);
  const victim=f.players.get(carrier);f.route(attacker,{x:victim.x-20,y:victim.y+24});
  f.request(attacker,'hit',{to:carrier,sw:1,face:3});
  const state=f.latest();assert.equal(state.players.find(p=>p.id===carrier).hp,150,'visible diagonal sword contact was ignored');
  assert.equal(state.flags[enemyTeam].carrier,0,'confirmed hit kept the flag on its carrier');
  assert(state.flags[enemyTeam].returning>0);assert.equal(state.score[1-enemyTeam],0);
 }
});

test('the visible base platform scores at radius 30 and outside it does not',()=>{
 const f=fixture();f.start();f.route(1,BASES[1]);
 f.route(1,{x:BASES[0].x+45,y:BASES[0].y});assert.equal(f.latest().score[0],0);
 f.walk(1,BASES[0].x+30,BASES[0].y);f.advance(100);assert.equal(f.latest().score[0],1,'feet are on the base but the server does not count the capture');
 f.advance(100);assert.equal(f.latest().score[0],1,'capture was counted twice');
});

test('swimming is published consistently and a carried flag returns home in a pond',()=>{
 const f=fixture();f.start();f.route(1,BASES[1]);const pond=OBSTACLES.find(o=>o.kind==='pond');
 f.route(1,{x:pond.x+pond.w/2,y:pond.y+pond.h/2});f.advance(100);
 const state=f.latest();assert.equal(state.players.find(p=>p.id===1).wet,1);assert.equal(state.players.find(p=>p.id===1).sw,1);
 assert.equal(state.flags[1].carrier,0);assert.equal(state.flags[1].returning,0);assert.equal(state.flags[1].x,BASES[1].x);assert.equal(state.flags[1].y,BASES[1].y);
});

test('native sword rejects forged inputs, remote targets and replayed swings without losing compatibility',()=>{
 const f=fixture();f.start();f.route(1,BASES[1]);const victim=f.players.get(1);f.route(2,{x:victim.x-20,y:victim.y+24});
 for(const fields of [{to:1,sw:1,face:9},{to:1,sw:-1,face:3},{to:1,sw:'1',face:3},{to:1,sw:Infinity,face:3},{to:2,sw:1,face:3},{to:1,sw:1.5,face:3}])f.request(2,'hit',fields);
 assert.equal(f.latest().players.find(p=>p.id===1).hp,180);assert.equal(f.latest().flags[1].carrier,1);
 f.advance(250);f.step(2,.01,0);f.request(2,'hit',{to:1,sw:2}); // Older native client: facing was already updated by movement.
 assert.equal(f.latest().players.find(p=>p.id===1).hp,150);assert.equal(f.latest().flags[1].carrier,0);
 f.advance(2100);f.request(2,'hit',{to:1,sw:2});assert.equal(f.latest().players.find(p=>p.id===1).hp,150,'same swing dealt damage again after invulnerability');
 f.request(2,'hit',{to:1,sw:1,face:3});assert.equal(f.latest().players.find(p=>p.id===1).hp,150,'older swing replay accepted');
 const before=f.players.get(2),x=before.x,y=before.y;f.route(2,{x:x-110,y});f.advance(250);f.request(2,'hit',{to:1,sw:3,face:3,damage:9999,x:victim.x,y:victim.y});assert.equal(f.latest().players.find(p=>p.id===1).hp,150,'forged coordinates expanded sword reach');
});

test('a native swing cannot bypass recovery or hit the same target twice',()=>{
 const f=fixture(4);f.start();f.route(1,BASES[1]);const target=f.players.get(1);
 f.route(3,{x:target.x-5,y:target.y});f.route(2,{x:target.x-20,y:target.y+24});
 f.request(2,'hit',{to:1,sw:10,face:3});assert.equal(f.latest().players.find(p=>p.id===1).hp,150);
 f.request(2,'hit',{to:3,sw:11,face:3});assert.equal(f.latest().players.find(p=>p.id===3).hp,180,'new swing bypassed the 200ms attack cooldown');
 f.request(2,'hit',{to:3,sw:10,face:3});assert.equal(f.latest().players.find(p=>p.id===3).hp,150,'one swing should reach a second valid opponent');
 f.request(2,'hit',{to:3,sw:10,face:3});assert.equal(f.latest().players.find(p=>p.id===3).hp,150);
});
