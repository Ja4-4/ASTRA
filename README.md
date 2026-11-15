# ASTRA

**Astronauts far from Earth cannot wait for a doctor to read their numbers. ASTRA lets each crew member check their own health in minutes, and compares every number with their own Earth "usual", not with a textbook average.**

**Try it now: https://astra-sigma-taupe.vercel.app** (runs on demo data in your browser; allow the camera for the scan)

NASA Space Apps Challenge 2026 · Challenge: *Create Health Monitoring Software for Astronauts on Space Missions* · Team FALAK (فلك)

> Self-assessment and guidance, not a diagnosis. All demo data is synthetic (fictional astronaut "Cmdr. Layla Haddad").

## What it does

| Part | What the astronaut sees |
|---|---|
| **Home: 3D body** | Each body system coloured by status: *In range*, *Watch*, *Act now*, *Not available*. Every status is the number against the astronaut's own usual. |
| **Camera scan (20 s, no sensors)** | Pulse from tiny skin-colour changes (rPPG, CHROM method), eye tests (eyes-closed time, blinks, eyelid opening, under-eye shade), tired signs against the astronaut's own usual, and a face reading that *suggests* a mood the astronaut confirms. No video is saved. |
| **Measure / Alerts** | One question at a time, plain-language results, a clear next step, and "tell the doctor" when it matters. |
| **Thinking tests** | Reaction time and memory, compared with the astronaut's usual. |
| **Re-entry** | Training plan on the real ISS devices (ARED, T2, CEVIS) with a 3D crew member, and a readiness score before landing. |
| **Atlas** | Assistant on every page, by voice or text. Runs a small local AI model (Qwen2.5-0.5B via Ollama) and falls back to rules when the model is off. |
| **Cabin** | Cabin air (CO₂, temperature, humidity) against ranges learned from real ISS telemetry (NASA OSDR). |

Works fully offline: the face model, the AI and the data all run on the station computer. With the server off, the app runs on demo data.

## Run it

Needs: [Node.js 20+](https://nodejs.org), [Rust](https://rustup.rs). Optional for Atlas AI: [Ollama](https://ollama.com).

```bash
# 1) build the app and hand it to the server
cd frontend
npm install
npm run build
cp -r dist/. ../backend/static/          # Windows: xcopy /E /Y dist\* ..\backend\static\

# 2) start the server (demo data, then serve on http://127.0.0.1:8000)
cd ../backend
cargo run --release -- seed
cargo run --release -- serve

# 3) optional: the local AI for Atlas
ollama pull qwen2.5:0.5b
ollama create ai -f ai/Modelfile
```

Open **http://127.0.0.1:8000**. Development mode: run the server, then `npm run dev` in `frontend/` and open http://localhost:5173.

## How it works (for engineers)

- **Frontend:** React, TypeScript, Vite, three.js (react-three-fiber). Details: [`frontend/README.md`](frontend/README.md), [`frontend/BACKEND.md`](frontend/BACKEND.md).
- **Backend:** Rust (axum + SQLite), one local server for the app and the API. Details: [`backend/README.md`](backend/README.md).
- **Camera scan:** MediaPipe FaceLandmarker (478 points, 52 face-movement scores) in the browser; pulse by CHROM rPPG; everything compared with the astronaut's own baseline.
- **AI:** Ollama with Qwen2.5-0.5B, registered as `ai`; answers are short and grounded in the astronaut's numbers; the rules answer when the model is unavailable.

## Science and data sources

- NASA Human Research Program, 5 hazards of human spaceflight.
- NASA OSDR Environmental Data App: ISS cabin telemetry used for the cabin reference ranges (`backend/data/raw`).
- de Haan & Jeanne (2013), *Robust pulse rate from chrominance-based rPPG*, IEEE TBME.
- Soukupová & Čech (2016), *Real-time eye blink detection using facial landmarks*.
- Sundelin et al. (2013), *Cues of fatigue: effects of sleep deprivation on facial appearance*, Sleep 36(9):1355-1360.
- Ekman, Davidson & Friesen (1990), *The Duchenne smile*.
- Barrett et al. (2019), *Emotional expressions reconsidered*: faces do not reliably show feelings, so ASTRA only suggests a mood and the astronaut decides.

## Limits

- Estimates, not a medical device. Movement and dim light make camera readings less reliable.
- Alert thresholds are prototypes and are not clinically validated.
- Tested by the team only.

## Credits and licence

Code: Apache License 2.0 ([`LICENSE`](LICENSE)). Third-party models, data and fonts keep their own licences, listed in [`frontend/CREDITS.md`](frontend/CREDITS.md) (BodyParts3D © DBCLS, MediaPipe © Google, NASA OSDR data).
