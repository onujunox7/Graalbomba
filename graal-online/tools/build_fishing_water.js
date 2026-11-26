'use strict';
// Creates a new water manifest from existing world data; never overwrites a file.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const [source,output,report]=process.argv.slice(2);
if(!source||!output)throw new Error('Usage: node build_fishing_water.js GODOT_DATA NEW_OUTPUT [SHORE_REPORT]');
const tiles=fs.readFileSync(path.join(source,'world_tiles.bin')),types=fs.readFileSync(path.join(source,'ttype.txt'));
const solid=fs.readFileSync(path.join(source,'world_solid.bin'));
const w=1664,h=2752,bits=Buffer.alloc(Math.ceil(w*h/8));let count=0;
const tile=(x,y)=>tiles.readUInt16LE((Math.floor(y/64)*26*4096+Math.floor(x/64)*4096+(y%64)*64+x%64)*2);
const water=(x,y)=>x>=192&&x<1472&&y>=1472&&y<h&&types[tile(x,y)]===56;
for(let y=1472;y<h;y++)for(let x=192;x<1472;x++)if(water(x,y)){const n=y*w+x;bits[n>>3]|=1<<(n&7);count++;}
let best,score=Infinity;
for(let y=1473;y<h-8;y++)for(let x=193;x<1471;x++){
 if(water(x,y)||solid[y*w+x]||solid[y*w+x-1]||solid[(y-1)*w+x])continue;
 for(const [face,dx,dy]of [[0,0,-1],[1,-1,0],[2,0,1],[3,1,0]])if(water(x+dx*6,y+dy*6)){
  const distance=(x*8-6704)**2+(y*8-17104)**2;
  if(distance<score){score=distance;best={x:x*8+4,y:y*8+4,tx:x*8+4+dx*48,ty:y*8+4+dy*48,face};}
 }
}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
fs.writeFileSync(output,JSON.stringify({version:1,w,h,encoding:'deflate-bitset',water_tiles:count,types:types.toString('ascii'),tiles_sha256:hash(tiles),types_sha256:hash(types),data:zlib.deflateSync(bits).toString('base64')})+'\n',{flag:'wx'});
if(report)fs.writeFileSync(report,JSON.stringify(best,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({water_tiles:count,output_bytes:fs.statSync(output).size,shore:best}));
