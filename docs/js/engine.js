// js/engine.js
//
// Owns the two ffmpeg backends — the in-browser @ffmpeg/ffmpeg WASM
// instance and the server-side adapter that proxies to native ffmpeg via
// server.js — plus engine-mode toggling, Whisper source toggling, and the
// OpenAI Whisper API helper.
//
// `getFF()` returns whichever backend is active; every consumer (process,
// stack, batch, autocaption) calls it instead of touching `state.engine`
// directly so the engine switch is a single point of change.

import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
import { fetchFile } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';

import { state } from './state.js';
import { addLog, syncProcessBtn } from './ui.js';

// Re-export so other modules import `fetchFile` from engine.js instead of
// each pulling the CDN URL themselves.
export { fetchFile };

// ── Shared-backend app token ────────────────────────────────────────────
// Gate for the server-side "app" key and "Workers AI" transcription backends.
// Set this to match the APP_TOKEN secret on your Cloudflare Worker so your own
// deployed frontend can use them. It ships in client JS (lightly obscured) — it
// deters casual endpoint abuse, not a determined attacker. Leave '' if you
// don't expose shared backends.
const APP_TRANSCRIBE_TOKEN = '';

// ── Server base-URL resolution ──────────────────────────────────────────
// All /api/* calls go through `_api()`, which prefixes the resolved base.
// '' means same origin (the page is served by server.js directly); a value
// like 'http://127.0.0.1:5500' means the page is deployed elsewhere and is
// reaching a local native-ffmpeg server over loopback.

/** Build a full /api/* URL using the resolved server base. */
function _api(path) {
  return (state.engine.serverBase || '') + path;
}

/** Probe one candidate base for a reachable, ffmpeg-capable server. */
async function _probeServer(base) {
  try {
    const r = await fetch((base || '') + '/api/status', { method: 'GET' });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.available;
  } catch (_) {
    return false;
  }
}

/**
 * Decide which base to use for native ffmpeg, and store it in
 * `state.engine.serverBase`. Tries same-origin first (covers running
 * `node server.js` and opening it directly on any port), then the
 * configured local URL (covers the deployed page reaching loopback).
 *
 * @returns {Promise<boolean>} whether a native-ffmpeg server was found
 */
export async function resolveServerBase() {
  if (await _probeServer('')) { state.engine.serverBase = ''; return true; }
  const local = (state.engine.serverUrl || '').replace(/\/+$/, '');
  if (local && await _probeServer(local)) { state.engine.serverBase = local; return true; }
  state.engine.serverBase = '';
  return false;
}

/** Update the configured local server URL and persist it. */
export function setServerUrl(url) {
  state.engine.serverUrl = (url || '').trim();
  localStorage.setItem('ffServerUrl', state.engine.serverUrl);
}

/**
 * On startup: fill the server-URL input. Only when the user has previously
 * chosen Server mode (persisted as ffEngine='server') do we probe for a
 * reachable native-ffmpeg server and reconnect to it. With no saved choice —
 * or an explicit Browser choice — stay on WASM and never force-switch just
 * because a server happens to be reachable. Safe to call once.
 */
export async function autoDetectServer() {
  const input = document.getElementById('serverUrlInput');
  if (input) input.value = state.engine.serverUrl;

  // Only auto-connect when the user has explicitly chosen Server mode before.
  // No saved choice (or an explicit Browser choice) stays on Browser — never
  // force-switch on a fresh visit just because a server happens to answer.
  if (localStorage.getItem('ffEngine') !== 'server') return;

  const found = await resolveServerBase();
  if (!found) return;

  const where = state.engine.serverBase || location.origin;
  addLog(`Native ffmpeg server detected at ${where} — using it (switch to Browser anytime).`, 'ok');
  setEngine('server');     // no-op if already in server mode
  await loadFFmpeg();      // marks server mode ready
}

// ── Instantiate backends ────────────────────────────────────────────────
state.engine.ffmpeg = new FFmpeg();

/**
 * Drop-in replacement for the @ffmpeg/ffmpeg FFmpeg instance that routes
 * all work through the local server.js API instead of the WASM runtime.
 * Mirrors the surface area used by the app: on(), writeFile(), readFile(),
 * deleteFile(), exec(), terminate().
 */
state.engine.serverFF = (() => {
  const _files = new Map();   // name → Uint8Array (queued for next exec)
  let _output     = null;     // Uint8Array from last exec
  let _outputName = null;     // last arg of last exec (the output filename)
  const _logHandlers      = [];
  const _progressHandlers = [];

  function _session() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  return {
    on(event, fn) {
      if (event === 'log')      _logHandlers.push(fn);
      if (event === 'progress') _progressHandlers.push(fn);
    },

    async writeFile(name, data) {
      _files.set(name, data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data));
    },

    async readFile(name) {
      if (_outputName && name === _outputName) return _output ?? new Uint8Array(0);
      if (_files.has(name)) return _files.get(name);
      return new Uint8Array(0);
    },

    async deleteFile(name) {
      _files.delete(name);
      if (name === _outputName) { _output = null; _outputName = null; }
    },

    async exec(args) {
      const session = _session();
      // Upload every queued file
      for (const [name, bytes] of _files) {
        const r = await fetch(
          _api(`/api/upload?session=${encodeURIComponent(session)}&name=${encodeURIComponent(name)}`),
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }
        );
        if (!r.ok) throw new Error(`Upload failed for "${name}": ${await r.text()}`);
      }
      _progressHandlers.forEach(fn => fn({ progress: 0.05 }));
      _logHandlers.forEach(fn => fn({ message: `[server] ffmpeg ${args.join(' ')}` }));

      const r = await fetch(_api('/api/exec'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, args }),
      });

      if (!r.ok) {
        let msg = `Server ffmpeg failed (${r.status})`;
        try {
          const j = await r.json();
          msg = j.error || msg;
          if (j.stderr) addLog(j.stderr.trim(), 'err');
        } catch (_) {}
        throw new Error(msg);
      }

      _output     = new Uint8Array(await r.arrayBuffer());
      _outputName = args[args.length - 1];
      _progressHandlers.forEach(fn => fn({ progress: 1 }));
      return 0;
    },

    async terminate() {
      _files.clear(); _output = null; _outputName = null;
    },
  };
})();

/** Returns the active ffmpeg instance (WASM or server adapter). */
export function getFF() {
  return state.engine.useServerMode ? state.engine.serverFF : state.engine.ffmpeg;
}

/** Whether the active backend is loaded and ready for exec(). */
export function isLoaded() {
  if (state.engine.useServerMode) return state.engine.serverModeReady;
  return document.getElementById('statusDot').classList.contains('loaded');
}

// ── Load / check ffmpeg ────────────────────────────────────────────────
export async function loadFFmpeg() {
  const btn = document.getElementById('loadBtn');
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const ff  = state.engine.ffmpeg;

  if (state.engine.useServerMode) {
    dot.className = 'dot loading';
    txt.textContent = 'Checking server ffmpeg…';
    btn.disabled = true;
    try {
      // Resolve which base to use (same-origin or the configured loopback URL).
      const found = await resolveServerBase();
      if (!found) {
        const local = (state.engine.serverUrl || '').replace(/\/+$/, '');
        const sameOrigin = !local || local === location.origin.replace(/\/+$/, '');
        let reason;
        if (sameOrigin) {
          // Page is served by (or shares origin with) the server — report its
          // own status reason (e.g. "ffmpeg not in PATH", or the CF Workers note).
          try {
            const resp = await fetch(_api('/api/status'));
            reason = resp.ok ? (await resp.json()).reason : ('HTTP ' + resp.status);
          } catch (e) { reason = e.message; }
          reason = reason || 'ffmpeg not found in PATH';
        } else {
          // Deployed page reaching a local server that didn't answer.
          reason = `Couldn't reach a native ffmpeg server at ${local}. Check that "node server.js" is running there on the right port, ffmpeg is in its PATH, ALLOWED_ORIGIN includes ${location.origin}, and you allowed local-network access for this site.`;
        }
        throw new Error(reason);
      }
      state.engine.serverModeReady = true;
      dot.className = 'dot loaded';
      const where = state.engine.serverBase || location.origin;
      txt.textContent = `Server ffmpeg ready (native — ${where})`;
      btn.innerHTML  = '<i class="fas fa-check"></i> Ready';
      btn.className  = 'btn btn-success ml-auto';
      btn.disabled   = true;
      addLog('Server-mode ffmpeg ready. All processing runs natively via localhost.', 'ok');
      syncProcessBtn();
    } catch (err) {
      state.engine.serverModeReady = false;
      dot.className   = 'dot';
      txt.textContent = 'Server check failed: ' + (err.message || err);
      btn.innerHTML   = '<i class="fas fa-server"></i> Check Server';
      btn.className   = 'btn btn-primary ml-auto';
      btn.disabled    = false;
      addLog('Server check error: ' + (err.message || err), 'err');
    }
    return;
  }

  // Browser WASM mode
  dot.className = 'dot loading';
  txt.textContent = 'Downloading ffmpeg-core (~31 MB)…';
  btn.disabled = true;

  ff.on('log', ({ message }) => addLog(message));
  ff.on('progress', ({ progress }) => {
    const pct = Math.min(100, Math.round(progress * 100));
    document.getElementById('progFill').style.width = pct + '%';
    document.getElementById('progPct').textContent = pct + '%';
  });

  const esmBase  = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/';
  // dist/esm is required: the worker loads the core via dynamic import()
  // which needs a real ES module (export default). The dist/umd build has
  // no exports, so import() returns an empty namespace and module.default
  // is undefined.
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  try {
    // docs/worker.js is a same-origin proxy that imports the CDN worker
    // module. Browsers block cross-origin type:module workers even with
    // CORS headers, and blob-URL workers cause
    // ERR_REQUEST_RANGE_NOT_SATISFIABLE on internal fetches. A same-origin
    // file avoids both issues: no blob URL, no CORS restriction.
    // import.meta.url inside the CDN module resolves to CDN, so all its
    // relative imports resolve correctly.
    const classWorkerURL = new URL('./worker.js', location.href).href;
    addLog('Using same-origin worker proxy (./worker.js).', 'ok');

    // coreURL must be a direct CDN URL (NOT a blob URL). The ESM
    // ffmpeg-core.js has internal relative imports; when loaded from a
    // blob URL those imports have no base to resolve against → memory
    // errors. Passing the CDN URL directly lets import() resolve them
    // from the CDN base.
    const coreURL = `${coreBase}/ffmpeg-core.js`;
    addLog('Using direct CDN URL for ffmpeg-core.js.', 'ok');

    // wasmURL: direct CDN URL. jsDelivr serves .wasm with
    // Content-Type: application/wasm + CORS headers, so
    // WebAssembly.instantiateStreaming works without a blob wrapper.
    // Blob URLs don't support Range requests (needed internally by the
    // streaming compiler → ERR_REQUEST_RANGE_NOT_SATISFIABLE).
    const wasmURL = `${coreBase}/ffmpeg-core.wasm`;
    addLog('Using direct CDN URL for ffmpeg-core.wasm.', 'ok');

    txt.textContent = 'Initialising ffmpeg (downloading WASM ~31 MB)…';
    await ff.load({ classWorkerURL, coreURL, wasmURL });

    dot.className = 'dot loaded';
    txt.textContent = 'ffmpeg loaded and ready';
    btn.innerHTML = '<i class="fas fa-check"></i> Loaded';
    btn.className = 'btn btn-success ml-auto';
    btn.disabled = true;
    addLog('ffmpeg loaded.', 'ok');
    syncProcessBtn();
  } catch (err) {
    // ffmpeg.wasm rejects with a plain string, not an Error — guard
    const msg = (err instanceof Error ? err.message : String(err)) || 'unknown error';
    dot.className = 'dot';
    txt.textContent = 'Load failed: ' + msg;
    btn.disabled = false;
    addLog('Load error: ' + msg, 'err');
  }
}

// ── Engine toggle (Browser WASM vs Server native) ──────────────────────
export function setEngine(mode) {
  const newServer = mode === 'server';
  if (newServer === state.engine.useServerMode) return;
  state.engine.useServerMode = newServer;
  localStorage.setItem('ffEngine', state.engine.useServerMode ? 'server' : 'browser');

  document.getElementById('btnEngineBrowser').classList.toggle('active', !state.engine.useServerMode);
  document.getElementById('btnEngineServer').classList.toggle('active',  state.engine.useServerMode);

  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const btn = document.getElementById('loadBtn');

  if (state.engine.useServerMode) {
    state.engine.serverModeReady = false;
    dot.className   = 'dot';
    txt.textContent = 'Server mode — click to verify native ffmpeg';
    btn.innerHTML   = '<i class="fas fa-server"></i> Check Server';
    btn.className   = 'btn btn-primary ml-auto';
    btn.disabled    = false;
    addLog('Switched to server mode. Calls native ffmpeg on localhost — no WASM download.', 'ok');
  } else {
    state.engine.serverModeReady = false;
    if (!document.getElementById('statusDot').classList.contains('loaded')) {
      txt.textContent = 'ffmpeg not loaded — click "Load ffmpeg" to begin';
      btn.innerHTML   = '<i class="fas fa-play"></i> Load ffmpeg (~31 MB)';
      btn.className   = 'btn btn-primary ml-auto';
      btn.disabled    = false;
    }
    addLog('Switched to browser mode (ffmpeg.wasm).', 'ok');
  }
  syncProcessBtn();
}

// ── Whisper source toggle (local Transformers.js vs OpenAI API) ────────
export function setWhisperSource(source) {
  state.whisper.source = source;
  localStorage.setItem('whisperSource', source);
  document.getElementById('btnWhisperLocal').classList.toggle('active', source === 'local');
  document.getElementById('btnWhisperAPI').classList.toggle('active',   source === 'api');
  document.getElementById('whisperApiConfigRow').classList.toggle('hidden', source !== 'api');
  document.getElementById('whisperModelRow').classList.toggle('hidden',  source === 'api');
  const hint = document.getElementById('autoCaptionModeHint');
  if (hint) {
    hint.innerHTML = source === 'api'
      ? '<strong style="color:var(--text)">API mode:</strong> audio is extracted in your browser and sent to the selected transcription backend via the server proxy.'
      : '<strong style="color:var(--text)">Local mode:</strong> audio extracted and transcribed on-device via Transformers.js. Zero data leaves your browser.';
  }
  updateAutoCaptionInfo();
}

// Prebuilt OpenAI-compatible transcription providers. Selecting one fills the
// Base URL + Model ID fields; the server proxy appends /audio/transcriptions
// and parses verbose_json → SRT (so non-OpenAI APIs like Groq/Mistral work).
export const WHISPER_PROVIDERS = {
  openai:  { name: 'OpenAI',  baseUrl: 'https://api.openai.com/v1',      model: 'whisper-1' },
  groq:    { name: 'Groq',    baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1',      model: 'voxtral-mini-latest' },
};

/** Map a base URL back to a provider id, or 'custom' if none matches. */
function detectWhisperProvider(baseUrl) {
  const u = (baseUrl || '').replace(/\/+$/, '');
  for (const [id, p] of Object.entries(WHISPER_PROVIDERS)) {
    if (p.baseUrl === u) return id;
  }
  return 'custom';
}

/**
 * Apply a prebuilt provider preset: fill the Base URL + Model ID fields and
 * persist. 'custom' (or unknown) leaves the fields untouched for manual entry.
 */
export function applyWhisperProvider(id) {
  const p = WHISPER_PROVIDERS[id];
  if (!p) return;  // Custom — keep whatever the user typed.
  document.getElementById('whisperBaseUrl').value = p.baseUrl;
  document.getElementById('whisperModelId').value = p.model;
  saveWhisperConfig();
}

// ── Transcription backend switching (server default + UI override) ─────
// The deployed Worker advertises which backends it offers and a default via
// GET /api/transcribe-config. The frontend follows that default unless the
// user explicitly picks a backend (persisted in state.whisper.apiBackend).
let transcribeConfig = { defaultBackend: 'user', appProviders: [], workersAi: false, tokenRequired: false };

/** Fetch the backend config from the active server; falls back to user-only. */
export async function fetchTranscribeConfig() {
  try {
    const resp = await fetch(_api('/api/transcribe-config'), { method: 'GET' });
    if (resp.ok) {
      const cfg = await resp.json();
      transcribeConfig = {
        defaultBackend: (cfg.defaultBackend || 'user'),
        appProviders:   Array.isArray(cfg.appProviders) ? cfg.appProviders : [],
        workersAi:      !!cfg.workersAi,
        tokenRequired:  !!cfg.tokenRequired,
      };
    } else {
      transcribeConfig = { defaultBackend: 'user', appProviders: [], workersAi: false, tokenRequired: false };
    }
  } catch (_) {
    transcribeConfig = { defaultBackend: 'user', appProviders: [], workersAi: false, tokenRequired: false };
  }
  applyTranscribeConfigToUI();
}

/** List of backends this deployment actually offers, 'user' always first. */
function availableBackends() {
  return ['user',
    ...(transcribeConfig.appProviders.length ? ['app'] : []),
    ...(transcribeConfig.workersAi ? ['workers-ai'] : [])];
}

/** Resolve the backend in effect: stored override if valid, else server default. */
export function getActiveBackend() {
  const avail = availableBackends();
  const stored = state.whisper.apiBackend;
  if (stored && avail.includes(stored)) return stored;
  return avail.includes(transcribeConfig.defaultBackend) ? transcribeConfig.defaultBackend : 'user';
}

/** Populate the backend dropdown / app-provider list and apply visibility. */
function applyTranscribeConfigToUI() {
  const avail = availableBackends();

  // Show only the backend options this deployment supports.
  const sel = document.getElementById('whisperBackend');
  if (sel) {
    for (const opt of sel.options) {
      opt.hidden = !avail.includes(opt.value);
    }
    // Hide the whole selector if 'user' is the only option (nothing to switch).
    const row = document.getElementById('whisperBackendRow');
    if (row) row.classList.toggle('hidden', avail.length <= 1);
  }

  // Fill the shared-provider dropdown from the configured app providers.
  const ap = document.getElementById('whisperAppProvider');
  if (ap) {
    ap.innerHTML = '';
    for (const id of transcribeConfig.appProviders) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = (WHISPER_PROVIDERS[id]?.name || id) + (WHISPER_PROVIDERS[id] ? ` (${WHISPER_PROVIDERS[id].model})` : '');
      ap.appendChild(o);
    }
    if (transcribeConfig.appProviders.includes(state.whisper.appProvider)) {
      ap.value = state.whisper.appProvider;
    } else if (transcribeConfig.appProviders.length) {
      ap.value = transcribeConfig.appProviders[0];
      state.whisper.appProvider = ap.value;
    }
  }

  updateWhisperBackendUI();
}

/** Toggle which API-config fields show for the active backend + update hint. */
function updateWhisperBackendUI() {
  const backend = getActiveBackend();
  const sel = document.getElementById('whisperBackend');
  if (sel && sel.value !== backend) sel.value = backend;

  const userFields = document.getElementById('whisperUserFields');
  const appFields  = document.getElementById('whisperAppFields');
  if (userFields) userFields.classList.toggle('hidden', backend !== 'user');
  if (appFields)  appFields.classList.toggle('hidden',  backend !== 'app');

  const hint = document.getElementById('whisperBackendHint');
  if (hint) {
    if (backend === 'app') {
      hint.innerHTML = '<strong style="color:var(--text)">App (shared key):</strong> audio is transcribed using this site’s server-side API key — no token needed from you.';
    } else if (backend === 'workers-ai') {
      hint.innerHTML = '<strong style="color:var(--text)">Cloudflare Workers AI:</strong> audio is transcribed on this site’s Workers AI — no external key needed.';
    } else {
      hint.innerHTML = 'Pick a provider preset (OpenAI, Groq, Mistral) or Custom for any OpenAI-compatible endpoint. All fields are saved locally in your browser and proxied through the server — your token never reaches the frontend host directly.';
    }
  }
}

/** UI handler: user picks a transcription backend (persists the override). */
export function setWhisperBackend(backend) {
  state.whisper.apiBackend = backend;
  localStorage.setItem('whisperApiBackend', backend);
  updateWhisperBackendUI();
}

/** UI handler: user picks the shared 'app' provider preset. */
export function setWhisperAppProvider(id) {
  state.whisper.appProvider = id;
  localStorage.setItem('whisperAppProvider', id);
}

/**
 * Persist all three OpenAI-compatible endpoint fields (token, base URL,
 * model ID) to localStorage. Called on every keystroke from the inline
 * oninput handlers in the Auto-Caption API config row.
 */
export function saveWhisperConfig() {
  state.whisper.apiKey  = document.getElementById('whisperApiKey').value;
  state.whisper.baseUrl = (document.getElementById('whisperBaseUrl').value || '').trim() || 'https://api.openai.com/v1';
  state.whisper.modelId = (document.getElementById('whisperModelId').value || '').trim() || 'whisper-1';
  localStorage.setItem('whisperApiKey',  state.whisper.apiKey);
  localStorage.setItem('whisperBaseUrl', state.whisper.baseUrl);
  localStorage.setItem('whisperModelId', state.whisper.modelId);
  // Keep the provider dropdown in sync (shows "Custom" once you diverge).
  const sel = document.getElementById('whisperProvider');
  if (sel) sel.value = detectWhisperProvider(state.whisper.baseUrl);
}

/**
 * Populate the API config input fields from saved state on page load.
 * Called once from main.js init.
 */
export function initWhisperConfigFields() {
  const k = document.getElementById('whisperApiKey');
  const b = document.getElementById('whisperBaseUrl');
  const m = document.getElementById('whisperModelId');
  if (k) k.value = state.whisper.apiKey;
  if (b) b.value = state.whisper.baseUrl;
  if (m) m.value = state.whisper.modelId;
  const s = document.getElementById('whisperProvider');
  if (s) s.value = detectWhisperProvider(state.whisper.baseUrl);
}

// `updateAutoCaptionInfo` lives in autocaption.js but setWhisperSource
// calls it. Avoid a circular import by deferring the lookup to call time.
function updateAutoCaptionInfo() {
  const fn = window.updateAutoCaptionInfo;
  if (typeof fn === 'function') fn();
}

// ── OpenAI-compatible API transcription (via local server proxy) ───────
// Converts Float32Array audio (16 kHz mono) to WAV and sends it to the
// local server proxy (/api/transcribe) which forwards to whatever
// OpenAI-compatible endpoint the user configured (base URL + model ID).
export async function transcribeViaAPI(audioSamples, apiKey) {
  const wavBytes = float32ToWAV(audioSamples, 16000);
  const backend = getActiveBackend();
  const headers = { 'Content-Type': 'audio/wav', 'X-Transcribe-Backend': backend };

  if (backend === 'app' || backend === 'workers-ai') {
    // Shared backends are gated by the app token and use server-side keys.
    if (APP_TRANSCRIBE_TOKEN) headers['X-App-Token'] = APP_TRANSCRIBE_TOKEN;
    if (backend === 'app') {
      const prov = state.whisper.appProvider || transcribeConfig.appProviders[0] || 'mistral';
      headers['X-Transcribe-Provider'] = prov;
      addLog(`Sending audio to the shared ${prov} backend…`, 'ok');
    } else {
      addLog('Sending audio to Cloudflare Workers AI…', 'ok');
    }
  } else {
    // User's own key: proxy to the configured OpenAI-compatible endpoint.
    const baseUrl = state.whisper.baseUrl || 'https://api.openai.com/v1';
    const modelId = state.whisper.modelId || 'whisper-1';
    headers['X-OpenAI-Key']      = apiKey;
    headers['X-OpenAI-Base-URL'] = baseUrl;
    headers['X-OpenAI-Model']    = modelId;
    addLog(`Sending audio to ${baseUrl} (model: ${modelId}) via server proxy…`, 'ok');
  }

  const resp = await fetch(_api('/api/transcribe'), {
    method:  'POST',
    headers,
    body: wavBytes,
  });
  if (!resp.ok) {
    const text = await resp.text();
    let msg = `API error (${resp.status})`;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.error || msg;
    } catch (_) {
      // Plain-text error (e.g. the worker's token/availability messages).
      if (text && text.trim()) msg = `${msg}: ${text.trim()}`;
    }
    throw new Error(msg);
  }
  return await resp.text(); // SRT-formatted transcript
}

/** Encode a Float32Array of mono PCM samples as a 16-bit PCM WAV file. */
export function float32ToWAV(samples, sampleRate) {
  const buf  = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str  = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0,  'RIFF');
  view.setUint32( 4, 36 + samples.length * 2, true);
  str(8,  'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1,  true); // PCM
  view.setUint16(22, 1,  true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2,  true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Uint8Array(buf);
}
