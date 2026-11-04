const http=require('http'),fs=require('fs'),path=require('path'),{WebSocketServer}=require('ws');
const PORT=process.env.PORT||3000;
const srv=http.createServer((q,s)=>{fs.readFile(path.join(__dirname,'public','index.html'),(e,d)=>{if(e){s.writeHead(500);return s.end('erro')}s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});s.end(d)})});
const wss=new WebSocketServer({server:srv,maxPayload:500000});
let nid=1;const P=new Map();
const skin=v=>(typeof v==='string'&&v.length<300000&&v.startsWith('data:image/png;base64,'))?v:null;
const eqv=v=>typeof v==='number'?((v|0)>=0&&(v|0)<=6?v|0:0):(typeof v==='string'&&v.length<90000&&v.startsWith('data:image/png;base64,')?v:0);
const send=(c,o)=>{if(c.readyState===1)c.send(typeof o==='string'?o:JSON.stringify(o))};
wss.on('connection',ws=>{
 const id=nid++;P.set(id,{id,x:0,y:0,nm:'?',an:'Idle_Down',al:1,ok:0,b:0,h:1,s:.6,bs:null,hs:null,lc:0,eq:null,sw:0});
 send(ws,{t:'id',id,v:3});
 for(const q of P.values())if(q.id!==id&&(q.bs||q.hs))send(ws,{t:'k',id:q.id,bs:q.bs,hs:q.hs});
 for(const q of P.values())if(q.id!==id&&q.eq)send(ws,{t:'q',id:q.id,e:q.eq});
 ws.on('message',d=>{let m;try{m=JSON.parse(d)}catch(e){return}const p=P.get(id);if(!p||!m)return;
  if(m.t==='u'){if(d.length>400)return;
   p.x=+m.x||0;p.y=+m.y||0;p.nm=String(m.nm||'?').slice(0,12);
   p.an=/^(Idle|Run|Attack)_(Up|Down|Left|Right)$/.test(m.an)?m.an:'Idle_Down';p.al=m.al==1?1:.4;
   p.b=Math.max(0,Math.min(99,+m.b|0));p.h=Math.max(0,Math.min(99,+m.h|0));p.s=Math.max(.3,Math.min(1,+m.s||.6));p.sw=m.sw?1:0;p.ok=1}
  else if(m.t==='k'){p.bs=skin(m.bs);p.hs=skin(m.hs);const o=JSON.stringify({t:'k',id,bs:p.bs,hs:p.hs});wss.clients.forEach(c=>{if(c!==ws)send(c,o)})}
  else if(m.t==='q'&&m.e&&typeof m.e==='object'){p.eq={h:eqv(m.e.h),s:eqv(m.e.s),d:eqv(m.e.d)};const o=JSON.stringify({t:'q',id,e:p.eq});wss.clients.forEach(c=>{if(c!==ws)send(c,o)})}
  else if(m.t==='c'){const now=Date.now();if(now-p.lc<500)return;p.lc=now;
   const x=String(m.x||'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,80);if(!x)return;
   const o=JSON.stringify({t:'c',id,nm:p.nm,x});wss.clients.forEach(c=>send(c,o))}
 });
 ws.on('close',()=>{P.delete(id);const o=JSON.stringify({t:'l',id});wss.clients.forEach(c=>send(c,o))});
 ws.on('error',()=>{});
});
setInterval(()=>{const a=[...P.values()].filter(p=>p.ok).map(p=>({id:p.id,x:p.x,y:p.y,nm:p.nm,an:p.an,al:p.al,b:p.b,h:p.h,s:p.s,sw:p.sw}));
 if(!a.length)return;const msg=JSON.stringify({t:'st',p:a});wss.clients.forEach(c=>send(c,msg))},100);
srv.listen(PORT,()=>console.log('Graal Online em http://localhost:'+PORT));
