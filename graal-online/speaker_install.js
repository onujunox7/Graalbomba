'use strict';
// The generic Unix yt-dlp needs a system Python, absent from the deployment runtime.
// Install the official standalone release at the same path used by speaker_media.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const {promisify}=require('node:util');
const RELEASE='2026.10.26';
const ASSETS={
  x64:{name:'yt-dlp_linux',sha256:'767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795'},
  arm64:{name:'yt-dlp_linux_aarch64',sha256:'e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483'}
};
const MAX_BINARY=64*1024*1024;

async function checksum(filename) {
  const hash=crypto.createHash('sha256');
  try { for await(const chunk of fs.createReadStream(filename))hash.update(chunk); }
  catch(error) { if(error.code==='ENOENT')return ''; throw error; }
  return hash.digest('hex');
}

async function verifyVersion(filename) {
  const {stdout}=await promisify(cp.execFile)(filename,['--version'],{timeout:15000,windowsHide:true,maxBuffer:65536});
  if(stdout.trim()!==RELEASE)throw new Error('Versão inesperada do preparador de áudio.');
}

async function install(target,platform=process.platform,arch=process.arch) {
  if(platform!=='linux')return false;
  const asset=ASSETS[arch];
  if(!asset)throw new Error('Arquitetura Linux sem preparador de áudio compatível: '+arch);
  if(await checksum(target)===asset.sha256) {
    await fs.promises.chmod(target,0o755);
    await verifyVersion(target);
    return false;
  }
  const response=await fetch('https://github.com/yt-dlp/yt-dlp/releases/download/'+RELEASE+'/'+asset.name,{signal:AbortSignal.timeout(90000)});
  if(!response.ok||!response.body)throw new Error('Download do preparador de áudio falhou (HTTP '+response.status+').');
  if(Number(response.headers.get('content-length'))>MAX_BINARY){await response.body.cancel();throw new Error('Preparador de áudio ultrapassa o tamanho permitido.');}
  await fs.promises.mkdir(path.dirname(target),{recursive:true});
  const temporary=target+'.speaker-'+crypto.randomBytes(6).toString('hex')+'.tmp';
  let output;
  try {
    output=await fs.promises.open(temporary,'wx',0o755);
    const hash=crypto.createHash('sha256');
    let bytes=0;
    for await(const chunk of response.body) {
      bytes+=chunk.length;
      if(bytes>MAX_BINARY)throw new Error('Preparador de áudio ultrapassa o tamanho permitido.');
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    await output.close();output=null;
    if(hash.digest('hex')!==asset.sha256)throw new Error('Checksum inválido do preparador de áudio.');
    await verifyVersion(temporary);
    await fs.promises.rename(temporary,target);
    return true;
  } finally {
    if(output)await output.close();
    await fs.promises.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}

module.exports=install;
if(require.main===module) {
  install(require('youtube-dl-exec').constants.YOUTUBE_DL_PATH).then(changed=>{
    if(changed)console.log('Preparador de áudio Linux '+RELEASE+' instalado com Python incluído.');
  }).catch(error=>{console.error('Instalação do áudio: '+error.message);process.exitCode=1;});
}
