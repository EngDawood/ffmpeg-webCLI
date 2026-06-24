/**
 * Cloudflare Worker for ffmpeg-webCLI.
 * 
 * - Serves frontend static assets from the docs/ folder using Cloudflare Workers Assets.
 * - Injects critical COOP (Cross-Origin-Opener-Policy) and COEP (Cross-Origin-Embedder-Policy)
 *   headers required for WebAssembly SharedArrayBuffer to function correctly.
 * - Proxies /api/transcribe to OpenAI Whisper API using the user's provided API key.
 * - Gracefully handles /api/status and /api/exec since native ffmpeg cannot be spawned
 *   in V8 serverless isolates.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route API requests
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, url);
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
      return new Response(JSON.stringify({ error: err.message || 'Asset fetch error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

async function handleAPI(request, url) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-OpenAI-Key',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
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
  if (url.pathname === '/api/transcribe' && request.method === 'POST') {
    const apiKey = request.headers.get('x-openai-key');
    if (!apiKey) {
      return new Response('Missing X-OpenAI-Key header', { status: 400, headers: corsHeaders });
    }

    try {
      const audioBlob = await request.blob();
      
      const formData = new FormData();
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'srt');
      formData.append('file', audioBlob, 'audio.wav');

      const openAIResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: formData
      });

      const responseText = await openAIResponse.text();
      
      const responseHeaders = {
        ...corsHeaders,
        'Content-Type': openAIResponse.headers.get('Content-Type') || 'text/plain'
      };

      return new Response(responseText, {
        status: openAIResponse.status,
        headers: responseHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'OpenAI Whisper proxy failed: ' + err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Not found', { status: 404, headers: corsHeaders });
}
