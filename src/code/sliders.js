// slider() controls of Strudel code as daW³ macros (pure, Node-safe — no Strudel engine needed).
//
//   parseSliders(code)            -> [{index, from, to, value, num, min, max, step, name}]   every slider(v, min, max, step)
//   sliderKey(ns, index)          -> the live-value key of a slider in a namespaced evaluation ('<ns>#<index>')
//   sliderDef(slider)             -> ParamDef-like { min, max, step, default, curve: 'lin' } for knobs / mod targets
//   syncSliderMacros(track)       -> boolean   maps every slider of a code track to a named macro (mutates the draft)
//   sliderMacroIndex(track, k)    -> macro index routed to slider k, or -1
//   writeSliderValues(code, track)-> code with each mapped slider's literal replaced by its macro's current value
//
// Strudel's transpiler turns slider(v, min, max, step) into sliderWithID('slider_<offset of v>', v, …) — ids are
// character offsets, so they move whenever the code above them changes. daW³ addresses sliders by their ordinal
// instead (k-th slider() call of the track's code, in source order — the transpiler's order too): the route target
// `slider:<k>` survives edits that don't add or remove sliders. A code track's evaluation is namespaced by its
// track id (src/code/strudel-real.js), so two tracks never share a slider value.
import { createModState, createRoute, MACRO_COUNT } from '../core/modulation.js';

const IDENT = /[A-Za-z0-9_$]/;

/** Skips a string / template / comment starting at i; returns the index after it, or i when there is none. */
function skipNonCode(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); return e < 0 ? src.length : e; }
  if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? src.length : e + 2; }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
    return j + 1;
  }
  return i;
}

/** Code with strings / comments blanked out (same length), so offsets stay valid. */
function codeOnly(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const j = skipNonCode(src, i);
    if (j > i) {
      const quote = src[i] === '"' || src[i] === "'" || src[i] === '`';
      out += quote ? src[i] + ' '.repeat(Math.max(0, j - i - 2)) + (j - i >= 2 ? src[i] : '') : ' '.repeat(j - i);
      i = j;
    } else { out += src[i]; i++; }
  }
  return out.slice(0, src.length);
}

/** The method / function the call at `pos` is an argument of: `.acidenv(slider(…))` -> 'acidenv'. */
function enclosingCall(clean, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = clean[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth) { depth--; continue; }
      if (c !== '(') return null;
      let j = i - 1;
      while (j >= 0 && /\s/.test(clean[j])) j--;
      let k = j;
      while (k >= 0 && IDENT.test(clean[k])) k--;
      const name = clean.slice(k + 1, j + 1);
      return name && !/^\d/.test(name) ? name : null;
    }
  }
  return null;
}

/** The top-level `$NAME:` / `name:` label the position belongs to (for a fallback name). */
function labelAt(clean, pos) {
  const head = clean.slice(0, pos);
  const m = [...head.matchAll(/(?:^|\n)\s*_?\$?([A-Za-z_][\w]*)?\s*:(?!:)/g)].pop();
  return m?.[1] || null;
}

const numLit = (s) => {
  const t = String(s ?? '').trim();
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : null;
};

/**
 * Every slider(value, min = 0, max = 1, step) call of the code, in source order.
 * value: the literal text of the first argument; num: its number (NaN when it isn't a number literal).
 */
export function parseSliders(code) {
  const src = String(code ?? '');
  const clean = codeOnly(src);
  const out = [];
  const re = /(^|[^\w$.])slider\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const callStart = m.index + m[1].length;
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const from = i;
    // split the arguments at depth-0 commas (strings are blanked in `clean`)
    const args = [];
    let depth = 0, a = i, end = -1;
    for (let j = i; j < clean.length; j++) {
      const c = clean[j];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (!depth) { args.push([a, j]); end = j; break; }
        depth--;
      } else if (c === ',' && !depth) { args.push([a, j]); a = j + 1; }
    }
    if (end < 0 || !args.length) continue;
    const txt = args.map(([s, e]) => src.slice(s, e).trim());
    if (!txt[0]) continue;
    let to = args[0][1];
    while (to > from && /\s/.test(src[to - 1])) to--;
    const num = numLit(txt[0]);
    const min = numLit(txt[1]) ?? 0;
    const max = numLit(txt[2]) ?? 1;
    const step = numLit(txt[3]);
    out.push({ index: out.length, from, to, value: txt[0], num: num ?? NaN, min, max: max > min ? max : min + 1, step: step ?? null, call: enclosingCall(clean, callStart), label: labelAt(clean, callStart) });
  }
  // names: the method each slider feeds (`acidenv`, `dly` …), numbered when it repeats
  const seen = new Map();
  for (const s of out) {
    const base = (s.call && s.call !== 'slider' ? s.call : (s.label ? `${s.label} slider` : 'Slider')).slice(0, 32);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    s.name = n > 1 ? `${base} ${n}` : base;
  }
  // a name used more than once gets its first occurrence numbered too
  for (const [base, n] of seen) if (n > 1) { const first = out.find((s) => s.name === base); if (first) first.name = `${base} 1`; }
  for (const s of out) { delete s.call; delete s.label; }
  return out;
}

export const sliderKey = (ns, index) => `${ns}#${index}`;

/** Knob / mod-target definition of a slider. */
export function sliderDef(s) {
  const min = Number.isFinite(s?.min) ? s.min : 0;
  const max = Number.isFinite(s?.max) && s.max > min ? s.max : min + 1;
  const def = Number.isFinite(s?.num) ? Math.min(max, Math.max(min, s.num)) : min;
  return { key: `slider${s?.index ?? 0}`, label: s?.name || 'Slider', type: 'number', min, max, step: s?.step || 0, default: def, curve: 'lin' };
}

const normOf = (s) => {
  const d = sliderDef(s);
  return (d.default - d.min) / (d.max - d.min || 1);
};
const isDefaultName = (name, i) => !name || name === `Macro ${i + 1}`;
const sliderTarget = /^slider:(\d+)$/;

/** Macro index routed to slider k of the track (-1 when none). */
export function sliderMacroIndex(track, k) {
  const r = (track?.mod?.routes || []).find((x) => x.target === `slider:${k}` && String(x.src).startsWith('macro:') && x.enabled !== false);
  return r ? Number(String(r.src).slice(6)) : -1;
}

/**
 * Maps every slider() of a code track to a macro: a macro named after the slider (`acidenv`, `dly 2` …) whose 0..1
 * knob spans the slider's min..max, routed to the `slider:<k>` modulation target (amount 1 from 0 — the macro IS the
 * slider). The macro starts at the slider's value in the code; when that literal changes in the code later, the
 * macro follows it (an edited number in the code wins). Up to 8 macros per track; sliders without a free macro keep
 * their code value. Routes of sliders that no longer exist are removed. Mutates `track` (a store draft).
 * -> true when something changed.
 */
export function syncSliderMacros(track, opts = {}) {
  if (!track || track.type !== 'code') return false;
  const sliders = opts.sliders || parseSliders(track.code || '');
  const before = JSON.stringify(track.mod || null);
  if (!sliders.length && !track.mod?.routes?.some((r) => sliderTarget.test(r.target))) return false;
  if (!track.mod) track.mod = createModState();
  const mod = track.mod;
  mod.routes = mod.routes || [];
  // routes to sliders that are gone
  for (const r of [...mod.routes]) {
    const m = sliderTarget.exec(r.target);
    if (!m || Number(m[1]) < sliders.length) continue;
    mod.routes.splice(mod.routes.indexOf(r), 1);
    const i = String(r.src).startsWith('macro:') ? Number(String(r.src).slice(6)) : -1;
    const mac = mod.macros?.[i];
    if (mac?.slider && !mod.routes.some((x) => x.src === r.src)) {
      if (mac.name === mac.slider.name) mac.name = `Macro ${i + 1}`;
      delete mac.slider;
    }
  }
  const used = (i) => mod.routes.some((r) => r.src === `macro:${i}`) || !!mod.macros[i]?.slider;
  for (const s of sliders) {
    let i = sliderMacroIndex(track, s.index);
    if (i < 0) {
      i = mod.macros.findIndex((m, j) => !used(j) && isDefaultName(m.name, j));
      if (i < 0 || i >= MACRO_COUNT) continue; // no free macro: the slider keeps its code value
      mod.routes.push(createRoute(`macro:${i}`, `slider:${s.index}`, { amount: 1, min: 0 }));
    }
    const mac = mod.macros[i];
    const prev = mac.slider;
    if (!prev || prev.code !== s.value || prev.min !== s.min || prev.max !== s.max) mac.value = normOf(s);
    if (!prev || mac.name === prev.name || isDefaultName(mac.name, i)) mac.name = s.name.slice(0, 40);
    mac.slider = { index: s.index, name: s.name, code: s.value, min: s.min, max: s.max, ...(s.step != null ? { step: s.step } : {}) };
  }
  return JSON.stringify(track.mod) !== before;
}

/** The slider's value a 0..1 macro position stands for. */
export function sliderValueOf(s, norm) {
  const d = sliderDef(s);
  const v = d.min + (d.max - d.min) * Math.min(1, Math.max(0, Number(norm) || 0));
  return +v.toFixed(6);
}

/**
 * The code with each macro-mapped slider's first argument replaced by the macro's current value (rounded to the
 * slider's step, else 3 decimals) — "write the knobs back into the code".
 */
export function writeSliderValues(code, track) {
  const sliders = parseSliders(code);
  let out = String(code ?? '');
  for (const s of [...sliders].reverse()) {
    const i = sliderMacroIndex(track, s.index);
    if (i < 0) continue;
    const v = sliderValueOf(s, track.mod.macros[i].value);
    const dec = s.step ? Math.max(0, (String(s.step).split('.')[1] || '').length) : 3;
    out = out.slice(0, s.from) + String(+v.toFixed(dec)) + out.slice(s.to);
  }
  return out;
}
