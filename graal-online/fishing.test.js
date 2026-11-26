'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const {Pool}=require('pg');
const {Economy}=require('./economy');
const {RewardWorld}=require('./reward-world');
const createFishing=require('./fishing');
let pool;
const id=()=>crypto.randomBytes(16).toString('hex');
before(async()=>{assert.ok(process.env.AETHERIA_TEST_DATABASE);pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE});await new Economy(pool).init({});});
after(async()=>{if(pool)await pool.end();});
function setup(extra={},fishRoll=0){
 let time=100000,active=true,refreshFails=false;
 const p={id:1,acc:'fish-'+id(),ok:true,hp:100,x:1200,y:1200,fishingClient:true,ws:{readyState:1},...extra};
 const players=new Map([[1,p]]),messages=[],visuals=[],economy=new Economy(pool);
 const fishing=createFishing({players,economy,world:{isWater:(x,y)=>Number.isFinite(x)&&Number.isFinite(y)&&x>=1000&&x<1180&&y>=1100&&y<1300},refresh:()=>{if(refreshFails)throw new Error('bad map');},send:(_ws,m)=>messages.push(m),broadcast:(_p,m)=>visuals.push(m),authorized:q=>active&&players.get(q.id)===q&&q.ws.readyState===1,now:()=>time,randomInt:(a,b)=>b===undefined?(a===100?fishRoll:0):a});
 const cast=fields=>fishing.handle(p,{op:'cast',rid:id(),x:1152,y:1200,...fields});
 const step=ms=>{time+=ms;fishing.tick();};
 return {p,fishing,economy,messages,visuals,cast,step,setActive:v=>active=v,setRefreshFailure:v=>refreshFails=v};
}
async function settle(condition){const deadline=Date.now()+3000;while(!condition()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(condition(),'async fishing result timed out');}
function play(s){
 let seq=0;
 for(let step=0;step<600&&s.fishing.sessions.has(1);step++){
  const session=s.fishing.sessions.get(1);
  if(session.phase==='resolve')return;
  if(session.phase==='reel'&&step%2===0)s.fishing.handle(s.p,{op:'input',sid:session.id,seq:++seq,held:session.target>session.bar+session.velocity*0.4});
  s.step(50);
 }
}

test('cast requires a live session, land, nearby real water and allowed space',()=>{
 for(const extra of [{hp:0},{in:1},{spar:'match'},{football:'match'},{fishingClient:false},{x:1140}]){const s=setup(extra);s.cast();assert.equal(s.fishing.sessions.size,0);}
 const s=setup();s.setActive(false);s.cast();assert.equal(s.fishing.sessions.size,0);
 for(const fields of [{x:1200},{x:900},{x:NaN},{x:'1152'},{rid:'forged'}]){const trial=setup();trial.cast(fields);assert.equal(trial.fishing.sessions.size,0);}
});

test('cast accepts farther water up to 128 and rejects water past the advertised limit',()=>{
 for(const distance of [24,96,104,128]){const s=setup();assert.equal(s.fishing.maxCastDistance,128);s.cast({x:s.p.x-distance});assert.equal(s.fishing.sessions.size,1);assert.equal(s.fishing.sessions.get(1).tx,s.p.x-distance);}
 for(const distance of [23,129,160]){const s=setup();s.cast({x:s.p.x-distance});assert.equal(s.fishing.sessions.size,0);assert.ok(s.messages.some(m=>m.code==='not_water'));}
});

test('bar simulation awards one server-selected fish and preserves currency',async()=>{
 const s=setup();s.cast();assert.equal(s.p.fishing,true);play(s);
 await settle(()=>s.messages.some(m=>m.op==='caught'));
 const result=s.messages.find(m=>m.op==='caught');
 assert.equal(result.fish,'lambari');assert.equal(result.grams,40);assert.equal(result.state.fish.lambari.count,1);assert.equal(result.state.gl,0);assert.equal(s.p.fishing,false);
 for(let i=0;i<20;i++)s.step(50);
 assert.equal((await new Economy(pool).ensure(s.p.acc)).fish.lambari.count,1);
 assert.ok(s.visuals.some(m=>m.phase==='caught'));
});

test('all six species including the rare moonfish are catchable through the control bar',async()=>{
 let roll=0;const catalog=require('./fishing-data/fish_catalog.json').fish;
 assert.equal(catalog.reduce((sum,fish)=>sum+fish.weight,0),100);
 for(const fish of catalog){
  const s=setup({},roll);s.cast();play(s);await settle(()=>s.messages.some(m=>m.op==='caught'));
  const result=s.messages.find(m=>m.op==='caught');assert.equal(result.fish,fish.id);assert.equal(result.state.fish[fish.id].count,1);assert.equal(result.state.gl,0);roll+=fish.weight;
 }
});

test('cast retries retain the same challenge and input cannot accelerate time or forge a fish',()=>{
 const s=setup(),rid=id();s.cast({rid});const session=s.fishing.sessions.get(1);
 s.cast({rid});assert.equal(s.fishing.sessions.get(1),session);
 s.step(2500);assert.equal(session.phase,'reel');
 const progress=session.progress;
 for(let seq=0;seq<100;seq++)s.fishing.handle(s.p,{op:'input',sid:session.id,seq,held:true,fish:'lua',progress:1});
 assert.equal(session.progress,progress);
 assert.ok(session.seq<=20);
 s.fishing.handle(s.p,{op:'input',sid:'wrong',seq:100,held:false});assert.equal(session.held,true);
});

test('cancel, moving away, losing health or changing account stops the session',()=>{
 for(const reason of ['cancel','move','death','account','football']){
  const s=setup();s.cast();const session=s.fishing.sessions.get(1);
  if(reason==='cancel')s.fishing.handle(s.p,{op:'cancel',sid:session.id});
  if(reason==='move')s.p.x+=20;
  if(reason==='death')s.p.hp=0;
  if(reason==='account')s.p.acc='other-account';
  if(reason==='football')s.p.football='match';
  s.step(50);assert.equal(s.fishing.sessions.size,0);assert.equal(s.p.fishing,false);assert.ok(!s.messages.some(m=>m.op==='caught'));
 }
});

test('disconnect during resolution cannot grant a catch to a revoked session',async()=>{
 const s=setup();s.cast();play(s);s.fishing.disconnect(1);
 await settle(()=>s.messages.some(m=>m.op==='error'));
 assert.ok(!(await s.economy.ensure(s.p.acc)).fish);assert.ok(!s.messages.some(m=>m.op==='caught'));
});

test('catch collection keeps best weight and refuses overflow',async()=>{
 const s=setup();await s.economy.transact(s.p.acc,id(),'seed',wallet=>{wallet.fish={lambari:{count:99999,best_g:80,total_g:999990}};});
 s.cast();play(s);await settle(()=>s.messages.some(m=>m.code==='collection_full'));
 assert.equal((await s.economy.ensure(s.p.acc)).fish.lambari.count,99999);
});

test('refresh errors fail closed without crashing the fishing loop',()=>{
 const s=setup();s.setRefreshFailure(true);s.cast();assert.equal(s.fishing.sessions.size,0);assert.ok(s.messages.some(m=>m.code==='temporarily_unavailable'));
 const active=setup();active.cast();active.setRefreshFailure(true);assert.doesNotThrow(()=>active.step(1100));assert.equal(active.fishing.sessions.size,0);
});

test('published level water and map edits override the base water manifest',()=>{
 const world=new RewardWorld(path.join(__dirname,'reward-data'));
 const waterId=world.waterTypes.indexOf(56),landId=world.waterTypes.indexOf(48);
 assert.ok(waterId>=0&&landId>=0);
 const x=812,y=2132,slot=Math.floor(y/64)*26+Math.floor(x/64),raw=Buffer.alloc(8192);
 for(let i=0;i<4096;i++)raw.writeUInt16LE(waterId,i*2);
 const level={t:raw.toString('base64'),c:[]};
 world.refresh({levels:{mundo:{[slot]:level}}});assert.equal(world.isWater(x*8+4,y*8+4),true);
 world.refresh({levels:{mundo:{[slot]:level}},map:{edits:[{k:'e',x,y,w:1,h:1}]}});assert.equal(world.isWater(x*8+4,y*8+4),false);
 for(let i=0;i<4096;i++)raw.writeUInt16LE(landId,i*2);
 world.refresh({levels:{mundo:{[slot]:{t:raw.toString('base64'),c:[]}}}});assert.equal(world.isWater(x*8+4,y*8+4),false);
 assert.equal(world.isWater(-1,y*8),false);
});


test('relaxed timing catches all species with 300ms decisions and forgives a one-second mistake',async()=>{
 let roll=0;
 for(const fish of require('./fishing-data/fish_catalog.json').fish){
  const s=setup({},roll);s.cast();let seq=0,reelSteps=0;
  for(let i=0;i<600&&s.fishing.sessions.has(1);i++){
   const session=s.fishing.sessions.get(1);if(session.phase==='resolve')break;
   if(session.phase==='reel'){
    if(reelSteps%6===0)s.fishing.handle(s.p,{op:'input',sid:session.id,seq:++seq,held:reelSteps<20?false:session.target>session.bar+session.velocity*0.4});
    reelSteps++;
   }
   s.step(50);
  }
  await settle(()=>s.messages.some(m=>m.op==='caught'));
  assert.equal(s.messages.find(m=>m.op==='caught').fish,fish.id);roll+=fish.weight;
 }
});

test('leaving the controls untouched still lets the fish escape',()=>{
 const s=setup();s.cast();for(let i=0;i<600&&s.fishing.sessions.has(1);i++)s.step(50);
 assert.equal(s.fishing.sessions.size,0);assert.ok(s.messages.some(m=>m.reason==='escaped'));assert.ok(!s.messages.some(m=>m.op==='caught'));
});
