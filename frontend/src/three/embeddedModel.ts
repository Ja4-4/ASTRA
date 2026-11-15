import { GLTFLoader, MeshoptDecoder } from 'three-stdlib';
import type * as THREE from 'three';

/**
 * Hosted builds (claude.ai artifact) cannot serve .glb files, so the models are inlined into the JS bundle
 * as base64 and parsed in memory. No network fetch, no blob URL.
 */
interface Gltf { scene: THREE.Object3D; animations: THREE.AnimationClip[] }

/** A Suspense hook for one embedded model: throws while it parses, throws the error if it failed. */
function embedded(load: () => Promise<{ default: string }>): () => Gltf {
  let pending: Promise<void> | null = null;
  let gltf: Gltf | null = null;
  let failure: Error | null = null;
  return () => {
    if (failure) throw failure;
    if (gltf) return gltf;
    pending ??= load()
      .then(async (m) => {
        if (!m.default) throw new Error('Embedded model missing: build with --mode artifact');
        const bin = Uint8Array.from(atob(m.default), (c) => c.charCodeAt(0));
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(typeof MeshoptDecoder === 'function' ? (MeshoptDecoder as unknown as () => unknown)() as never : MeshoptDecoder as never);
        gltf = await new Promise<Gltf>((res, rej) => loader.parse(bin.buffer, '', res as never, rej));
      })
      .catch((e: unknown) => { failure = e instanceof Error ? e : new Error(String(e)); });
    throw pending;
  };
}

const useBody = embedded(() => import('virtual:astra-model'));
let nodes: Record<string, THREE.Object3D> | null = null;

/** Body model nodes by name. */
export function useEmbeddedNodes(): Record<string, THREE.Object3D> {
  const { scene } = useBody();
  if (!nodes) {
    const map: Record<string, THREE.Object3D> = {};
    scene.traverse((o) => { map[o.name] = o; });
    nodes = map;
  }
  return nodes;
}

/** Crew member + ISS exercise devices, with their animation clips. */
export const useEmbeddedWorkout = embedded(() => import('virtual:workout-model'));
