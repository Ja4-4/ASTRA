import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useAnimations, useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import { useReducedMotion } from 'framer-motion';
import { webglAvailable } from './bodyModel';
import { useEmbeddedWorkout } from './embeddedModel';

/** Crew member + ISS exercise devices, built by tools/build_astronaut.py (original asset, Blender). */
const MODEL = `${import.meta.env.BASE_URL}models/astronaut_workouts.glb`;
/** Artifact build: the model is inside the JS bundle (virtual:workout-model), because the host cannot serve .glb files. */
const EMBED = import.meta.env.VITE_EMBED_MODEL === '1';
/** Training session id -> animation clip and the device that is shown with it. */
const CLIP: Record<string, { clip: string; device: string }> = {
  ared: { clip: 'squat', device: 'ared' },
  t2: { clip: 'run', device: 't2' },
  cevis: { clip: 'cycle', device: 'cevis' },
  balance: { clip: 'balance', device: 'rail' },
};
const DEVICES = ['ared', 't2', 'cevis', 'rail'];
/** Checked once: each check creates a WebGL context, and the player re-renders every half second. */
let hasWebgl: boolean | null = null;

class ClipMissing extends Error {}

function Scene({ sessionId }: { sessionId: string }) {
  const group = useRef<THREE.Group>(null);
  const { scene, animations } = EMBED ? useEmbeddedWorkout() : useGLTF(MODEL, false, true);
  const pick = CLIP[sessionId] ?? CLIP.ared;
  if (!animations.some((a) => a.name === pick.clip)) throw new ClipMissing(`clip "${pick.clip}" missing for session ${sessionId}`);
  // A copy per view: the Re-entry preview and the player can be on screen at the same time.
  const model = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const { actions } = useAnimations(animations, group);
  const reduce = !!useReducedMotion();

  useEffect(() => {
    model.traverse((o) => {
      const prefix = o.name.split('_')[0];
      if (DEVICES.includes(prefix)) o.visible = prefix === pick.device;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; }
    });
    const a = actions[pick.clip];
    if (!a) return;
    a.reset().fadeIn(0.2).play();
    if (reduce) { a.time = a.getClip().duration * 0.5; a.paused = true; }
    return () => { a.fadeOut(0.2); };
  }, [actions, model, pick, reduce]);

  return (
    <group ref={group}>
      <primitive object={model} />
    </group>
  );
}

class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) {
    const reason = err instanceof ClipMissing ? `clip missing (${err.message})` : `model failed to load (${err instanceof Error ? err.message : String(err)})`;
    console.info(`[workout3d] fallback: ${reason}`);
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/**
 * 3D crew member doing the session on its ISS device. Drag to turn it (not in `preview`, the small looping card view).
 * Falls back to the 2D figure without WebGL or the model, and says why in the console.
 */
export function Workout3D({ sessionId, fallback, preview = false }: { sessionId: string; fallback: ReactNode; preview?: boolean }) {
  if (hasWebgl === null) {
    hasWebgl = webglAvailable();
    if (!hasWebgl) console.info('[workout3d] fallback: no WebGL');
  }
  if (!hasWebgl) return <>{fallback}</>;
  return (
    <Fallback fallback={fallback}>
      <Canvas shadows={!preview} dpr={preview ? [1, 1.5] : [1, 1.75]} camera={{ fov: 32, position: preview ? [2.6, 1.6, 3.1] : [2.4, 1.5, 2.9], near: 0.05, far: 40 }} aria-hidden="true"
        onCreated={({ camera }) => camera.lookAt(0, 0.85, 0)}>
        <color attach="background" args={['#1A1724']} />
        <hemisphereLight args={['#F1EEF8', '#221E2F', 0.9]} />
        <directionalLight position={[3, 5, 2]} intensity={2.2} castShadow={!preview} shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#A684FF" />
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <circleGeometry args={[2.2, 48]} />
          <meshStandardMaterial color="#221E2F" />
        </mesh>
        <Suspense fallback={null}>
          <Scene sessionId={sessionId} />
        </Suspense>
        {!preview && <OrbitControls target={[0, 0.85, 0]} enablePan={false} minDistance={2} maxDistance={6} minPolarAngle={Math.PI * 0.2} maxPolarAngle={Math.PI * 0.5} />}
      </Canvas>
    </Fallback>
  );
}

if (!EMBED) useGLTF.preload(MODEL, false, true);
