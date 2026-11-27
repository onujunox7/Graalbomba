'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const create=require('./capture-flag'),{FIELD,OBSTACLES,BASES}=create.RULES;
function fixture(n=2){
 let time=100000;const players=new Map(),messages=new Map(),sequence=new Map();
 for(let id=1;id<=n;id++){players.set(id,{id,nm:'Jogador '+id,ws:{readyState:1},allowed:true,ok:1,x:6704+id,y:17104,hp:60+id,hm:60+id,lv:id===1?1:999,an:'Idle_Down'});messages.set(id,[]);}
 const ctf=create({players,send:(ws,m)=>{const p=[...players.values()].find(p=>p.ws===ws);if(p)messages.get(p.id).push(structuredClone(m));},authorized:p=>p.allowed,now:()=>time});
 const latest=(id=1,op='state')=>messages.get(id).findLast(m=>m.op===op);
 const request=(id,op,fields={})=>ctf.handle(players.get(id),{op,...fields});
 const advance=ms=>{time+=ms;ctf.tick();};
 function start(){for(const id of players.keys())request(id,'join',{team:id%2===1?0:1});advance(10000);assert.equal(latest().phase,'countdown');advance(3000);assert.equal(latest().phase,'playing');}
 function pos(id){const state=latest(id);return state.players.find(p=>p.id===id);}
 function step(id,dx,dy){const seq=(sequence.get(id)||0)+1;sequence.set(id,seq);request(id,'move',{seq,dx,dy});advance(50);}
 function walk(id,x,y){
  for(let i=0;i<500;i++){
   if(latest(id)?.phase==='finished')return;
   const p=players.get(id),dx=x-p.x,dy=y-p.y;
   if(Math.hypot(dx,dy)<5)return;
   const speed=latest(id)?.players.find(p=>p.id===id)?.speed||125;
   step(id,Math.max(-1,Math.min(1,dx/(speed*.05))),Math.max(-1,Math.min(1,dy/(speed*.05))));
  }throw new Error('path did not reach waypoint');
 }
 const viaTop=(id,target)=>{walk(id,players.get(id).x,FIELD.y+24);walk(id,target.x,FIELD.y+24);walk(id,target.x,target.y);};
 return {ctf,players,messages,request,advance,latest,start,pos,step,walk,viaTop};
}

test('12 players, six per team, deterministic balanced bases and obstacle-safe spawn',()=>{
 const f=fixture(13);
 for(let id=1;id<=12;id++)f.request(id,'join',{team:id%2===1?0:1});
 f.request(13,'join',{team:0});assert.match(f.latest(13,'error').message,/6 jogadores/);
 f.advance(10000);f.advance(3000);const state=f.latest();assert.equal(state.players.length,12);assert.equal(state.flags.length,2);assert.ok(state.obstacles.length>=6);
 for(const team of [0,1])assert.equal(state.players.filter(p=>p.team===team).length,6);
 for(const p of state.players){assert.equal(p.hp,180);assert.equal(p.hm,180);assert.ok(!OBSTACLES.some(o=>p.x>o.x-6&&p.x<o.x+o.w+6&&p.y>o.y-6&&p.y<o.y+o.h+6));}
 const report=path.resolve(__dirname,'../../../reports/capture-flag-20261126');fs.writeFileSync(path.join(report,'native-state.json'),JSON.stringify(state));
});

test('movement is server-owned, bounded, cannot cross walls or replay a command',()=>{
 const f=fixture();f.start();const p=f.players.get(1);f.walk(1,FIELD.x+90,FIELD.y+80);
 for(let i=0;i<30;i++)f.step(1,1,0);
 assert.ok(p.x<=FIELD.x+112-6+.001,'crossed a solid obstacle');
 const x=p.x;f.request(1,'move',{seq:1,dx:1,dy:0,x:999999,y:999999});f.advance(50);assert.equal(p.x,x);
 f.request(1,'move',{seq:9999,dx:Infinity,dy:0});f.advance(50);assert.equal(p.x,x);
 assert.ok(p.x>=FIELD.x&&p.x<=FIELD.x+FIELD.w);
});

test('enemy flag is carried to its own base to score; three captures win and world state returns',()=>{
 const f=fixture();const back=structuredClone({...f.players.get(1),ws:null});f.start();
 for(let capture=1;capture<=3;capture++){
  f.viaTop(1,BASES[1]);assert.equal(f.latest().flags[1].carrier,1);
  f.viaTop(1,BASES[0]);assert.equal(f.latest().score[0],capture);
 }
 assert.equal(f.latest().phase,'finished');assert.equal(f.latest().winner,0);f.advance(3000);
 assert.equal(f.players.get(1).ctf,null);assert.equal(f.players.get(1).x,back.x);assert.equal(f.players.get(1).hp,back.hp);assert.equal(f.players.get(1).hm,back.hm);
});

test('own stolen flag blocks scoring until it is recovered; dropped flag returns automatically',()=>{
 const f=fixture();f.start();f.viaTop(1,BASES[1]);f.viaTop(2,BASES[0]);
 assert.equal(f.latest().flags[0].carrier,2);f.viaTop(1,BASES[0]);assert.equal(f.latest().score[0],0);
 f.walk(2,BASES[0].x+75,BASES[0].y);f.request(2,'drop');f.walk(2,BASES[0].x+75,BASES[0].y-50);f.advance(16000);assert.equal(f.latest().flags[0].carrier,0);assert.equal(f.latest().flags[0].returning,0);
 assert.equal(f.latest().score[0],1,'capture did not happen after own flag came home');
});

test('confirmed hit drops flag, ignores forged damage and respects recovery window',()=>{
 const f=fixture();f.start();f.viaTop(1,BASES[1]);f.walk(2,BASES[1].x-20,BASES[1].y);f.step(2,0.1,0);
 f.request(2,'hit',{damage:99999});assert.equal(f.latest().players.find(p=>p.id===1).hp,150);assert.equal(f.latest().flags[1].carrier,0);
 f.request(2,'hit');assert.equal(f.latest().players.find(p=>p.id===1).hp,150);
});

test('leave/disconnect cleans roster and queues and cannot keep carrying a flag',()=>{
 const f=fixture();f.start();f.viaTop(1,BASES[1]);f.ctf.disconnect(1);
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
 const f=fixture();f.start();f.viaTop(1,BASES[1]);
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
