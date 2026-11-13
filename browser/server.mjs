import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleUpgrade} from './relay.mjs';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.opus':'audio/ogg','.wav':'audio/wav','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf','.vxl':'application/octet-stream','.kv6':'application/octet-stream'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  const name=decodeURIComponent(url.pathname);const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root)||name.includes('\\')){res.writeHead(403);res.end();return;}
  const info=await stat(file);if(!info.isFile())throw Error('Not a file');
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','X-OpenSpades-Relay':'1'});
  if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
 }catch{res.writeHead(404);res.end('Not found');}
});
// Multiplayer: browsers reach UDP game servers through the WebSocket relay at /relay.
server.on('upgrade',(req,socket)=>{
 const port=server.address().port;
 if(!handleUpgrade(req,socket,new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`])))socket.destroy();
});
server.listen(Number(process.env.PORT)||8080,'127.0.0.1',()=>console.log(`OpenSpades: http://127.0.0.1:${server.address().port}`));
