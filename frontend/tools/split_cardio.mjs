/**
 * Splits sys_cardio into the heart (keeps the name sys_cardio, tinted by status) and cardio_vessels
 * (always drawn neutral). Without this, a 'watch' on heart & blood flow tints the vessels that run
 * through the whole body, and the figure reads as a whole-body alarm.
 *
 * A connected part of the mesh counts as heart when it lies fully inside HEART_BOX (metres, model frame:
 * feet at y=0, height 1.75 m, front is +z). Everything else (aorta, arteries, veins) becomes cardio_vessels.
 *
 *   node tools/split_cardio.mjs <in.glb> <out.glb>
 *
 * The output is uncompressed; run `gltf-transform meshopt` on it afterwards (see build_body.sh).
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const HEART_BOX = { min: [-0.07, 1.26, -0.05], max: [0.09, 1.41, 0.09] };
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node tools/split_cardio.mjs <in.glb> <out.glb>');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const root = doc.getRoot();
if (root.listNodes().some((n) => n.getName() === 'cardio_vessels')) throw new Error('model is already split');
const node = root.listNodes().find((n) => n.getName() === 'sys_cardio');
if (!node) throw new Error('sys_cardio node not found');

const prim = node.getMesh().listPrimitives()[0];
const pos = prim.getAttribute('POSITION');
const tris = prim.getIndices().getArray();
const world = node.getWorldMatrix();
const toWorld = ([x, y, z]) => [0, 1, 2].map((i) => world[i] * x + world[4 + i] * y + world[8 + i] * z + world[12 + i]);

// Connected parts: union vertices that share a triangle or sit at the same position.
const parent = Int32Array.from({ length: pos.getCount() }, (_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
const seen = new Map();
const v = [0, 0, 0];
for (let i = 0; i < pos.getCount(); i++) {
  const key = pos.getElement(i, v).join(',');
  if (seen.has(key)) unite(i, seen.get(key)); else seen.set(key, i);
}
for (let t = 0; t < tris.length; t += 3) { unite(tris[t], tris[t + 1]); unite(tris[t], tris[t + 2]); }

const outside = new Set();
for (let i = 0; i < pos.getCount(); i++) {
  const p = toWorld(pos.getElement(i, v));
  if (p.some((c, k) => c < HEART_BOX.min[k] || c > HEART_BOX.max[k])) outside.add(find(i));
}
const heart = [];
const vessels = [];
for (let t = 0; t < tris.length; t += 3) (outside.has(find(tris[t])) ? vessels : heart).push(tris[t], tris[t + 1], tris[t + 2]);
if (!heart.length || !vessels.length) throw new Error(`split failed: heart ${heart.length / 3} tris, vessels ${vessels.length / 3} tris`);

const indexAccessor = (list) => doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(list)).setBuffer(prim.getIndices().getBuffer());
const vesselPrim = prim.clone().setIndices(indexAccessor(vessels));
prim.setIndices(indexAccessor(heart));
compactPrimitive(prim);
compactPrimitive(vesselPrim);

const vesselNode = doc.createNode('cardio_vessels')
  .setMesh(doc.createMesh('cardio_vessels').addPrimitive(vesselPrim))
  .setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale());
(node.getParentNode() ?? root.listScenes()[0]).addChild(vesselNode);

root.listExtensionsUsed().filter((e) => e.extensionName === 'EXT_meshopt_compression').forEach((e) => e.dispose());
await io.write(output, doc);
console.log(`[split_cardio] heart ${heart.length / 3} tris, vessels ${vessels.length / 3} tris -> ${output}`);
