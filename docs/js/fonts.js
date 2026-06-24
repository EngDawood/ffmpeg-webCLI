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
