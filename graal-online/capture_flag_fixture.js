'use strict';
const assert=require('node:assert/strict'),create=require('./capture-flag'),{FIELD}=create.RULES;
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
module.exports={fixture};
