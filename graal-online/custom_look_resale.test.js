'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {Pool}=require('pg'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),zlib=require('node:zlib');
const {Economy}=require('./economy'),looks=require('./custom-looks');
const source=fs.readFileSync(path.join(__dirname,'custom_looks.test.js'),'utf8');
const {png}=vm.runInNewContext(source.slice(source.indexOf('const SIZES ='),source.indexOf('let pool;'))+'\n({png});',{Buffer,zlib});
const rid=()=>crypto.randomBytes(16).toString('hex'),actor=()=>({acc:'resale-'+rid(),ok:true,hp:100});
let pool,economy;
before(async()=>{assert.ok(process.env.AETHERIA_TEST_DATABASE);pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE,max:8});economy=new Economy(pool);await economy.init({});});
after(async()=>{if(pool)await pool.end();});
async function purchase(price=20000){
 const p=actor();await economy.ensure(p.acc);await economy.credit(p.acc,20000,rid(),()=>true);
 const request={rid:rid(),kind:'head',png:png('head'),price,paid:999999,boughtAt:1};
 const result=await economy.buyLook(p,request,()=>({head:price}),()=>true);
 return {p,request,asset:result.asset};
}
const quote=(p,asset)=>economy.lookSale(p,{rid:rid(),kind:'head',asset},true,()=>true);
async function age(p,asset,ms){await economy.transact(p.acc,rid(),'fixture-age',s=>{s.looks.library.head.find(a=>a.id===asset).boughtAt=Date.now()-ms;},()=>true);}

test('new purchase records the real paid amount and server time; exactly five hours changes 100% to 50%',async()=>{
 const {p,asset}=await purchase();const state=await economy.ensure(p.acc),item=state.looks.library.head[0];
 assert.equal(item.paid,20000);assert.ok(item.boughtAt>Date.now()-10000);
 const end=item.boughtAt+looks.FULL_REFUND_MS;
 assert.equal(looks.quoteSale(state,{kind:'head',asset},end-1).refund,20000);
 assert.equal(looks.quoteSale(state,{kind:'head',asset},end).refund,10000);
 assert.equal(looks.quoteSale(state,{kind:'head',asset},end+1).refund,10000);
});

test('selling before five hours returns all paid Glims, removes the slot and unequips; retry never pays twice',async()=>{
 const {p,asset}=await purchase();const q=await quote(p,asset);assert.equal(q.quote.refund,20000);assert.equal(q.state.gl,0);
 const request={rid:rid(),kind:'head',asset,refund:q.quote.refund};
 const result=await economy.lookSale(p,request,false,()=>true);
 assert.equal(result.state.gl,20000);assert.equal(result.state.looks.library.head.length,0);assert.equal(result.state.looks.equipped.head,'');
 const retry=await economy.lookSale(p,request,false,()=>true);assert.equal(retry.duplicate,true);assert.equal(retry.state.gl,20000);
 await assert.rejects(economy.lookSale(p,{...request,rid:rid()},false,()=>true),{code:'not_owned'});
});

test('after five hours returns half of the paid price, including odd prices and free items',async()=>{
 for(const price of [20000,5,0]){
  const {p,asset}=await purchase(price);await age(p,asset,looks.FULL_REFUND_MS+1000);
  const q=await quote(p,asset);assert.equal(q.quote.refund,Math.floor(price/2));
  const sold=await economy.lookSale(p,{rid:rid(),kind:'head',asset,refund:q.quote.refund},false,()=>true);
  assert.equal(sold.state.gl,20000-price+Math.floor(price/2));
 }
});

test('crossing the five-hour boundary after preview asks for a new confirmation and does not remove the item',async()=>{
 const {p,asset}=await purchase();const old=await quote(p,asset);await age(p,asset,looks.FULL_REFUND_MS+1000);
 await assert.rejects(economy.lookSale(p,{rid:rid(),kind:'head',asset,refund:old.quote.refund},false,()=>true),{code:'refund_changed'});
 const state=await economy.ensure(p.acc);assert.equal(state.gl,0);assert.equal(state.looks.library.head.length,1);
 assert.equal((await quote(p,asset)).quote.refund,10000);
});

test('older bought files recover real price and purchase time from account receipts',async()=>{
 const {p,asset,request}=await purchase(17321);
 await economy.transact(p.acc,rid(),'fixture-old-metadata',s=>{delete s.looks.library.head[0].paid;delete s.looks.library.head[0].boughtAt;},()=>true);
 await pool.query("UPDATE graal_economy_receipts SET created_at=now()-interval '6 hours' WHERE account_id=$1 AND request_id=$2",[p.acc,request.rid]);
 const q=await quote(p,asset);assert.equal(q.quote.paid,17321);assert.equal(q.quote.refund,8660);
 const restored=q.state.looks.library.head[0];assert.equal(restored.paid,17321);assert.ok(restored.boughtAt<Date.now()-looks.FULL_REFUND_MS);
});

test('another account, forged refund, concurrent sale and wallet overflow cannot mint currency or lose the file',async()=>{
 const {p,asset}=await purchase();const other=actor();await economy.ensure(other.acc);
 await assert.rejects(quote(other,asset),{code:'not_owned'});
 await assert.rejects(economy.lookSale(p,{rid:rid(),kind:'head',asset,refund:99999},false,()=>true),{code:'refund_changed'});
 const results=await Promise.allSettled([1,2].map(()=>economy.lookSale(p,{rid:rid(),kind:'head',asset,refund:20000},false,()=>true)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await economy.ensure(p.acc)).gl,20000);
 const full=await purchase();await economy.transact(full.p.acc,rid(),'fixture-full-wallet',s=>{s.gl=1000000000;},()=>true);
 await assert.rejects(economy.lookSale(full.p,{rid:rid(),kind:'head',asset:full.asset,refund:20000},false,()=>true),{code:'capacity'});
 assert.equal((await economy.ensure(full.p.acc)).looks.library.head.length,1);
});

test('unrecorded legacy files do not invent a paid value; a repurchase starts a fresh five-hour window',async()=>{
 const p=actor(),asset=looks.validate('head',png('head'));await economy.ensure(p.acc);
 await economy.transact(p.acc,rid(),'fixture-unrecorded-file',s=>{s.looks.library.head=[{...asset,name:'Legacy'}];},()=>true);
 await assert.rejects(quote(p,asset.id),{code:'refund_unavailable'});
 const purchased=await purchase();await age(purchased.p,purchased.asset,looks.FULL_REFUND_MS+1000);
 await economy.lookSale(purchased.p,{rid:rid(),kind:'head',asset:purchased.asset,refund:10000},false,()=>true);
 const again=await economy.buyLook(purchased.p,{rid:rid(),kind:'head',png:png('head'),price:5},()=>({head:5}),()=>true);
 assert.equal((await quote(purchased.p,again.asset)).quote.refund,5);
});

test('heads, bodies, shields and swords all sell with their own paid value',async()=>{
 for(const kind of looks.KINDS){
  const p=actor();await economy.ensure(p.acc);await economy.credit(p.acc,100,rid(),()=>true);
  const bought=await economy.buyLook(p,{rid:rid(),kind,png:png(kind),price:100},()=>({[kind]:100}),()=>true);
  const q=await economy.lookSale(p,{rid:rid(),kind,asset:bought.asset},true,()=>true);assert.equal(q.quote.refund,100);
  const sold=await economy.lookSale(p,{rid:rid(),kind,asset:bought.asset,refund:100},false,()=>true);
  assert.equal(sold.state.gl,100);assert.equal(sold.state.looks.library[kind].length,0);
 }
});

test('real WebSockets route quote and sale through production handler and update the observer after sale',{timeout:10000},async()=>{
 const {WebSocketServer,WebSocket}=require('ws'),{once}=require('node:events');
 const {p:buyer,asset}=await purchase(),messages=[],broadcast=[];
 const text=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
 const handler=text.slice(text.indexOf("  ws.on('message', d => {"),text.indexOf("  ws.on('close',",text.indexOf("  ws.on('message', d => {")));
 const apply=text.slice(text.indexOf('function applyLooks('),text.indexOf('const {RewardWorld}'));
 const economic=text.slice(text.indexOf('async function economicRequest('),text.indexOf('function applySv('));
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 server.on('connection',ws=>{
  const p={...buyer,id:1,ws,economyClient:true};
  vm.runInNewContext(apply+'\n'+economic+'\n'+handler,{ws,p,id:1,P:new Map([[1,p]]),customLooks:looks,economy,
    economicSession:q=>q===p&&ws.readyState===1,sendTo:(socket,m)=>socket.send(JSON.stringify(m)),others:(_id,m)=>broadcast.push(m),console});
 });
 const client=new WebSocket('ws://127.0.0.1:'+server.address().port);client.on('message',raw=>messages.push(JSON.parse(raw)));
 try{
  await once(client,'open');
  const request=async(op,fields)=>{
   const id=rid();client.send(JSON.stringify({t:'eco',op,rid:id,...fields}));
   const until=Date.now()+3000;while(Date.now()<until){const result=messages.find(m=>m.rid===id);if(result)return result;await new Promise(r=>setTimeout(r,5));}
   throw new Error('Production sale handler did not reply');
  };
  const q=await request('look_sell_quote',{kind:'head',asset});assert.equal(q.ok,true);assert.equal(q.quote.refund,20000);assert.equal(q.state.gl,0);
  const sold=await request('look_sell',{kind:'head',asset,refund:q.quote.refund});assert.equal(sold.ok,true);assert.equal(sold.state.gl,20000);
  assert.equal(sold.state.looks.library.head.length,0);assert.equal(broadcast.at(-1).hs,null);
  const saved=await new Economy(pool).ensure(buyer.acc);assert.equal(saved.gl,20000);assert.equal(saved.looks.equipped.head,'');
 }finally{client.terminate();for(const ws of server.clients)ws.terminate();await new Promise(resolve=>server.close(resolve));}
});
