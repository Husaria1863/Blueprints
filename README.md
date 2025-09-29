# Blueprints – Vite + React

Minimal Vite + React scaffold.

## TLDraw + Gemini prototype

This app includes a TLDraw canvas for sketching room layouts. Click "Generate Room" to capture a screenshot and send it to Google Gemini ("nano banana") which returns an image preview of a room matching the layout.

### Quick start

1. Install dependencies: `npm install`
2. Set your API key in the environment: `setx GEMINI_API_KEY "YOUR_KEY"` (PowerShell) or `export GEMINI_API_KEY=YOUR_KEY` (bash/zsh)
3. Run client + server together in development: `npm run dev:full`
4. To run a single command that builds the client and starts the server (production-like): `npm start`
4. Draw on the left; the generated image will appear on the right.

Other scripts:
- `npm run dev` – client only (Vite)
- `npm run dev:server` – API server only
- `npm run build` – client build
- `npm run preview` – preview built client
-- `npm start` – build client to `dist/` then run `node server/index.js` which will serve the static files and API from the same origin

