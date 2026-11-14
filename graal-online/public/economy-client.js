/* Browser compatibility for server-confirmed economy. No wallet writes are trusted. */
(()=>{'use strict';
 const api=window.ECON={enabled:false,account:'',state:null},queue=[],callbacks=new Map();let sent=0;
 const id=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 const pendingKey=()=> 'aetheria_pending_purchases_'+api.account;
 const persist=()=>{try{localStorage.setItem(pendingKey(),JSON.stringify(queue.filter(q=>q.op==='buy')));}catch{}};
 api.request=(op,fields={},callback)=>{if(!api.enabled||!api.account||!window.MPNET?.live()||queue.length>=64)return '';const q={...fields,t:'eco',op,rid:id()};queue.push(q);if(callback)callbacks.set(q.rid,callback);persist();return q.rid;};
 const available=(kind,n)=>Math.max(0,n-queue.filter(q=>q.op==='consume'&&q.kind===kind).length);
 api.apply=()=>{const s=api.state;if(!s||typeof P==='undefined'||!P)return;
  const delta=Math.max(0,s.lvl-P.lvl);P.pts=(P.pts||0)+delta*3;
  for(let level=P.lvl+1;level<=s.lvl;level++){P.str++;if(level%2)P.res++;else P.wil++;}
  P.dmg+=(s.up-P.up)*4;Object.assign(P,{gl:s.gl,pot:available('pot',s.pot),up:s.up,lvl:s.lvl,exp:s.exp,kills:s.kills});
  P.hpM=mHP(P);P.mpM=mMP(P);P.stM=mST(P);
  if(window.__ZL){__ZL.b=available('b',s.b);__ZL.a=available('a',s.a);}
  try{localStorage.setItem('graal_hats_owned',JSON.stringify(s.hats));localStorage.setItem('graal_hat_equip',s.hat);localStorage.setItem('graal_mount_owned',s.mount?'1':'0');localStorage.setItem('graal_npc_bag_v1',JSON.stringify(s.bag));}catch{}
  if(typeof Q!=='undefined'&&s.quest)Q={...s.quest};
  if(typeof CH!=='undefined')for(const chest of CH){const key=Math.round(chest.x/8-1)+','+Math.round(chest.y/8-2);chest.open=s.chests.includes(key)?1:0;}
 };
 api.net=m=>{
  if(m.t==='id'){api.enabled=m.economy===1;return;}
  if(m.t==='acc'){
   if(api.account!==m.id){queue.length=0;callbacks.clear();api.state=null;api.account=m.id;try{for(const q of JSON.parse(localStorage.getItem(pendingKey())||'[]').slice(0,8))if(q.op==='buy'&&typeof q.rid==='string')queue.push(q);}catch{}}
   sent=0;api.request('sync');return;
  }
  if(m.t==='mr'){
   if(typeof SK==='undefined'||!SK)return;const mob=SK.find(s=>s.ca?.id===m.sid);if(!mob)return;
   mob.hp=m.hp;mob.hurt=.25;mob.combat=1;if(m.dead){mob.dead=1;mob.rt=30;mob.combat=0;}dmgText(mob,m.damage,'#fff');return;
  }
  if(m.t!=='eco'||m.account!==api.account)return;
  if(['busy','temporarily_unavailable'].includes(m.code))return;
  const at=queue.findIndex(q=>q.rid===m.rid),deliver=at>=0;if(deliver){queue.splice(at,1);sent=0;persist();}
  if(m.state&&(!api.state||m.state.v>=api.state.v)){api.state=m.state;api.apply();}
  if(deliver&&m.ok&&m.effect&&typeof P!=='undefined'&&P){if(m.effect==='heal')P.hp=P.hpM;else if(m.effect.startsWith('hp:'))P.hp=Math.min(P.hpM,P.hp+Number(m.effect.slice(3)));}
  const callback=callbacks.get(m.rid);callbacks.delete(m.rid);if(callback)callback(m);
  window.dispatchEvent(new CustomEvent('economy-reply',{detail:m}));
 };
 api.hit=(mob,weapon='sword')=>{if(!api.enabled)return false;if(mob.ca?.id&&!(mob.imm>0)){api.request('hit',{sid:mob.ca.id,weapon});mob.imm=.5;}return true;};
 api.chest=chest=>{if(!api.enabled)return false;api.request('chest',{x:Math.round(chest.x/8-1),y:Math.round(chest.y/8-2)});return true;};
 setInterval(()=>{if(!api.enabled||!window.MPNET?.live()||!queue.length||Date.now()-sent<3000)return;sent=Date.now();MPNET.send(queue[0]);},60);
 // Game initialization can follow the account handshake. Reapply only canonical
 // inventory/stat values; transient health and movement remain gameplay state.
 setInterval(()=>{if(api.enabled)api.apply();},1000);
})();
