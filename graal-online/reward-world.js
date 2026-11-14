'use strict';
const fs=require('fs'),path=require('path');
const {error,near,digest}=require('./economy');
const W=1664,H=2752;
const json=(v,f={})=>{try{return typeof v==='string'?JSON.parse(v):v||f;}catch{return f;}};
// Only published world data can create reward sources. Client drop values are never used.
class RewardWorld {
 constructor(root){this.base=fs.readFileSync(path.join(root,'world_bushes.bin'));this.signature='';this.bushes=new Map();this.chests=new Map();}
 refresh(cfg){
  const signature=digest([cfg.map,cfg.levels,cfg.tilesets]);if(signature===this.signature)return;
  const bushes=new Map(),chests=new Map();
  for(let i=0;i+3<this.base.length;i+=4){const x=this.base.readUInt16LE(i),y=this.base.readUInt16LE(i+2);bushes.set(y*W+x,{x,y,w:2,h:2});}
  const erase=(map,x,y,w,h)=>{for(const k of map.keys()){const px=k%W,py=Math.floor(k/W);if(px>=x&&px<x+w&&py>=y&&py<y+h)map.delete(k);}};
  const levels=json(cfg.levels).mundo||{};
  for(const [key,level]of Object.entries(levels)){const n=Number(key);if(!Number.isInteger(n)||n<0||n>=26*43)continue;const x=n%26*64,y=Math.floor(n/26)*64;erase(bushes,x,y,64,64);for(const c of level.c||[])if(Array.isArray(c)&&c.length>=2){const cx=x+Number(c[0]),cy=y+Number(c[1]);chests.set(cy*W+cx,{x:cx,y:cy});}}
  const defs=json(cfg.tilesets).objs||[],dims=[[8,10],[8,10],[8,10],[4,4],[4,4],[2,2],[2,2],[2,2],[2,2],[2,2],[2,2],[4,4],[2,2]];
  for(const e of json(cfg.map).edits||[]){
   const x=Math.trunc(e.x),y=Math.trunc(e.y);if(!Number.isFinite(x)||!Number.isFinite(y))continue;
   if(e.k==='e'||e.k==='v'){erase(bushes,x,y,e.w,e.h);erase(chests,x,y,e.w,e.h);continue;}
   if(e.k!=='o'&&e.k!=='f')continue;
   let wh=dims[e.i],bush=e.i===10||e.i===11;
   if(e.i>=13){const def=defs[e.i-13];if(!def||!Array.isArray(def.rect))continue;const sc=Math.max(1,Number(def.sc)||1);wh=[Math.max(1,Math.floor(def.rect[2]/sc/8)),Math.max(1,Math.floor(def.rect[3]/sc/8))];bush=def.bush===true||(def.bush==null&&/arbusto|mato|bush/i.test(def.name||''));}
   if(!wh)continue;const [w,h]=wh,cols=e.k==='f'?Math.max(1,Math.min(512,e.cols|0)):1,rows=e.k==='f'?Math.max(1,Math.min(512,e.rows|0)):1;
   for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const px=x+c*w,py=y+r*h;if(px<0||py<0||px>=W||py>=H)continue;
    erase(bushes,px,py,w,h);
    if(e.i===12)chests.set(py*W+px,{x:px,y:py});
    if(bush&&w>=2&&h>=2){const source={x:px,y:py,w,h},xs=[],ys=[];for(let i=0;i<w-1;i+=2)xs.push(i);if(xs.at(-1)!==w-2)xs.push(w-2);for(let i=0;i<h-1;i+=2)ys.push(i);if(ys.at(-1)!==h-2)ys.push(h-2);for(const by of ys)for(const bx of xs)bushes.set((py+by)*W+px+bx,source);}
   }
  }
  this.bushes=bushes;this.chests=chests;this.signature=signature;
 }
 source(p,kind,x,y){
  if(p.in||p.spar||!Number.isInteger(x)||!Number.isInteger(y)||p.hp===0)throw error('invalid_source');
  const source=(kind==='bush'?this.bushes:this.chests).get(y*W+x);
  if(!source||!near(p,(source.x+1)*8,(source.y+2)*8,kind==='bush'?64:36))throw error('source_out_of_range');
  return source;
 }
}
module.exports={RewardWorld};
