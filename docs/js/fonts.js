// js/fonts.js
//
// Custom caption font loading via the FontFace API. Lets the user pick a
// .ttf / .otf / .woff / .woff2 file from either the "Embed Subtitles" or
// "Auto-Caption" panel; we load it into the document, store the generated
// family name in `state.fonts.customFamily`, and the canvas-based caption
// renderer (subtitles.js `buildCaptionBurnArgs`) picks it up via
// `getCaptionFontFamily()`.
//
// Applies to HARD-BURN captions only. Soft-embed subtitles are rendered
// by the player (VLC, browser, etc.) using its own font, not by us.
//
// The font lives in memory for the page session — it is NOT persisted to
// localStorage (font files can be several MB and localStorage has a
// ~5 MB cap). The user re-picks the font after a page reload. This
// matches the existing pattern for subtitle/overlay/concat aux files.

import { state } from './state.js';
import { addLog } from './ui.js';

const ACCEPTED_EXT = ['ttf', 'otf', 'woff', 'woff2'];
// Map file extensions to the CSS @font-face format hint that the
// FontFace constructor accepts. The hint is optional but speeds up
// parsing and is required by some browsers for WOFF2.
const FORMAT_HINT = {
  ttf:   'truetype',
  otf:   'opentype',
  woff:  'woff',
  woff2: 'woff2',
};

// ── Bundled fonts (prebuilt list + last-used) ───────────────────────────
// Fonts shipped under docs/fonts/, listed in docs/fonts/fonts.json. Unlike
// user uploads, a bundled font is identified by a stable id, so we CAN
// persist the last-used choice to localStorage (we store only the id, not
// the font bytes) and restore it on the next page load.
const FONT_DIR = 'fonts/';
const MANIFEST_URL = FONT_DIR + 'fonts.json';
const LS_KEY = 'captionFontId';   // last-used bundled font id
let _manifest = [];               // [{ id, name, file }]

/**
 * Fetch the bundled-font manifest, populate every `.caption-font-select`
 * dropdown, and restore the last-used bundled font (if any). Safe to call
 * once at startup; failures degrade gracefully to upload-only behaviour.
 */
export async function initCaptionFonts() {
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _manifest = await res.json();
  } catch (err) {
    // No manifest / network error → leave dropdowns with just "Default".
    console.warn('Caption font manifest unavailable:', err.message || err);
    _manifest = [];
  }

  document.querySelectorAll('.caption-font-select').forEach(sel => {
    // Option 0 ("Default (Arial)") is authored in HTML; append bundled ones.
    for (const f of _manifest) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      sel.appendChild(opt);
    }
  });

  // Restore last-used bundled font, if it still exists in the manifest.
  const savedId = localStorage.getItem(LS_KEY);
  if (savedId && _manifest.some(f => f.id === savedId)) {
    await loadBundledFont(savedId);
  }
}

/**
 * onchange handler for the `.caption-font-select` dropdowns. Empty value
 * means "Default (Arial)"; any other value is a bundled font id.
 *
 * @param {HTMLSelectElement} select
 */
export async function onCaptionFontSelect(select) {
  const id = select.value;
  if (!id) { clearCaptionFont(); return; }
  await loadBundledFont(id);
}

/**
 * Fetch a bundled font by id, register it via the FontFace API, update the
 * shared caption-font UI, and persist the choice. Mirrors the registration
 * path in `onCaptionFontChange` but sources bytes from a URL.
 *
 * @param {string} id  a manifest entry id
 */
export async function loadBundledFont(id) {
  const entry = _manifest.find(f => f.id === id);
  if (!entry) { addLog(`Unknown bundled font: ${id}`, 'err'); return; }
  const ext = (entry.file.split('.').pop() || '').toLowerCase();

  try {
    const res = await fetch(FONT_DIR + entry.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();

    if (state.fonts.customFace) {
      try { document.fonts.delete(state.fonts.customFace); } catch (_) {}
    }

    const family = `fwc-bundled-${id}`;
    const fontFace = new FontFace(family, buf, FORMAT_HINT[ext] ? { format: FORMAT_HINT[ext] } : undefined);
    await fontFace.load();
    document.fonts.add(fontFace);

    state.fonts.customFamily = family;
    state.fonts.customName   = entry.name;
    state.fonts.customFace   = fontFace;
    localStorage.setItem(LS_KEY, id);

    document.querySelectorAll('.caption-font-name').forEach(el => {
      el.textContent = entry.name;
      el.style.color = 'var(--text)';
    });
    document.querySelectorAll('.caption-font-clear-btn').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.caption-font-preview').forEach(el => {
      el.style.fontFamily = `"${family}", Arial, sans-serif`;
    });
    // Keep both dropdowns in sync with the active bundled font.
    document.querySelectorAll('.caption-font-select').forEach(el => { el.value = id; });

    addLog(`Caption font: ${entry.name}`, 'ok');
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    addLog(`Failed to load bundled font "${entry.name}": ${msg}`, 'err');
  }
}

/**
 * Validate, load, and register a user-selected font file via the FontFace
 * API. Replaces any previously-loaded custom font. Updates every
 * `.caption-font-name` display element and toggles every
 * `.caption-font-clear-btn` so the UI stays consistent across both the
 * Subtitles and Auto-Caption panels (which both have a font picker).
 *
 * @param {HTMLInputElement} input  the <input type="file"> that triggered
 * @returns {Promise<void>}
 */
export async function onCaptionFontChange(input) {
  if (!input.files || !input.files.length) return;
  const file = input.files[0];
  const ext  = (file.name.split('.').pop() || '').toLowerCase();

  if (!ACCEPTED_EXT.includes(ext)) {
    addLog(`Unsupported font format: .${ext}. Accepted: ${ACCEPTED_EXT.map(e => '.' + e).join(', ')}`, 'err');
    input.value = '';
    return;
  }

  try {
    const buf = await file.arrayBuffer();

    // Unload any previously-loaded custom font so we don't accumulate
    // FontFace objects in document.fonts across repeated picks.
    if (state.fonts.customFace) {
      try { document.fonts.delete(state.fonts.customFace); } catch (_) {}
    }

    // Generate a unique family name so repeated loads don't collide.
    const family = `fwc-custom-${Date.now()}`;
    const fontFace = new FontFace(family, buf, FORMAT_HINT[ext] ? { format: FORMAT_HINT[ext] } : undefined);

    await fontFace.load();
    document.fonts.add(fontFace);

    state.fonts.customFamily = family;
    state.fonts.customName   = file.name;
    state.fonts.customFace   = fontFace;

    // Update every font-name display + clear-button across all panels.
    document.querySelectorAll('.caption-font-name').forEach(el => {
      el.textContent = file.name;
      el.style.color = 'var(--text)';
    });
    document.querySelectorAll('.caption-font-clear-btn').forEach(el => {
      el.classList.remove('hidden');
    });
    // Show every font preview line in the new font.
    document.querySelectorAll('.caption-font-preview').forEach(el => {
      el.style.fontFamily = `"${family}", Arial, sans-serif`;
    });

    // An upload is not a bundled font: reset the dropdowns to "Default" and
    // drop any persisted bundled id (uploaded bytes can't be restored on reload).
    document.querySelectorAll('.caption-font-select').forEach(el => { el.value = ''; });
    localStorage.removeItem(LS_KEY);

    addLog(`Custom caption font loaded: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, 'ok');
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    addLog(`Failed to load font "${file.name}": ${msg}`, 'err');
    state.fonts.customFamily = null;
    state.fonts.customName   = null;
    state.fonts.customFace   = null;
  } finally {
    input.value = '';  // allow re-picking the same file
  }
}

/**
 * Clear the custom font and fall back to the default (Arial). Called
 * from the "Reset font" buttons in either panel.
 */
export function clearCaptionFont() {
  if (state.fonts.customFace) {
    try { document.fonts.delete(state.fonts.customFace); } catch (_) {}
  }
  state.fonts.customFamily = null;
  state.fonts.customName   = null;
  state.fonts.customFace   = null;

  document.querySelectorAll('.caption-font-name').forEach(el => {
    el.textContent = 'Default (Arial)';
    el.style.color = 'var(--muted)';
  });
  document.querySelectorAll('.caption-font-clear-btn').forEach(el => {
    el.classList.add('hidden');
  });
  // Reset preview lines to the default font.
  document.querySelectorAll('.caption-font-preview').forEach(el => {
    el.style.fontFamily = '';
  });
  // Reset dropdowns and forget the last-used bundled font.
  document.querySelectorAll('.caption-font-select').forEach(el => { el.value = ''; });
  localStorage.removeItem(LS_KEY);
  addLog('Custom caption font cleared. Using default (Arial).', 'ok');
}

/**
 * Returns the CSS font-family string for the canvas caption renderer.
 * Falls back to `'Arial, Helvetica, sans-serif'` when no custom font is
 * loaded. Used by subtitles.js `buildCaptionBurnArgs`.
 *
 * @returns {string}
 */
export function getCaptionFontFamily() {
  return state.fonts.customFamily
    ? `"${state.fonts.customFamily}", Arial, sans-serif`
    : 'Arial, Helvetica, sans-serif';
}

/**
 * Whether a custom font is currently loaded. Used to decide whether to
 * use `bold` weight (default Arial benefits from bold for readability on
 * video; custom fonts should render at their natural weight).
 *
 * @returns {boolean}
 */
export function hasCustomFont() {
  return !!state.fonts.customFamily;
}
