// Separate, local-only server for the original threaded client. No production changes.
import http from 'node:http';
import {createReadStream, mkdirSync, appendFileSync, writeFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleUpgrade} from '../relay.mjs';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
// ---- Playtest crash logging: the page (debug-log.js) POSTs log lines to /__log. ----
const logDir=fileURLToPath(new URL('../logs/',import.meta.url));mkdirSync(logDir,{recursive:true});
const sessions=new Map(); // session -> {file,last,warned}
function writeLog(sess,lines){
  let s=sessions.get(sess);
  if(!s){s={file:path.join(logDir,sess.replace(/[^\w-]/g,'_')+'.log'),last:0,warned:false};sessions.set(sess,s);console.log(`[log] new session ${sess} -> ${s.file}`);}
  s.last=Date.now();if(s.warned){s.warned=false;lines=[...lines,'          [server] heartbeat resumed'];}
  appendFileSync(s.file,lines.join('\n')+'\n');
  for(const l of lines)if(/\[(FATAL|ERROR|ABORT|EXIT|status|dialog)\]/.test(l))console.log(`[log ${sess.slice(-4)}] ${l.slice(0,500)}`);
}
setInterval(()=>{for(const[sess,s]of sessions)if(!s.warned&&Date.now()-s.last>15000){s.warned=true;const msg=`          [server] NO DATA FROM PAGE FOR ${((Date.now()-s.last)/1000)|0}s at ${new Date().toISOString()} (tab crashed, frozen, closed, or throttled in background)`;appendFileSync(s.file,msg+'\n');console.log(`[log ${sess.slice(-4)}] ${msg}`);}},5000);
const types={'.js':'text/javascript','.html':'text/html; charset=utf-8','.wasm':'application/wasm','.data':'application/octet-stream','.opus':'audio/ogg'};
const server=http.createServer(async(req,res)=>{
  try {
    if(req.url==='/__log'&&req.method==='POST'){let body='';req.setEncoding('utf8');req.on('data',c=>{body+=c;if(body.length>4e6)req.destroy();});req.on('end',()=>{try{const j=JSON.parse(body);writeLog(String(j.session),j.lines.map(String));}catch(e){console.log('[log] bad post',e.message);}res.writeHead(204);res.end();});return;}
    // Crash reports (crash-report.js): one JSON file each in browser/logs/.
    if(req.url==='/__crash'&&req.method==='POST'){let body='';req.setEncoding('utf8');req.on('data',c=>{body+=c;if(body.length>2e6)req.destroy();});req.on('end',()=>{try{const j=JSON.parse(body);const id=String(j.id||Date.now()).replace(/[^\w-]/g,'_');const file=path.join(logDir,`crash-${id}.json`);writeFileSync(file,JSON.stringify(j,null,1));console.log(`[crash] ${j.kind}: ${String(j.reason).slice(0,200)} -> ${file}`);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id}));}catch(e){res.writeHead(400);res.end();}});return;}
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(name==='/'){res.writeHead(302,{Location:'/full/'});res.end();return;}
    const file=path.resolve(root,'.'+(name.endsWith('/')?name+'index.html':name));
    if(!file.startsWith(root)||name.includes('\\')){res.writeHead(403);res.end();return;}
    const info=await stat(file);if(!info.isFile())throw Error();
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':info.size,'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-cache'});
    if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }catch{res.writeHead(404);res.end('Not found');}
});
server.on('upgrade',(req,socket)=>{const port=server.address().port;if(!handleUpgrade(req,socket,new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`])))socket.destroy();});
server.listen(Number(process.env.PORT)||8100,'127.0.0.1',()=>console.log(`Original OpenSpades client: http://127.0.0.1:${server.address().port}/full/`));
