'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const http=require('node:http');
const {Pool}=require('pg');
const {WebSocketServer}=require('ws');
const {Economy,pendingDrop}=require('./economy');

test('native client collects all colors and restores admin drops through the real economy handler', {timeout:60000}, async()=>{
 assert.ok(process.env.AETHERIA_TEST_DATABASE);
 assert.ok(process.env.AETHERIA_GODOT_BIN);
 const pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE});
 const economy=new Economy(pool);await economy.init({});
 const account='native-'+crypto.randomBytes(12).toString('hex');
 await economy.transact(account,crypto.randomBytes(16).toString('hex'),'fixture-seed',state=>{
  for(const [i,v]of [1,5,30,100,1000,5000].entries())pendingDrop(state,6604+i*40,17144,v,crypto.randomBytes(16).toString('hex'));
 });
 const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
 const wss=new WebSocketServer({server});
 const P=new Map(),ACTIVE_ACC=new Map(),DROPS=new Map();
 const sendTo=(ws,m)=>{if(ws.readyState===1)ws.send(JSON.stringify(m));};
 const text=fs.readFileSync(path.join(__dirname,'server.js'),'utf8').replace(/\r\n/g,'\n');
 const start=text.indexOf('const economicSession='),end=text.indexOf('\n}\n',start)+2;
 assert.ok(start>=0&&end>start);
 const defs=text.slice(text.indexOf('const groundBroadcast='),text.indexOf('\nsetInterval',text.indexOf('const groundBroadcast=')));
 const handlers=vm.runInNewContext(text.slice(start,end)+'\n'+defs+'\n({economicRequest,groundSnapshot});',{
  economy,ACTIVE_ACC,DROPS,P,sendTo,SP:{add:[]},spBroadcast:()=>{},Date,Set,
 });
 const pending=new Set();
 wss.on('connection',ws=>{
  const p={id:1,acc:account,ok:true,x:6704,y:17104,hp:100,hm:100,role:1,economyClient:true,groundDrops:false,ws};
  P.set(1,p);ACTIVE_ACC.set(account,p);
  sendTo(ws,{t:'id',id:1,v:3,economy:1,ground_drops:1});
  sendTo(ws,{t:'acc',id:account,pid:'',guest:true,data:{}});
  sendTo(ws,{t:'role',r:1});
  ws.on('message',raw=>{
   const m=JSON.parse(raw);
   if(m.t==='hi'){p.groundDrops=m.ground_drops===1;handlers.groundSnapshot(p);}
   if(m.t==='u'){p.x=Number(m.x);p.y=Number(m.y);}
   if(m.t==='eco'){
    const operation=handlers.economicRequest(p,m);pending.add(operation);operation.finally(()=>pending.delete(operation));
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const root=path.resolve(__dirname,'../../..');
 const report=path.join(root,'reports/glim-pickup-20261125');
 const out=fs.openSync(path.join(report,'native.stdout.log'),'w'),err=fs.openSync(path.join(report,'native.stderr.log'),'w');
 try{
  const child=spawn(process.env.AETHERIA_GODOT_BIN,['--path',path.join(root,'Aetheriav1/graal-godot'),'--rendering-method','gl_compatibility','--rendering-driver','opengl3','--audio-driver','Dummy','res://tests/ground_drops_check.tscn','--quit-after','2400','--',`--fixture=ws://127.0.0.1:${port}`],{
   env:{...process.env,APPDATA:path.join(report,'native-appdata'),LOCALAPPDATA:path.join(report,'native-localappdata')},stdio:['ignore',out,err],windowsHide:true,
  });
  const timeout=setTimeout(()=>child.kill(),45000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timeout);
  const stdout=fs.readFileSync(path.join(report,'native.stdout.log'),'utf8');
  const stderr=fs.readFileSync(path.join(report,'native.stderr.log'),'utf8');
  assert.equal(code,0,stdout+'\n'+stderr.slice(0,1600));
  assert.match(stdout,/GROUND_DROPS_CHECK checks=\d+ failures=0 wallet=6141/);
  assert.doesNotMatch(stderr,/SCRIPT ERROR|Parse Error/);
  await Promise.allSettled(pending);
  assert.equal((await economy.ensure(account)).gl,6141);
  assert.equal((await economy.ensure(account)).drops.length,0);
  assert.equal(DROPS.size,0);
  console.log(stdout.match(/GROUND_DROPS_CHECK[^\r\n]+/)[0]);
 }finally{
  fs.closeSync(out);fs.closeSync(err);
  for(const ws of wss.clients)ws.terminate();
  await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));await pool.end();
 }
});
