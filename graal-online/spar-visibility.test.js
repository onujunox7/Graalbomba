const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./server.js'),'utf8');
function fixture() {
  const players = new Map(), clients = new Set();
  const context = {P:players,wss:{clients},sendTo:(c,m)=>c.messages.push(m),setInterval:fn=>{context.snapshot=fn;}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('/* v16: igual a others()'),source.indexOf('const SPAR_QUEUE ='))+'\nthis.broadcast=othersSame;',context);
  vm.runInContext(source.slice(source.indexOf('const AN_DIR ='),source.indexOf('Promise.all([initConfigDB()')),context);
  function player(id, extra={}) {const ws={pid:id,messages:[]}; const p={id,ok:1,x:600,y:600,ws,...extra};players.set(id,p);clients.add(ws);return p;}
  return {player,snapshot:()=>context.snapshot(),broadcast:(p,m)=>context.broadcast(p,m)};
}
test('World spar stays visible to observers in snapshots and immediate movement',()=>{
  const f=fixture(), a=f.player(1,{spar:'one',sparPublic:true}), b=f.player(2,{spar:'one',sparPublic:true}), observer=f.player(3);
  f.player(4,{in:1});f.player(5,{football:'match'});f.player(6,{hid:1});
  f.snapshot();
  assert.deepEqual(Array.from(observer.ws.messages.at(-1).p,p=>p.id),[1,2,3]);
  assert.deepEqual(Array.from(a.ws.messages.at(-1).p,p=>p.id),[1,2,3]);
  f.broadcast(a,{t:'pu',id:a.id});
  assert.equal(observer.ws.messages.at(-1).t,'pu');
  assert.equal(b.ws.messages.at(-1).t,'pu');
  a.spar=b.spar=null; f.snapshot();
  assert.deepEqual(Array.from(observer.ws.messages.at(-1).p,p=>p.id),[1,2,3]);
});
test('Legacy arena, hidden admins and other game modes stay isolated',()=>{
  const f=fixture(), legacy=f.player(1,{spar:'private'}), other=f.player(2,{spar:'private'}), outside=f.player(3);
  f.snapshot();
  assert.deepEqual(Array.from(legacy.ws.messages.at(-1).p,p=>p.id),[1,2]);
  assert.deepEqual(Array.from(outside.ws.messages.at(-1).p,p=>p.id),[3]);
  f.broadcast(legacy,{t:'pu',id:1});
  assert.equal(other.ws.messages.at(-1).t,'pu');
  assert.equal(outside.ws.messages.at(-1).t,'st');
});
test('Interior spar is visible only in the same physical space; CTF stays isolated',()=>{
  const f=fixture(), a=f.player(1,{spar:'one',sparPublic:true,in:1}), observer=f.player(2,{in:1});
  const outside=f.player(3), ctf=f.player(4,{in:1,ctf:'private'});
  f.snapshot();
  assert.ok(observer.ws.messages.at(-1).p.some(p=>p.id===a.id));
  assert.ok(!outside.ws.messages.at(-1).p.some(p=>p.id===a.id));
  assert.ok(!ctf.ws.messages.at(-1).p.some(p=>p.id===a.id));
});
