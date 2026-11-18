'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');

test('Python ausente no servidor recebe diagnóstico correto em vez de culpar o vídeo', async t=>{
  t.mock.method(cp,'execFile',(_binary,_args,_options,callback)=>{
    const error=Object.assign(new Error('exit 127'),{code:127});
    queueMicrotask(()=>callback(error,'',"env: 'python3': No such file or directory\nenv: use -[v]S to pass options in shebang lines\n"));
  });
  const modulePath=require.resolve('./speaker_media');
  delete require.cache[modulePath];
  const createMedia=require(modulePath);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'speaker-runtime-test-'));
  try {
    await assert.rejects(createMedia(directory).resolve('https://youtu.be/oXBWG4owmvE'),{
      message:'O preparador de áudio do servidor está incompleto. Atualize as dependências do servidor.'
    });
    assert.deepEqual(fs.readdirSync(directory),[]);
  } finally {
    if(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('speaker-runtime-test-'))fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('Windows mantém o executável já fornecido pela dependência',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('Unexpected download');});
  const install=require('./speaker_install');
  assert.equal(await install('unused','win32','x64'),false);
});

test('download inválido preserva o executável antigo e limpa apenas seu temporário',async t=>{
  const install=require('./speaker_install');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'speaker-install-test-'));
  const target=path.join(directory,'yt-dlp');
  const original='#!/usr/bin/env python3\n';
  fs.writeFileSync(target,original);
  t.mock.method(globalThis,'fetch',async url=>{
    assert.equal(url,'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux');
    return new Response('corrupted download');
  });
  try {
    await assert.rejects(install(target,'linux','x64'),/Checksum inválido/);
    assert.equal(fs.readFileSync(target,'utf8'),original);
    assert.deepEqual(fs.readdirSync(directory),['yt-dlp']);
  } finally {
    if(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('speaker-install-test-'))fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('falha HTTP de instalação preserva o executável anterior',async t=>{
  const install=require('./speaker_install');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'speaker-install-test-'));
  const target=path.join(directory,'yt-dlp');
  fs.writeFileSync(target,'old downloader');
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  try {
    await assert.rejects(install(target,'linux','x64'),/HTTP 503/);
    assert.equal(fs.readFileSync(target,'utf8'),'old downloader');
    assert.deepEqual(fs.readdirSync(directory),['yt-dlp']);
  } finally {
    if(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('speaker-install-test-'))fs.rmSync(directory,{recursive:true,force:true});
  }
});
