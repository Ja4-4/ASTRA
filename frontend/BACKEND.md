# Running ASTRA with the station server (Windows)

1. Once, in `backend\`: `ollama create ai -f ai/Modelfile` (Ollama must be running; this adds the small Atlas model).
2. In `backend\`: `cargo run --release -- seed` (fills the database with Cmdr. Layla Haddad's demo history).
3. In `backend\`: `cargo run --release -- serve` (leave it open; it listens on port 8000).
4. In `frontend\`, in a second window: `npm run dev`, then open the address it prints.

**Live data / Demo data** (small chip in the side menu, or under "More" on a phone):
- *Live data*: numbers come from the station server, and new check-ins are saved there.
- *Demo data*: the server is off, so the app shows the built-in sample history, exactly as before.

**What happens when something is off**
- Server off: the app starts on demo data in under 2 seconds. Nothing breaks, and nothing is sent anywhere.
- Server on, Ollama off (or the model is missing): everything stays live, and Atlas answers from its built-in rules.
- A number that cannot reach the server stays in the app, with the line "Saved on this device. It will not reach the station server."
