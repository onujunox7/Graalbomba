const http=require('http'),fs=require('fs'),path=require('path'),{WebSocketServer}=require('ws');
const PORT=process.env.PORT||3000;
const srv=http.createServer((q,s)=>{fs.readFile(path.join(__dirname,'public','index.html'),(e,d)=>{if(e){s.writeHead(500);return s.end('erro')}s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});s.end(d)})});
const wss=new WebSocketServer({server:srv});
let nid=1;const P=new Map();
wss.on('connection',ws=>{
 const id=nid++;P.set(id,{id,x:0,y:0,nm:'?',an:'Idle_Down',al:1,ok:0,b:0,h:1,s:.6});
 ws.send(JSON.stringify({t:'id',id}));
 ws.on('message',d=>{if(d.length>300)return;let m;try{m=JSON.parse(d)}catch(e){return}
  if(m.t!=='u')return;const p=P.get(id);
  p.x=+m.x||0;p.y=+m.y||0;p.nm=String(m.nm||'?').slice(0,12);
  p.an=/^(Idle|Run|Attack)_(Up|Down|Left|Right)$/.test(m.an)?m.an:'Idle_Down';p.b=Math.max(0,Math.min(99,+m.b|0));p.h=Math.max(0,Math.min(99,+m.h|0));p.s=Math.max(.3,Math.min(1,+m.s||.6));p.al=m.al==1?1:.4;p.ok=1});
 ws.on('close',()=>P.delete(id));ws.on('error',()=>{});
});
setInterval(()=>{const a=[...P.values()].filter(p=>p.ok);if(!a.length)return;const msg=JSON.stringify({t:'st',p:a});wss.clients.forEach(c=>{if(c.readyState===1)c.send(msg)})},100);
srv.listen(PORT,()=>console.log('Graal Online em http://localhost:'+PORT));
