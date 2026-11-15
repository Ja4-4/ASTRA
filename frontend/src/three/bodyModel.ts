import type { SystemId } from '../lib/systems';

export const MODEL_URL = `${import.meta.env.BASE_URL}models/astra_body.glb`;
/** Contract with tools/build_body.py. Missing names fail loudly. */
export const REQUIRED_MESHES = ['shell', 'sys_cardio', 'sys_neuro', 'sys_metabolic', 'sys_msk', 'sys_ocular', 'sys_immune', 'cardio_vessels', 'immune_spleen', 'anat_lungs', 'anat_kidneys', 'anat_gut'] as const;
/** Organs with no tracked number in this demo: drawn neutral for context, never tinted, not clickable. */
export const CONTEXT_MESHES = ['anat_lungs', 'anat_kidneys', 'anat_gut'] as const;
/** Where the blood-flow pulse starts (the heart), in model metres. */
export const HEART_CENTER: [number, number, number] = [0.02, 1.335, 0.02];

/** Development only: render primitive placeholder geometry instead of the GLB. Never on in a build for judging. */
export const DEV_PLACEHOLDER_BODY = import.meta.env.DEV && import.meta.env.VITE_DEV_PLACEHOLDER_BODY === '1';

export const EMISSIVE = { ok: 0.25, watch: 0.6, act: 0.9, nodata: 0 } as const;

export interface CamPreset { target: [number, number, number]; dist: number; elev?: number }
export const DEFAULT_VIEW: CamPreset = { target: [0, 0.93, 0], dist: 3.35, elev: 0.08 };
export const CAMERA_PRESETS: Record<SystemId, CamPreset> = {
  cardio: { target: [0.02, 1.3, 0.02], dist: 0.8, elev: 0.05 },
  neuro: { target: [0, 1.66, 0], dist: 0.62, elev: 0.08 },
  metabolic: { target: [-0.01, 1.19, 0.03], dist: 0.78 },
  immune: { target: [0, 0.98, 0], dist: 2.9 },
  msk: { target: [0, 0.82, 0], dist: 2.5 },
  ocular: { target: [0, 1.625, 0.05], dist: 0.4 },
};

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}
