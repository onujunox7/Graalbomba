'use strict';
const crypto = require('crypto');
const HATS = new Set(['hat_01','hat_02','hat_03','hat_04','hat_05']);
const integer = (v, lo, hi, fallback=0) => Number.isSafeInteger(Number(v)) ? Math.max(lo,Math.min(hi,Number(v))) : fallback;
const parse = (v, fallback={}) => { try { const d=typeof v==='string'?JSON.parse(v):v; return d && typeof d==='object'?d:fallback; } catch { return fallback; } };
const error = code => Object.assign(new Error(code), {code});
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const QUESTS=[['kill',5,30,40],['chest',3,30,50],['elite',1,60,100],['mon',6,70,120],['kill',15,80,150]];
function questEvent(state,kind){
 const progress=state.quest||(state.quest={i:0,n:0}),quest=QUESTS[progress.i];
 if(!quest||quest[0]!==kind)return;
 if(++progress.n<quest[1])return;
 progress.i++;progress.n=0;state.gl=Math.min(1000000000,state.gl+quest[3]);state.exp+=quest[2];
 while(state.exp>=100){state.exp-=100;state.lvl=Math.min(999,state.lvl+1);}
}
function legacyState(data={}) {
 const sv=parse(data.graal_classic_save_v1), ammo=parse(data.graal_classic_zelda_v1), raw=parse(data.graal_hats_owned,[]);
 const hats=Array.isArray(raw)?[...new Set(raw.filter(x=>HATS.has(x)))]:[];
 const quest=parse(sv.q);
 const bag={}; for(const [k,v] of Object.entries(parse(data.graal_npc_bag_v1)).slice(0,500)) if(k.length<=100&&k!=='__proto__') bag[k]=integer(v,0,99999);
 return {v:0, gl:integer(sv.gl,0,1000000000), lvl:integer(sv.lvl,1,999,1), exp:integer(sv.exp,0,99), kills:integer(sv.kills,0,1000000000), hats, hat:hats.includes(data.graal_hat_equip)?data.graal_hat_equip:'', mount:data.graal_mount_owned==='1', bag,
  pot:integer(sv.pot,0,9,1), up:integer(sv.up,0,5), b:integer(ammo.b,0,99999,10), a:integer(ammo.a,0,99999,20), chests:[],quest:{i:integer(quest.i,0,QUESTS.length),n:integer(quest.n,0,15)}};
}
function accountData(data, state) {
 if(!state)return {...data};
 const out={...data}, sv=parse(out.graal_classic_save_v1);
 out.graal_classic_save_v1=JSON.stringify({...sv,gl:state.gl,pot:state.pot,up:state.up,lvl:state.lvl,exp:state.exp,kills:state.kills,q:state.quest});
 out.graal_classic_zelda_v1=JSON.stringify({...parse(out.graal_classic_zelda_v1),b:state.b,a:state.a});
 out.graal_hats_owned=JSON.stringify(state.hats);out.graal_hat_equip=state.hat;
 out.graal_mount_owned=state.mount?'1':'0';out.graal_npc_bag_v1=JSON.stringify(state.bag);
 return out;
}
function protectSave(out, previous) {
 for(const k of ['graal_hats_owned','graal_hat_equip','graal_mount_owned','graal_npc_bag_v1','graal_classic_zelda_v1']) delete out[k];
 if(typeof out.graal_classic_save_v1==='string'){
  const next=parse(out.graal_classic_save_v1), old=parse(previous.graal_classic_save_v1);
  for(const k of ['gl','pot','up','lvl','exp','kills','q']) next[k]=old[k]??(k==='lvl'?1:k==='q'?{i:0,n:0}:0);
  out.graal_classic_save_v1=JSON.stringify(next);
 }
 return out;
}
function near(p,x,y,r=90){return !!p.ok&&Number.isFinite(x)&&Number.isFinite(y)&&Math.hypot((p.in?p.ix:p.x)-x,(p.in?p.iy:p.y)-y)<=r;}
function merchant(p,request,npcs){
 if(!Number.isSafeInteger(request.x)||!Number.isSafeInteger(request.y))throw error('invalid_shop');
 const npc=npcs.find(n=>n.x===request.x&&n.y===request.y);
 if(!npc||!near(p,npc.x,npc.y)||p.hp===0)throw error('shop_out_of_range');
 return npc;
}
function offers(npc){return npc.it.map((item,index)=>({...item,index,quote:digest(item)}));}
function buy(state,item,p){
 const price=item.c;if(!Number.isSafeInteger(price)||price<0||price>99999)throw error('invalid_price');
 if(state.gl<price)throw error('insufficient_glims');
 const q=integer(item.q,1,99,1);let effect='';
 switch(item.t){
 case 'hat': if(!HATS.has(item.id))throw error('unknown_item');if(state.hats.includes(item.id))throw error('already_owned');state.hats.push(item.id);break;
 case 'mount':if(state.mount)throw error('already_owned');state.mount=true;break;
 case 'sword':if(state.up>=5)throw error('capacity');state.up++;break;
 case 'pot':if(state.pot>=9)throw error('capacity');state.pot=Math.min(9,state.pot+q);break;
 case 'bomb':if(state.b>=30)throw error('capacity');state.b=Math.min(30,state.b+q);break;
 case 'arrow':if(state.a>=60)throw error('capacity');state.a=Math.min(60,state.a+q);break;
 case 'heal':if(!(p.hp<p.hm))throw error('capacity');effect='heal';break;
 case 'x': {
  const v=integer(item.v,1,9999,1),e=item.e;
  if(e==='none'){if(typeof item.nm!=='string'||!item.nm||['__proto__','constructor','prototype'].includes(item.nm))throw error('unknown_item');state.bag[item.nm]=Math.min(99999,(Object.hasOwn(state.bag,item.nm)?state.bag[item.nm]:0)+1);}
  else if(['pot','bomb','arrow'].includes(e)){const key={pot:'pot',bomb:'b',arrow:'a'}[e],cap={pot:9,bomb:30,arrow:60}[e];if(state[key]>=cap)throw error('capacity');state[key]=Math.min(cap,state[key]+v);}
  else if(e==='hp'){if(!(p.hp<p.hm))throw error('capacity');effect='hp:'+v;}
  else throw error('unknown_item');break;
 }
 default:throw error('unknown_item');
 }
 state.gl-=price;return {effect,price,item:item.id||item.t};
}
class Economy {
 constructor(pool){this.pool=pool;this.cache=new Map();}
 async init(accounts){
  await this.pool.query(`CREATE TABLE IF NOT EXISTS graal_economy (account_id TEXT PRIMARY KEY,state JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await this.pool.query(`CREATE TABLE IF NOT EXISTS graal_economy_receipts (account_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(account_id,request_id))`);
  await this.pool.query(`CREATE TABLE IF NOT EXISTS graal_reward_sources (source_id TEXT PRIMARY KEY,state JSONB NOT NULL)`);
  // Migration reads only existing persisted accounts, once, before accepting connections.
  for(const account of Object.values(accounts)) await this.ensure(account.id,legacyState(account.data));
 }
 remember(id,state){const old=this.cache.get(id);if(!old||old.v<=state.v)this.cache.set(id,state);return state;}
 peek(id){return this.cache.get(id);}
 async ensure(id,seed=legacyState()){
  await this.pool.query('INSERT INTO graal_economy(account_id,state) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[id,JSON.stringify(seed)]);
  const row=await this.pool.query('SELECT state FROM graal_economy WHERE account_id=$1',[id]);return this.remember(id,row.rows[0].state);
 }
 async transact(id,rid,fingerprint,mutate,authorized=()=>true){
  if(typeof id!=='string'||!id||typeof rid!=='string'||!/^[a-zA-Z0-9_-]{16,96}$/.test(rid))throw error('invalid_request');
  if(!authorized())throw error('session_changed');
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');await db.query("SET LOCAL lock_timeout = '5s'");await db.query("SET LOCAL statement_timeout = '8s'");
   await db.query('INSERT INTO graal_economy(account_id,state) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[id,JSON.stringify(legacyState())]);
   const row=await db.query('SELECT state FROM graal_economy WHERE account_id=$1 FOR UPDATE',[id]);
   if(!authorized())throw error('session_changed');
   const state=row.rows[0].state;
   const receipt=await db.query('SELECT fingerprint,result FROM graal_economy_receipts WHERE account_id=$1 AND request_id=$2',[id,rid]);
   if(receipt.rowCount){if(receipt.rows[0].fingerprint!==fingerprint)throw error('request_conflict');await db.query('COMMIT');return {state:this.remember(id,state),...receipt.rows[0].result,duplicate:true};}
   const result=await mutate(state,db)||{};state.v++;
   await db.query('UPDATE graal_economy SET state=$2::jsonb,updated_at=now() WHERE account_id=$1',[id,JSON.stringify(state)]);
   await db.query('INSERT INTO graal_economy_receipts(account_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',[id,rid,fingerprint,JSON.stringify(result)]);
   await db.query('COMMIT');return {state:this.remember(id,state),...result};
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
 }
 async purchase(p,request,npcs,authorized){
  const id=p.acc;
  return this.transact(id,request.rid,digest(request),state=>{
   const npc=merchant(p,request,npcs);
   if(!Number.isSafeInteger(request.index)||request.index<0)throw error('unknown_item');
   const item=npc.it[request.index];if(!item||request.quote!==digest(item))throw error('shop_changed');
   return buy(state,item,p);
  },authorized);
 }
 async equip(p,request,authorized){return this.transact(p.acc,request.rid,digest(request),state=>{if(request.hat!==''&&!state.hats.includes(request.hat))throw error('not_owned');state.hat=request.hat;},authorized);}
 async consume(p,request,authorized){
  const origin={x:p.in?p.ix:p.x,y:p.in?p.iy:p.y,inside:!!p.in};
  return this.transact(p.acc,request.rid,digest(request),state=>{
  if(!['pot','b','a'].includes(request.kind)||state[request.kind]<1||!p.ok||p.hp===0)throw error('empty');
  if(request.kind==='pot'&&!(p.hp<p.hm))throw error('capacity');
  if(request.kind!=='pot'&&(!Number.isFinite(origin.x)||!Number.isFinite(origin.y)))throw error('invalid_source');
  state[request.kind]--;
  if(request.kind!=='pot'){state.shots=(state.shots||[]).filter(s=>s.until>Date.now()).slice(-15);state.shots.push({id:request.rid,kind:request.kind,...origin,until:Date.now()+(request.kind==='a'?4000:12000),targets:[]});}
  return {kind:request.kind,effect:request.kind==='pot'?'hp:30':''};
 },authorized);}
 async reward(p,request,world,authorized){
  return this.transact(p.acc,request.rid,digest(request),async(state,db)=>{
   const source=world.source(p,request.op,request.x,request.y),key=source.x+','+source.y;
   let gl=0;
   if(request.op==='chest'){
    if(state.chests.includes(key))throw error('already_open');
    if(state.chests.length>=50000)throw error('capacity');
    state.chests.push(key);gl=crypto.randomInt(10,41);questEvent(state,'chest');
    if(crypto.randomInt(100)<35)state.pot=Math.min(9,state.pot+1);
    state.b=Math.max(state.b,Math.min(30,state.b+crypto.randomInt(1,4)));state.a=Math.max(state.a,Math.min(60,state.a+crypto.randomInt(3,9)));
   }else{
    await db.query('INSERT INTO graal_reward_sources(source_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING',['bush:'+key,JSON.stringify({next:0})]);
    const row=await db.query('SELECT state FROM graal_reward_sources WHERE source_id=$1 FOR UPDATE',['bush:'+key]);
    if(row.rows[0].state.next>Date.now())throw error('cooldown');
    await db.query('UPDATE graal_reward_sources SET state=$2 WHERE source_id=$1',['bush:'+key,JSON.stringify({next:Date.now()+15000})]);
    if(crypto.randomInt(100)<45)gl=crypto.randomInt(100)<15?5:1;
   }
   if(request.op==='bush')state.lastCut={x:p.x,y:p.y,until:Date.now()+5000};
   state.gl=Math.min(1000000000,state.gl+gl);return {reward:gl,source:key,op:request.op};
  },authorized);
 }
 async credit(id,amount,rid,authorized){if(!Number.isSafeInteger(amount)||amount<0||amount>100000)throw error('invalid_reward');return this.transact(id,rid,digest(['credit',amount]),s=>{s.gl=Math.min(1000000000,s.gl+amount);},authorized);}
}
module.exports={Economy,legacyState,accountData,protectSave,merchant,offers,buy,near,digest,error,HATS,questEvent};
