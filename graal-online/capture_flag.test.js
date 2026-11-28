'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const create=require('./capture-flag'),{FIELD,OBSTACLES,BASES}=create.RULES;
const {fixture}=require('./capture_flag_fixture');

test('12 players, six per team, deterministic balanced bases and obstacle-safe spawn',()=>{
 const f=fixture(13);
 for(let id=1;id<=12;id++)f.request(id,'join',{team:id%2===1?0:1});
 f.request(13,'join',{team:0});assert.match(f.latest(13,'error').message,/6 jogadores/);
 f.advance(10000);f.advance(3000);const state=f.latest();assert.equal(state.players.length,12);assert.equal(state.flags.length,2);assert.ok(state.obstacles.length>=16);
 for(const team of [0,1])assert.equal(state.players.filter(p=>p.team===team).length,6);
 for(const p of state.players){assert.equal(p.hp,180);assert.equal(p.hm,180);assert.ok(!create.isBlocked(p));}
 const report=path.resolve(__dirname,'../../../reports/ctf-fixes-20261127');fs.mkdirSync(report,{recursive:true});fs.writeFileSync(path.join(report,'native-state.json'),JSON.stringify(state));
 fs.writeFileSync(path.join(report,'sword-rules.json'),JSON.stringify(create.RULES.SWORD_FRAMES));
 const samples=[];for(let y=0;y<=FIELD.h;y+=32)for(let x=0;x<=FIELD.w;x+=32){const point={x:FIELD.x+x,y:FIELD.y+y};samples.push({...point,blocked:create.isBlocked(point)});}
 fs.writeFileSync(path.join(report,'geometry-samples.json'),JSON.stringify(samples));
 assert.equal(FIELD.w,1280);assert.equal(FIELD.h,768);assert.ok(state.outline.length>20);
 assert.ok(new Set(OBSTACLES.map(o=>o.kind)).size>=6);
 for(const sample of samples)assert.equal(create.isBlocked({x:FIELD.x+FIELD.w-(sample.x-FIELD.x),y:sample.y}),sample.blocked,'map is unfairly asymmetric');
});

test('movement is server-owned, bounded, cannot cross walls or replay a command',()=>{
 const f=fixture();f.start();const p=f.players.get(1),obstacle=OBSTACLES.find(o=>o.kind==='boulder');f.route(1,{x:obstacle.x-18,y:obstacle.y+obstacle.h/2});
 for(let i=0;i<30;i++)f.step(1,1,0);
 assert.ok(p.x<=obstacle.x-6+.001,'crossed a solid obstacle');
 const x=p.x;f.request(1,'move',{seq:1,dx:1,dy:0,x:999999,y:999999});f.advance(50);assert.equal(p.x,x);
 f.request(1,'move',{seq:9999,dx:Infinity,dy:0});f.advance(50);assert.equal(p.x,x);
 assert.ok(p.x>=FIELD.x&&p.x<=FIELD.x+FIELD.w);
});

test('enemy flag is carried to its own base to score; three captures win and world state returns',()=>{
 const f=fixture();const back=structuredClone({...f.players.get(1),ws:null});f.start();
 for(let capture=1;capture<=3;capture++){
  f.route(1,BASES[1]);assert.equal(f.latest().flags[1].carrier,1);
  f.route(1,BASES[0]);assert.equal(f.latest().score[0],capture);
 }
 assert.equal(f.latest().phase,'finished');assert.equal(f.latest().winner,0);f.advance(3000);
 assert.equal(f.players.get(1).ctf,null);assert.equal(f.players.get(1).x,back.x);assert.equal(f.players.get(1).hp,back.hp);assert.equal(f.players.get(1).hm,back.hm);
});

test('own stolen flag blocks scoring until it is recovered; dropped flag returns automatically',()=>{
 const f=fixture();f.start();f.route(1,BASES[1]);f.route(2,BASES[0]);
 assert.equal(f.latest().flags[0].carrier,2);f.route(1,BASES[0]);assert.equal(f.latest().score[0],0);
 f.walk(2,BASES[0].x+75,BASES[0].y);f.request(2,'drop');f.walk(2,BASES[0].x+75,BASES[0].y-50);f.advance(16000);assert.equal(f.latest().flags[0].carrier,0);assert.equal(f.latest().flags[0].returning,0);
 assert.equal(f.latest().score[0],1,'capture did not happen after own flag came home');
});

test('confirmed hit drops flag, ignores forged damage and respects recovery window',()=>{
 const f=fixture();f.start();f.route(1,BASES[1]);f.walk(2,BASES[1].x-20,BASES[1].y);f.step(2,0.1,0);
 f.request(2,'hit',{damage:99999});assert.equal(f.latest().players.find(p=>p.id===1).hp,150);assert.equal(f.latest().flags[1].carrier,0);
 f.request(2,'hit');assert.equal(f.latest().players.find(p=>p.id===1).hp,150);
});

test('leave/disconnect cleans roster and queues and cannot keep carrying a flag',()=>{
 const f=fixture();f.start();f.route(1,BASES[1]);f.ctf.disconnect(1);
 assert.equal(f.players.get(1).ctf,null);assert.equal(f.latest(2).phase,'finished');assert.equal(f.latest(2).flags[1].carrier,0);
 f.advance(3000);assert.equal(f.players.get(2).ctf,null);assert.equal(f.ctf.has(f.players.get(2)),false);
});

test('authorization and incompatible modes reject joining and packet flood cannot speed up simulation',()=>{
 for(const bad of [{allowed:false},{football:'match'},{spar:'match'},{sparPending:'match'},{in:1},{mt:1},{cy:1},{hp:0},{hid:1}]){
  const f=fixture();Object.assign(f.players.get(1),bad);f.request(1,'join',{team:0});assert.equal(f.ctf.has(f.players.get(1)),false);
 }
 const f=fixture();f.start();const x=f.players.get(1).x;
 for(let i=1;i<=500;i++)f.request(1,'move',{seq:i,dx:1,dy:0});f.advance(50);
 assert.ok(f.players.get(1).x-x<=6.251);
});

test('six hits defeat a player; waiting alone does not revive and movement returns them to their own base',()=>{
 const f=fixture();f.start();f.route(1,BASES[1]);
 for(let hit=1;hit<=6;hit++){
  const victim=f.latest().players.find(p=>p.id===1);f.walk(2,victim.x-20,victim.y);f.step(2,.01,0);
  f.request(2,'hit');assert.equal(f.latest().players.find(p=>p.id===1).hp,180-hit*30);f.advance(2000);
 }
 f.advance(5000);assert.equal(f.latest().players.find(p=>p.id===1).hp,0);
 f.step(1,-1,0);f.advance(50);const revived=f.latest().players.find(p=>p.id===1);
 assert.equal(revived.hp,180);assert.ok(Math.abs(revived.x-(BASES[0].x+40))<1);assert.ok(revived.inv>0);
});

test('match timeout ends in a draw and restores both players without changing their world health',()=>{
 const f=fixture();f.start();f.advance(create.RULES.DURATION);assert.equal(f.latest().phase,'finished');assert.equal(f.latest().winner,-1);
 f.advance(3000);assert.equal(f.players.get(1).hp,61);assert.equal(f.players.get(2).hp,62);assert.equal(f.ctf.has(f.players.get(1)),false);
});

test('upper, central and lower routes remain connected between the two bases',()=>{
 for(const offset of [88,384,680]){
  const f=fixture();f.start();f.route(1,{x:FIELD.x+FIELD.w/2,y:FIELD.y+offset});f.route(1,BASES[1]);
  assert.equal(f.latest().flags[1].carrier,1,'route cannot reach the opposing flag');
 }
});
