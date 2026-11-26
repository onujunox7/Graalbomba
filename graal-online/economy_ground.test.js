'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {Economy,legacyState}=require('./economy');
const {CombatRewards}=require('./combat-rewards');
let pool;
const rid=()=>crypto.randomBytes(16).toString('hex');
const actor=(extra={})=>({acc:'test-'+rid(),ok:true,x:88,y:88,hp:100,hm:100,role:0,groundDrops:true,...extra});
const world={source:()=>({x:10,y:10,w:2,h:2})};
before(async()=>{
 assert.ok(process.env.AETHERIA_TEST_DATABASE,'Use an isolated test database');
 pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE,max:8});
 await new Economy(pool).init({});
});
after(async()=>{if(pool)await pool.end();});

test('blue bush glim waits on the ground and credits five only on pickup',async t=>{
 t.mock.method(crypto,'randomInt',()=>0);
 const economy=new Economy(pool),p=actor();
 const reward=await economy.reward(p,{op:'bush',rid:rid(),x:10,y:10},world,()=>true);
 assert.equal(reward.state.gl,0,'a ground reward must not enter the wallet before pickup');
 assert.equal(reward.state.drops.length,1);
 assert.equal(reward.state.drops[0].v,5);
 assert.equal((await new Economy(pool).ensure(p.acc)).drops[0].id,reward.state.drops[0].id);
 const request={op:'pickup',rid:rid(),id:reward.state.drops[0].id};
 const result=await economy.pickup(p,request,()=>true);
 assert.equal(result.state.gl,5);
 assert.equal(result.state.drops.length,0);
 const retry=await economy.pickup(p,request,()=>true);
 assert.equal(retry.state.gl,5);
 assert.equal(retry.duplicate,true);
});

test('old clients retain immediate confirmed rewards',async t=>{
 t.mock.method(crypto,'randomInt',()=>0);
 const economy=new Economy(pool),p=actor({groundDrops:false});
 const source={source:()=>({x:12,y:10,w:2,h:2})};
 const result=await economy.reward(p,{op:'bush',rid:rid(),x:12,y:10},source,()=>true);
 assert.equal(result.state.gl,5);
 assert.equal((result.state.drops||[]).length,0);
});

test('admin can drop all six colors for another player to collect',async()=>{
 const economy=new Economy(pool),admin=actor({role:1}),p=actor({x:112});
 for(const amount of [1,5,30,100,1000,5000]){
  const spawn=await economy.adminDrop(admin,{op:'admin_drop',rid:rid(),v:amount},()=>true);
  assert.equal(spawn.drop.v,amount);
  assert.equal(spawn.state.gl,0);
  await economy.pickup(p,{op:'pickup',rid:rid(),id:spawn.drop.id},()=>true);
 }
 assert.equal((await economy.ensure(p.acc)).gl,6136);
});

test('only one concurrent player receives a shared glim',async()=>{
 const economy=new Economy(pool),admin=actor({role:2});
 const {drop}=await economy.adminDrop(admin,{op:'admin_drop',rid:rid(),v:30},()=>true);
 const a=actor({x:drop.x,y:drop.y}),b=actor({x:drop.x,y:drop.y});
 const results=await Promise.allSettled([economy.pickup(a,{rid:rid(),id:drop.id},()=>true),economy.pickup(b,{rid:rid(),id:drop.id},()=>true)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await economy.ensure(a.acc)).gl+(await economy.ensure(b.acc)).gl,30);
});

test('ground drops survive a new Economy instance and retry does not respawn them',async()=>{
 const economy=new Economy(pool),admin=actor({role:1});
 const request={op:'admin_drop',rid:rid(),v:5};
 const first=await economy.adminDrop(admin,request,()=>true);
 const next=new Economy(pool);
 assert.ok((await next.publicDrops()).some(d=>d.id===first.drop.id));
 const retry=await next.adminDrop(admin,request,()=>true);
 assert.equal(retry.drop.id,first.drop.id);
 const p=actor({x:first.drop.x,y:first.drop.y});
 await next.pickup(p,{rid:rid(),id:first.drop.id},()=>true);
 assert.ok(!(await next.publicDrops()).some(d=>d.id===first.drop.id));
});

test('ordinary players and revoked roles cannot mint ground currency',async()=>{
 const economy=new Economy(pool),p=actor();
 await assert.rejects(economy.adminDrop(p,{rid:rid(),v:100},()=>true),{code:'forbidden'});
 p.role=1;
 await assert.rejects(economy.adminDrop(p,{rid:rid(),v:100},()=>false),{code:'session_changed'});
 for(const v of [-1,0,1.5,100001,'5',null])await assert.rejects(economy.adminDrop(p,{rid:rid(),v},()=>true));
});

test('pickup validates distance, space, health and unknown IDs without granting currency',async()=>{
 const economy=new Economy(pool),admin=actor({role:1});
 const {drop}=await economy.adminDrop(admin,{rid:rid(),v:5},()=>true);
 for(const extra of [{x:drop.x+200},{in:true},{spar:'match'},{football:'match'},{hp:0}]){
  const p=actor({x:drop.x,y:drop.y,...extra});
  await assert.rejects(economy.pickup(p,{rid:rid(),id:drop.id},()=>true));
  assert.equal((await economy.ensure(p.acc)).gl,0);
 }
 await assert.rejects(economy.pickup(actor(),{rid:rid(),id:'forged'},()=>true));
 assert.ok((await economy.publicDrops()).some(d=>d.id===drop.id));
});

test('wallet capacity does not destroy the shared drop',async()=>{
 const economy=new Economy(pool),admin=actor({role:1});
 const {drop}=await economy.adminDrop(admin,{rid:rid(),v:5},()=>true);
 const p=actor({x:drop.x,y:drop.y});
 await economy.ensure(p.acc,{...legacyState(),gl:1000000000});
 await assert.rejects(economy.pickup(p,{rid:rid(),id:drop.id},()=>true),{code:'capacity'});
 assert.ok((await economy.publicDrops()).some(d=>d.id===drop.id));
});

test('another account cannot take a personal drop or forge the credited amount',async t=>{
 t.mock.method(crypto,'randomInt',()=>0);
 const economy=new Economy(pool),p=actor();
 const source={source:()=>({x:16,y:10,w:2,h:2})};
 const result=await economy.reward(p,{op:'bush',rid:rid(),x:16,y:10},source,()=>true);
 const drop=result.state.drops[0],other=actor({x:drop.x,y:drop.y});
 await assert.rejects(economy.pickup(other,{rid:rid(),id:drop.id,v:100000},()=>true),{code:'drop_unavailable'});
 p.x=drop.x;p.y=drop.y;
 const collected=await economy.pickup(p,{rid:rid(),id:drop.id,v:100000},()=>true);
 assert.equal(collected.state.gl,5);
});

test('monster red reward waits for collection while kill progress is confirmed',async t=>{
 let roll=0;
 t.mock.method(crypto,'randomInt',(a,b)=>b===undefined?[0,96,99][roll++]??99:1);
 const economy=new Economy(pool),combat=new CombatRewards(economy),p=actor();
 const result=await combat.hit(p,{op:'hit',rid:rid(),sid:17,weapon:'sword'},[{id:17,k:'bubble',x:88,y:88,lv:1}],()=>true);
 assert.equal(result.dead,true);
 assert.equal(result.state.kills,1);
 assert.equal(result.reward,30);
 assert.equal(result.state.gl,0);
 assert.equal(result.state.drops[0].v,30);
 const pickup=await economy.pickup(p,{rid:rid(),id:result.state.drops[0].id},()=>true);
 assert.equal(pickup.state.gl,30);
});

test('expired admin drops cannot be collected after reconnect',async t=>{
 const economy=new Economy(pool),admin=actor({role:1});
 const {drop}=await economy.adminDrop(admin,{rid:rid(),v:5},()=>true);
 const now=Date.now();t.mock.method(Date,'now',()=>now+600001);
 assert.ok(!(await new Economy(pool).publicDrops()).some(d=>d.id===drop.id));
 await assert.rejects(economy.pickup(actor({x:drop.x,y:drop.y}),{rid:rid(),id:drop.id},()=>true),{code:'drop_unavailable'});
});
