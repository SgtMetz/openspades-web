import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Finds a running copy of this version of the game server (identified by the X-OpenSpades-Relay
// response header) or starts one. An older server without the relay may still hold port
// 8080, so the next free port is used in that case.
async function probe(port){
 try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1200)});return r.ok&&r.headers.get('x-openspades-relay')==='1'?'game':'other';}catch{return 'free';}
}
let url=null;
for(let port=8080;port<8090&&!url;port++){
 let status=await probe(port);
 if(status==='other')continue;
 if(status==='free'){
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{...process.env,PORT:String(port)},detached:true,windowsHide:true,stdio:'ignore'});child.unref();
  for(let i=0;i<25&&status!=='game';i++){await new Promise(r=>setTimeout(r,200));status=await probe(port);}
 }
 if(status==='game')url=`http://127.0.0.1:${port}/`;
}
if(!url)throw Error('Could not start the local game on ports 8080-8089. Run npm start in the browser folder to see details.');
execFile('cmd.exe',['/d','/c','start','',url],{windowsHide:true});
console.log('OpenSpades is running at '+url);
