// Strudel code -> one CODE track per part, each playing through Strudel / superdough exactly like the code itself
// ("Split into tracks", the default for Strudel imports and the Code view's "Render to tracks").
//
//   findParts(code)                       -> { parts: [{name, code, muted, kind, sound}], error? }   (needs loadStrudel())
//   faithfulSplitToProject(project, code, opts) -> summary   mutates `project` (call inside store.transact)
//   importStrudelFaithful(store, code, opts)    -> Promise<summary>   loads the engine + one undo step
//
// Every track's code is the whole program with only the OTHER parts taken out, so the shared preamble (setcpm,
// setScale, consts, helper functions, samples(), register(), …) and the project's prebakes (evaluated once in the
// same Strudel scope) apply to each part exactly as when the code runs as one: same functions, gain curve, defaults,
// effects, samples and sounds. What makes a part:
//   · each top-level labelled block (`$:`, `$NAME:`, `name:`; `_$:` muted blocks become muted tracks),
//   · otherwise the members of the code's single stack(…) (a member's siblings become `silence`, so methods applied
//     to the whole stack still apply to it),
//   · otherwise the top-level consts holding sound patterns that the final expression uses (the other parts' consts
//     become `silence` — works through arrange(), cat(), stack() …).
// Audio: each code track has its own superdough controller feeding its mixer strip (strudel-instrument.js); orbit
// sidechains (`.duck("3:4")`) reach the orbits of every code track, so ducking across parts still works. The parts
// add up to the code played as one (tools/browser-check/split-fidelity-check.mjs verifies it numerically).
// Arrangement: song mode, each part as clips of type 'code' (scheduler.js plays a code track only inside its clips):
// one clip per arrange() section the part plays in, else one clip over the piece. Every slider() becomes a macro on
// its track (src/code/sliders.js) — a knob, an automation lane and a MIDI-learnable control.
import { evaluate, queryEvents, loadStrudel } from './strudel.js';
import { strudelModules } from './strudel-real.js';
import { syncSliderMacros, parseSliders } from './sliders.js';
import { createTrack, createClip, createProject, beatsPerBar } from '../core/model.js';
import { uid } from '../core/util.js';

const COLORS = ['#ffa94d', '#38d9a9', '#ff5f6d', '#4dabf7', '#9775fa', '#ffd43b', '#f783ac', '#3bc9db', '#a9e34b', '#ced4da'];
const SOUND_CALL = /(^|[^\w$])(s|sound)\s*\(|\.(s|sound|bank)\s*\(|(^|[^\w$])(note|n|freq)\s*\(/;
const DRUMS = /^(bd|sd|hh|oh|ch|cp|rim|lt|mt|ht|cr|rd|cb|sh|perc|tb|cl|tbd|top|jcp|dsd|kick|snare|hats?|clap|white|noise|breaks?\d*|brk|.*_(bd|sd|hh|oh|cp))$/i;
const MAX_PERIOD = 32;

function parse(code) {
  const S = strudelModules();
  if (!S) throw new Error('Strudel engine not loaded');
  return S.acornParse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
}

/** Removes the given [start, end) ranges (with their line when it holds nothing else) and tidies blank lines. */
function cut(code, ranges) {
  let s = code;
  for (const [a0, b0] of [...ranges].sort((x, y) => y[0] - x[0])) {
    let a = a0, b = b0;
    const ls = s.lastIndexOf('\n', a - 1) + 1;
    if (!s.slice(ls, a).trim()) a = ls;
    const le = s.indexOf('\n', b);
    if (!s.slice(b, le < 0 ? s.length : le).trim()) b = le < 0 ? s.length : le + 1;
    s = s.slice(0, a) + s.slice(b);
  }
  return s.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}
/** Replaces [start, end) ranges with `text`. */
function replace(code, ranges, text) {
  let s = code;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) s = s.slice(0, a) + text + s.slice(b);
  return s;
}

/** The base call of a method chain: `stack(a, b).room(.2).gain(.8)` -> the stack(…) CallExpression. */
function chainBase(node) {
  let n = node;
  for (;;) {
    if (n?.type === 'CallExpression' && n.callee.type === 'MemberExpression') { n = n.callee.object; continue; }
    if (n?.type === 'MemberExpression') { n = n.object; continue; }
    return n;
  }
}
const isStack = (n) => n?.type === 'CallExpression' && n.callee.type === 'Identifier' && /^(stack|p)$/.test(n.callee.name) && n.arguments.length >= 2;

/** Name of a part from its code: first sound name (drums -> 'Drums'), else `Part n`. */
function soundName(body) {
  const snd = /(?:^|[.\s(])(?:s|sound)\(\s*["'`]\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
  const isNote = /(?:^|[^\w$])(?:note|n)\(/.test(body);
  if (!snd) return null;
  return DRUMS.test(snd) && !isNote ? snd : snd;
}
const pretty = (s) => String(s).replace(/^_+|_+$/g, '');

/** `// comment` on the line(s) right above `start` -> a short name, or ''. */
function commentAbove(code, start) {
  const ls = code.lastIndexOf('\n', start - 1) + 1;
  if (code.slice(ls, start).trim()) return '';
  const prev = code.lastIndexOf('\n', ls - 2) + 1;
  const line = code.slice(prev, Math.max(prev, ls - 1)).trim();
  const m = /^\/\/+\s*([A-Za-z][\w &'-]{1,30})\s*$/.exec(line);
  return m ? m[1].trim() : '';
}

function guessRole(body, name = '') {
  if (/bass/i.test(name)) return 'bass';
  const snd = /(?:^|[.\s(])(?:s|sound)\(\s*["'`]\s*([A-Za-z0-9_]+)/.exec(body)?.[1] || '';
  const melodic = /(?:^|[^\w$])(?:note|n|chord|voicing|arp)\(/.test(body);
  if (!melodic && DRUMS.test(snd)) return 'drums';
  if (/\bbass/i.test(body)) return 'bass';
  return melodic ? 'lead' : 'fx';
}

/**
 * The parts of the code (see the header). Each part's code runs on its own (the other parts removed / silenced).
 * -> { parts: [{name, code, muted, kind: 'label'|'member'|'const'|'whole', sound}], error? }
 */
export function findParts(code) {
  const src = String(code ?? '');
  let ast;
  try { ast = parse(src); } catch (e) { return { parts: [], error: e?.message || String(e) }; }
  const labels = ast.body.filter((n) => n.type === 'LabeledStatement');
  const used = new Map();
  const unique = (name) => {
    const k = used.get(name) || 0;
    used.set(name, k + 1);
    return k ? `${name} ${k + 1}` : name;
  };
  const parts = [];
  if (labels.length >= 2) {
    const anySolo = labels.some((l) => /^S(?=[$A-Za-z])/.test(l.label.name) && !/^_/.test(l.label.name));
    labels.forEach((l, i) => {
      const raw = l.label.name;
      const muted = /^_|_$/.test(raw) || (anySolo && !/^S(?=[$A-Za-z])/.test(raw));
      const others = labels.filter((x) => x !== l).map((x) => [x.start, x.end]);
      let partCode = cut(src, others);
      // the label plays inside its own track (the track's mute button carries a muted block's state)
      const clean = raw.replace(/^_+|_+$/g, '').replace(/^S(?=[$A-Za-z])/, '');
      if (clean !== raw) partCode = partCode.replace(new RegExp(`(^|\\n)(\\s*)${raw.replace(/\$/g, '\\$')}\\s*:`), `$1$2${clean}:`);
      const body = src.slice(l.body.start, l.body.end);
      const base = clean.replace(/^\$+/, '');
      const name = base && !/^\d+$/.test(base) ? pretty(base) : (commentAbove(src, l.start) || soundName(body) || `Part ${i + 1}`);
      parts.push({ name: unique(name), code: partCode, muted, kind: 'label', sound: soundName(body), role: guessRole(body, name), start: l.start, end: l.end });
    });
    return { parts };
  }
  // one part: a stack(…)'s members?
  const main = labels[0] || [...ast.body].reverse().find((n) => n.type === 'ExpressionStatement');
  if (!main) return { parts: [{ name: 'Strudel', code: src, muted: false, kind: 'whole', sound: null, role: guessRole(src) }] };
  const expr = main.type === 'LabeledStatement' ? (main.body.type === 'ExpressionStatement' ? main.body.expression : null) : main.expression;
  const base = expr && chainBase(expr);
  const consts = new Map(); // name -> declarator (sound patterns)
  for (const n of ast.body) {
    if (n.type !== 'VariableDeclaration') continue;
    for (const d of n.declarations) if (d.id?.type === 'Identifier' && d.init && SOUND_CALL.test(src.slice(d.init.start, d.init.end))) consts.set(d.id.name, d);
  }
  if (isStack(base)) {
    const args = base.arguments;
    args.forEach((a, i) => {
      const body = src.slice(a.start, a.end);
      const others = args.filter((x) => x !== a).map((x) => [x.start, x.end]);
      const name = (a.type === 'Identifier' ? a.name : '') || commentAbove(src, a.start) || soundName(body) || `Part ${i + 1}`;
      const role = guessRole(a.type === 'Identifier' && consts.has(a.name) ? src.slice(consts.get(a.name).init.start, consts.get(a.name).init.end) : body);
      parts.push({ name: unique(pretty(name)), code: replace(src, others, 'silence'), muted: false, kind: 'member', sound: soundName(body), role });
    });
    return { parts };
  }
  // consts holding sound patterns used by the final expression (arrange(), cat(), …)
  if (expr) {
    const refs = [];
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'Identifier' && consts.has(n.name) && !refs.includes(n.name)) refs.push(n.name);
      for (const k of Object.keys(n)) {
        if (k === 'property' && n.type === 'MemberExpression' && !n.computed) continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
      }
    };
    visit(expr);
    if (refs.length >= 2) {
      for (const name of refs) {
        const others = refs.filter((r) => r !== name).map((r) => [consts.get(r).init.start, consts.get(r).init.end]);
        const d = consts.get(name);
        const body = src.slice(d.init.start, d.init.end);
        parts.push({ name: unique(pretty(name)), code: replace(src, others, 'silence'), muted: false, kind: 'const', sound: soundName(body), role: guessRole(body) });
      }
      return { parts };
    }
  }
  const body = expr ? src.slice(expr.start, expr.end) : src;
  const nm = main.type === 'LabeledStatement' ? main.label.name.replace(/^[_$S]+|_+$/g, '') : '';
  return { parts: [{ name: nm || commentAbove(src, main.start) || soundName(body) || 'Strudel', code: src, muted: false, kind: 'whole', sound: soundName(body), role: guessRole(body) }] };
}

/** arrange([cycles, pat], …) sections (the longest call): [{name, start, cycles}] + total, or null. */
export function arrangeSections(code) {
  let ast;
  try { ast = parse(code); } catch { return null; }
  let best = null;
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'arrange') {
      const secs = [];
      let at = 0;
      for (const a of n.arguments) {
        const c = a.type === 'ArrayExpression' ? a.elements[0] : null;
        const cyc = c?.type === 'Literal' && typeof c.value === 'number' ? c.value : null;
        if (!(cyc > 0)) { secs.length = 0; break; }
        const le = code.indexOf('\n', a.start);
        const cm = /\/\/\s*(.+?)\s*$/.exec(code.slice(a.start, le < 0 ? code.length : le));
        secs.push({ name: cm ? cm[1].slice(0, 40) : `Section ${secs.length + 1}`, start: at, cycles: cyc });
        at += cyc;
      }
      if (secs.length && (!best || at > best.total)) best = { sections: secs, total: at };
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
    }
  };
  ast.body.forEach(visit);
  return best;
}

/** Onset signature of each cycle 0..n-1 of an evaluation (times within the cycle + sound + pitch). */
function cycleSignatures(res, n) {
  const sig = Array.from({ length: n }, () => []);
  let evs = [];
  try { evs = queryEvents(res, 0, n) || []; } catch { return null; }
  for (const e of evs) {
    const b = Number(e.begin);
    const c = Math.floor(b + 1e-9);
    if (c < 0 || c >= n) continue;
    const v = e.value || {};
    sig[c].push(`${(b - c).toFixed(4)}|${v.s ?? ''}|${v.note ?? v.n ?? v.freq ?? ''}`);
  }
  return sig.map((x) => x.sort().join(';'));
}

/** Smallest repeat period (cycles) of an evaluation, up to MAX_PERIOD; null when it doesn't repeat in range. */
export function patternPeriod(res) {
  const n = MAX_PERIOD * 2;
  const sig = cycleSignatures(res, n);
  if (!sig) return null;
  if (sig.every((s) => !s)) return 1;
  for (let p = 1; p <= MAX_PERIOD; p++) {
    let ok = true;
    for (let c = 0; c + p < n && ok; c++) if (sig[c] !== sig[c + p]) ok = false;
    if (ok) return p;
  }
  return null;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * Adds the split to `project` (opts.replace: a fresh song replaces the project's tracks / clips / markers, keeping
 * buses, master and samples). opts: { replace, original (code as pasted), prebake: [refs], minBars = 16, name }.
 * -> summary { mode: 'faithful', tracks: [{id, name, sliders, muted, role}], bars, bpm, sections, firstTrackId, notes }
 */
export function faithfulSplitToProject(project, code, opts = {}) {
  const { parts, error } = findParts(code);
  if (error) return { error };
  if (!parts.length) return { error: 'The code has no parts' };
  const whole = evaluate(code);
  if (whole.error) return { error: whole.error };
  const bpbOf = (p) => beatsPerBar(p);
  if (opts.replace) {
    const fresh = createProject();
    const keep = { buses: project.buses, master: project.master, samples: project.samples };
    for (const k of Object.keys(project)) if (!(k in keep) && k !== 'id') delete project[k];
    Object.assign(project, fresh, keep, { id: project.id, name: opts.name || 'Strudel song', tracks: [], patterns: {}, clips: [], markers: [] });
    for (const sc of project.scenes || []) sc.slots = {};
  }
  const bpb = bpbOf(project);
  if (whole.cps > 0 && (opts.replace || !project.tracks.length)) project.bpm = Math.round(whole.cps * 60 * bpb * 1000) / 1000;
  // length: arrange() sections, else the parts' common repeat period (at least minBars)
  const arr = arrangeSections(code);
  const notes = [];
  let cycles;
  const evals = parts.map((pt) => evaluate(pt.code));
  if (arr) cycles = arr.total;
  else {
    let l = 1;
    let open = false;
    for (const r of evals) {
      if (r.error) continue;
      const p = patternPeriod(r);
      if (!p) { open = true; continue; }
      l = (l * p) / gcd(l, p);
      if (l > MAX_PERIOD) { open = true; l = MAX_PERIOD; break; }
    }
    const minBars = opts.minBars ?? 16;
    cycles = Math.max(minBars, l);
    if (open) notes.push('Some parts never repeat exactly (random / slow signals): the clips cover the first ' + cycles + ' bars — drag their ends to make the song longer.');
  }
  const startIndex = project.tracks.length;
  const tracks = [];
  parts.forEach((pt, i) => {
    const t = createTrack({ type: 'code', name: pt.name.slice(0, 40), code: pt.code, role: pt.role || 'code', color: COLORS[(startIndex + i) % COLORS.length] });
    if (pt.muted) t.mute = true;
    syncSliderMacros(t);
    project.tracks.push(t);
    tracks.push(t);
    const r = evals[i];
    if (r.error) notes.push(`${t.name}: ${r.error}`);
    // clips: the arrange() sections this part plays in (adjacent ones merged), else the whole piece
    const spans = [];
    if (arr && !r.error) {
      for (const sec of arr.sections) {
        let n = 0;
        try { n = (queryEvents(r, sec.start, sec.start + sec.cycles) || []).length; } catch { n = 1; }
        if (!n) continue;
        const last = spans[spans.length - 1];
        if (last && last[1] === sec.start) last[1] = sec.start + sec.cycles; else spans.push([sec.start, sec.start + sec.cycles]);
      }
    }
    if (!spans.length) spans.push([0, cycles]);
    for (const [a, b] of spans) {
      const c = createClip(t.id, { type: 'code', start: a * bpb, length: (b - a) * bpb, offset: a * bpb, name: t.name });
      c.color = t.color;
      project.clips.push(c);
    }
  });
  if (arr && opts.replace) {
    project.markers = arr.sections.map((s) => ({ id: uid('mk'), beat: s.start * bpb, name: s.name }));
  }
  if (opts.muteTrackId) { const src = project.tracks.find((t) => t.id === opts.muteTrackId); if (src) src.mute = true; }
  // the code as one track (muted): A/B against the split, or play it live
  if (opts.keepOriginal !== false) {
    const orig = createTrack({ type: 'code', name: 'Strudel (original)', code, role: 'code', color: '#ced4da' });
    orig.mute = true;
    syncSliderMacros(orig);
    project.tracks.push(orig);
  }
  if (opts.replace || !project.tracks.some((t) => !tracks.includes(t) && t.type !== 'code')) project.mode = 'song';
  if (opts.replace) project.loop = { enabled: false, start: 0, end: cycles * bpb };
  if (opts.original && opts.original !== code) project.importedCode = { code, original: opts.original, repairs: opts.repairs || [] };
  if (opts.prebake?.length) {
    const cur = Array.isArray(project.prebake) ? project.prebake : [];
    const key = (r) => (r.url ? `u:${r.url}` : `c:${r.code}`);
    const have = new Set(cur.map(key));
    project.prebake = [...cur, ...opts.prebake.filter((r) => !have.has(key(r)))];
  }
  return {
    mode: 'faithful',
    tracks: tracks.map((t) => ({ id: t.id, name: t.name, muted: !!t.mute, role: t.role, sliders: parseSliders(t.code).length, macros: (t.mod?.macros || []).filter((m) => m.slider).map((m) => m.name) })),
    bars: (cycles * bpb) / bpb, bpm: project.bpm, sections: arr ? arr.sections.length : 1,
    firstTrackId: tracks[0]?.id || null, notes,
  };
}

/** Loads the engine, then adds the split in ONE undo step. -> summary ({ error } when the code can't be split). */
export async function importStrudelFaithful(store, code, opts = {}) {
  await loadStrudel();
  let summary;
  // (evaluate first: a broken program leaves the project untouched)
  const probe = evaluate(code);
  if (probe.error) return { error: probe.error };
  store.transact(opts.label || 'Import Strudel (split into tracks)', (p) => {
    summary = faithfulSplitToProject(p, code, opts); // (errors are found before the project is touched)
  });
  return summary;
}

/** One-paragraph report of a faithful split. */
export function faithfulSummaryText(s) {
  if (s.error) return `Could not split the code: ${s.error}`;
  const sl = s.tracks.reduce((n, t) => n + t.macros.length, 0);
  return `${s.tracks.length} track${s.tracks.length === 1 ? '' : 's'} (${s.tracks.map((t) => t.name).join(', ')}) · ${s.bars} bars at ${s.bpm} BPM`
    + ` · each plays its part of the code through Strudel (prebakes, effects and sounds as in the code)${sl ? ` · ${sl} slider${sl === 1 ? '' : 's'} → macro knobs` : ''}.`;
}
