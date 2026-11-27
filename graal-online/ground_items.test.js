'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),{Pool}=require('pg');
const {Economy,legacyState,pendingDrop}=require('./economy'),{CombatRewards}=require('./combat-rewards');
const rid=()=>crypto.randomBytes(16).toString('hex');
const actor=(extra={})=>({acc:'items-'+rid(),ok:true,x:88,y:88,hp:100,hm:100,role:0,groundDrops:true,itemDrops:true,...extra});
let pool;
before(async()=>{assert.ok(process.env.AETHERIA_TEST_DATABASE,'Use isolated test database');pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE,max:8});await new Economy(pool).init({});});
after(async()=>{if(pool)await pool.end();});

for(const [kind,roll]of [['a',10],['b',20]]){
 test('bush '+kind+' waits on ground, persists and collects exactly once',async t=>{
  let n=0;t.mock.method(crypto,'randomInt',()=>[0,0,roll][n++]??99);
  const economy=new Economy(pool),p=actor(),request={op:'bush',rid:rid(),x:kind==='a'?800:802,y:500};
  const result=await economy.reward(p,request,{source:()=>({x:request.x,y:request.y,w:2,h:2})},()=>true);
  assert.equal(result.state.gl,0);assert.equal(result.state.a,20);assert.equal(result.state.b,10);
  const item=result.state.drops.find(d=>d.k===kind);assert.ok(item);assert.equal(item.pop,1);
  assert.equal(new Set(result.state.drops.map(d=>d.id)).size,2);
  assert.equal((await economy.reward(p,request,{source:()=>{throw Error('duplicate must not reroll');}},()=>true)).state.drops.length,2);
  assert.ok((await new Economy(pool).ensure(p.acc)).drops.some(d=>d.id===item.id));
  p.x=item.x;p.y=item.y;const pickup={rid:rid(),id:item.id,v:100000,k:kind==='a'?'b':'a'};
  const got=await economy.pickup(p,pickup,()=>true);assert.equal(got.state[kind],(kind==='a'?20:10)+1);assert.equal(got.state.gl,0);
  const again=await economy.pickup(p,pickup,()=>true);assert.equal(again.duplicate,true);assert.equal(again.state[kind],got.state[kind]);
 });
 test('monster '+kind+' and Glims remain visible pending separate pickups',async t=>{
  let n=0;t.mock.method(crypto,'randomInt',(a,b)=>b===undefined?[0,96,roll][n++]??99:1);
  const economy=new Economy(pool),combat=new CombatRewards(economy),p=actor(),request={op:'hit',rid:rid(),sid:kind==='a'?91001:91002,weapon:'sword'};
  const result=await combat.hit(p,request,[{id:request.sid,k:'bubble',x:88,y:88,lv:1}],()=>true);
  assert.equal(result.dead,true);assert.equal(result.state.kills,1);assert.equal(result.state.gl,0);assert.equal(result.state.a,20);assert.equal(result.state.b,10);
  const coin=result.state.drops.find(d=>d.k===''),item=result.state.drops.find(d=>d.k===kind);assert.equal(coin.v,30);assert.ok(item);
  p.x=item.x;p.y=item.y;const picked=await economy.pickup(p,{rid:rid(),id:item.id},()=>true);assert.equal(picked.state[kind],(kind==='a'?20:10)+1);
  p.x=coin.x;p.y=coin.y;assert.equal((await economy.pickup(p,{rid:rid(),id:coin.id},()=>true)).state.gl,30);
 });
}
test('full ammunition does not destroy pending drop and retry works after spending',async()=>{
 const economy=new Economy(pool),p=actor();await economy.ensure(p.acc,{...legacyState(),a:60});
 const seeded=await economy.transact(p.acc,rid(),'seed-arrow',s=>({drop:pendingDrop(s,88,88,1,rid(),'a')}));
 await assert.rejects(economy.pickup(p,{rid:rid(),id:seeded.drop.id},()=>true),{code:'capacity'});
 assert.equal((await economy.ensure(p.acc)).drops.length,1);
 await economy.consume(p,{rid:rid(),kind:'a'},()=>true);
 assert.equal((await economy.pickup(p,{rid:rid(),id:seeded.drop.id},()=>true)).state.a,60);
});
test('another account, revoked session and distant client cannot take ammunition',async()=>{
 const economy=new Economy(pool),p=actor(),seeded=await economy.transact(p.acc,rid(),'seed-bomb',s=>({drop:pendingDrop(s,88,88,1,rid(),'b')}));
 await assert.rejects(economy.pickup(actor(),{rid:rid(),id:seeded.drop.id},()=>true),{code:'drop_unavailable'});
 await assert.rejects(economy.pickup(p,{rid:rid(),id:seeded.drop.id},()=>false),{code:'session_changed'});
 p.x=1000;await assert.rejects(economy.pickup(p,{rid:rid(),id:seeded.drop.id},()=>true),{code:'source_out_of_range'});
 assert.equal((await economy.ensure(p.acc)).b,10);
});
test('parallel pickup requests cannot duplicate personal ammunition',async()=>{
 const economy=new Economy(pool),p=actor(),seeded=await economy.transact(p.acc,rid(),'seed-bomb',s=>({drop:pendingDrop(s,88,88,1,rid(),'b')}));
 const results=await Promise.allSettled([economy.pickup(p,{rid:rid(),id:seeded.drop.id},()=>true),economy.pickup(p,{rid:rid(),id:seeded.drop.id},()=>true)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await economy.ensure(p.acc)).b,11);
});
test('old client receives ammunition directly and never sees it as Glims',async t=>{
 let n=0;t.mock.method(crypto,'randomInt',()=>[99,10][n++]??99);
 const economy=new Economy(pool),p=actor({itemDrops:false});
 const result=await economy.reward(p,{op:'bush',rid:rid(),x:30,y:10},{source:()=>({x:30,y:10,w:2,h:2})},()=>true);
 assert.equal(result.state.a,21);assert.equal(result.state.gl,0);assert.equal((result.state.drops||[]).length,0);
});
