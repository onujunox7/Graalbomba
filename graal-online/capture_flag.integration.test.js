'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {once}=require('node:events'),{spawn}=require('node:child_process'),{WebSocket,WebSocketServer}=require('ws');
const create=require('./capture-flag');
async function until(condition,timeout=4000){const end=Date.now()+timeout;while(Date.now()<end){if(condition())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out waiting for CTF message');}
async function fixture(){
 const text=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
 const start=text.indexOf("  ws.on('message', d => {"),end=text.indexOf("  ws.on('close',",start);assert.ok(start>=0&&end>start);
 let time=100000,next=1;const players=new Map(),clients=[];
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const send=(ws,m)=>{if(ws.readyState===1)ws.send(typeof m==='string'?m:JSON.stringify(m));};
 const ctf=create({players,send,authorized:p=>p.allowed,viewPlayer:p=>({id:p.id,nm:p.nm,b:19,h:36,s:.6}),now:()=>time});
 server.on('connection',ws=>{
  const id=next++;ws.pid=id;
  const p={id,ws,ok:1,allowed:true,hp:60,hm:60,x:6704+id,y:17104,nm:'Jogador '+id,an:'Idle_Down',acc:'fixture-'+id};players.set(id,p);
  vm.runInNewContext(text.slice(start,end),{ws,p,id,P:players,ctf,football:{handle(){throw new Error('CTF player reached football');}},SPAR_QUEUE:[],sendTo:send,Date,console});
  ws.on('close',()=>{ctf.disconnect(id);players.delete(id);});
  send(ws,{t:'id',id,v:3});
 });
 return {players,ctf,port:server.address().port,advance(ms){time+=ms;ctf.tick();},
  async connect(){
   const ws=new WebSocket('ws://127.0.0.1:'+server.address().port),messages=[];clients.push(ws);ws.on('message',raw=>messages.push(JSON.parse(raw)));await once(ws,'open');await until(()=>messages.some(m=>m.t==='id'));
   return {ws,id:messages.find(m=>m.t==='id').id,messages,send:(op,fields={})=>ws.send(JSON.stringify({t:'ctf',op,...fields})),last:(op='state')=>messages.findLast(m=>m.t==='ctf'&&m.op===op)};
  },async close(){for(const ws of clients)ws.terminate();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));}
 };
}

test('12 real WebSocket clients share flags and score, reject a seventh teammate and ignore forged world updates',{timeout:15000},async()=>{
 const f=await fixture();try{
  const clients=[];for(let i=0;i<13;i++)clients.push(await f.connect());
  for(let i=0;i<12;i++){clients[i].send('join',{team:i%2});await until(()=>clients[i].last('queue')?.joined);}
  clients[12].send('join',{team:0});await until(()=>clients[12].last('error'));assert.match(clients[12].last('error').message,/6 jogadores/);
  f.advance(10000);f.advance(3000);await until(()=>clients[0].last()?.phase==='playing'&&clients[11].last()?.phase==='playing');
  for(const client of clients.slice(0,12)){assert.equal(client.last().players.length,12);assert.equal(client.last().flags.length,2);assert.deepEqual(client.last().score,[0,0]);}
  const p=f.players.get(clients[0].id),before={x:p.x,y:p.y};
  clients[0].ws.send(JSON.stringify({t:'u',lv:999,hp:99999,hm:99999,x:99999,y:99999}));
  clients[0].ws.send(JSON.stringify({t:'football',op:'join'}));
  await until(()=>clients[0].messages.some(m=>m.t==='football'&&m.op==='error'));
  assert.equal(p.x,before.x);assert.equal(p.y,before.y);assert.equal(p.hp,180);
  clients[0].send('move',{seq:1,dx:1,dy:0});await new Promise(r=>setTimeout(r,10));f.advance(100);
  await until(()=>clients[0].last()?.players.find(e=>e.id===p.id).ack===1);assert.ok(p.x>before.x);
  clients[0].send('leave');await until(()=>clients[0].last('end'));assert.equal(p.x,6704+p.id);assert.equal(p.hp,60);
 }finally{await f.close();}
});

test('native Godot client joins through production routing, moves in arena and leaves back at original position',{timeout:25000},async()=>{
 const f=await fixture();let timer,child;
 try{
  const bot=await f.connect();bot.send('join',{team:0});await until(()=>bot.last('queue')?.joined);
  const report=path.resolve(__dirname,'../../../reports/ctf-fixes-20261127');
  const out=fs.openSync(path.join(report,'network-native-out.log'),'w'),err=fs.openSync(path.join(report,'network-native-err.log'),'w');
  timer=setInterval(()=>f.advance(250),50);
  child=spawn('C:/Users/Junior/Downloads/Godot_v4.7.2-stable_win64.exe/Godot_v4.7.2-stable_win64.exe',
   ['--headless','--path',path.resolve(__dirname,'../../../Aetheriav1/graal-godot'),'res://tests/capture_flag_network_check.tscn','--quit-after','1200','--',`--fixture=ws://127.0.0.1:${f.port}`],
   {windowsHide:true,stdio:['ignore',out,err],env:{...process.env,APPDATA:path.join(report,'network-appdata'),LOCALAPPDATA:path.join(report,'network-localappdata')}});
  const timeout=setTimeout(()=>child.kill(),18000);const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timeout);fs.closeSync(out);fs.closeSync(err);
  const stdout=fs.readFileSync(path.join(report,'network-native-out.log'),'utf8'),stderr=fs.readFileSync(path.join(report,'network-native-err.log'),'utf8');
  assert.equal(code,0,stdout+'\n'+stderr.slice(0,2000));assert.match(stdout,/CTF_NETWORK_CHECK checks=\d+ failures=0/);assert.doesNotMatch(stderr,/SCRIPT ERROR|Parse Error/);console.log(stdout.match(/CTF_NETWORK_CHECK[^\r\n]+/)[0]);
 }finally{clearInterval(timer);await f.close();}
});
