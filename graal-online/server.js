const http=require('http'),fs=require('fs'),path=require('path'),{WebSocketServer}=require('ws');
const PORT=process.env.PORT||3000;
const srv=http.createServer((q,s)=>{fs.readFile(path.join(__dirname,'public','index.html'),(e,d)=>{if(e){s.writeHead(500);return s.end('erro')}s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});s.end(d)})});
const wss=new WebSocketServer({server:srv});
let nid=1;const P=new Map();
wss.on('connection',ws=>{
 const id=nid++;P.set(id,{id,x:0,y:0,nm:'?',an:'Idle_2',al:1,ok:0});
 ws.send(JSON.stringify({t:'id',id}));
 ws.on('message',d=>{if(d.length>300)return;let m;try{m=JSON.parse(d)}catch(e){return}
  if(m.t!=='u')return;const p=P.get(id);
  p.x=+m.x||0;p.y=+m.y||0;p.nm=String(m.nm||'?').slice(0,12);
  p.an=/^(Idle|Run|Attack)_[0-3]$/.test(m.an)?m.an:'Idle_2';p.al=m.al==1?1:.4;p.ok=1});
 ws.on('close',()=>P.delete(id));ws.on('error',()=>{});
});
setInterval(()=>{const a=[...P.values()].filter(p=>p.ok);if(!a.length)return;const msg=JSON.stringify({t:'st',p:a});wss.clients.forEach(c=>{if(c.readyState===1)c.send(msg)})},100);
srv.listen(PORT,()=>console.log('Graal Online em http://localhost:'+PORT));
