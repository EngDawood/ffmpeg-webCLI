// js/subtitles.js
//
// Subtitle parsing (SRT / WebVTT / ASS-SSA) and the canvas-based
// hard-burn renderer. The hard-burn path is needed because @ffmpeg/core's
// WASM build ships the `subtitles` filter but no fonts for libass, so
// the filter renders nothing. Instead we parse the cues, draw each one
// to a PNG with the browser canvas, and overlay those PNGs on the video
// via a chained ffmpeg `overlay` filter with `enable='between(t,...)'`.

import { state } from './state.js';
import { getVideoSize } from './helpers.js';
import { getFF } from './engine.js';
import { addLog } from './ui.js';
import { getCaptionFontFamily, hasCustomFont } from './fonts.js';

// Characters from right-to-left scripts (Hebrew, Arabic, Syriac, Thaana,
// Arabic Supplement/Extended, plus Arabic presentation forms A/B). Used to
// flip the canvas bidi direction so captions render with correct
// punctuation, parenthesis and Latin-digit placement. Letter shaping/joining
// itself is handled natively by the browser text engine.
const RTL_RE = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;
function isRTL(s) { return RTL_RE.test(s || ''); }

/**
 * Parse a "HH:MM:SS,mmm" / "MM:SS.mmm" timecode to seconds. Returns null
 * if it doesn't look like a timecode.
 */
export function parseSubtitleClock(str) {
  const m = (str || '').trim().match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return h * 3600 + min * 60 + sec + ms / 1000;
}

/**
 * Parse subtitle text (SRT, WebVTT, or ASS/SSA) into an array of
 * {startSec, endSec, text} cues. Used by the canvas-based hard-burn
 * renderer.
 */
export function parseSubtitleCues(content) {
  let txt = (content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^﻿/, '');
  const cues = [];

  // ── ASS / SSA: read Dialogue lines from the [Events] section ──
  if (/^\s*Dialogue:/m.test(txt)) {
    // Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    const dlg = /^Dialogue:\s*[^,]*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,(?:[^,]*,){6}(.*)$/;
    for (const line of txt.split('\n')) {
      const m = line.match(dlg);
      if (!m) continue;
      const s = parseSubtitleClock(m[1]);
      const e = parseSubtitleClock(m[2]);
      if (s == null || e == null) continue;
      const text = m[3]
        .replace(/\{[^}]*\}/g, '')   // strip override tags
        .replace(/\\N/gi, '\n')       // hard line break
        .replace(/\\h/gi, ' ')        // hard space
        .trim();
      if (text) cues.push({ startSec: s, endSec: e, text });
    }
    return cues;
  }

  // ── SRT / WebVTT: blank-line separated blocks with a "-->" timecode line ──
  txt = txt.replace(/^WEBVTT[^\n]*\n/, '');
  const blocks = txt.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex(l => l.includes('-->'));
    if (idx === -1) continue;
    const [startStr, endStr] = lines[idx].split('-->');
    const s = parseSubtitleClock(startStr);
    const e = parseSubtitleClock(endStr);
    if (s == null || e == null) continue;
    const text = lines.slice(idx + 1).join('\n')
      .replace(/<[^>]+>/g, '')  // strip VTT inline tags
      .trim();
    if (text) cues.push({ startSec: s, endSec: e, text });
  }
  return cues;
}

/** Clamp a number into the 0..1 range (alpha values). */
function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

/** Trace a rounded rectangle path (does not fill/stroke). */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw one caption "tile" (background + outlined text) to a freshly-sized
 * offscreen canvas and return it. Shared by the hard-burn overlay loop
 * (exported to PNG) and the live style swatch in captionstyles.js, so the
 * preview is pixel-for-pixel what gets burned in.
 *
 * @param {string[]} lines  already-wrapped lines of caption text
 * @param {Object} o
 * @param {string} [o.fontFamily]  CSS font-family
 * @param {'bold'|'normal'} [o.weight]
 * @param {number} [o.fontSize]
 * @param {string} [o.color]   text color (#RRGGBB or CSS color)
 * @param {'box'|'solid'|'none'} [o.bg]  background style
 * @param {number} [o.opacity] background alpha 0..1 (box/solid only)
 * @param {'none'|'med'|'heavy'} [o.outline]  outline weight
 * @param {number} [o.lineHeight]
 * @returns {HTMLCanvasElement}
 */
export function renderCaptionCanvas(lines, o = {}) {
  const {
    fontFamily = 'Arial, Helvetica, sans-serif',
    weight = 'bold', fontSize = 48,
    color = '#ffffff', bg = 'box', opacity = 0.55, outline = 'med',
  } = o;
  const lineHeight = o.lineHeight || Math.round(fontSize * 1.3);
  const padX = Math.round(fontSize * 0.7);
  const padY = Math.round(fontSize * 0.4);
  const FONT = `${weight} ${fontSize}px ${fontFamily}`;

  const m = document.createElement('canvas').getContext('2d');
  m.font = FONT;
  let textW = 0;
  for (const l of lines) textW = Math.max(textW, m.measureText(l).width);

  const boxW = Math.max(1, Math.ceil(textW) + 2 * padX);
  const boxH = Math.max(1, lines.length * lineHeight + 2 * padY);

  const c = document.createElement('canvas');
  c.width = boxW;
  c.height = boxH;
  const cx = c.getContext('2d');

  // Background (skipped entirely for 'none' → transparent tile).
  if (bg !== 'none') {
    const radius = bg === 'solid' ? Math.round(fontSize * 0.12) : Math.round(fontSize * 0.4);
    const r = Math.min(radius, Math.floor(boxH / 2));
    cx.fillStyle = `rgba(0,0,0,${clamp01(opacity)})`;
    roundRect(cx, 0, 0, boxW, boxH, r);
    cx.fill();
  }

  cx.font = FONT;
  cx.textAlign = 'center';
  cx.textBaseline = 'top';
  cx.lineJoin = 'round';

  // Outline pass (carries a soft drop-shadow for 'heavy').
  if (outline !== 'none') {
    cx.lineWidth = outline === 'heavy' ? Math.max(3, fontSize / 5) : Math.max(2, fontSize / 8);
    cx.strokeStyle = 'rgba(0,0,0,0.95)';
    if (outline === 'heavy') {
      cx.shadowColor = 'rgba(0,0,0,0.6)';
      cx.shadowBlur = Math.round(fontSize / 6);
    }
    for (let j = 0; j < lines.length; j++) cx.strokeText(lines[j], boxW / 2, padY + j * lineHeight);
    cx.shadowColor = 'transparent';
    cx.shadowBlur = 0;
  }

  // Readability guard: no box AND no outline would leave bare text that
  // vanishes on matching backgrounds — give the fill a protective shadow.
  if (bg === 'none' && outline === 'none') {
    cx.shadowColor = 'rgba(0,0,0,0.85)';
    cx.shadowBlur = Math.round(fontSize / 5);
    cx.shadowOffsetY = Math.max(1, Math.round(fontSize / 24));
  }

  // Fill pass.
  cx.fillStyle = color;
  for (let j = 0; j < lines.length; j++) cx.fillText(lines[j], boxW / 2, padY + j * lineHeight);
  cx.shadowColor = 'transparent';
  cx.shadowBlur = 0;
  cx.shadowOffsetY = 0;

  return c;
}

/**
 * Render caption cues to per-cue PNG overlays with the browser canvas
 * and build the ffmpeg args (minus the output name) that burn them into
 * the video. Captions are centered horizontally; vertical placement and
 * the visual look come from `styleOpts` (see captionstyles.js
 * `getCaptionStyle`). Timing comes straight from the cue start/end via the
 * overlay `enable` expression, so it stays in sync.
 *
 * @param {Array<{startSec:number,endSec:number,text:string}>} cues
 * @param {string} inName  ffmpeg virtual-FS name of the input video
 * @param {'small'|'medium'|'large'} fontSizeChoice
 * @param {Object} [styleOpts]  { preset, bg, color, opacity, outline, position, weight }
 * @returns {Promise<string[]>} ffmpeg args (without the output filename)
 */
export async function buildCaptionBurnArgs(cues, inName, fontSizeChoice, styleOpts = {}) {
  const { w: vidW, h: vidH } = getVideoSize();
  const canvasW = vidW || 1920;
  const canvasH = vidH || 1080;
  // Font size scales with video height; the user choice nudges it up or down.
  const fontScale = { small: 0.7, medium: 1.0, large: 1.5 }[fontSizeChoice] || 1.0;
  const fontSize = Math.max(14, Math.round(canvasH * 0.045 * fontScale));

  // Resolve style axes, defaulting to the classic "clean" look so callers
  // that pass nothing keep the original behaviour.
  const style = {
    bg:       styleOpts.bg       || 'box',
    color:    styleOpts.color    || '#ffffff',
    opacity:  styleOpts.opacity == null ? 0.55 : styleOpts.opacity,
    outline:  styleOpts.outline  || 'med',
    position: styleOpts.position || 'bottom',
    // weight is normally pre-resolved by getCaptionStyle(); fall back to the
    // legacy rule (bold for default Arial, natural weight for custom fonts).
    weight:   styleOpts.weight   || (hasCustomFont() ? 'normal' : 'bold'),
  };

  addLog(`Caption: ${styleOpts.preset || 'clean'} style, ${fontSizeChoice || 'medium'} size (${fontSize}px @ ${canvasW}x${canvasH})`, 'ok');
  if (state.fonts.customName) {
    addLog(`Using custom caption font: ${state.fonts.customName}`, 'ok');
  }

  const fontFamily = getCaptionFontFamily();
  const FONT = `${style.weight} ${fontSize}px ${fontFamily}`;
  const lineHeight = Math.round(fontSize * 1.3);
  const maxTextWidth = canvasW * 0.86;   // wrap within ~86% of frame width
  const marginV = Math.round(canvasH * 0.045);

  const measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = FONT;

  const wrapText = (text) => {
    const out = [];
    for (const para of text.split('\n')) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (measureCtx.measureText(test).width > maxTextWidth && line) {
          out.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) out.push(line);
    }
    return out.length ? out : [text];
  };

  for (let i = 0; i < cues.length; i++) {
    const lines = wrapText(cues[i].text.trim());
    const tile = renderCaptionCanvas(lines, {
      fontFamily, weight: style.weight, fontSize, lineHeight,
      color: style.color, bg: style.bg, opacity: style.opacity, outline: style.outline,
    });
    const b64 = tile.toDataURL('image/png').split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    await getFF().writeFile(`caption_${i}.png`, bytes);
  }

  // Vertical placement of the overlay, per the chosen position axis.
  const yExpr = style.position === 'top'
    ? String(marginV)
    : style.position === 'center'
      ? '(main_h-overlay_h)/2'
      : `main_h-overlay_h-${marginV}`;

  // Chain one timed overlay per cue: centered horizontally, placed per axis.
  let filterComplex = '';
  for (let i = 0; i < cues.length; i++) {
    const src = i === 0 ? '[0:v]' : `[v${i - 1}]`;
    const start = cues[i].startSec.toFixed(3);
    const end = cues[i].endSec.toFixed(3);
    filterComplex += `${src}[${i + 1}:v]overlay=(main_w-overlay_w)/2:${yExpr}:enable='between(t,${start},${end})'[v${i}]`;
    if (i < cues.length - 1) filterComplex += ';';
  }

  // Each caption is a looped (`-loop 1`) image so it stays available for
  // the full duration of its `enable` window. On its own that's an
  // infinite input and ffmpeg would never stop after the video ends —
  // `-shortest` bounds the output to the finite video/audio, so captions
  // render for the whole clip AND ffmpeg exits.
  const args = ['-i', inName];
  for (let i = 0; i < cues.length; i++) args.push('-loop', '1', '-i', `caption_${i}.png`);
  args.push('-filter_complex', filterComplex);
  args.push('-map', `[v${cues.length - 1}]`, '-map', '0:a?');
  args.push('-c:a', 'copy', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-shortest');
  return args;
}

/**
 * Convert transcription segments to SRT format (HH:MM:SS,mmm).
 * @param {Array<{start:number,end:number,text:string}>} segments
 */
export function segmentsToSRT(segments) {
  if (!segments || segments.length === 0) {
    return '';
  }

  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  return segments
    .map((seg, i) => `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text}\n`)
    .join('\n');
}
