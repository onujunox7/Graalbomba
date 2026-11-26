'use strict';
const crypto=require('node:crypto');
const {digest,error}=require('./economy');
const CATALOG=require('./fishing-data/fish_catalog.json').fish;
const MAX_CAST_DISTANCE=128;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));

module.exports=function createFishing({players,economy,world,refresh=()=>{},send,broadcast=()=>{},authorized,now=Date.now,randomInt=crypto.randomInt}){
 const sessions=new Map(),cooldowns=new Map();let refreshed=0;
 const available=p=>authorized(p)&&p.ok&&p.hp>0&&!p.in&&!p.spar&&!p.football;
 // Native swimming probes two pixels above the avatar origin, at its feet.
 const onLand=p=>!world.isWater(p.x,p.y-2);
 const valid=s=>players.get(s.p.id)===s.p&&s.p.acc===s.account&&available(s.p)&&Math.hypot(s.p.x-s.x,s.p.y-s.y)<=16&&world.isWater(s.tx,s.ty)&&onLand(s.p);
 const visual=s=>({t:'fish',op:'visual',actor:s.p.id,sid:s.id,phase:s.phase,x:s.x,y:s.y,tx:s.tx,ty:s.ty,fish:s.phase==='caught'?s.fish.id:''});
 const state=s=>({t:'fish',op:'state',actor:s.p.id,sid:s.id,rid:s.rid,phase:s.phase,x:s.x,y:s.y,tx:s.tx,ty:s.ty,bar:s.bar,target:s.target,progress:s.progress,window:s.fish.window,remaining:s.phase==='reel'?Math.max(0,20-(now()-s.reelAt)/1000):0});
 const notify=(p,code,rid='')=>send(p.ws,{t:'fish',op:'error',actor:p.id,code,rid});
 function end(s,reason){
  if(sessions.get(s.p.id)!==s)return;
  sessions.delete(s.p.id);s.cancelled=true;s.p.fishing=false;s.phase='end';
  send(s.p.ws,{t:'fish',op:'end',actor:s.p.id,sid:s.id,reason});broadcast(s.p,visual(s));
 }
 async function finish(s){
  s.phase='resolve';send(s.p.ws,state(s));broadcast(s.p,visual(s));
  const grams=randomInt(s.fish.min_g,s.fish.max_g+1);
  try{
   const result=await economy.transact(s.account,s.id,digest(['fishing',s.fish.id,grams]),wallet=>{
    const collection=wallet.fish||(wallet.fish={}),old=collection[s.fish.id]||{count:0,best_g:0,total_g:0};
    if(old.count>=99999)throw error('capacity');
    collection[s.fish.id]={count:old.count+1,best_g:Math.max(old.best_g,grams),total_g:old.total_g+grams};
    return {fish:s.fish.id,grams};
   },()=>!s.cancelled&&sessions.get(s.p.id)===s&&s.p.acc===s.account&&available(s.p));
   if(sessions.get(s.p.id)!==s)return;
   sessions.delete(s.p.id);s.p.fishing=false;s.phase='caught';
   send(s.p.ws,{t:'fish',op:'caught',actor:s.p.id,sid:s.id,rid:s.id,account:s.account,ok:true,...result});
   broadcast(s.p,visual(s));
  }catch(e){notify(s.p,e.code==='capacity'?'collection_full':'temporarily_unavailable',s.rid);end(s,'unavailable');}
 }
 function cast(p,m){
  if(typeof m.rid!=='string'||!/^[a-f0-9]{32}$/.test(m.rid))return;
  const active=sessions.get(p.id);
  if(active){if(active.rid===m.rid)send(p.ws,state(active));else notify(p,'busy',m.rid);return;}
  if(!available(p)||!p.fishingClient){notify(p,'not_available',m.rid);return;}
  if(now()-(cooldowns.get(p.id)??-Infinity)<1000){notify(p,'cooldown',m.rid);return;}
  cooldowns.set(p.id,now());try{refresh();refreshed=now();}catch{notify(p,'temporarily_unavailable',m.rid);return;}
  const distance=Math.hypot(m.x-p.x,m.y-p.y);
  if(!Number.isFinite(m.x)||!Number.isFinite(m.y)||distance<24||distance>MAX_CAST_DISTANCE||!world.isWater(m.x,m.y)||!onLand(p)){notify(p,'not_water',m.rid);return;}
  let roll=randomInt(100),fish=CATALOG[0];for(const entry of CATALOG){if(roll<entry.weight){fish=entry;break;}roll-=entry.weight;}
  const s={p,account:p.acc,id:crypto.randomBytes(16).toString('hex'),rid:m.rid,phase:'cast',x:p.x,y:p.y,tx:m.x,ty:m.y,fish,seed:randomInt(6284)/1000,start:now(),biteAt:now()+randomInt(2400,4801),last:now(),sent:now(),bar:0.45,velocity:0,target:0.5,progress:0.4,held:false,seq:-1,inputAt:now(),inputWindow:now(),inputCount:0,cancelled:false};
  sessions.set(p.id,s);p.fishing=true;send(p.ws,state(s));broadcast(p,visual(s));
 }
 function handle(p,m){
  if(!authorized(p)||!p.fishingClient||!m||typeof m!=='object')return;
  if(m.op==='cast'){cast(p,m);return;}
  const s=sessions.get(p.id);if(!s||s.account!==p.acc)return;
  if(m.op==='cancel'&&(m.sid===s.id||m.rid===s.rid)){end(s,'cancelled');return;}
  if(m.op!=='input'||m.sid!==s.id||s.phase!=='reel'||typeof m.held!=='boolean'||!Number.isSafeInteger(m.seq)||m.seq<=s.seq||m.seq>10000)return;
  if(now()-s.inputWindow>=1000){s.inputWindow=now();s.inputCount=0;}
  if(++s.inputCount>20)return;
  s.seq=m.seq;s.held=m.held;s.inputAt=now();
 }
 function tick(){
  const time=now();if(sessions.size&&time-refreshed>=1000){try{refresh();refreshed=time;}catch{for(const s of [...sessions.values()])end(s,'unavailable');return;}}
  for(const s of sessions.values()){
   if(!valid(s)){end(s,'interrupted');continue;}
   const dt=clamp((time-s.last)/1000,0,0.1);s.last=time;
   if(s.phase==='cast'&&time-s.start>=450){s.phase='wait';send(s.p.ws,state(s));broadcast(s.p,visual(s));}
   if(s.phase==='wait'&&time>=s.biteAt){s.phase='reel';s.reelAt=time;s.inputAt=time;send(s.p.ws,state(s));broadcast(s.p,visual(s));}
   if(s.phase!=='reel')continue;
   const elapsed=(time-s.reelAt)/1000,held=s.held&&time-s.inputAt<500;
   s.velocity=(s.velocity+(held?1.15:-0.95)*dt)*Math.exp(-2*dt);
   s.bar=clamp(s.bar+s.velocity*dt,s.fish.window/2,1-s.fish.window/2);
   if(s.bar<=s.fish.window/2||s.bar>=1-s.fish.window/2)s.velocity=0;
   s.target=clamp(0.5+0.31*Math.sin(elapsed*s.fish.speed+s.seed)+0.08*Math.sin(elapsed*s.fish.speed*2.7+s.seed*0.5),0.06,0.94);
   s.progress=clamp(s.progress+(Math.abs(s.bar-s.target)<=s.fish.window/2?0.20:-0.10)*dt,0,1);
   if(s.progress>=1){finish(s);continue;}
   if(s.progress<=0||elapsed>=20){end(s,'escaped');continue;}
   if(time-s.sent>=100){s.sent=time;send(s.p.ws,state(s));}
  }
 }
 return {handle,tick,maxCastDistance:MAX_CAST_DISTANCE,disconnect(id){const s=sessions.get(id);if(s)end(s,'disconnected');cooldowns.delete(id);},sync(p){if(p.fishingClient&&!p.in&&!p.spar&&!p.football)for(const s of sessions.values())send(p.ws,visual(s));},sessions};
};
