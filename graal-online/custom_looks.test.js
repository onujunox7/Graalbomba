'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto'), zlib = require('node:zlib'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Pool } = require('pg');
const looks = require('./custom-looks');
const { Economy, legacyState, protectSave } = require('./economy');
const rid = () => crypto.randomBytes(16).toString('hex');
const SIZES = { head:[32,128],body:[128,224],shield:[38,20],sword:[128,96],hat:[192,48] };
function crc(bytes) { let c=0xffffffff; for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; }
function chunk(tag,data) { const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(tag,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b; }
function png(kind,color=100) {
  const [w,h]=SIZES[kind], ih=Buffer.alloc(13);ih.writeUInt32BE(w);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;
  const pixels=Buffer.alloc((w*4+1)*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const at=y*(w*4+1)+1+x*4;pixels[at]=color;pixels[at+1]=(x%4)*40;pixels[at+2]=(y%4)*40;pixels[at+3]=255;}
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
// Two complete GIF frames with explicit LZW clears: deterministic fixture, no encoder dependency.
function gif(kind) {
  const [w,h]=SIZES[kind], header=Buffer.alloc(13);header.write('GIF89a');header.writeUInt16LE(w,6);header.writeUInt16LE(h,8);header[10]=0x80;
  const parts=[header,Buffer.from([30,50,100,180,50,30])];
  for(let frame=0;frame<2;frame++){
    parts.push(Buffer.from([0x21,0xf9,4,0,frame?25:10,0,0,0]));
    const descriptor=Buffer.alloc(10);descriptor[0]=0x2c;descriptor.writeUInt16LE(w,5);descriptor.writeUInt16LE(h,7);parts.push(descriptor,Buffer.from([2]));
    const codes=[];for(let pixel=0;pixel<w*h;pixel++)codes.push(4,frame);codes.push(5);
    const packed=Buffer.alloc(Math.ceil(codes.length*3/8));codes.forEach((code,index)=>{const bit=index*3;packed[bit>>3]|=code<<(bit&7);if((bit&7)>5)packed[(bit>>3)+1]|=code>>(8-(bit&7));});
    for(let at=0;at<packed.length;at+=255){const block=packed.subarray(at,at+255);parts.push(Buffer.from([block.length]),block);}parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));return 'data:image/gif;base64,'+Buffer.concat(parts).toString('base64');
}
let pool;
before(async()=>{assert.ok(process.env.AETHERIA_TEST_DATABASE,'Use the isolated database runner');pool=new Pool({connectionString:process.env.AETHERIA_TEST_DATABASE,max:8});await new Economy(pool).init({});});
after(async()=>{if(pool)await pool.end();});
const actor=()=>({acc:'looks-'+rid(),hp:100,hm:100,ok:true});

test('all five PNG formats validate; corrupt, truncated and huge images are rejected',()=>{
  for(const kind of looks.KINDS)assert.match(looks.validate(kind,png(kind)).id,/^[a-f0-9]{64}$/);
  assert.throws(()=>looks.validate('head',png('body')),{code:'invalid_png'});
  assert.throws(()=>looks.validate('head',png('head').slice(0,-10)),{code:'invalid_png'});
  assert.throws(()=>looks.validate('__proto__',png('head')),{code:'invalid_png'});
  const corrupt=Buffer.from(png('head').slice(22),'base64');corrupt[30]^=1;
  assert.throws(()=>looks.validate('head','data:image/png;base64,'+corrupt.toString('base64')),{code:'invalid_png'});
  assert.throws(()=>looks.validate('head','data:image/png;base64,'+'A'.repeat(100000)),{code:'invalid_png'});
});

test('GIFs preserve both frames and per-frame delays for every type',async()=>{
  const fixtures={};
  for(const kind of looks.KINDS){
    const asset=await looks.prepare(kind,gif(kind));
    assert.deepEqual(asset.animation.delays,[0.1,0.25]);assert.equal(asset.animation.height,SIZES[kind][1]);
    const raw=Buffer.from(asset.png.slice(22),'base64');assert.equal(raw.readUInt32BE(20),SIZES[kind][1]*2);
    fixtures[kind]={...asset,name:'Teste animado '+kind};
    fs.writeFileSync(path.resolve(__dirname,'../../../reports/spar-equipment-20261127/test-'+kind+'.gif'),Buffer.from(gif(kind).slice(22),'base64'));
  }
  const report=path.resolve(__dirname,'../../../reports/custom-looks-20261126');
  fs.writeFileSync(path.join(report,'native-fixtures.json'),JSON.stringify(fixtures));
  fs.writeFileSync(path.join(report,'test-head.png'),Buffer.from(png('head').slice(22),'base64'));
  fs.writeFileSync(path.join(report,'test-head.gif'),Buffer.from(gif('head').slice(22),'base64'));
  await assert.rejects(looks.prepare('body',gif('head')),{code:'invalid_png'});
  await assert.rejects(looks.prepare('head',gif('head').slice(0,-8)),{code:'invalid_png'});
});

test('0 through 20000 Glims, durable ownership, idempotency and no double charge',async()=>{
  const economy=new Economy(pool),p=actor();await economy.ensure(p.acc);await economy.credit(p.acc,40000,rid(),()=>true);
  const config={head:20000,body:0,shield:0,sword:0},request={kind:'head',png:png('head'),name:'Meu head',price:20000,rid:rid()};
  const first=await economy.buyLook(p,request,()=>config,()=>true);
  assert.equal(first.state.gl,20000);assert.equal(first.state.looks.library.head.length,1);
  assert.equal((await economy.buyLook(p,request,()=>config,()=>true)).duplicate,true);
  assert.equal((await economy.ensure(p.acc)).gl,20000);
  await assert.rejects(economy.buyLook(p,{...request,rid:rid()},()=>config,()=>true),{code:'already_owned'});
  for(const kind of ['body','shield','sword','hat'])await economy.buyLook(p,{kind,png:gif(kind),name:kind,price:0,rid:rid()},()=>config,()=>true);
  const saved=await new Economy(pool).ensure(p.acc);
  assert.equal(saved.gl,20000);for(const kind of looks.KINDS)assert.equal(saved.looks.library[kind].length,1);
  await economy.equipLook(p,{kind:'head',asset:'',rid:rid()},()=>true);
  await economy.equipLook(p,{kind:'head',asset:first.asset,rid:rid()},()=>true);
  await assert.rejects(economy.equipLook(p,{kind:'head',asset:'not-owned',rid:rid()},()=>true),{code:'not_owned'});
  assert.equal((await economy.ensure(p.acc)).gl,20000);
});

test('changed price, insufficient funds, stale session and concurrent buys cannot create free assets',async()=>{
  const economy=new Economy(pool),p=actor();await economy.ensure(p.acc);await economy.credit(p.acc,30000,rid(),()=>true);
  const request={kind:'head',png:png('head'),price:0,rid:rid()};
  await assert.rejects(economy.buyLook(p,request,()=>({head:20000}),()=>true),{code:'shop_changed'});
  await assert.rejects(economy.buyLook(p,{...request,price:20000},()=>({head:20000}),()=>false),{code:'session_changed'});
  const results=await Promise.allSettled([1,2].map(n=>economy.buyLook(p,{...request,png:png('head',n),price:20000,rid:rid()},()=>({head:20000}),()=>true)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'insufficient_glims');
  const saved=await economy.ensure(p.acc);assert.equal(saved.gl,10000);assert.equal(saved.looks.library.head.length,1);
  await assert.rejects(economy.buyLook({...p,spar:'match'},{...request,price:20000},()=>({head:20000}),()=>true),{code:'busy'});
});

test('trusted legacy skins migrate once without replacing account progress; client saves cannot inject ownership',async()=>{
  const economy=new Economy(pool),p=actor(),data={graal_custom_v1:JSON.stringify({h:[png('head')],b:[]}),graal_skin_v2:JSON.stringify({h:37,b:19})};
  const old=legacyState();delete old.looks;old.gl=12345;
  await pool.query('INSERT INTO graal_economy(account_id,state) VALUES($1,$2::jsonb)',[p.acc,JSON.stringify(old)]);
  const state=await economy.ensure(p.acc,legacyState(data));assert.equal(state.gl,12345);assert.equal(state.looks.library.head.length,1);assert.ok(state.looks.equipped.head);
  assert.equal((await economy.ensure(p.acc)).looks.library.head.length,1);
  const save={graal_custom_v1:'fake',graal_headbuy_v1:'fake',graal_classic_save_v1:'{"gl":99999}'};protectSave(save,{});
  assert.equal(save.graal_custom_v1,undefined);assert.equal(save.graal_headbuy_v1,undefined);
});

test('production admin handler allows admins to set 0 and 20000; rejects ordinary users and invalid prices',()=>{
  const source=fs.readFileSync(path.join(__dirname,'server.js'),'utf8'),a=source.indexOf("  ws.on('message', d => {"),b=source.indexOf("  ws.on('close',",a);
  assert.ok(a>=0&&b>a);
  const AD={cfg:{}},messages=[],ws={on:(_event,callback)=>{ws.receive=callback;}},p={role:0,cmdT:0};let saves=0;
  const context={ws,p,id:1,P:new Map(),Date,AD,customLooks:looks,lookPrices:()=>looks.prices(AD.cfg.lookPrices),saveAD:()=>saves++,wss:{clients:[ws]},sendTo:(_ws,m)=>messages.push(m),note:m=>messages.push({note:m})};
  vm.runInNewContext(source.slice(a,b),context);
  const set=(role,kind,price)=>{p.role=role;p.cmdT=0;ws.receive(Buffer.from(JSON.stringify({t:'a',c:'look_price',kind,price})));};
  set(0,'head',20000);assert.equal(saves,0);
  set(1,'head',0);assert.equal(saves,1);assert.equal(AD.cfg.lookPrices.head,0);
  set(1,'body',20000);assert.equal(saves,2);assert.equal(AD.cfg.lookPrices.body,20000);
  for(const v of [-1,20001,1.5,'20000'])set(2,'head',v);
  set(2,'__proto__',0);assert.equal(saves,2);assert.ok(messages.some(m=>m.t==='look_prices'));
});

test('native animated atlas confirms without GIF reconversion; validates every untrusted animation field',async()=>{
  const report=path.resolve(__dirname,'../../../reports/fast-look-confirmation-20261126');
  const request=JSON.parse(fs.readFileSync(path.join(report,'native-upload.json'),'utf8'));
  const start=performance.now();
  const asset=await looks.prepare(request.kind,request.png,request.animation);
  console.log('NATIVE_ATLAS_VALIDATION ms='+ (performance.now()-start).toFixed(3));
  assert.equal(asset.animation.delays.length,2);assert.equal(asset.animation.height,128);
  for(const animation of [false,{}, {height:128,delays:[]},{height:128,delays:[0]},{height:128,delays:[Infinity]},
    {height:128,delays:['0.1']},{height:128,delays:[601]},{height:128,delays:Array(33).fill(0.1)},
    {height:129,delays:[0.1,0.25]},{height:128.5,delays:[0.1,0.25]}, {height:128,delays:[0.1]}]) {
    await assert.rejects(looks.prepare(request.kind,request.png,animation),{code:'invalid_png'});
  }
  const economy=new Economy(pool),p=actor();await economy.ensure(p.acc);await economy.credit(p.acc,20000,rid(),()=>true);
  const purchase={...request,price:20000,rid:rid()};
  const buying=performance.now();const bought=await economy.buyLook(p,purchase,()=>({head:20000}),()=>true);
  console.log('NATIVE_ATLAS_PURCHASE_ACK ms='+ (performance.now()-buying).toFixed(3));
  assert.equal(bought.state.gl,0);assert.equal(bought.state.looks.library.head[0].animation.delays.length,2);
  assert.equal((await economy.buyLook(p,purchase,()=>({head:20000}),()=>true)).duplicate,true);
  assert.equal((await economy.ensure(p.acc)).gl,0);
});
