'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Pool}=require('pg');
const {WebSocketServer}=require('ws');
const {Economy}=require('./economy');
const {RewardWorld}=require('./reward-world');
const createFishing=require('./fishing');

test('native mouse/tap selects water beyond the old range while UI, drag and pinch remain separate', {timeout:65000}, async()=>{
 assert.ok(process.env.AETHERIA_TEST_DATABASE);assert.ok(process.env.AETHERIA_GODOT_BIN);
 const pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE}),economy=new Economy(pool);await economy.init({});
 const world=new RewardWorld(path.join(__dirname,'reward-data'));world.refresh({});
 const P=new Map(),account='target-'+crypto.randomBytes(12).toString('hex'),accepted=[];
 const send=(ws,m)=>{if(ws.readyState===1)ws.send(JSON.stringify(m));};
 const fishing=createFishing({players:P,economy,world,send,authorized:p=>p.ws.readyState===1&&P.get(p.id)===p,randomInt:(a,b)=>b===undefined?0:a});
 const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();}),wss=new WebSocketServer({server});
 const timer=setInterval(()=>fishing.tick(),50);
 wss.on('connection',ws=>{
  const p={id:1,acc:account,ok:true,hp:60,x:6500,y:17060,fishingClient:false,ws};P.set(1,p);
  send(ws,{t:'id',id:1,v:3,economy:1,ground_drops:1,fishing:1,fishing_range:fishing.maxCastDistance});send(ws,{t:'acc',id:account,pid:'',guest:true,data:{}});
  ws.on('message',raw=>{
   const m=JSON.parse(raw);
   if(m.t==='hi')p.fishingClient=m.fishing===1;
   if(m.t==='u'){p.x=Number(m.x);p.y=Number(m.y);p.hp=Number(m.hp);}
   if(m.t==='fish'){
    const previous=fishing.sessions.get(1)?.id;fishing.handle(p,m);const session=fishing.sessions.get(1);
    if(m.op==='cast'&&session&&session.id!==previous)accepted.push({x:session.tx,y:session.ty,distance:Math.hypot(session.tx-session.x,session.ty-session.y)});
   }
   if(m.t==='eco'&&m.op==='sync')economy.ensure(account).then(state=>send(ws,{t:'eco',op:'sync',rid:m.rid,account,ok:true,state}));
  });
  ws.on('close',()=>{fishing.disconnect(1);P.delete(1);});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const root=path.resolve(__dirname,'../../..'),report=path.join(root,'reports/fishing-target-20261126');
 const out=fs.openSync(path.join(report,'native.stdout.log'),'w'),err=fs.openSync(path.join(report,'native.stderr.log'),'w');
 try{
  const child=spawn(process.env.AETHERIA_GODOT_BIN,['--path',path.join(root,'Aetheriav1/graal-godot'),'--rendering-method','gl_compatibility','--rendering-driver','opengl3','--audio-driver','Dummy','res://tests/fishing_target_check.tscn','--quit-after','3000','--',`--fixture=ws://127.0.0.1:${port}`],{env:{...process.env,APPDATA:path.join(report,'native-appdata'),LOCALAPPDATA:path.join(report,'native-localappdata')},stdio:['ignore',out,err],windowsHide:true});
  const timeout=setTimeout(()=>child.kill(),50000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timeout);
  const stdout=fs.readFileSync(path.join(report,'native.stdout.log'),'utf8'),stderr=fs.readFileSync(path.join(report,'native.stderr.log'),'utf8');
  assert.equal(code,0,stdout+'\n'+stderr.slice(0,2400));assert.match(stdout,/FISHING_TARGET_CHECK checks=\d+ failures=0 casts=3/);assert.doesNotMatch(stderr,/SCRIPT ERROR|Parse Error/);
  assert.equal(accepted.length,3);assert.ok(accepted.every(p=>p.distance>88&&p.distance<=128));
  assert.ok(Math.hypot(accepted[0].x-6399.54,accepted[0].y-17086.92)<.05);
  assert.ok(Math.hypot(accepted[1].x-6399.54,accepted[1].y-17086.92)<.05);
  const saved=await economy.ensure(account);assert.equal(saved.gl,0);assert.ok(!saved.fish);assert.equal(fishing.sessions.size,0);
  console.log(stdout.match(/FISHING_TARGET_CHECK[^\r\n]+/)[0]);
 }finally{
  clearInterval(timer);fs.closeSync(out);fs.closeSync(err);for(const ws of wss.clients)ws.terminate();
  await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));await pool.end();
 }
});
