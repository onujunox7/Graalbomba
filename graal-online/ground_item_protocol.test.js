'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pendingDrop}=require('./economy');

test('new personal Glims start their visible pop animation',()=>{
 const state={};const drop=pendingDrop(state,88,88,5,'a'.repeat(32));
 assert.equal(drop.pop,1);
});
test('coin and ammunition from the same source have distinct typed IDs',()=>{
 const state={},request='b'.repeat(32);
 const coin=pendingDrop(state,88,88,5,request);
 const arrow=pendingDrop(state,100,88,1,request,'a');
 const bomb=pendingDrop(state,100,88,1,request,'b');
 assert.equal(arrow.k,'a');assert.equal(bomb.k,'b');
 assert.equal(new Set([coin.id,arrow.id,bomb.id]).size,3);
});

const source=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
const start=source.indexOf("if (m.t === 'hi') {"),end=source.indexOf("if (m.t === 'auth')",start);
assert.ok(start>=0&&end>start);
function hello(){let snapshots=0,syncs=0;const handler=vm.runInNewContext('(function(p,m){const ws={};'+source.slice(start,end)+'})',{
 sendTo:()=>{},groundSnapshot:()=>snapshots++,fishing:{sync:()=>syncs++},
 sha:()=> 'guest-hash',P:new Map(),banOf:()=>null,KICKED:new Map(),AD:{admins:{}},setRole:()=>{},
 setTimeout:()=>{},fmtDur:()=>'',banMsg:()=>'',football:{disconnect:()=>{}},ctf:{disconnect:()=>{}},parties:{disconnect:()=>{}},others:()=>{}
});return {handler,get snapshots(){return snapshots;},get syncs(){return syncs;}};}
test('Discord identity negotiates drop features before identity early return',()=>{
 const h=hello(),p={uh:'signed-account-hash'},m={t:'hi',uid:'1'.repeat(32),economy:1,ground_drops:1,item_drops:1,fishing:1};
 h.handler(p,m);assert.equal(p.groundDrops,true);assert.equal(p.itemDrops,true);assert.equal(h.snapshots,1);
 h.handler(p,m);assert.equal(h.snapshots,1,'repeat hello cannot replay snapshots');
 assert.equal(p.uh,'signed-account-hash');
});
test('guest and old clients keep compatible feature negotiation',()=>{
 const h=hello(),p={role:0};h.handler(p,{t:'hi',uid:'2'.repeat(32),economy:1,ground_drops:1});
 assert.equal(p.groundDrops,true);assert.equal(p.itemDrops,false);assert.equal(p.uh,'guest-hash');
});
