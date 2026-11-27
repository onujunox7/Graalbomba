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
  }throw new Error('path did not reach waypoint '+x+','+y+' from '+players.get(id).x+','+players.get(id).y);
 }
 function route(id,target){
  const cell=24,cols=Math.floor(FIELD.w/cell),rows=Math.floor(FIELD.h/cell);
  const point=index=>({x:FIELD.x+(index%cols)*cell+cell/2,y:FIELD.y+Math.floor(index/cols)*cell+cell/2});
  const free=index=>index>=0&&index<cols*rows&&!create.isBlocked(point(index));
  const nearest=p=>{let best=-1,dist=Infinity;for(let i=0;i<cols*rows;i++)if(free(i)){const d=Math.hypot(point(i).x-p.x,point(i).y-p.y);if(d<dist){dist=d;best=i;}}return best;};
  const from=nearest(players.get(id)),to=nearest(target),queue=[from],prev=new Map([[from,-1]]);
  const traversable=(a,b)=>{for(let t=0;t<=1;t+=.1)if(create.isBlocked({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}))return false;return true;};
  for(let at=0;at<queue.length&&!prev.has(to);at++){
   const current=queue[at];for(const delta of [-cols,cols,-1,1]){
    const next=current+delta;if(!free(next)||prev.has(next)||Math.abs((next%cols)-(current%cols))+Math.abs(Math.floor(next/cols)-Math.floor(current/cols))!==1||!traversable(point(current),point(next)))continue;
    prev.set(next,current);queue.push(next);
   }
  }
  assert.ok(prev.has(to),'bases are disconnected');const path=[];for(let node=to;node!==-1;node=prev.get(node))path.push(point(node));
  for(const waypoint of path.reverse())walk(id,waypoint.x,waypoint.y);walk(id,target.x,target.y);
 }
 return {ctf,players,messages,request,advance,latest,start,pos,step,walk,route};
}

test('12 players, six per team, deterministic balanced bases and obstacle-safe spawn',()=>{
 const f=fixture(13);
 for(let id=1;id<=12;id++)f.request(id,'join',{team:id%2===1?0:1});
 f.request(13,'join',{team:0});assert.match(f.latest(13,'error').message,/6 jogadores/);
 f.advance(10000);f.advance(3000);const state=f.latest();assert.equal(state.players.length,12);assert.equal(state.flags.length,2);assert.ok(state.obstacles.length>=16);
 for(const team of [0,1])assert.equal(state.players.filter(p=>p.team===team).length,6);
 for(const p of state.players){assert.equal(p.hp,180);assert.equal(p.hm,180);assert.ok(!create.isBlocked(p));}
 const report=path.resolve(__dirname,'../../../reports/capture-flag-20261126');fs.writeFileSync(path.join(report,'native-state.json'),JSON.stringify(state));
 const samples=[];for(let y=0;y<=FIELD.h;y+=32)for(let x=0;x<=FIELD.w;x+=32){const point={x:FIELD.x+x,y:FIELD.y+y};samples.push({...point,blocked:create.isBlocked(point)});}
 fs.writeFileSync(path.join(report,'geometry-samples.json'),JSON.stringify(samples));
 assert.equal(FIELD.w,1280);assert.equal(FIELD.h,768);assert.ok(state.outline.length>20);
 assert.ok(new Set(OBSTACLES.map(o=>o.kind)).size>=6);
 for(const sample of samples)assert.equal(create.isBlocked({x:FIELD.x+FIELD.w-(sample.x-FIELD.x),y:sample.y}),sample.blocked,'map is unfairly asymmetric');
});

test('movement is server-owned, bounded, cannot cross walls or replay a command',()=>{
 const f=fixture();f.start();const p=f.players.get(1),obstacle=OBSTACLES[0];f.route(1,{x:obstacle.x-18,y:obstacle.y+obstacle.h/2});
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
