// js/captionstyles.js
//
// Caption-style presets for the canvas hard-burn renderer (subtitles.js
// `renderCaptionCanvas` / `buildCaptionBurnArgs`). Mirrors the Whisper-
// provider pattern in engine.js: selecting a named preset fills the
// Advanced axis controls; editing any axis re-detects and flips the
// dropdown to "Custom". All values persist to localStorage('captionStyle').
//
// NOTE: the libass `force_style` presets in the repo-root
// ffmpeg-caption-styles.js cannot run in the browser — the @ffmpeg/core
// WASM build ships no fonts for libass, so the `subtitles` filter renders
// nothing. These presets recreate the same *looks* with the canvas
// renderer instead. Font family + size stay their own separate pickers;
// a preset only controls background, color, opacity, outline, position,
// and bold weight.

import { state } from './state.js';
import { renderCaptionCanvas } from './subtitles.js';
import { getCaptionFontFamily } from './fonts.js';

const LS_KEY = 'captionStyle';

/** Named caption looks. Each is a combination of the overridable axes. */
export const CAPTION_PRESETS = {
  clean:     { bg: 'box',   color: '#ffffff', opacity: 0.55, outline: 'med',   position: 'bottom', weight: 'auto' },
  hormozi:   { bg: 'solid', color: '#fed424', opacity: 1,    outline: 'none',  position: 'bottom', weight: 'bold' },
  cinematic: { bg: 'none',  color: '#ffffff', opacity: 0,    outline: 'heavy', position: 'bottom', weight: 'bold' },
  youtube:   { bg: 'box',   color: '#ffffff', opacity: 0.75, outline: 'none',  position: 'bottom', weight: 'auto' },
  subtle:    { bg: 'none',  color: '#ffffff', opacity: 0,    outline: 'med',   position: 'bottom', weight: 'auto' },
};

function eqColor(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

/** Map the current axis values back to a preset id, or 'custom' if none match. */
export function detectCaptionPreset(o) {
  for (const [id, p] of Object.entries(CAPTION_PRESETS)) {
    if (p.bg !== o.bg) continue;
    if (!eqColor(p.color, o.color)) continue;
    if (p.outline !== o.outline) continue;
    if (p.position !== o.position) continue;
    if (p.weight !== o.weight) continue;
    // Opacity only matters when a background is actually drawn.
    if (o.bg !== 'none' && Math.abs((p.opacity ?? 0) - (o.opacity ?? 0)) > 0.001) continue;
    return id;
  }
  return 'custom';
}

/**
 * Render-ready style object consumed by buildCaptionBurnArgs. Resolves the
 * 'auto' weight to the legacy rule: bold for the default Arial, natural
 * weight for a loaded custom font (synthetic bold on custom fonts looks
 * muddy). Reads `state.fonts.customFamily` directly to avoid importing the
 * `hasCustomFont` symbol (keeps the dependency surface small).
 */
export function getCaptionStyle() {
  const c = state.caption;
  const weight = c.weight === 'bold' ? 'bold' : (state.fonts.customFamily ? 'normal' : 'bold');
  return {
    preset: c.preset, bg: c.bg, color: c.color, opacity: c.opacity,
    outline: c.outline, position: c.position, weight,
  };
}

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.caption)); } catch { /* ignore quota */ }
}

/** Push state.caption → every caption-style control (both panels) + swatches. */
function syncControls() {
  const c = state.caption;
  document.querySelectorAll('.caption-style-select').forEach(el => { el.value = c.preset; });
  document.querySelectorAll('.caption-bg').forEach(el => { el.value = c.bg; });
  document.querySelectorAll('.caption-color').forEach(el => { el.value = c.color; });
  document.querySelectorAll('.caption-opacity').forEach(el => {
    el.value = String(c.opacity);
    el.disabled = (c.bg === 'none');   // opacity is meaningless without a box
  });
  document.querySelectorAll('.caption-outline').forEach(el => { el.value = c.outline; });
  document.querySelectorAll('.caption-position').forEach(el => { el.value = c.position; });
  renderCaptionSwatch();
}

/** onchange handler for the preset dropdown. */
export function onCaptionPresetChange(el) {
  applyCaptionPreset(el.value);
}

/** Apply a named preset's axes (or keep current axes for 'custom'); persist. */
export function applyCaptionPreset(id) {
  const p = CAPTION_PRESETS[id];
  if (p) Object.assign(state.caption, p, { preset: id });
  else state.caption.preset = 'custom';
  persist();
  syncControls();
}

/** oninput/onchange handler for any Advanced axis control. */
export function onCaptionStyleInput(el) {
  const c = state.caption;
  if (el.classList.contains('caption-bg'))            c.bg = el.value;
  else if (el.classList.contains('caption-color'))    c.color = el.value;
  else if (el.classList.contains('caption-opacity'))  c.opacity = parseFloat(el.value);
  else if (el.classList.contains('caption-outline'))  c.outline = el.value;
  else if (el.classList.contains('caption-position')) c.position = el.value;
  c.preset = detectCaptionPreset(c);   // flips to 'custom' when it diverges
  persist();
  syncControls();
}

const SWATCH_TEXT = 'Sample caption';

/** Dark checkerboard so transparency / low opacity reads in the preview. */
function paintSwatchBackdrop(ctx, w, h) {
  const s = 8;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      ctx.fillStyle = (((x / s) + (y / s)) % 2 === 0) ? '#3a3a3a' : '#2c2c2c';
      ctx.fillRect(x, y, s, s);
    }
  }
}

/** Re-draw the small live-preview swatch in every panel from current style. */
export function renderCaptionSwatch() {
  const style = getCaptionStyle();
  const fontFamily = getCaptionFontFamily();
  document.querySelectorAll('.caption-style-swatch').forEach(cv => {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    paintSwatchBackdrop(ctx, cv.width, cv.height);
    const fontSize = Math.round(cv.height * 0.36);
    const tile = renderCaptionCanvas([SWATCH_TEXT], { ...style, fontFamily, fontSize });
    const scale = Math.min(1, (cv.width * 0.92) / tile.width, (cv.height * 0.86) / tile.height);
    const w = tile.width * scale, h = tile.height * scale;
    const y = style.position === 'top' ? cv.height * 0.07
      : style.position === 'center' ? (cv.height - h) / 2
      : cv.height - h - cv.height * 0.07;
    ctx.drawImage(tile, (cv.width - w) / 2, y, w, h);
  });
}

/**
 * Load persisted style, populate controls, draw the swatch. Call once from
 * main.js init AFTER initCaptionFonts() so the swatch uses the right font.
 */
export function initCaptionStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved && typeof saved === 'object') Object.assign(state.caption, saved);
  } catch { /* ignore corrupt value */ }
  state.caption.preset = detectCaptionPreset(state.caption);
  syncControls();
}
