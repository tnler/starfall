import './domstub.mjs';
const THREE = await import('three');
const { World, WORLD } = await import('../js/world.js');
const scene = new THREE.Scene();
const t0 = Date.now();
const gen = World.build(scene, 20260726);
let r, n = 0; do { r = gen.next(); n++; } while (!r.done && n < 8000);
const buildMs = Date.now() - t0;

let meshes = 0, tris = 0, instanced = 0;
scene.traverse(o => {
  if (!o.isMesh) return;
  meshes++;
  if (o.isInstancedMesh) instanced += o.count;
  const g = o.geometry;
  if (g && g.index) tris += g.index.count / 3;
  else if (g && g.attributes && g.attributes.position) tris += g.attributes.position.count / 3;
});
console.log(`build            ${buildMs} ms`);
console.log(`scene meshes     ${meshes}  (+${instanced} instances)`);
console.log(`triangles        ${Math.round(tris).toLocaleString()}`);
console.log(`colliders        ${World.grid.all.length.toLocaleString()}`);
console.log(`terrain chunks   ${World.chunks.length} resident of ${Math.pow(WORLD.size/WORLD.chunk,2)} total`);

// Stream cost, at the speed a guardian actually moves (sprint ~12 units/s).
const pos = new THREE.Vector3(0, 40, 780);
let worst = 0, total = 0, frames = 0;
for (let i = 0; i < 3600; i++) {
  pos.z -= 12 / 60;
  const s = performance.now();
  World._streamChunks(pos);
  const ms = performance.now() - s;
  worst = Math.max(worst, ms); total += ms; frames++;
}
console.log(`stream/frame     avg ${(total/frames).toFixed(2)} ms, worst ${worst.toFixed(1)} ms`);
console.log(`chunks after walk ${World.chunks.length}`);
