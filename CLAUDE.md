# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running Locally

```bash
node server.js          # serves docs/ at http://127.0.0.1:5500 (default port)
node server.js 3000     # custom port
```

The server sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which are **required** for `SharedArrayBuffer` (used by ffmpeg.wasm). These headers must be present on all deployments.

There is no build step — all frontend code is served directly from `docs/`.

## Deploying to Cloudflare Workers

```bash
npx wrangler deploy     # deploys src/worker.js + docs/ assets
```

Config is in `wrangler.jsonc`. The worker in `src/worker.js` injects COOP/COEP headers and proxies `/api/transcribe` to OpenAI Whisper. Unlike `server.js`, it cannot run native ffmpeg (`/api/exec` returns 400 on Workers).

## Architecture

This is a **browser-first, serverless video editor** powered by ffmpeg.wasm running in a Web Worker. No server-side processing is required for the core functionality.

### Two execution backends (engine.js)

| Engine | Where it runs | When to use |
|--------|--------------|-------------|
| WASM (default) | Browser Web Worker | Always available; ~31 MB download |
| Server | `node server.js` | When native ffmpeg is in PATH; faster for large files |

`getFF()` in `engine.js` returns whichever backend is active. All consumers (`process.js`, `stack.js`, `batch.js`, `autocaption.js`) call `getFF()` — never reference `state.engine` directly.

The server backend (`state.engine.serverFF`) is a drop-in adapter that uploads files to `server.js` via `/api/upload`, runs ffmpeg via `/api/exec`, and returns the binary output.

**Server base-URL resolution.** All `/api/*` calls route through `_api(path)` in `engine.js`, which prefixes `state.engine.serverBase`. `resolveServerBase()` probes **same-origin first** (covers running `node server.js` and opening it directly), then the configured loopback URL `state.engine.serverUrl` (default `http://127.0.0.1:5500`, persisted as `ffServerUrl`). `autoDetectServer()` runs at startup: if a native server is found and the user hasn't explicitly chosen Browser mode, it switches to Server mode. This lets a **deployed page (e.g. `https://ffmpeg.engdawood.com`) drive the user's own local native ffmpeg** — see the cross-origin requirements under Server API. Native ffmpeg is only reachable when a local helper process is running; a web page cannot detect or run a visitor's native binary.

### Frontend module tree (`docs/js/`)

All modules are ES modules loaded via `<script type="module">` in `docs/index.html`. Functions used in `onclick=` HTML attributes must be explicitly exported to `window` in `main.js` (ES module scope is private).

**Module responsibilities:**
- `state.js` — single shared mutable object; all modules import and mutate `state.*`. Constants: `CHAINABLE` (ops that can be stacked), `BATCH_UNSUPPORTED`.
- `main.js` — entry point; imports all modules, runs init, wires `window.*` exports.
- `engine.js` — FFmpeg WASM instance, server adapter, `loadFFmpeg()`, engine/whisper-source toggling, server base-URL resolution (`_api`, `resolveServerBase`, `autoDetectServer`, `setServerUrl`), and transcription provider presets (`WHISPER_PROVIDERS`, `applyWhisperProvider`).
- `process.js` — `processVideo()` / `runProcess()` — the large per-op switch for single-file mode.
- `operations.js` — `setOp()` (UI panel switching) + `buildOperationArgs()` (batch-mode args builder).
- `stack.js` — operation chaining: `opToFilters()`, `composeStackCommand()`, `runProcessStack()`.
- `batch.js` — batch queue UI, `runBatch()`, sequential per-file processing, ZIP download.
- `subtitles.js` — subtitle parsing (SRT/VTT/ASS) + canvas-based hard-burn caption renderer.
- `autocaption.js` — Whisper Transformers.js integration; audio extraction → transcription → embed flow. The transcript (`state.whisper.srt`) is **kept after embedding** so the user can re-embed with different burn/font/format without re-transcribing; `files.js` clears it on new-file load to prevent cross-file reuse.
- `fonts.js` — caption-font picker (hard-burn only). User uploads (FontFace, in-memory) **plus** a prebuilt list from `docs/fonts/fonts.json` (`initCaptionFonts`, `loadBundledFont`, `onCaptionFontSelect`). Last-used bundled font persists via `captionFontId` (only bundled fonts can be restored — uploaded bytes can't).
- `ui.js` — `addLog()`, `syncProcessBtn()`, `renderOutput()`, screen wake lock.
- `files.js` — drag & drop, `handleFile()`, aux file pickers (subtitle, overlay, concat, etc.).
- `crop.js` — crop state + pointer-drag handlers + canvas overlay.
- `helpers.js` — pure utils: `fmtTime`, `fmtBytes`, `parseShellArgs`, `buildAtempo`, `getVideoSize`.

### Key constraints

- **No package.json / no bundler.** CDN imports (`cdn.jsdelivr.net`) are used for `@ffmpeg/ffmpeg` and `@ffmpeg/util`. Transformers.js is loaded via CDN in `docs/transcriber.js`.
- **COOP/COEP required everywhere.** `SharedArrayBuffer` (ffmpeg.wasm multi-thread) only works with these headers. Any proxy, CDN, or hosting must forward or set them.
- **Whisper memory management.** The WASM ffmpeg instance (~31 MB) is unloaded before Whisper loads, and Whisper is disposed before ffmpeg re-engages, to stay under the 2 GB WebAssembly heap limit.
- **`Reverse` and `Boomerang` are excluded from batch mode** — they buffer the entire video in memory; multiple large files would exceed the heap.

### Server API (server.js only, not available on Cloudflare Workers)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/status` | GET | Check if native ffmpeg is in PATH |
| `/api/upload?session=&name=` | POST | Upload input file into session temp dir |
| `/api/exec` | POST | Run ffmpeg `{ session, args }` → binary output |
| `/api/transcribe` | POST | Proxy audio to an OpenAI-compatible transcription API (headers: `X-OpenAI-Key`, `X-OpenAI-Base-URL`, `X-OpenAI-Model`). Requests `verbose_json` and parses to SRT, so non-OpenAI providers (Groq, Mistral/Voxtral) work. |

Sessions are temp dirs under `os.tmpdir()/ffwc-<id>`, cleaned up after 30 minutes.

**Transcription provider presets** (Auto-Caption → API mode): a Provider dropdown (`WHISPER_PROVIDERS` in `engine.js`) fills Base URL + Model for OpenAI (`whisper-1`), Groq (`https://api.groq.com/openai/v1`, `whisper-large-v3-turbo`), and Mistral (`https://api.mistral.ai/v1`, `voxtral-mini-latest`), or Custom. Editing fields flips it to Custom. Keys are entered in the UI (localStorage), never read from `.env`.

**Cross-origin access (deployed page → local `server.js`).** When the page is served from a different origin than the local server, `server.js` must allow it. Implemented: CORS with an **origin allowlist** (`ALLOWED_ORIGIN` env, default `https://ffmpeg.engdawood.com` — never `*`, since `/api/exec` runs arbitrary ffmpeg), an `OPTIONS` preflight handler, `Access-Control-Allow-Private-Network: true` (Chrome/Edge Private Network Access), and API responses use `Cross-Origin-Resource-Policy: cross-origin` (so a COEP `require-corp` page can read them). `http://127.0.0.1`/`localhost` is exempt from mixed-content blocking, so no TLS is needed on the local server. The service worker bypasses all `/api/*` requests so it never caches/intercepts the live native-server calls.

### Deployment targets

- **Local dev:** `node server.js` — full API including native ffmpeg
- **Cloudflare Workers:** `npx wrangler deploy` — static assets + Whisper proxy only
- **Vercel:** `docs/vercel.json` config — static hosting, same headers
- **PWA:** `docs/service-worker.js` precaches all static assets and CDN resources for offline use
