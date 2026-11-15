/**
 * Adds context organs to the body model: lungs, kidneys & bladder, stomach & intestines, and the spleen.
 * They are drawn neutral (no tracked number drives them), except the spleen, which joins the immune system.
 *
 * Source: BodyParts3D 3.0 STL files from the GitHub mirror Kevin-Mattheus-Moerman/BodyParts3D
 * ("BodyParts3D, (c) The Database Center for Life Science licensed under CC Attribution-Share Alike 2.1 Japan").
 * See CREDITS.md.
 *
 *   node tools/add_organs.mjs <stl dir> <in.glb> <out.glb>
 *
 * BodyParts3D is Z-up in millimetres with the front at -Y. The model frame is metres, Y-up, front +Z, feet at 0.
 * FRAME was fitted to parts that exist in both: the femurs (scale, x) and the liver (height, depth).
 * The output is uncompressed; run `gltf-transform meshopt` on it afterwards (see build_body.sh).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const FRAME = { scale: 0.001079, offset: [0.006, -0.0127, -0.1046] };

/** Mesh name -> FMA ids and triangle budget. Names are the contract with src/three/bodyModel.ts. */
export const ORGANS = {
  anat_lungs: { ids: ['FMA7333', 'FMA7337', 'FMA7383', 'FMA7370', 'FMA7371', 'FMA7394'], budget: 14000 },
  anat_kidneys: { ids: ['FMA7204', 'FMA7205', 'FMA15900'], budget: 5000 },
  anat_gut: { ids: ['FMA7148', 'FMA7206', 'FMA7207', 'FMA7208', 'FMA14543nsn', 'FMA14544'], budget: 16000 },
  immune_spleen: { ids: ['FMA7196'], budget: 1500 },
};

const [stlDir, input, output] = process.argv.slice(2);
if (!stlDir || !input || !output) throw new Error('usage: node tools/add_organs.mjs <stl dir> <in.glb> <out.glb>');

function readStl(path) {
  const buf = readFileSync(path);
  const count = buf.readUInt32LE(80);
  if (buf.length !== 84 + count * 50) throw new Error(`${path}: not a binary STL`);
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const o = 84 + t * 50 + 12 + k * 12;
      const X = buf.readFloatLE(o), Y = buf.readFloatLE(o + 4), Z = buf.readFloatLE(o + 8);
      out.set([FRAME.scale * X + FRAME.offset[0], FRAME.scale * Z + FRAME.offset[1], -FRAME.scale * Y + FRAME.offset[2]], t * 9 + k * 3);
    }
  }
  return out;
}

/** Shared-vertex mesh from a triangle soup: identical positions become one vertex. */
function weld(soup) {
  const map = new Map();
  const pos = [];
  const idx = new Uint32Array(soup.length / 3);
  for (let i = 0; i < soup.length; i += 3) {
    const key = `${soup[i].toFixed(6)},${soup[i + 1].toFixed(6)},${soup[i + 2].toFixed(6)}`;
    let v = map.get(key);
    if (v === undefined) { v = pos.length / 3; map.set(key, v); pos.push(soup[i], soup[i + 1], soup[i + 2]); }
    idx[i / 3] = v;
  }
  return { positions: new Float32Array(pos), indices: idx };
}

function compact(positions, indices) {
  const remap = new Map();
  const pos = [];
  const idx = new Uint32Array(indices.length);
  indices.forEach((v, i) => {
    let n = remap.get(v);
    if (n === undefined) { n = pos.length / 3; remap.set(v, n); pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
    idx[i] = n;
  });
  return { positions: new Float32Array(pos), indices: idx };
}

function vertexNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) { n[v] += f[0]; n[v + 1] += f[1]; n[v + 2] += f[2]; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const root = doc.getRoot();
const scene = root.listScenes()[0];
const buffer = root.listBuffers()[0];

for (const [name, { ids, budget }] of Object.entries(ORGANS)) {
  if (root.listNodes().some((n) => n.getName() === name)) throw new Error(`${name} already in the model`);
  const soups = ids.map((id) => readStl(join(stlDir, `${id}.stl`)));
  const soup = new Float32Array(soups.reduce((s, a) => s + a.length, 0));
  soups.reduce((o, a) => { soup.set(a, o); return o + a.length; }, 0);
  const welded = weld(soup);
  const before = welded.indices.length / 3;
  const target = Math.min(welded.indices.length, budget * 3);
  const [simple] = MeshoptSimplifier.simplify(welded.indices, welded.positions, 3, target, 0.01);
  const { positions, indices } = compact(welded.positions, simple);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(vertexNormals(positions, indices)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  console.log(`[add_organs] ${name}: ${before} -> ${indices.length / 3} tris`);
}

root.listExtensionsUsed().filter((e) => e.extensionName === 'EXT_meshopt_compression').forEach((e) => e.dispose());
await io.write(output, doc);
