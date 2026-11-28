const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),zlib=require('node:zlib');
const looks=require('./custom-looks');
const source=fs.readFileSync(path.join(__dirname,'custom_looks.test.js'),'utf8');
const {png}=vm.runInNewContext(source.slice(source.indexOf('const SIZES ='),source.indexOf('let pool;'))+'\n({png});',{Buffer,zlib});
test('Hats can be bought, equipped, restored and sold by existing accounts without losing other looks',()=>{
 const state={gl:20000,looks:looks.empty()};delete state.looks.library.hat;delete state.looks.equipped.hat;
 const original=looks.buy(state,{kind:'sword',png:png('sword'),price:0},{});
 assert.equal(looks.selected(state).hat,null);
 delete state.looks.library.hat;delete state.looks.equipped.hat;
 const purchase=looks.buy(state,{kind:'hat',png:png('hat'),price:100}, {hat:100});
 assert.equal(state.gl,19900);assert.equal(looks.selected(state).hat,png('hat'));
 assert.equal(state.looks.equipped.sword,original.asset);
 looks.equip(state,{kind:'hat',asset:''});assert.equal(looks.selected(state).hat,null);
 looks.equip(state,{kind:'hat',asset:purchase.asset});
 assert.throws(()=>looks.equip(state,{kind:'hat',asset:'unowned'}),{code:'not_owned'});
 const restored=JSON.parse(JSON.stringify(state));assert.equal(looks.selected(restored).hat,png('hat'));
 const quote=looks.quoteSale(state,{kind:'hat',asset:purchase.asset});
 looks.sell(state,{kind:'hat',asset:purchase.asset,refund:quote.refund});
 assert.equal(state.gl,20000);assert.equal(looks.selected(state).hat,null);
 assert.equal(state.looks.equipped.sword,original.asset);
});
test('Native equipment uploads are accepted by the real server validator',()=>{
 for(const kind of ['sword','shield','hat']) {
  const file=path.resolve(__dirname,'../../../reports/spar-equipment-20261127/'+kind+'.txt');
  assert.ok(looks.validate(kind,fs.readFileSync(file,'utf8')).id);
 }
});
test('Browser file picker handles selection, cancellation, size limits and read errors',()=>{
 const gd=fs.readFileSync(path.resolve(__dirname,'../../../Aetheriav1/graal-godot/scripts/custom_looks.gd'),'utf8');
 const js=gd.match(/JavaScriptBridge\.eval\("""([\s\S]*?)""", true\)/)[1];
 for(const scenario of ['valid','large','error','cancel']) {
  const replies=[];let input,removed=false,clicked=false,read=false;
  const window={_aetheriaLookVersion:7,_aetheriaLookPicked:(...args)=>replies.push(args)};
  const file={name:'my-sword.png',size:scenario==='large'?4194305:1024};
  const document={body:{appendChild(){}},createElement:()=>input={style:{},files:[file],remove:()=>{removed=true;},click:()=>{clicked=true;}}};
  class FileReader {readAsDataURL(f){read=true;assert.equal(f,file);this.result='data:image/png;base64,AA==';if(scenario==='error')this.onerror();else this.onload();}}
  vm.runInNewContext(js,{window,document,FileReader});assert.ok(clicked);assert.match(input.accept,/\.gif/);
  if(scenario==='cancel'){input.oncancel();assert.equal(replies.length,0);}else{
   input.onchange();assert.equal(replies.length,1);assert.equal(replies[0][0],file.name);assert.equal(replies[0][2],7);
   assert.equal(replies[0][1],scenario==='valid'?'data:image/png;base64,AA==':'');
  }
  assert.ok(removed);assert.equal(read,['valid','error'].includes(scenario));
 }
});
