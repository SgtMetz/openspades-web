import assert from 'node:assert/strict';
import createOpenSpades from '../dist/engine/openspades.js';
const m=await createOpenSpades();
const state=()=>{const p=m._os_state()>>>2;return m.HEAPF32.slice(p,p+32);};
const roster=()=>{const p=m._os_players()>>>2;return m.HEAPF32.slice(p,p+2048);};
const events=()=>{const n=m._os_event_count(),p=m._os_events()>>>2;const e=m.HEAPF32.slice(p,p+n*8);m._os_clear_events();return Array.from({length:n},(_,i)=>Array.from(e.slice(i*8,i*8+8)));};
function step(n,{bits=0,buttons=0,yaw=0,pitch=0,tool=2}={}){for(let i=0;i<n;i++){m._os_input(bits,buttons,yaw,pitch,tool);m._os_step(1/60);}}
function reset(weapon=0,bots=0){m._os_init(weapon,bots);step(60);events();}
reset();
assert.equal(state()[6],100);assert.equal(state()[7],10);assert.equal(state()[17],1);
assert.ok(state().every(Number.isFinite),'Finite native snapshot');
const initial=state();step(60,{bits:1});assert.ok(state()[0]>initial[0]+4,'Original forward movement');
step(60);const ground=state()[2];step(15,{bits:16});assert.ok(state()[2]<ground-.5,'Original jump');step(120);assert.ok(Math.abs(state()[2]-ground)<.1,'Collision lands on the ground');
step(1,{bits:32});assert.ok(state()[2]>ground+.5,'Crouch lowers eye');step(1);assert.ok(Math.abs(state()[2]-ground)<.1,'Uncrouch restores eye');
console.log('PASS: movement, jump, ground collision, crouch');
for(const [weapon,clip,stock] of [[0,10,50],[1,30,120],[2,6,48]]){
 reset(weapon);step(1,{buttons:1});step(2);assert.equal(state()[7],clip-1,'One shot consumes one round');
 m._os_reload();step(210);assert.equal(state()[7],clip);assert.equal(state()[8],stock-1);assert.equal(state()[12],0);
 assert.ok(events().some(e=>e[0]===1),'Native weapon fire event');
}
console.log('PASS: rifle, SMG, shotgun firing and finite-ammo reloads');
reset();const initialRevision=state()[20];step(120,{pitch:1.1,buttons:1,tool:0});
const digEvents=events();assert.ok(state()[20]>initialRevision,'Spade changes terrain');assert.ok(digEvents.some(e=>e[0]===2),'Spade hit callback');
step(2,{pitch:.9,tool:1});let before=state();assert.equal(before[22],1,'Valid block cursor');const cell=before.slice(23,26);assert.equal(m._os_solid(...cell),0);
step(1,{pitch:.9,tool:1,buttons:1});step(2,{pitch:.9,tool:1});assert.equal(state()[9],before[9]-1);assert.equal(m._os_solid(...cell),1,'Build changes authoritative voxel map');
assert.ok(events().some(e=>e[0]===12));
console.log('PASS: digging, valid placement, inventory and voxel mutations');
const rev=state()[20];step(12,{tool:3,pitch:-.3,buttons:1});step(250,{tool:3,pitch:-.3});assert.equal(state()[10],2);assert.ok(events().some(e=>e[0]===4),'Grenade explodes');assert.ok(state()[20]>rev,'Grenade destroys terrain');
console.log('PASS: grenade fuse, explosion and destruction');
reset();let vertices=0,chunks=0;for(let cy=12;cy<20;cy++)for(let cx=12;cx<20;cx++){const i=cy*32+cx,n=m._os_mesh(i),ni=m._os_mesh_index_count();assert.equal(n%4,0);assert.equal(ni,n/4*6);const ip=m._os_mesh_indices()>>>2;const idx=m.HEAPU32.slice(ip,ip+ni);assert.ok(idx.every(v=>v<n),'Indices in range');const pp=m._os_mesh_positions();const pos=m.HEAPU8.slice(pp,pp+n*3);assert.ok(pos.every(v=>v<=64),'Chunk-local positions');vertices+=n;chunks++;}assert.equal(chunks,64);assert.ok(vertices>10000);
console.log(`PASS: all 64 arena chunks produce valid indexed geometry (${vertices} vertices)`);
reset(0,3);
let sawKill=false,sawRespawn=false,victim=-1,killTime=0;
for(let frame=0;frame<60*75;frame++){
 const s=state(),p=roster();let target=-1,best=Infinity;
 for(let i=1;i<=3;i++){let b=i*16;if(p[b+6]){const d=Math.hypot(p[b]-s[0],p[b+1]-s[1],p[b+2]-s[2]);if(d<best){target=i;best=d;}}}
 if(s[7]===0&&!s[12])m._os_reload();
 if(target>0){const b=target*16,dx=p[b]-s[0],dy=p[b+1]-s[1],dz=p[b+2]-s[2];step(1,{buttons:1,yaw:Math.atan2(dy,dx),pitch:Math.atan2(dz,Math.hypot(dx,dy))});}else step(1);
 for(const e of events())if(e[0]===10&&e[1]>0){sawKill=true;victim=e[1];killTime=s[16];}
 if(sawKill&&s[16]>killTime+4&&p[victim*16+6])sawRespawn=true;
 assert.ok(state().every(Number.isFinite));
 if(sawKill&&sawRespawn)break;
}
assert.ok(sawKill,'Native hitscan damages and kills an opponent');assert.ok(sawRespawn,'Opponent respawns after four seconds');assert.ok(state()[14]>0,'Score increments');
console.log('PASS: bot simulation, native hitscan, damage, eliminations and respawn');
reset();assert.equal(state()[14],0);assert.equal(state()[15],0);assert.equal(state()[19],0);assert.equal(state()[9],50);
console.log('PASS: new match resets state');
console.log('All gameplay tests passed.');
