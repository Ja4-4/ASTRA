// Copies the MediaPipe Tasks Vision WASM runtime from node_modules into public/, so the app serves it itself
// and the camera scan works fully offline. Runs before dev and build; the copy is not committed (see .gitignore).
// The face model itself (public/models/face_landmarker.task) is committed.
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const from = 'node_modules/@mediapipe/tasks-vision/wasm';
const to = 'public/mediapipe/tasks-vision/wasm';
if (!existsSync(from)) throw new Error('@mediapipe/tasks-vision is missing: run npm install');
mkdirSync(to, { recursive: true });
// FilesetResolver.forVisionTasks(path) loads only vision_wasm_internal.{js,wasm}; the *_module_* pair (14.6 MB) is never used.
cpSync(from, to, { recursive: true, filter: (p) => !p.includes('_module_') });
console.info('[copy-mediapipe] tasks-vision wasm ready in', to);
