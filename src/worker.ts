/**
 * Cloudflare Worker for ffmpeg-webCLI.
 *
 * - Serves frontend static assets from the docs/ folder using Cloudflare Workers Assets.
 * - Injects critical COOP (Cross-Origin-Opener-Policy) and COEP (Cross-Origin-Embedder-Policy)
 *   headers required for WebAssembly SharedArrayBuffer to function correctly.
 * - Proxies /api/transcribe to an OpenAI-compatible API or Cloudflare Workers AI.
 * - Gracefully handles /api/status and /api/exec since native ffmpeg cannot be spawned
 *   in V8 serverless isolates.
 *
 * Typed entrypoint: Wrangler bundles this .ts with esbuild (no separate build
 * step). The Env interface below documents every binding/secret/var this Worker
 * expects — keep it in sync with wrangler.jsonc and your `wrangler secret put`s.
 * For full runtime types you can additionally run `wrangler types`.
 */

/** Minimal shape of the Workers AI binding we use (avoids a types dependency). */
interface WorkersAI {
  run(model: string, input: unknown): Promise<unknown>;
}

/** Minimal shape of the static-assets binding. */
interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  /** Static assets binding (docs/). */
  ASSETS: AssetFetcher;
  /** Workers AI binding — powers the "workers-ai" transcription backend. */
  AI?: WorkersAI;

  // ── Secrets (set via `wrangler secret put <NAME>`) ──
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  /** Gate for the shared "app"/"workers-ai" backends. */
  APP_TOKEN?: string;

  // ── Vars (wrangler.jsonc) ──
  /** Default backend when the frontend doesn't override: user | app | workers-ai. */
  APP_TRANSCRIBE_DEFAULT?: string;
  /** Workers AI speech-to-text model id for the "workers-ai" backend. */
  WORKERS_AI_MODEL?: string;

  /** Allow dynamic provider-key lookup (env[provider.keyVar]). */
  [key: string]: unknown;
}

type CorsHeaders = Record<string, string>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route API requests
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, url, env);
    }

    // Serve static assets via the ASSETS binding
    try {
      let response = await env.ASSETS.fetch(request);

      // SPA Fallback: If asset not found, serve index.html
      if (response.status === 404) {
        const indexRequest = new Request(new URL('/index.html', request.url), request);
        response = await env.ASSETS.fetch(indexRequest);
      }

      // Inject headers required for SharedArrayBuffer / cross-origin isolation
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
      newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
      newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

      // Set caching headers for service worker and assets if not already defined
      const baseName = url.pathname.split('/').pop() || '';
      if (baseName === 'service-worker.js' || baseName === 'manifest.json') {
        newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Asset fetch error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

async function handleAPI(request: Request, url: URL, env: Env): Promise<Response> {
  const corsHeaders: CorsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-OpenAI-Key, X-OpenAI-Base-URL, X-OpenAI-Model, X-Transcribe-Backend, X-Transcribe-Provider, X-App-Token',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // GET /api/transcribe-config — tells the frontend which transcription
  // backends this deployment offers and the server-chosen default, so the UI
  // can follow the server default and only show available options.
  if (url.pathname === '/api/transcribe-config' && request.method === 'GET') {
    const appProviders = Object.keys(APP_PROVIDERS).filter(id => !!env[APP_PROVIDERS[id].keyVar]);
    const body = {
      defaultBackend: (env.APP_TRANSCRIBE_DEFAULT || 'user').toLowerCase(),
      appProviders,
      workersAi: !!env.AI,
      tokenRequired: !!env.APP_TOKEN,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // GET /api/status
  if (url.pathname === '/api/status' && request.method === 'GET') {
    return new Response(
      JSON.stringify({
        available: false,
        reason: 'Native ffmpeg execution is not available in the Cloudflare Workers serverless environment. Please use the WebAssembly (WASM) engine option in settings.'
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }

  // POST /api/exec
  if (url.pathname === '/api/exec' && request.method === 'POST') {
    return new Response(
      JSON.stringify({
        error: 'Server-side execution is not supported on Cloudflare Workers. Please switch the engine mode to "WebAssembly (WASM)" in settings to process files in your browser.'
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }

  // POST /api/upload
  if (url.pathname === '/api/upload' && request.method === 'POST') {
    return new Response(
      JSON.stringify({
        error: 'File uploads are not supported on Cloudflare Workers. Please switch the engine mode to "WebAssembly (WASM)" in settings to process files in your browser.'
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }

  // POST /api/transcribe
  // Three switchable backends, chosen by the X-Transcribe-Backend header
  // (falling back to the APP_TRANSCRIBE_DEFAULT var):
  //   user       — proxy the visitor's own key to any OpenAI-compatible API.
  //   app        — use a server-side secret key (Groq/Mistral/OpenAI).
  //   workers-ai — transcribe on Cloudflare Workers AI (no external key).
  // The shared backends (app, workers-ai) are gated by an app token so the
  // public endpoint can't drain your credits. All backends return SRT text.
  if (url.pathname === '/api/transcribe' && request.method === 'POST') {
    const backend = (request.headers.get('x-transcribe-backend') || env.APP_TRANSCRIBE_DEFAULT || 'user').toLowerCase();

    if (backend === 'app' || backend === 'workers-ai') {
      if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
        return new Response('Forbidden: invalid or missing app token', { status: 403, headers: corsHeaders });
      }
    }

    try {
      if (backend === 'workers-ai') {
        return await transcribeWorkersAI(request, env, corsHeaders);
      }
      // 'app' uses a server secret; anything else falls back to the user's key.
      return await transcribeExternal(request, env, corsHeaders, backend === 'app');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: 'Transcription proxy failed: ' + message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Not found', { status: 404, headers: corsHeaders });
}

interface AppProvider {
  baseUrl: string;
  model: string;
  keyVar: string;
}

// Prebuilt providers for the server-side "app" backend. The key for each is
// read from a Cloudflare secret of the matching name (set whichever you use).
const APP_PROVIDERS: Record<string, AppProvider> = {
  openai:  { baseUrl: 'https://api.openai.com/v1',      model: 'whisper-1',              keyVar: 'OPENAI_API_KEY' },
  groq:    { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyVar: 'GROQ_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1',      model: 'voxtral-mini-latest',    keyVar: 'MISTRAL_API_KEY' },
};

// Normalize a base URL into a full /audio/transcriptions endpoint.
function resolveTranscriptionEndpoint(baseUrlStr: string): string {
  let endpoint = 'https://api.openai.com/v1/audio/transcriptions';
  if (!baseUrlStr) return endpoint;
  try {
    const parsed = new URL(baseUrlStr);
    let pathStr = parsed.pathname;
    if (pathStr === '/' || pathStr === '') {
      pathStr = '/v1/audio/transcriptions';
    } else if (!pathStr.endsWith('/audio/transcriptions') && !pathStr.endsWith('/transcriptions')) {
      pathStr = pathStr.replace(/\/$/, '') + '/audio/transcriptions';
    }
    parsed.pathname = pathStr;
    endpoint = parsed.toString();
  } catch (e) {
    // Fall back to the OpenAI default on a malformed URL.
  }
  return endpoint;
}

// Proxy a WAV body to an OpenAI-compatible API and return SRT. useAppKey picks
// the credentials/endpoint from a server secret instead of the visitor's key.
async function transcribeExternal(request: Request, env: Env, corsHeaders: CorsHeaders, useAppKey: boolean): Promise<Response> {
  let apiKey: string | null | undefined;
  let baseUrlStr: string;
  let model: string;

  if (useAppKey) {
    const providerId = (request.headers.get('x-transcribe-provider') || 'mistral').toLowerCase();
    const p = APP_PROVIDERS[providerId];
    if (!p) {
      return new Response('Unknown app provider: ' + providerId, { status: 400, headers: corsHeaders });
    }
    apiKey = env[p.keyVar] as string | undefined;
    if (!apiKey) {
      return new Response(`App key not configured for ${providerId} (set the ${p.keyVar} secret)`, { status: 503, headers: corsHeaders });
    }
    baseUrlStr = p.baseUrl;
    model = p.model;
  } else {
    apiKey = request.headers.get('x-openai-key');
    if (!apiKey) {
      return new Response('Missing X-OpenAI-Key header', { status: 400, headers: corsHeaders });
    }
    baseUrlStr = request.headers.get('x-openai-base-url') || 'https://api.openai.com/v1';
    model = request.headers.get('x-openai-model') || 'whisper-1';
  }

  const endpoint = resolveTranscriptionEndpoint(baseUrlStr);
  const audioBlob = await request.blob();

  // Mistral (Voxtral) returns an empty segments array unless segment-level
  // timestamps are requested, and expects the plain field name; OpenAI/Groq
  // use the array form.
  const isMistral = /mistral/i.test(new URL(endpoint).hostname);
  const granField = isMistral ? 'timestamp_granularities' : 'timestamp_granularities[]';

  const formData = new FormData();
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');
  formData.append(granField, 'segment');
  formData.append('file', audioBlob, 'audio.wav');

  const apiResponse = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData
  });

  const responseText = await apiResponse.text();
  const finalData = apiResponse.ok ? verboseJsonToSRT(responseText) : responseText;

  return new Response(finalData, {
    status: apiResponse.status,
    headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
  });
}

interface WhisperWord { word?: string; start?: number; end?: number; }
interface WhisperResult { text?: string; words?: WhisperWord[]; vtt?: string; }

// Transcribe on Cloudflare Workers AI (no external API key needed).
async function transcribeWorkersAI(request: Request, env: Env, corsHeaders: CorsHeaders): Promise<Response> {
  if (!env.AI) {
    return new Response('Workers AI binding (AI) is not configured on this Worker', { status: 503, headers: corsHeaders });
  }
  const buf = await request.arrayBuffer();
  // NOTE: the `audio: number[]` (Uint8Array spread) input format is correct for
  // @cf/openai/whisper (the default). @cf/openai/whisper-large-v3-turbo expects
  // a DIFFERENT input (base64 string), so do NOT just point WORKERS_AI_MODEL at
  // turbo — it would need a base64 encoding change here first.
  const audio = [...new Uint8Array(buf)];
  const model = env.WORKERS_AI_MODEL || '@cf/openai/whisper';
  const result = (await env.AI.run(model, { audio })) as WhisperResult;
  return new Response(whisperResultToSRT(result), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
  });
}

// Convert a Workers AI Whisper result (vtt / words / text) into SRT text.
function whisperResultToSRT(result: WhisperResult): string {
  if (result && typeof result.vtt === 'string' && result.vtt.trim()) {
    return vttToSRT(result.vtt);
  }
  if (result && Array.isArray(result.words) && result.words.length) {
    // Group word-level timings into ~10-word cues.
    const GROUP = 10;
    let srt = '';
    let idx = 1;
    for (let i = 0; i < result.words.length; i += GROUP) {
      const chunk = result.words.slice(i, i + GROUP);
      const start = chunk[0].start || 0;
      const end = chunk[chunk.length - 1].end || start;
      const text = chunk.map(w => (w.word || '').trim()).join(' ').trim();
      srt += `${idx++}\r\n${formatTime(start)} --> ${formatTime(end)}\r\n${text}\r\n\r\n`;
    }
    return srt;
  }
  const text = ((result && result.text) || '').trim();
  return `1\r\n00:00:00,000 --> 00:00:05,000\r\n${text}\r\n\r\n`;
}

interface VttCue { start: string; end: string; text: string[]; }

// Convert WebVTT cues to SRT (commas for the ms separator, padded hours).
function vttToSRT(vtt: string): string {
  const lines = vtt.replace(/\r/g, '').split('\n');
  const tc = /(\d{2}:\d{2}:\d{2}|\d{2}:\d{2})[.,](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}|\d{2}:\d{2})[.,](\d{3})/;
  const cues: VttCue[] = [];
  let cur: VttCue | null = null;
  const norm = (hms: string, ms: string) => (hms.length === 5 ? '00:' + hms : hms) + ',' + ms;
  for (const line of lines) {
    const m = line.match(tc);
    if (m) {
      if (cur) cues.push(cur);
      cur = { start: norm(m[1], m[2]), end: norm(m[3], m[4]), text: [] };
    } else if (cur && line.trim() && !/^WEBVTT/i.test(line) && !/^\d+$/.test(line.trim())) {
      cur.text.push(line.trim());
    } else if (cur && !line.trim()) {
      cues.push(cur);
      cur = null;
    }
  }
  if (cur) cues.push(cur);

  let srt = '';
  cues.forEach((c, i) => {
    srt += `${i + 1}\r\n${c.start} --> ${c.end}\r\n${c.text.join('\n')}\r\n\r\n`;
  });
  return srt;
}

interface VerboseSegment { start?: number; end?: number; text?: string; }

// Parse an OpenAI-compatible verbose_json transcription response into SRT text.
function verboseJsonToSRT(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr) as { segments?: VerboseSegment[]; duration?: number; text?: string };
    if (!Array.isArray(data.segments) || data.segments.length === 0) {
      // No segments (e.g. a provider that ignores timestamp_granularities):
      // fall back to a single segment spanning the whole clip with the full text.
      const duration = data.duration || 0;
      return `1\r\n00:00:00,000 --> ${formatTime(duration)}\r\n${(data.text || '').trim()}\r\n\r\n`;
    }

    let srt = '';
    data.segments.forEach((seg, index) => {
      const startStr = formatTime(seg.start || 0);
      const endStr = formatTime(seg.end || 0);
      srt += `${index + 1}\r\n${startStr} --> ${endStr}\r\n${(seg.text || '').trim()}\r\n\r\n`;
    });
    return srt;
  } catch (e) {
    // If it's not valid JSON, just return the raw string.
    return jsonStr;
  }
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  const pad = (num: number, len = 2) => String(num).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
