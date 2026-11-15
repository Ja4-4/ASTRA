#!/usr/bin/env bash
# Reproducible body model build. Requires: python with bpy 5.x (pip install bpy) or Blender >= 4.2, node.
set -euo pipefail
SRC="${1:?usage: tools/build_body.sh <work dir>}"
BASE=https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST
mkdir -p "$SRC"
[ -f "$SRC/partof_element_parts.txt" ] || curl -fsS -o "$SRC/partof_element_parts.txt" "$BASE/partof_element_parts.txt"
if [ ! -d "$SRC/partof_BP3D_4.0_obj_99" ]; then
  curl -fsS -o "$SRC/bp3d.zip" "$BASE/partof_BP3D_4.0_obj_99.zip"
  unzip -q "$SRC/bp3d.zip" -d "$SRC"
fi
mkdir -p public/models
PY="${BPY_PYTHON:-python3}"
"$PY" tools/build_body.py --src "$SRC" --out "$SRC/astra_body_raw.glb"
npx gltf-transform weld "$SRC/astra_body_raw.glb" "$SRC/welded.glb"
node tools/split_cardio.mjs "$SRC/welded.glb" "$SRC/split.glb"
# Context organs (lungs, kidneys, gut, spleen) from the BodyParts3D 3.0 STL mirror on GitHub.
MIRROR=https://raw.githubusercontent.com/Kevin-Mattheus-Moerman/BodyParts3D/main/assets/BodyParts3D_data/stl
mkdir -p "$SRC/stl"
for id in FMA7333 FMA7337 FMA7383 FMA7370 FMA7371 FMA7394 FMA7204 FMA7205 FMA15900 FMA7148 FMA7206 FMA7207 FMA7208 FMA14543nsn FMA14544 FMA7196; do
  [ -f "$SRC/stl/$id.stl" ] || curl -fsS -o "$SRC/stl/$id.stl" "$MIRROR/$id.stl"
done
node tools/add_organs.mjs "$SRC/stl" "$SRC/split.glb" "$SRC/organs.glb"
npx gltf-transform meshopt "$SRC/organs.glb" public/models/astra_body.glb --level medium
npx gltf-transform inspect public/models/astra_body.glb
ls -la public/models/astra_body.glb
