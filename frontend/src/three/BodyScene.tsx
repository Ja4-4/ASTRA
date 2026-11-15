import { Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Environment, Html, Lightformer, OrbitControls, Outlines, useGLTF } from '@react-three/drei';
import { EffectComposer, SMAA } from '@react-three/postprocessing';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { CAMERA_PRESETS, CONTEXT_MESHES, DEFAULT_VIEW, DEV_PLACEHOLDER_BODY, EMISSIVE, HEART_CENTER, MODEL_URL, REQUIRED_MESHES, type CamPreset } from './bodyModel';
import { makeHologramMaterial } from './hologram';
import { useEmbeddedNodes } from './embeddedModel';

const EMBED = import.meta.env.VITE_EMBED_MODEL === '1';
import { STATUS, STATUS_HEX, type StatusKey } from '../lib/status';
import { SYSTEMS, type SystemId, type SystemState } from '../lib/systems';

export interface BodySceneProps {
  systems: SystemState[];
  selected: SystemId | null;
  hovered: SystemId | null;
  onSelect: (s: SystemId) => void;
  onHover: (s: SystemId | null) => void;
  reducedMotion: boolean;
  resetNonce: number;
  sky: string;
  onReady?: () => void;
}

const MESH_TO_SYSTEM: Record<string, SystemId> = Object.fromEntries(SYSTEMS.map((s) => [s.mesh, s.id]));
const HEX = STATUS_HEX.dark;
/** Moon White toward Dust: the colour of every system that needs no attention. */
const NEUTRAL = '#CFC9DE';
const NEUTRAL_GLOW = 0.06;

export default function BodyScene(props: BodySceneProps) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ fov: 30, position: [0, DEFAULT_VIEW.target[1] + 0.27, DEFAULT_VIEW.dist], near: 0.05, far: 100 }}
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      aria-hidden="true"
      onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; }}
    >
      <color attach="background" args={[props.sky]} />
      <fog attach="fog" args={[props.sky, 6, 18]} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[-2, 3, 3]} intensity={1.1} color="#FFFFFF" />
      <directionalLight position={[0, 2, -3]} intensity={1.6} color="#FFFFFF" />
      <Environment resolution={64} frames={1}>
        <Lightformer form="rect" intensity={0.6} color="#FFFFFF" position={[0, 3, 3]} scale={[4, 2, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#FFFFFF" position={[0, 1, -4]} scale={3} />
      </Environment>
      <Suspense fallback={null}>
        {DEV_PLACEHOLDER_BODY ? <PlaceholderBody {...props} /> : <Body {...props} />}
      </Suspense>
      <CameraRig selected={props.selected} reduced={props.reducedMotion} resetNonce={props.resetNonce} />
      <EffectComposer multisampling={0}>
        <SMAA />
      </EffectComposer>
    </Canvas>
  );
}

function useStatusOf(systems: SystemState[]) {
  return useMemo(() => Object.fromEntries(systems.map((s) => [s.def.id, s])) as Record<SystemId, SystemState>, [systems]);
}

function Body(props: BodySceneProps) {
  // EMBED is a build-time constant, so the hook order never changes between renders.
  const nodes = (EMBED ? useEmbeddedNodes() : useGLTF(MODEL_URL, false, true).nodes) as Record<string, THREE.Mesh>;
  const missing = REQUIRED_MESHES.filter((n) => !nodes[n] || !(nodes[n] as THREE.Mesh).isMesh);
  if (missing.length) {
    // Fail loudly: the error boundary renders the 2D fallback and names the missing meshes.
    throw new Error(`astra_body.glb is missing required meshes: ${missing.join(', ')}`);
  }
  useEffect(() => { props.onReady?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <BodyMeshes nodes={nodes} {...props} />;
}

function BodyMeshes({ nodes, systems, selected, hovered, onSelect, onHover, reducedMotion }: BodySceneProps & { nodes: Record<string, THREE.Mesh> }) {
  const byId = useStatusOf(systems);
  const group = useRef<THREE.Group>(null);
  const immune = byId.immune.status;
  const shellMat = useMemo(() => makeHologramMaterial('#E4DEF5'), []);
  useEffect(() => {
    const c = new THREE.Color('#E4DEF5').lerp(new THREE.Color(HEX[immune]), immune === 'nodata' ? 0.35 : 0.5);
    shellMat.uniforms.uColor.value = c;
  }, [immune, shellMat]);
  useEffect(() => {
    shellMat.uniforms.uOpacity.value = selected && selected !== 'immune' ? 0.07 : 0.15;
  }, [selected, shellMat]);

  useFrame(({ clock }) => {
    if (!group.current) return;
    if (reducedMotion) { group.current.position.y = 0; group.current.rotation.z = 0; return; }
    const t = clock.elapsedTime;
    group.current.position.y = Math.sin(t * 0.6) * 0.008; // ~±4px at default framing
    group.current.rotation.z = Math.sin(t * 0.37) * THREE.MathUtils.degToRad(0.5);
  });

  const shellNode = nodes.shell;
  const organHit = (e: ThreeEvent<PointerEvent | MouseEvent>) => e.intersections.some((i) => (i.object.name in MESH_TO_SYSTEM || i.object.name === 'cardio_vessels') && i.object.name !== 'shell');

  return (
    <group ref={group}>
      {SYSTEMS.map((s) => (
        <Organ key={s.id} node={nodes[s.mesh]} state={byId[s.id]} selected={selected} hovered={hovered} onSelect={onSelect} onHover={onHover} reducedMotion={reducedMotion} />
      ))}
      <Organ node={nodes.immune_spleen} state={byId.immune} selected={selected} hovered={hovered} onSelect={onSelect} onHover={onHover} reducedMotion={reducedMotion} />
      <Vessels node={nodes.cardio_vessels} bpm={bpmOf(byId.cardio)} selected={selected} hovered={hovered} onSelect={onSelect} onHover={onHover} reducedMotion={reducedMotion} />
      {CONTEXT_MESHES.map((n) => <ContextOrgan key={n} node={nodes[n]} dim={selected !== null && selected !== 'immune'} />)}

      <mesh
        name="shell_display"
        geometry={shellNode.geometry}
        position={shellNode.position}
        quaternion={shellNode.quaternion}
        scale={shellNode.scale}
        material={shellMat}
        renderOrder={10}
        onPointerMove={(e) => { if (!organHit(e)) { e.stopPropagation(); onHover('immune'); } }}
        onPointerOut={() => onHover(null)}
        onClick={(e) => { if (!organHit(e)) { e.stopPropagation(); onSelect('immune'); } }}
      >
        {(hovered === 'immune' || selected === 'immune') && <Outlines thickness={0.004} color={HEX[immune]} transparent opacity={0.9} />}
      </mesh>
      {hovered && <HoverTip state={byId[hovered]} />}
    </group>
  );
}

function Organ({ node, state, selected, hovered, onSelect, onHover, reducedMotion }: {
  node: THREE.Mesh; state: SystemState; selected: SystemId | null; hovered: SystemId | null;
  onSelect: (s: SystemId) => void; onHover: (s: SystemId | null) => void; reducedMotion: boolean;
}) {
  const id = state.def.id;
  const status = state.status;
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const dim = selected !== null && selected !== id && !(selected === 'immune');
  // Only systems that need a look get a status colour; in-range and no-number systems stay neutral.
  const flagged = status === 'watch' || status === 'act';
  const focused = selected === id || hovered === id;
  // The skeleton spans the whole body, so a 'watch' on it is only a hint until pointed at; 'act' is always full.
  const quiet = id === 'msk' && status === 'watch' && !focused;
  const color = flagged ? (quiet ? new THREE.Color(NEUTRAL).lerp(new THREE.Color(HEX[status]), 0.35).getStyle() : HEX[status]) : NEUTRAL;
  useFrame(({ clock }) => {
    if (!mat.current) return;
    const base = flagged ? EMISSIVE[status] * (quiet ? 0.2 : 1) : NEUTRAL_GLOW;
    mat.current.emissiveIntensity = status === 'act' && !reducedMotion ? base * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin((clock.elapsedTime * 2 * Math.PI) / 1.2))) + 0.2 : base;
    const targetOpacity = dim ? 0.2 : flagged && !quiet ? 0.95 : 0.45;
    mat.current.opacity = THREE.MathUtils.lerp(mat.current.opacity, targetOpacity, reducedMotion ? 1 : 0.12);
  });
  const showOutline = hovered === id || selected === id;
  return (
    <mesh
      name={node.name}
      geometry={node.geometry}
      position={node.position}
      quaternion={node.quaternion}
      scale={node.scale}
      onPointerOver={(e) => { e.stopPropagation(); onHover(id); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { onHover(null); document.body.style.cursor = ''; }}
      onClick={(e) => { e.stopPropagation(); onSelect(id); }}
    >
      <meshStandardMaterial
        ref={mat}
        color={color}
        emissive={color}
        emissiveIntensity={flagged ? EMISSIVE[status] : NEUTRAL_GLOW}
        roughness={0.45}
        metalness={0.1}
        transparent
        opacity={0.95}
        depthWrite={!dim}
      />
      {showOutline && <Outlines thickness={0.003} color={status === 'nodata' ? '#A39DB5' : color} transparent opacity={0.95} />}
    </mesh>
  );
}

/** Heart beats per minute from the latest reading, else the astronaut's usual. Drives the blood-flow pulse. */
function bpmOf(cardio: SystemState): number {
  const hr = cardio.results.find((r) => r.metric === 'hr');
  const n = hr ? parseFloat(hr.display) : NaN;
  return Number.isFinite(n) && n > 20 ? n : 62;
}

/**
 * Arteries and veins run through the whole body, so they never carry a status colour; only the heart does.
 * A light pulse leaves the heart once per beat, at the astronaut's own heart rate. Off under reduced motion.
 */
function Vessels({ node, bpm, selected, hovered, onSelect, onHover, reducedMotion }: {
  node: THREE.Mesh; bpm: number; selected: SystemId | null; hovered: SystemId | null;
  onSelect: (s: SystemId) => void; onHover: (s: SystemId | null) => void; reducedMotion: boolean;
}) {
  const dim = selected !== null && selected !== 'cardio' && selected !== 'immune';
  const focused = selected === 'cardio' || hovered === 'cardio';
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uRate: { value: bpm / 60 }, uFlow: { value: 1 }, uOrigin: { value: new THREE.Vector3(...HEART_CENTER) } }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { uniforms.uRate.value = bpm / 60; }, [bpm, uniforms]);
  useEffect(() => { uniforms.uFlow.value = reducedMotion ? 0 : 1; }, [reducedMotion, uniforms]);
  useFrame(({ clock }) => { uniforms.uTime.value = clock.elapsedTime; });
  const onBeforeCompile = useMemo(() => (shader: THREE.WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vFlowPos;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = 'uniform float uTime;\nuniform float uRate;\nuniform float uFlow;\nuniform vec3 uOrigin;\nvarying vec3 vFlowPos;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\nfloat flowWave = smoothstep(0.82, 1.0, fract(distance(vFlowPos, uOrigin) * 3.0 - uTime * uRate));\ntotalEmissiveRadiance += vec3(0.95, 0.93, 1.0) * flowWave * 0.9 * uFlow;',
    );
  }, [uniforms]);
  return (
    <mesh
      name={node.name}
      geometry={node.geometry}
      position={node.position}
      quaternion={node.quaternion}
      scale={node.scale}
      onPointerOver={(e) => { e.stopPropagation(); onHover('cardio'); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { onHover(null); document.body.style.cursor = ''; }}
      onClick={(e) => { e.stopPropagation(); onSelect('cardio'); }}
    >
      <meshStandardMaterial color={NEUTRAL} emissive={NEUTRAL} emissiveIntensity={NEUTRAL_GLOW} roughness={0.45} metalness={0.1} transparent opacity={dim ? 0.15 : focused ? 0.75 : 0.45} depthWrite={!dim} onBeforeCompile={onBeforeCompile} />
    </mesh>
  );
}

const CONTEXT_OPACITY: Record<string, number> = { anat_lungs: 0.3, anat_kidneys: 0.3, anat_gut: 0.22 };

/** Lungs, kidneys, gut: anatomy for orientation only. No number drives them, so they stay neutral and let clicks pass through. */
function ContextOrgan({ node, dim }: { node: THREE.Mesh; dim: boolean }) {
  return (
    <mesh name={node.name} geometry={node.geometry} position={node.position} quaternion={node.quaternion} scale={node.scale} raycast={() => null}>
      <meshStandardMaterial color={NEUTRAL} emissive={NEUTRAL} emissiveIntensity={NEUTRAL_GLOW} roughness={0.55} metalness={0.05} transparent opacity={dim ? 0.08 : CONTEXT_OPACITY[node.name] ?? 0.22} depthWrite={false} />
    </mesh>
  );
}

const TIP_ANCHOR: Record<SystemId, [number, number, number]> = {
  cardio: [0.14, 1.36, 0.1], neuro: [0.12, 1.72, 0], metabolic: [0.16, 1.2, 0.1], immune: [0.34, 1.0, 0.1], msk: [0.2, 0.7, 0.05], ocular: [0.1, 1.64, 0.08],
};

function HoverTip({ state }: { state: SystemState }) {
  const S = STATUS[state.status];
  const d = state.driver;
  return (
    <Html position={TIP_ANCHOR[state.def.id]} style={{ pointerEvents: 'none' }} zIndexRange={[20, 0]}>
      <div className="force-dark card-raised w-max max-w-[240px] -translate-y-1/2 translate-x-3 px-3 py-2 text-xs shadow-xl">
        <div className="font-semibold text-text">{state.def.label}</div>
        <div className="mt-0.5 flex items-center gap-1" style={{ color: state.status === 'nodata' ? 'var(--nodata-text)' : S.cssVar }}>
          <S.icon size={12} aria-hidden="true" /> {S.label}
        </div>
        <div className="num mt-0.5 text-muted">{d && d.display !== '—' ? `${d.display} ${d.unit}` : state.def.tracked ? 'Not available' : 'Not tracked in this demo'}</div>
      </div>
    </Html>
  );
}

function CameraRig({ selected, reduced, resetNonce }: { selected: SystemId | null; reduced: boolean; resetNonce: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const tween = useRef<{ fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number } | null>(null);
  useEffect(() => {
    const p: CamPreset = selected ? CAMERA_PRESETS[selected] : DEFAULT_VIEW;
    const toT = new THREE.Vector3(...p.target);
    const toP = toT.clone().add(new THREE.Vector3(0, (p.elev ?? 0.06) * p.dist + 0.02, p.dist));
    const fromT = controls.current ? controls.current.target.clone() : toT.clone();
    tween.current = { fromP: camera.position.clone(), toP, fromT, toT, t: reduced ? 1 : 0 };
  }, [selected, resetNonce, reduced, camera]);
  useFrame((_, dt) => {
    const tw = tween.current;
    if (!tw || !controls.current) return;
    tw.t = Math.min(1, tw.t + dt / 0.6);
    const k = 1 - Math.pow(1 - tw.t, 3);
    camera.position.lerpVectors(tw.fromP, tw.toP, k);
    controls.current.target.lerpVectors(tw.fromT, tw.toT, k);
    controls.current.update();
    if (tw.t >= 1) tween.current = null;
  });
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan={false}
      minDistance={0.3}
      maxDistance={4.5}
      minPolarAngle={Math.PI * 0.22}
      maxPolarAngle={Math.PI * 0.62}
      rotateSpeed={0.6}
      zoomSpeed={0.6}
      enableDamping={!reduced}
      target={DEFAULT_VIEW.target}
    />
  );
}

/** DEV ONLY (VITE_DEV_PLACEHOLDER_BODY=1): primitive figure so the scene can be worked on without the GLB. */
function PlaceholderBody(props: BodySceneProps) {
  const byId = useStatusOf(props.systems);
  const c = (id: SystemId) => HEX[byId[id].status as StatusKey];
  return (
    <group>
      <mesh position={[0, 1.66, 0]} onClick={() => props.onSelect('neuro')}><sphereGeometry args={[0.09, 24, 24]} /><meshStandardMaterial color={c('neuro')} emissive={c('neuro')} emissiveIntensity={0.5} /></mesh>
      <mesh position={[0.02, 1.3, 0.03]} onClick={() => props.onSelect('cardio')}><sphereGeometry args={[0.06, 24, 24]} /><meshStandardMaterial color={c('cardio')} emissive={c('cardio')} emissiveIntensity={0.5} /></mesh>
      <mesh position={[0, 0.9, 0]} onClick={() => props.onSelect('msk')}><capsuleGeometry args={[0.16, 1.2, 8, 16]} /><meshStandardMaterial color={c('msk')} transparent opacity={0.3} /></mesh>
    </group>
  );
}

if (!EMBED) useGLTF.preload(MODEL_URL, false, true);
