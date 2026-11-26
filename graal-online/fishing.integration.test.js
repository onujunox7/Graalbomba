'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Pool}=require('pg');
const {WebSocketServer,WebSocket}=require('ws');
const {Economy}=require('./economy');
const {RewardWorld}=require('./reward-world');
const createFishing=require('./fishing');

test('native rod, touch bar, catch animation, observer and collection run through real server simulation', {timeout:70000}, async()=>{
 assert.ok(process.env.AETHERIA_TEST_DATABASE);assert.ok(process.env.AETHERIA_GODOT_BIN);
 const pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE}),economy=new Economy(pool);await economy.init({});
 const world=new RewardWorld(path.join(__dirname,'reward-data'));world.refresh({});
 const P=new Map(),active=new Map(),account='native-fish-'+crypto.randomBytes(12).toString('hex');
 const send=(ws,m)=>{if(ws.readyState===1)ws.send(JSON.stringify(m));};
 const fishing=createFishing({players:P,economy,world,send,broadcast:(p,m)=>{for(const q of P.values())if(q!==p&&q.fishingClient)send(q.ws,m);},authorized:p=>p.ws.readyState===1&&active.get(p.acc)===p,randomInt:(a,b)=>b===undefined?0:a});
 const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();}),wss=new WebSocketServer({server});
 const timer=setInterval(()=>fishing.tick(),50);
 wss.on('connection',(ws,req)=>{
  const observer=req.url.includes('observer'),id=observer?2:1;
  const p={id,acc:observer?'observer-'+account:account,ok:true,hp:60,x:6500,y:17060,fishingClient:false,ws};P.set(id,p);active.set(p.acc,p);
  send(ws,{t:'id',id,v:3,economy:1,ground_drops:1,fishing:1});send(ws,{t:'acc',id:p.acc,pid:'',guest:true,data:{}});
  ws.on('message',raw=>{
   const m=JSON.parse(raw);
   if(m.t==='hi'){p.fishingClient=m.fishing===1;fishing.sync(p);}
   if(m.t==='u'){p.x=Number(m.x);p.y=Number(m.y);p.hp=Number(m.hp);}
   if(m.t==='fish'&&raw.length<=512)fishing.handle(p,m);
   if(m.t==='eco'&&m.op==='sync')economy.ensure(p.acc).then(state=>send(ws,{t:'eco',op:'sync',rid:m.rid,account:p.acc,ok:true,state}));
  });
  ws.on('close',()=>{fishing.disconnect(id);P.delete(id);active.delete(p.acc);});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const observer=new WebSocket(`ws://127.0.0.1:${port}/?observer=1`),observed=[];
 observer.on('message',raw=>observed.push(JSON.parse(raw)));
 await new Promise(resolve=>observer.on('open',resolve));observer.send(JSON.stringify({t:'hi',fishing:1}));
 const root=path.resolve(__dirname,'../../..'),report=path.join(root,'reports/fishing-20261125');
 const out=fs.openSync(path.join(report,'native.stdout.log'),'w'),err=fs.openSync(path.join(report,'native.stderr.log'),'w');
 try{
  const child=spawn(process.env.AETHERIA_GODOT_BIN,['--path',path.join(root,'Aetheriav1/graal-godot'),'--rendering-method','gl_compatibility','--rendering-driver','opengl3','--audio-driver','Dummy','res://tests/fishing_check.tscn','--quit-after','3600','--',`--fixture=ws://127.0.0.1:${port}`],{env:{...process.env,APPDATA:path.join(report,'native-appdata'),LOCALAPPDATA:path.join(report,'native-localappdata')},stdio:['ignore',out,err],windowsHide:true});
  const timeout=setTimeout(()=>child.kill(),55000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timeout);
  const stdout=fs.readFileSync(path.join(report,'native.stdout.log'),'utf8'),stderr=fs.readFileSync(path.join(report,'native.stderr.log'),'utf8');
  assert.equal(code,0,stdout+'\n'+stderr.slice(0,2400));assert.match(stdout,/FISHING_CHECK checks=\d+ failures=0 caught=1/);assert.doesNotMatch(stderr,/SCRIPT ERROR|Parse Error/);
  const saved=await new Economy(pool).ensure(account);assert.equal(saved.fish.lambari.count,1);assert.equal(saved.gl,0);
  assert.ok(observed.some(m=>m.t==='fish'&&m.op==='visual'&&m.phase==='caught'&&m.actor===1));
  assert.ok(!observed.some(m=>m.state||m.account===account));
  console.log(stdout.match(/FISHING_CHECK[^\r\n]+/)[0]);
 }finally{
  clearInterval(timer);fs.closeSync(out);fs.closeSync(err);for(const ws of wss.clients)ws.terminate();
  await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));await pool.end();
 }
});
