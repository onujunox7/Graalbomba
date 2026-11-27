'use strict';
const crypto=require('crypto');
const {MONSTER_HIT_INV_MS}=require('./combat-timing');
const {error,near,digest,questEvent,pendingDrop,ammunitionLoot}=require('./economy');
// The host still animates/moves monsters. Health, hit cadence, loot and respawn
// eligibility belong to the server; a host cannot submit a death or a reward.
const TYPES={blue:[80,6,14],red:[100,8,22],chasupa:[40,2,16],popo:[36,1,12],bubble:[20,0,18],sblue:[90,6,18],sgray:[120,8,24],lizard:[140,9,30],ninja:[110,7,32],sgold:[160,11,34],dragon:[260,14,60],green_eyegore:[80,6,14],blue_taros:[90,6,18],red_taros:[100,8,22],moblin:[120,8,24],sk:[34,3,10],skE:[80,5,35]};
class CombatRewards{
 constructor(economy){this.economy=economy;this.positions=new Map();this.health=new Map();}
 async init(){const rows=await this.economy.pool.query("SELECT source_id,state FROM graal_reward_sources WHERE source_id LIKE 'monster:%'");for(const row of rows.rows)this.health.set(Number(row.source_id.slice(8)),row.state);}
 state(s){const base=TYPES[s.k];if(!base)return null;const level=Math.max(1,Math.min(100,s.lv||1)),max=Math.round(base[0]*(1+(s.k==='sk'||s.k==='skE'?0.12:0.15)*(level-(s.k==='skE'?3:1))));const old=this.health.get(s.id);return old&&old.signature===digest([s.k,s.x,s.y,s.lv])&&(old.hp>0||old.next>Date.now())?old:{hp:max,next:0};}
 observe(entries,spawns){
  const now=Date.now();
  for(const e of entries){if(!Array.isArray(e)||!Number.isInteger(e[0]))continue;const s=spawns[e[0]];if(!s||!TYPES[s.k])continue;
   const x=Number(e[1]),y=Number(e[2]),old=this.positions.get(s.id);
   if(!Number.isFinite(x)||!Number.isFinite(y)||Math.hypot(x-s.x,y-s.y)>200)continue;
   if(old&&Math.hypot(x-old.x,y-old.y)>100*Math.min(2,(now-old.at)/1000)+30)continue;
   this.positions.set(s.id,{x,y,at:now});
  }
 }
 async hit(p,request,spawns,authorized){
  const result=await this.economy.transact(p.acc,request.rid,digest(request),async(state,db)=>{
   const s=spawns.find(s=>s.id===request.sid);if(!s||!TYPES[s.k]||p.in||p.spar||p.hp===0)throw error('invalid_source');
   const pos=this.positions.get(s.id)||s;
   let multiplier=1,origin={x:p.x,y:p.y};
   if(request.weapon==='a'||request.weapon==='b'){
    const shot=(state.shots||[]).find(shot=>!shot.inside&&shot.kind===request.weapon&&shot.until>Date.now()&&!shot.targets.includes(s.id)&&(shot.kind==='b'||shot.targets.length===0)&&Math.hypot(shot.x-pos.x,shot.y-pos.y)<(shot.kind==='a'?430:180));
    if(!shot)throw error('invalid_source');shot.targets.push(s.id);origin=shot;multiplier=request.weapon==='a'?0.9:2.2;
   }else if(request.weapon==='throw'){
    if(!state.lastCut||state.lastCut.until<Date.now()||Math.hypot(state.lastCut.x-pos.x,state.lastCut.y-pos.y)>140)throw error('invalid_source');origin=state.lastCut;state.lastCut=null;multiplier=1.2;
   }else if(!near(p,pos.x,pos.y,70))throw error('source_out_of_range');
   // Per-account and per-monster cooldowns are both persisted under row locks.
   if((state.nextHit||0)>Date.now()&&request.weapon!=='b')throw error('cooldown');
   const level=Math.max(1,Math.min(100,s.lv||1)),base=TYPES[s.k],scale=s.k==='sk'||s.k==='skE'?0.12:0.15;
   const maxHP=Math.round(base[0]*(1+scale*(level-(s.k==='skE'?3:1))));
   const key='monster:'+s.id,signature=digest([s.k,s.x,s.y,s.lv]);
   await db.query('INSERT INTO graal_reward_sources(source_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING',[key,JSON.stringify({hp:maxHP,next:0,hit:0,signature})]);
   const row=await db.query('SELECT state FROM graal_reward_sources WHERE source_id=$1 FOR UPDATE',[key]);let mob=row.rows[0].state;
   if(mob.signature!==signature)mob={hp:maxHP,next:0,hit:0,signature};
   if(mob.hp<=0){if(mob.next>Date.now())throw error('cooldown');mob.hp=maxHP;}
   if(mob.hit>Date.now())throw error('cooldown');
   const damage=Math.max(3,Math.round((state.lvl*5+30+state.up*8+crypto.randomInt(1,20))*multiplier)-base[1]-level*3-6);
   mob.hp=Math.max(0,mob.hp-damage);mob.hit=Date.now()+MONSTER_HIT_INV_MS;state.nextHit=Date.now()+350;
   let reward=0;
   if(mob.hp===0){mob.next=Date.now()+30000;if(crypto.randomInt(100)<70){const roll=crypto.randomInt(100);reward=roll>=95?30:roll>=60?5:1;}if(p.groundDrops&&reward>0)pendingDrop(state,pos.x,pos.y,reward,request.rid);else state.gl=Math.min(1000000000,state.gl+reward);ammunitionLoot(state,p,pos.x,pos.y,request.rid);state.kills++;state.exp+=Math.round(base[2]*(1+0.2*(level-1)));while(state.exp>=100){state.exp-=100;state.lvl=Math.min(999,state.lvl+1);}}
   if(mob.hp===0){questEvent(state,'kill');if(s.k==='skE')questEvent(state,'elite');if(!['sk','skE'].includes(s.k))questEvent(state,'mon');}
   await db.query('UPDATE graal_reward_sources SET state=$2 WHERE source_id=$1',[key,JSON.stringify(mob)]);
   let dx=pos.x-origin.x,dy=pos.y-origin.y,length=Math.hypot(dx,dy);
   if(length<0.001){const face=/(Up|Left|Down|Right)$/.exec(p.an||'')?.[1]||'Right';[dx,dy]={Up:[0,-1],Left:[-1,0],Down:[0,1],Right:[1,0]}[face];length=1;}
   return {kx:dx/length,ky:dy/length,sid:s.id,hp:mob.hp,damage,reward,dead:mob.hp===0,x:pos.x,y:pos.y,mob};
  },authorized);
  if(!result.duplicate)this.health.set(result.sid,result.mob);
  return result;
 }
}
module.exports={CombatRewards,TYPES};
