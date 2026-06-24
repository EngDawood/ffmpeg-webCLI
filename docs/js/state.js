// js/state.js
//
// Single shared state object for the whole app. Every module imports this
// and reads/writes through `state.*`. Keeping everything on one object
// avoids ES-module live-binding footguns (you can't reassign an imported
// binding from another module) and gives us one place to look when
// debugging "what's the current value of X?".
//
// Grouping on sub-objects (state.input, state.op, state.engine, ...) keeps
// the surface area small and makes the call sites readable
// (`state.input.file` instead of `inputFile`).

export const state = {
  // ── Source video / file ────────────────────────────────────────────
  input: {
    file: null,          // File the user loaded (single mode)
    ext:  '',            // extension of `file`, lowercased
    vidDur: 0,           // duration in seconds (filled on loadedmetadata)
  },

  // ── Active operation & last output ─────────────────────────────────
  op: {
    current: 'convert',
    outBlob: null,
    outExt:  'mp4',
    outName: null,   // suggested download filename; null → default 'output.ext'
    // When the user picks the "gif" op-tile we lock the output-format
    // dropdown to gif. Store the previous selection here so we can restore
    // it when they switch away from gif.
    lastFormatBeforeGif: 'mp4',
  },

  // ── Engine: 'browser' (ffmpeg.wasm) or 'server' (native via server.js)
  engine: {
    useServerMode:  localStorage.getItem('ffEngine') === 'server',
    serverModeReady: false,
    ffmpeg:   null,   // @ffmpeg/ffmpeg FFmpeg instance (set by engine.js)
    serverFF: null,   // server-adapter object (set by engine.js)
  },

  // ── Whisper / Auto-Caption ─────────────────────────────────────────
  whisper: {
    source:  localStorage.getItem('whisperSource') || 'local',  // 'local' | 'api'
    apiKey:  localStorage.getItem('whisperApiKey')  || '',
    // OpenAI-compatible endpoint config — supports OpenAI, Azure OpenAI,
    // Groq, local LLM servers (e.g. llama.cpp / vLLM with /v1 prefix), etc.
    baseUrl: localStorage.getItem('whisperBaseUrl') || 'https://api.openai.com/v1',
    modelId: localStorage.getItem('whisperModelId') || 'whisper-1',
    transcriber: null,   // Transcriber instance (reused across runs)
    segments:    null,   // segments from last transcription (pre-edit)
    srt:         null,   // editable SRT text
    inProgress:  false,
  },

  // ── Crop selector ──────────────────────────────────────────────────
  crop: {
    x: 0, y: 0, w: 0, h: 0,
    drag: null,           // active pointer-drag state, or null
    MIN_PX: 24,
  },

  // ── Operation stack (chaining mode) ────────────────────────────────
  // Each stack item is { id, op, params } where `params` is a snapshot of
  // that op's own controls captured at "Add to Stack" time. Trim-dependent
  // values (e.g. fade-out start time) are intentionally NOT baked in here —
  // they are recomposed at compose time from the live trim so changing the
  // trim updates the chain.
  stack: {
    mode:  false,
    items: [],
    seq:   0,
  },

  // ── Batch mode ─────────────────────────────────────────────────────
  // Each batch item is { file, status, error?, output?, outputName? }
  // where status ∈ 'pending' | 'processing' | 'done' | 'error'.
  batch: {
    mode:    false,
    queue:   [],
    current: null,  // index of currently-processing file
  },

  // ── Auxiliary input files (per-op "second input" pickers) ─────────
  auxFiles: {
    rawInput2: null, rawInput2Ext: '',
    subtitle:  null, subtitleExt:  '',
    overlay:   null, overlayExt:   '',
    mixAudio:  null, mixAudioExt:  '',
    concat:    null, concatExt:    '',
    sxs:       null, sxsExt:       '',
    pip:       null, pipExt:       '',
  },

  // ── Screen wake lock (prevents sleep during long jobs) ────────────
  wakeLock: null,

  // ── Custom caption font (used by hard-burn subtitle rendering) ─────
  // When the user uploads a .ttf/.otf/.woff/.woff2 file we load it via
  // the FontFace API and store the generated family name here. The
  // canvas-based caption renderer in subtitles.js picks it up via
  // getCaptionFontFamily(). Falls back to 'Arial, Helvetica, sans-serif'
  // when null. Applies to HARD-BURN only — soft-embed subtitles are
  // rendered by the player, not by us.
  fonts: {
    customFamily: null,   // e.g. 'fwc-custom-1719234567890'
    customName:   null,   // original file name for display, e.g. 'myfont.ttf'
    customFace:   null,   // the FontFace object (so we can unload it)
  },
};

// ── Constants ──────────────────────────────────────────────────────────

/** Operations that can be chained in Stack mode (single-input, frame-wise). */
export const CHAINABLE = new Set([
  'crop', 'resizecompress', 'rotate', 'adjust', 'fade',
  'denoise', 'sharpenblur', 'speed', 'pad', 'volume',
]);

/** Font-Awsemble icon classes for each chainable op (used in stack item UI). */
export const STACK_ICON = {
  crop: 'fa-crop-simple',
  resizecompress: 'fa-compress',
  rotate: 'fa-rotate-right',
  adjust: 'fa-sliders',
  fade: 'fa-circle-half-stroke',
  denoise: 'fa-broom',
  sharpenblur: 'fa-eye',
  speed: 'fa-bolt',
  pad: 'fa-expand',
  volume: 'fa-volume-high',
};

/**
 * Operations unsupported in batch mode — multi-input, memory-intensive
 * buffering, whole-file special handling, or informational only.
 */
export const BATCH_UNSUPPORTED = new Set([
  'crop', 'concat', 'sxs', 'pip', 'mixaudio', 'overlay',
  'subtitles', 'autocaption', 'reverse', 'boomerang', 'info', 'raw',
]);
