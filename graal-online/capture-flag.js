'use strict';

const FIELD=Object.freeze({x:512,y:2048,w:1280,h:768});
function smooth(points){
 for(let pass=0;pass<2;pass++){
  const next=[];for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];next.push({x:a.x*.75+b.x*.25,y:a.y*.75+b.y*.25},{x:a.x*.25+b.x*.75,y:a.y*.25+b.y*.75});}points=next;
 }return points;
}
const OUTLINE=Object.freeze(smooth([[16,280],[64,160],[256,48],[416,96],[544,24],[736,24],[864,96],[1024,48],[1216,160],[1264,280],
 [1264,488],[1216,608],[1024,720],[864,672],[736,744],[544,744],[416,672],[256,720],[64,608],[16,488]].map(([x,y])=>({x:FIELD.x+x,y:FIELD.y+y}))).map(Object.freeze));
const half=[['pond',336,136,168,96],['pond',384,536,128,104],['boulder',240,280,64,48],['tree',288,424,56,56],
 ['crate',168,144,48,40],['crate',200,584,48,40],['ruins',496,288,32,128],['ruins',496,288,96,28],['hedge',376,352,104,44],['tree',512,72,48,48]];
const OBSTACLES=Object.freeze([...half,...half.map(([kind,x,y,w,h])=>[kind,FIELD.w-x-w,y,w,h]),
 ['pond',600,120,80,192],['pond',600,456,80,192]].map(([kind,x,y,w,h])=>Object.freeze({kind,x:FIELD.x+x,y:FIELD.y+y,w,h})));
const TEAM_SIZE=6,HP=180,DAMAGE=30,STEP=50,SPEED=125,DURATION=300000,TARGET=3,RADIUS=6;
const CAPTURE_RADIUS=34; // Same stone platform radius drawn by GCtfArt._base.
// GSkinRig.sword_frame_bounds at scale 1: five visible sword frames per facing.
const SWORD_FRAMES=[[[14,-41,16,28],[-10,-57,14,20],[-16,-63,10,22],[-24,-53,10,24],[-40,-39,24,28]],
 [[-26,-39,28,28],[-40,-39,24,28],[-42,-13,34,12],[-38,-7,28,28],[-28,3,28,24]],
 [[-28,-15,28,28],[-26,-1,28,24],[2,9,12,24],[8,-1,14,24],[18,-9,24,28]],
 [[-2,-39,28,28],[12,-39,24,28],[14,-13,34,12],[10,-7,28,28],[0,3,28,24]]];
function swordContact(attacker,target,face,scale){
 return SWORD_FRAMES[face].some(([x,y,w,h])=>{
  const left=attacker.x+x*scale,top=attacker.y+y*scale;
  const nearX=Math.max(left,Math.min(left+w*scale,target.x));
  const nearY=Math.max(top,Math.min(top+h*scale,target.y-6));
  return (nearX-target.x)**2+(nearY-target.y+6)**2<=64;
 });
}
const BASES=Object.freeze([{x:FIELD.x+128,y:FIELD.y+FIELD.h/2},{x:FIELD.x+FIELD.w-128,y:FIELD.y+FIELD.h/2}]);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const inside=(p,r,pad=0)=>p.x>r.x-pad&&p.y>r.y-pad&&p.x<r.x+r.w+pad&&p.y<r.y+r.h+pad;
const roundObstacle=o=>['pond','boulder','tree','hedge'].includes(o.kind);
function obstacleHit(p,o,radius=RADIUS){
 if(!roundObstacle(o))return inside(p,o,radius);
 const dx=(p.x-o.x-o.w/2)/(o.w/2+radius),dy=(p.y-o.y-o.h/2)/(o.h/2+radius);return dx*dx+dy*dy<1-1e-8;
}
function inOutline(p){
 let hit=false;for(let i=0,j=OUTLINE.length-1;i<OUTLINE.length;j=i++){
  const a=OUTLINE[i],b=OUTLINE[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;
 }return hit;
}
function edgeDistanceSquared(p,a,b){
 const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));
 return (p.x-a.x-t*dx)**2+(p.y-a.y-t*dy)**2;
}
const blocked=p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||!inOutline(p)||OUTLINE.some((a,i)=>edgeDistanceSquared(p,a,OUTLINE[(i+1)%OUTLINE.length])<RADIUS*RADIUS-1e-8)||OBSTACLES.some(o=>o.kind!=='pond'&&obstacleHit(p,o));
const inWater=p=>OBSTACLES.some(o=>o.kind==='pond'&&obstacleHit({x:p.x,y:p.y-2},o,0));
function move(entry,dx,dy){
 const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/3));
 for(let i=0;i<steps;i++){
  const x=entry.x+dx/steps;if(!blocked({x,y:entry.y}))entry.x=x;
  const y=entry.y+dy/steps;if(!blocked({x:entry.x,y}))entry.y=y;
 }
}

module.exports=function createCaptureFlag({players,send,authorized,viewPlayer=p=>({id:p.id,nm:p.nm}),eligible=()=>true,now=Date.now}){
 const queue=new Map(),matches=new Map(),members=new Map(),rates=new Map();let nextId=1,queueUntil=0;
 const live=p=>!!p&&players.get(p.id)===p&&p.ws.readyState===1&&authorized(p);
 const emit=(p,m)=>{if(p?.ws.readyState===1)send(p.ws,{t:'ctf',...m});};
 const error=(p,message)=>emit(p,{op:'error',message});
 const count=team=>[...queue.values()].filter(q=>q.team===team).length;
 const canJoin=p=>live(p)&&eligible(p)&&p.ok&&!p.hid&&!p.in&&!p.spar&&!p.sparPending&&!p.football&&!p.fishing&&!p.mt&&!p.cy&&p.hp>0&&Number.isFinite(p.x)&&Number.isFinite(p.y);
 const queuePacket=id=>({op:'queue',supported:1,joined:queue.has(id),team:queue.get(id)?.team??-1,teams:[count(0),count(1)],capacity:TEAM_SIZE,starts:Math.max(0,queueUntil-now())});
 function queueState(){
  if(!count(0)||!count(1))queueUntil=0;else if(!queueUntil)queueUntil=now()+10000;
  for(const id of queue.keys())emit(players.get(id),queuePacket(id));
 }
 function home(flag){Object.assign(flag,{...BASES[flag.team],carrier:0,returnAt:0,blockedId:0,blockedUntil:0});}
 function flagFor(match,id){return match.flags.find(f=>f.carrier===id);}
 function drop(match,id){
  const flag=flagFor(match,id),entry=match.entries.get(id);if(!flag||!entry)return;
  Object.assign(flag,{x:entry.x,y:entry.y,carrier:0,returnAt:now()+15000,blockedId:id,blockedUntil:now()+1000});
  match.notice='Bandeira derrubada!';
 }
 function spawn(match,entry){
  const slot=[...match.entries.values()].filter(e=>e.team===entry.team).findIndex(e=>e.id===entry.id);
  entry.x=BASES[entry.team].x+(entry.team===0?1:-1)*40;
  entry.y=BASES[entry.team].y+(slot-2.5)*36;
  Object.assign(entry,{hp:HP,hitUntil:now()+2000,hurtUntil:0,respawnAt:0,inputs:[],dir:{x:0,y:0}});
 }
 function state(match){
  const time=now();return {op:'state',match:match.id,phase:match.phase,field:FIELD,outline:OUTLINE,obstacles:OBSTACLES,bases:BASES,
   flags:match.flags.map(f=>({team:f.team,x:f.x,y:f.y,carrier:f.carrier,returning:Math.max(0,f.returnAt-time)})),score:[...match.score],target:TARGET,
   remaining:Math.max(0,(match.ends||time+DURATION)-time),wait:Math.max(0,match.until-time),winner:match.winner??-1,notice:match.notice||'',
   players:[...match.entries.values()].map(e=>({...viewPlayer(players.get(e.id)),id:e.id,team:e.team,x:e.x,y:e.y,hp:e.hp,hm:HP,ack:e.ack,
    face:e.face,an:(e.hp===0?'Hurt_':time<e.attackUntil?'Attack_':e.dir.x||e.dir.y?'Run_':'Idle_')+['Up','Left','Down','Right'][e.face],
    speed:flagFor(match,e.id)?SPEED*0.82:SPEED,inv:Math.max(0,e.hitUntil-time),wet:inWater(e)?1:0,sw:inWater(e)?1:0,respawn:Math.max(0,e.respawnAt-time)}))};
 }
 function snapshot(match){
  for(const e of match.entries.values()){const p=players.get(e.id);if(p){p.x=e.x;p.y=e.y;p.hp=e.hp;p.hm=HP;}}
  const packet=state(match);for(const id of match.entries.keys())emit(players.get(id),packet);match.sent=now();
 }
 function restore(p,entry,reason,winner=-1){
  members.delete(entry.id);if(!p)return;Object.assign(p,entry.back,{ctf:null,ctfQueued:false});
  emit(p,{op:'end',reason,winner,team:entry.team,x:p.x,y:p.y});
 }
 function finish(match,reason){
  if(match.phase==='finished')return;match.phase='finished';match.reason=reason;match.until=now()+3000;
  match.winner=match.score[0]===match.score[1]?-1:match.score[0]>match.score[1]?0:1;
  if(reason==='forfeit')match.winner=[...match.entries.values()][0]?.team??-1;
  for(const entry of match.entries.values()){entry.inputs=[];entry.dir={x:0,y:0};}snapshot(match);
 }
 function start(){
  const entries=new Map(),id='ctf-'+nextId++;
  for(const [pid,choice]of queue){const p=players.get(pid);if(canJoin(p)){
   entries.set(pid,{id:pid,team:choice.team,back:{x:p.x,y:p.y,hp:p.hp,hm:p.hm,an:p.an,mt:p.mt,cy:p.cy},
    hp:HP,x:0,y:0,face:choice.team===0?3:1,seq:0,ack:0,inputs:[],dir:{x:0,y:0},lastInput:now(),attackAt:-1000,attackUntil:0});
  }else{if(p)p.ctfQueued=false;queue.delete(pid);}}
  if(![0,1].every(team=>[...entries.values()].some(e=>e.team===team))){queueState();return;}
  const match={id,entries,score:[0,0],flags:BASES.map((base,team)=>({...base,team,carrier:0,returnAt:0})),phase:'countdown',until:now()+3000,ends:0,stepped:now(),sent:0};
  matches.set(id,match);
  for(const entry of entries.values()){
   const p=players.get(entry.id);queue.delete(entry.id);members.set(entry.id,id);p.ctf=id;p.ctfQueued=false;p.hm=HP;p.hp=HP;p.mt=0;p.cy=0;p.ac=0;
   spawn(match,entry);p.x=entry.x;p.y=entry.y;
  }queueUntil=0;queueState();snapshot(match);
 }
 function leave(id,reason='left'){
  const p=players.get(id);if(queue.delete(id)){if(p)p.ctfQueued=false;queueState();emit(p,queuePacket(id));}
  const match=matches.get(members.get(id));if(!match)return;
  const entry=match.entries.get(id);drop(match,id);match.entries.delete(id);restore(p,entry,reason);
  if(!match.entries.size){matches.delete(match.id);return;}
  if(![0,1].every(team=>[...match.entries.values()].some(e=>e.team===team)))finish(match,'forfeit');else snapshot(match);
 }
 function hit(match,entry,message){
  const time=now();if(entry.hp<=0||inWater(entry))return;
  const native=message.to!==undefined||message.sw!==undefined||message.face!==undefined;
  const face=message.face===undefined?entry.face:message.face;
  if(native&&(!Number.isSafeInteger(message.to)||message.to<=0||!Number.isSafeInteger(message.sw)||message.sw<=0||message.sw>2147483647||!Number.isInteger(face)||face<0||face>3))return;
  const sameSwing=native&&entry.swing===message.sw;
  if(sameSwing){if(time>entry.swingUntil||face!==entry.swingFace||entry.swingHits.has(message.to))return;}
  else{
   if(time-entry.attackAt<(native?200:400)||(native&&message.sw<=(entry.swing||0)))return;
   entry.attackAt=time;entry.attackUntil=time+200;
   if(native){entry.swing=message.sw;entry.swingFace=face;entry.swingUntil=time+250;entry.swingHits=new Set();}
  }
  if(native)entry.face=entry.swingFace;
  const forward=[{x:0,y:-1},{x:-1,y:0},{x:0,y:1},{x:1,y:0}][entry.face];
  for(const target of match.entries.values()){
   if(target.team===entry.team||target.hp<=0||time<target.hitUntil||inWater(target)||(native&&target.id!==message.to))continue;
   const dx=target.x-entry.x,dy=target.y-entry.y,front=dx*forward.x+dy*forward.y,side=Math.abs(dx*forward.y-dy*forward.x);
   const scale=Math.max(.3,Math.min(1,Number(players.get(entry.id)?.s)||.6));
   if(native?!swordContact(entry,target,entry.face,scale):(front<0||front>34||side>17||distance(entry,target)>36))continue;
   let wall=false;for(let t=0.1;t<1;t+=0.1)if(OBSTACLES.some(r=>r.kind!=='pond'&&obstacleHit({x:entry.x+dx*t,y:entry.y+dy*t},r,0)))wall=true;
   if(wall)continue;
   if(native)entry.swingHits.add(target.id);
   drop(match,target.id);target.hp=Math.max(0,target.hp-DAMAGE);target.hitUntil=time+2000;target.hurtUntil=time+150;
   const length=Math.max(1,Math.hypot(dx,dy));move(target,dx/length*14,dy/length*14);
   if(target.hp===0){target.respawnAt=time+2000;target.inputs=[];target.dir={x:0,y:0};}
  }snapshot(match);
 }
 function step(match){
  const time=now();
  for(const entry of match.entries.values()){
   const command=entry.inputs.shift();entry.dir={x:0,y:0};
   if(!command)continue;entry.ack=command.seq;
   if(entry.hp===0){if(time>=entry.respawnAt&&(command.x||command.y))spawn(match,entry);continue;}
   if(time<entry.hurtUntil)continue;
   entry.dir={x:command.x,y:command.y};
   if(command.x||command.y)entry.face=Math.abs(command.x)>=Math.abs(command.y)?(command.x<0?1:3):(command.y<0?0:2);
   const speed=flagFor(match,entry.id)?SPEED*0.82:SPEED;move(entry,command.x*speed*STEP/1000,command.y*speed*STEP/1000);
   const p=players.get(entry.id);if(p){p.x=entry.x;p.y=entry.y;p.hp=entry.hp;p.hm=HP;p.uT=time;}
  }
  for(const entry of match.entries.values()){
   if(entry.hp<=0||!inWater(entry))continue;
   const carried=flagFor(match,entry.id);if(carried){home(carried);match.notice='Bandeira voltou para a base!';}
  }
  for(const flag of match.flags){
   if(flag.returnAt&&time>=flag.returnAt)home(flag);
   if(flag.carrier){const entry=match.entries.get(flag.carrier);if(entry){flag.x=entry.x;flag.y=entry.y;}continue;}
   for(const entry of match.entries.values()){
    if(entry.hp<=0||inWater(entry)||distance(entry,flag)>17||(flag.blockedId===entry.id&&time<flag.blockedUntil))continue;
    if(entry.team===flag.team){if(flag.returnAt){home(flag);match.notice='Bandeira recuperada!';}continue;}
    if(flagFor(match,entry.id))continue;flag.carrier=entry.id;flag.returnAt=0;match.notice='Bandeira roubada!';break;
   }
  }
  for(const entry of match.entries.values()){
   const flag=flagFor(match,entry.id),own=match.flags[entry.team];
   if(flag&&entry.hp>0&&distance(entry,BASES[entry.team])<=CAPTURE_RADIUS&&!own.carrier&&!own.returnAt){
    match.score[entry.team]++;home(flag);match.notice='Captura do time '+(entry.team===0?'Azul':'Vermelho')+'!';
    if(match.score[entry.team]>=TARGET){finish(match,'score');return;}
   }
  }
 }
 function handle(p,message){
  if(!live(p))return;
  const time=now(),rate=rates.get(p.id)||{at:time,count:0};if(time-rate.at>=1000){rate.at=time;rate.count=0;}rates.set(p.id,rate);if(++rate.count>40)return;
  if(message.op==='get'){emit(p,queuePacket(p.id));const match=matches.get(members.get(p.id));if(match)emit(p,state(match));return;}
  if(message.op==='leave'){leave(p.id);return;}
  if(message.op==='join'){
   if(members.has(p.id))return;if(!canJoin(p))return error(p,'Saia de outros modos, montarias e interiores antes de entrar.');
   let team=message.team;if(team===-1)team=count(0)<=count(1)?0:1;if(team!==0&&team!==1)return error(p,'Escolha Azul ou Vermelho.');
   if(count(team)-(queue.get(p.id)?.team===team?1:0)>=TEAM_SIZE)return error(p,'Esse time já tem 6 jogadores.');
   queue.set(p.id,{team});p.ctfQueued=true;queueState();return;
  }
  const match=matches.get(members.get(p.id)),entry=match?.entries.get(p.id);if(!entry||match.phase!=='playing')return;
  if(message.op==='move'){
   if(!Number.isSafeInteger(message.seq)||message.seq<=entry.seq||message.seq>2147483647||!Number.isFinite(message.dx)||!Number.isFinite(message.dy)||Math.abs(message.dx)>1||Math.abs(message.dy)>1||entry.inputs.length>=8)return;
   const length=Math.max(1,Math.hypot(message.dx,message.dy));entry.seq=message.seq;entry.lastInput=time;
   entry.inputs.push({seq:message.seq,x:message.dx/length,y:message.dy/length});
  }else if(message.op==='hit')hit(match,entry,message);
  else if(message.op==='drop'){drop(match,p.id);snapshot(match);}
 }
 function tick(){
  const time=now();
  for(const id of [...queue.keys()])if(!canJoin(players.get(id)))leave(id,'unavailable');
  if(queueUntil&&time>=queueUntil)start();
  for(const match of matches.values()){
   for(const id of [...match.entries.keys()])if(!live(players.get(id)))leave(id,'disconnect');
   if(!matches.has(match.id))continue;
   if(match.phase==='countdown'&&time>=match.until){match.phase='playing';match.ends=time+DURATION;match.stepped=time;}
   if(match.phase==='playing'){
    let steps=Math.min(4,Math.floor((time-match.stepped)/STEP));while(steps-->0&&match.phase==='playing'){match.stepped+=STEP;step(match);}
    if(time-match.stepped>200)match.stepped=time;
    if(time>=match.ends)finish(match,'time');
   }else match.stepped=time;
   if(match.phase==='finished'&&time>=match.until){for(const entry of match.entries.values())restore(players.get(entry.id),entry,match.reason,match.winner);matches.delete(match.id);continue;}
   if(time-match.sent>=100)snapshot(match);
  }
 }
 return {handle,tick,has:p=>!!p&&(queue.has(p.id)||members.has(p.id)),disconnect:id=>{leave(id,'disconnect');rates.delete(id);}};
};
module.exports.RULES={FIELD,OUTLINE,OBSTACLES,BASES,TEAM_SIZE,HP,DAMAGE,STEP,SPEED,DURATION,TARGET,CAPTURE_RADIUS,SWORD_FRAMES};
module.exports.isBlocked=blocked;
