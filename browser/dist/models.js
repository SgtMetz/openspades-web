import * as THREE from './vendor/three.module.js';
const cache=new Map();
// KV6 is the same voxel format consumed by OpenSpades' VoxelModel::LoadKV6.
export async function loadModel(name,team=0x4678b6){
 const key=name+team;if(cache.has(key))return cache.get(key);
 const response=await fetch('assets/Models/'+name+'.kv6');if(!response.ok)throw Error('Missing model: '+name);
 const b=await response.arrayBuffer(),v=new DataView(b);
 if(v.getUint32(0,true)!==0x6c78764b)throw Error('Invalid KV6: '+name);
 const xs=v.getUint32(4,true),ys=v.getUint32(8,true),zs=v.getUint32(12,true);
 const px=v.getFloat32(16,true),py=v.getFloat32(20,true),pz=v.getFloat32(24,true),count=v.getUint32(28,true);
 const spans=32+count*8+xs*4,voxels=new Map();let idx=0;
 for(let x=0;x<xs;x++)for(let y=0;y<ys;y++){
  const n=v.getUint16(spans+(x*ys+y)*2,true);
  for(let j=0;j<n;j++,idx++){
   const offset=32+idx*8,z=v.getUint16(offset+4,true),c=v.getUint32(offset,true)&0xffffff;
   voxels.set(x+','+y+','+z,{x,y,z,c:c===0?team:c});
  }
 }
 const pos=[],colors=[],normal=[];
 const faces=[[[1,0,0],[[1,0,0],[1,1,0],[1,1,1],[1,0,1]]],[[-1,0,0],[[0,1,0],[0,0,0],[0,0,1],[0,1,1]]],[[0,1,0],[[1,1,0],[0,1,0],[0,1,1],[1,1,1]]],[[0,-1,0],[[0,0,0],[1,0,0],[1,0,1],[0,0,1]]],[[0,0,1],[[0,0,1],[1,0,1],[1,1,1],[0,1,1]]],[[0,0,-1],[[0,1,0],[1,1,0],[1,0,0],[0,0,0]]]];
 for(const {x,y,z,c} of voxels.values())for(const [n,verts] of faces){
  if(voxels.has((x+n[0])+','+(y+n[1])+','+(z+n[2])))continue;
  // GLOptimizedVoxelModel: origin -= .5 so (0,0,0) is the center of voxel (0,0,0), not its corner.
  // This coordinate transform has negative determinant, so reverse triangle winding.
  for(const i of [0,2,1,0,3,2]){const p=verts[i];pos.push(x+p[0]-px-.5,-z-p[2]+pz+.5,-y-p[1]+py+.5);normal.push(n[0],-n[2],-n[1]);colors.push(((c>>16)&255)/255,((c>>8)&255)/255,(c&255)/255);}
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.computeBoundingSphere();cache.set(key,g);return g;
}
