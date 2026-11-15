import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * virtual:astra-model (body) and virtual:workout-model (crew member + ISS exercise devices) export a GLB as base64,
 * but only when embedding (artifact build, whose host cannot serve .glb files). Every other build exports an empty
 * string and loads the GLB by URL from /models/.
 */
function embeddedModels(embed: boolean): Plugin {
  const files: Record<string, string> = { 'virtual:astra-model': 'astra_body.glb', 'virtual:workout-model': 'astronaut_workouts.glb' };
  return {
    name: 'astra-models',
    resolveId: (s) => (s in files ? '\0' + s : null),
    load: (s) => {
      const file = s.startsWith('\0') ? files[s.slice(1)] : undefined;
      if (!file) return null;
      const b64 = embed ? readFileSync(new URL(`./public/models/${file}`, import.meta.url)).toString('base64') : '';
      return `export default ${JSON.stringify(b64)};`;
    },
  };
}

/**
 * Dev server only (never in a build): POST /__scan-calibration writes the JSON body of the /scan?calibrate
 * session to frontend/.scan-calibration.json (gitignored), so the scan limits can be tuned from real numbers.
 */
function scanCalibration(): Plugin {
  const out = new URL('./.scan-calibration.json', import.meta.url);
  return {
    name: 'scan-calibration',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__scan-calibration', (req, res, next) => {
        if (req.method !== 'POST') { next(); return; }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => { body += c; });
        req.on('end', () => {
          try {
            writeFileSync(out, JSON.stringify(JSON.parse(body), null, 2));
            res.statusCode = 200;
            res.end('{"saved":true}');
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), embeddedModels(mode === 'artifact'), scanCalibration()],
  // Dev only: /api goes to the station server (backend/, `cargo run --release -- serve`). Builds are unaffected.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } } },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing', 'postprocessing'],
          charts: ['recharts'],
        },
      },
    },
  },
}));
