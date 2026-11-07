// Cadence & phrasing model for generated parts (pure, deterministic). See docs/GENERATION.md.
//
// The idea: a part is two clocks running at once — a SLOW harmonic clock (one pitch held for most of the bar, a
// short pickup into it, an anticipation at the end of every second bar, a 4-bar root cycle) and a FAST rhythmic
// clock (a 16-step cell that re-triggers whatever pitch the slow clock holds). Phrases are built as call -> answer:
// the second bar of a pair keeps the first half of the call and re-cuts its ending, the second 2-bar pair contrasts
// with the first, and the second 4 bars of an 8-bar phrase change only the very last gesture.
//
//   rollCells(rng)                  -> 4 bars of 16-step run lengths [A, A', B, B'] (call, answer, contrast, answer)
//   runsToSteps(runs)               -> [{step, len}] onsets of one bar
//   longToneLine(progression, ...)  -> (t) => pitch: the slow clock (held roots, pickups, anticipations)
//   rollingPart(progression, ...)   -> notes: the slow clock struck by the fast clock (layered-bass rhythm)
//   dyadPhrase(progression, ...)    -> per-segment 2-note chord shapes over a 4/8-bar phrase (answering ending)
//   gatedArp(shapes, ...)           -> notes: shapes arpeggiated by a per-step gate cell with rests, plus a
//                                      polymetric octave / fifth accent cycle
//   answerBars(notes, ...)          -> rhythmic call & response inside every 2-bar pair of a looping part
//   degreeShift(pitch, k, pcs)      -> pitch moved k scale steps (any scale size)
import { createNote } from '../core/model.js';
import { mod12, chordPitchClasses } from '../theory/index.js';

const EPS = 1e-6;
const r4 = (x) => Math.round(x * 10000) / 10000;
const vel = (v) => Math.round(Math.min(1, Math.max(0.05, v)) * 100) / 100;

/** pitch moved by k steps of the scale `pcs` (sorted or not); a non-scale pitch snaps down first. */
export function degreeShift(pitch, k, pcs) {
  const set = new Set(pcs.map(mod12));
  let p = Math.round(pitch);
  let guard = 0;
  while (!set.has(mod12(p)) && guard++ < 12) p--;
  const dir = k >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(k); i++) {
    p += dir;
    guard = 0;
    while (!set.has(mod12(p)) && guard++ < 12) p += dir;
  }
  return p;
}

/** The chord sounding at beat t (the last one when t is past the end). */
export function chordAt(progression, t) {
  return progression.find((c) => t >= c.startBeat - EPS && t < c.startBeat + c.durBeats - EPS) || progression[progression.length - 1];
}

/**
 * The scale as heard over chord `c`: the chord's tones replace any scale tone a semitone away from them (a borrowed
 * bVII in harmonic minor keeps its own 7th degree), so degree steps from the chord root land on its colours.
 */
export function chordScale(c, pcs) {
  const ct = c?.chord ? chordPitchClasses(c.chord.root, c.chord.type).map(mod12) : [];
  const near1 = (x) => ct.some((y) => mod12(x - y) === 1 || mod12(y - x) === 1);
  return [...new Set([...ct, ...pcs.map(mod12).filter((x) => ct.includes(x) || !near1(x))])].sort((a, b) => a - b);
}

/** Root (or slash bass) pitch class of a progression entry. */
const rootPc = (c) => mod12(c?.chord?.bass ?? c?.chord?.root ?? 0);
/** The pitch of pitch class pc nearest to `center`. */
const near = (pc, center) => { let p = center - 6; while (mod12(p) !== mod12(pc)) p++; return p; };

// ------------------------------------------------------------------------------------------- the fast clock
/**
 * Call cells: one bar of 16 steps as run lengths (each run = one onset held for `len` steps). Syncopated, mostly
 * 1–2 step runs with a longer run somewhere — a rolling bass that leans on the off-16ths, never a straight 8th pulse.
 */
const CALLS = [
  [2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 2],
  [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [3, 1, 2, 2, 1, 2, 1, 2, 2],
  [1, 2, 2, 1, 2, 1, 2, 2, 1, 2],
  [2, 2, 1, 1, 2, 2, 1, 1, 2, 2],
  [1, 1, 2, 1, 2, 2, 1, 2, 1, 1, 2],
];
/** Contrast cells for bars 3–4 of the cycle: a straighter gallop under the same harmony. */
const CONTRASTS = [
  [1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2],
  [2, 1, 2, 1, 2, 1, 2, 1, 2, 2],
  [1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1],
  [2, 1, 1, 2, 2, 1, 1, 2, 2, 2],
];

/** Keep the runs covering the first `keep` steps, re-cut the rest of the bar with `tail` runs (sum preserved). */
function recut(runs, keep, tail) {
  const head = [];
  let s = 0;
  for (const r of runs) { if (s + r > keep) break; head.push(r); s += r; }
  const rest = 16 - s;
  const out = [...head];
  let left = rest;
  for (const r of tail) { if (left <= 0) break; const x = Math.min(r, left); out.push(x); left -= x; }
  if (left > 0) out.push(left);
  return out;
}

/**
 * Four bars of the fast clock: [call, answer, contrast, answer]. The answers share the first half of their call and
 * end differently (busier into the bar line, so the pair sounds like question -> reply).
 */
export function rollCells(rng) {
  const a = CALLS[rng.int(0, CALLS.length - 1)];
  const b = CONTRASTS[rng.int(0, CONTRASTS.length - 1)];
  const tails = [[1, 2, 1, 1, 1, 1, 1], [2, 1, 1, 1, 1, 2], [1, 1, 2, 1, 1, 1, 1], [1, 2, 1, 2, 1, 1]];
  const ta = tails[rng.int(0, tails.length - 1)];
  const tb = tails[rng.int(0, tails.length - 1)];
  return [a, recut(a, 8, ta), b, recut(b, 10, tb)];
}

/** Run lengths -> [{step, len}]. */
export const runsToSteps = (runs) => { const out = []; let s = 0; for (const r of runs) { out.push({ step: s, len: r }); s += r; } return out; };

// ------------------------------------------------------------------------------------------- the slow clock
/**
 * The harmonic clock of a bass / pedal part: each bar holds its chord's root for most of the bar. Into a chord
 * change, the odd (answering) bar of a pair anticipates the next root on its last beat, the even (calling) bar
 * leans in with a one-step pickup from the next chord's fifth below; an odd bar that keeps its chord moves to the
 * fifth for its last beat instead (the reply inside the long note). -> (t) => MIDI pitch. opts: {bpb, length, center}
 */
export function longToneLine(progression, { bpb = 4, length, center = 38 }) {
  const steps = Math.round(bpb * 4);
  const bars = Math.ceil(length / bpb - EPS);
  const plan = []; // per bar: [{from step, pitch}]
  for (let b = 0; b < bars; b++) {
    const t0 = b * bpb;
    const c = chordAt(progression, t0 + 0.01);
    const endC = chordAt(progression, t0 + bpb - 0.01);
    const next = chordAt(progression, t0 + bpb + 0.01);
    const root = near(rootPc(c), center);
    const segs = [{ from: 0, pitch: root }];
    // chords changing inside the bar take over at their own beat
    for (const x of progression) {
      const st = Math.round((x.startBeat - t0) * 4);
      if (st > 0 && st < steps) segs.push({ from: st, pitch: near(rootPc(x), center) });
    }
    const last = segs.reduce((m, s2) => Math.max(m, s2.from), 0);
    const changes = b < bars - 1 && rootPc(next) !== rootPc(endC);
    if (b < bars - 1 && last <= steps - 4) {
      const nextRoot = near(rootPc(next), center);
      if (b % 2 === 1 && changes) segs.push({ from: steps - 4, pitch: nextRoot });
      else if (changes) segs.push({ from: steps - 1, pitch: nextRoot - 5 >= center - 9 ? nextRoot - 5 : nextRoot + 7 });
      else if (b % 2 === 1 && endC?.chord) segs.push({ from: steps - 4, pitch: near(mod12(rootPc(endC) + 7), center) });
    }
    segs.sort((x, y) => x.from - y.from);
    plan.push(segs);
  }
  return (t) => {
    const b = Math.min(plan.length - 1, Math.max(0, Math.floor(t / bpb + EPS)));
    const st = Math.round((t - b * bpb) * 4);
    let p = plan[b][0].pitch;
    for (const s of plan[b]) if (s.from <= st) p = s.pitch;
    return p;
  };
}

/**
 * Rolling layered-bass part: the slow clock struck by the 4-bar fast-clock cycle, each note clipped to 80 % of its
 * run (air between the strikes, room for the kick's duck). Accents on the off-8ths. opts: {bpb, length, rng, keyRoot,
 * pcs, center, cells?} -> notes (and .cells, the 4 bars of run lengths, for the layers that share the rhythm).
 */
export function rollingPart(progression, { bpb = 4, length, rng, keyRoot = 0, pcs, center = 38, cells = null, clip = 0.8 }) {
  const line = longToneLine(progression, { bpb, length, center });
  const cyc = cells || rollCells(rng);
  const out = [];
  const bars = Math.ceil(length / bpb - EPS);
  for (let b = 0; b < bars; b++) {
    for (const { step, len } of runsToSteps(cyc[b % 4])) {
      if (step >= bpb * 4) continue;
      const t = b * bpb + step / 4;
      if (t >= length - EPS) continue;
      const v = step % 4 === 2 ? 0.86 : step % 4 === 0 ? 0.74 : 0.68;
      out.push(createNote(line(t + 0.001), r4(t), r4(Math.min(length - t, (len / 4) * clip)), vel(v)));
    }
  }
  out.cells = cyc;
  return out;
}

// ------------------------------------------------------------------------------------------- chord shapes & gated arps
/**
 * Two-note chord shapes over a phrase: [{start, dur, lo, hi}] (MIDI). Each bar's shape stands on its chord's root
 * (or third), the interval wide (7th / octave / 10th); bars 2 and 4 of every 4 bars move to a narrower fifth for
 * their last beat (a short ending inside the long note), bar 4 splits its last beat into two moving shapes, and the
 * second 4 bars of an 8-bar phrase answer with a different final shape. opts: {bpb, length, pcs, center, rng}
 */
export function dyadPhrase(progression, { bpb = 4, length, pcs, center = 67, rng }) {
  const wide = [[0, 6], [0, 7], [2, 9], [0, 9]][rng.int(0, 3)];
  const alt = [[2, 7], [0, 7], [2, 9]][rng.int(0, 2)];
  const out = [];
  const bars = Math.ceil(length / bpb - EPS);
  const shape = (t, a, b) => {
    const c = chordAt(progression, t + 0.01);
    const cs = chordScale(c, pcs);
    const base = near(mod12(c?.chord?.root ?? 0), center - 5);
    return { lo: degreeShift(base, a, cs), hi: degreeShift(base, b, cs), pcs: cs };
  };
  for (let b = 0; b < bars; b++) {
    const t0 = b * bpb;
    const pos = b % 4;
    const second = Math.floor(b / 4) % 2 === 1;
    const main = pos === 2 ? alt : wide;
    const push = (a, d, iv) => { if (t0 + a < length - EPS) out.push({ start: t0 + a, dur: Math.min(d, length - t0 - a), ...shape(t0 + a, iv[0], iv[1]) }); };
    if (pos === 0 || pos === 2) push(0, bpb, main);
    else if (pos === 1) { push(0, bpb - 1, main); push(bpb - 1, 1, [0, 4]); }
    else {
      push(0, bpb - 2, [alt[0], alt[1] - 1]);
      push(bpb - 2, 1, [0, 4]);
      push(bpb - 1, 0.5, [2, 6]);
      push(bpb - 0.5, 0.5, second ? [2, 8] : [2, 7]);
    }
  }
  return out;
}

/**
 * Gate cells: 8 steps of [index, len] — index into the shape (0 = low note, 1 = high, 2 = low an octave up),
 * null = a rest. Each cell starts or breathes with a rest so the figure has an attack pattern, not a 16th stream.
 */
export const GATE_CELLS = [
  [[null, 1], [0, 1], [1, 2], [0, 1], [1, 1], [0, 1], [1, 1]],
  [[0, 1], [null, 1], [1, 1], [0, 1], [1, 2], [null, 1], [2, 1]],
  [[null, 1], [1, 1], [0, 1], [1, 1], [0, 2], [1, 1], [null, 1]],
  [[0, 1], [1, 1], [null, 1], [1, 1], [0, 1], [null, 1], [1, 2]],
  [[null, 1], [0, 1], [2, 1], [1, 1], [null, 1], [0, 1], [1, 2]],
];
/** Accent cycle: 6 segments per bar (polymetric against the 8-step gate) adding a scale fifth / octave. */
const ACCENTS = [[0, 0, 0, 4, 0, 7], [0, 0, 4, 0, 0, 7], [0, 7, 0, 0, 4, 0]];

/**
 * Arpeggiate chord shapes with a gate cell (16th grid), an answer cell on the second half of every 4th bar, and a
 * polymetric accent cycle (6 per bar: scale fifth / octave adds) that drifts against the 8-step gate. Notes are
 * legato to the next onset (the filter envelope, not the note length, shapes each step). opts: {bpb, length, rng,
 * pcs, vel} -> notes (with .gate = the main cell index, for tests / meta)
 */
export function gatedArp(shapes, { bpb = 4, length, rng, pcs, vel: v0 = 0.7 }) {
  const gi = rng.int(0, GATE_CELLS.length - 1);
  const cell = GATE_CELLS[gi];
  const answer = GATE_CELLS[(gi + 1 + rng.int(0, GATE_CELLS.length - 2)) % GATE_CELLS.length];
  const acc = ACCENTS[rng.int(0, ACCENTS.length - 1)];
  const steps = Math.round(bpb * 4);
  const hits = [];
  for (let b = 0; b * bpb < length - EPS; b++) {
    for (let half = 0; half * 8 < steps; half++) {
      const c = b % 4 === 3 && half === 1 ? answer : cell;
      let s = half * 8;
      for (const [idx, len] of c) {
        const t = b * bpb + s / 4;
        s += len;
        if (idx === null || s - len >= steps || t >= length - EPS) continue;
        const sh = shapes.find((x) => t >= x.start - EPS && t < x.start + x.dur - EPS) || shapes[shapes.length - 1];
        if (!sh) continue;
        let p = idx === 0 ? sh.lo : idx === 1 ? sh.hi : sh.lo + 12;
        const seg = Math.floor(((t - b * bpb) / bpb) * 6 + EPS);
        // (bars 2 and 4 of a phrase skip the fifth add: the shape's own ending speaks there)
        const add = acc[Math.min(5, seg)];
        if (add === 7 && p + 12 <= 86) p += 12;
        else if (add === 4 && b % 2 === 0) p = degreeShift(p, 4, sh.pcs || pcs);
        hits.push({ t, p, accent: idx === 1 || add > 0, end: sh.start + sh.dur });
      }
    }
  }
  const out = hits.map((h, i) => {
    // legato to the next onset, but never across the shape's end (a new chord)
    const next = Math.min(hits[i + 1] ? hits[i + 1].t : h.t + 0.5, h.end, length);
    return createNote(h.p, r4(h.t), r4(Math.max(0.1, (next - h.t) * 0.94)), vel(h.accent ? v0 + 0.12 : v0));
  });
  out.gate = gi;
  return out;
}

// ------------------------------------------------------------------------------------------- call & response pass
/**
 * Rhythmic call & response inside each 2-bar pair of a looping part (mutates and returns `notes`): when bar 2k+1
 * repeats bar 2k's rhythm exactly, its last beat is re-cut — a 16th pickup into the next bar (the next chord's root
 * when the chord changes, else the note it answers), and on every 4th bar the last note is pushed a 16th early
 * (an anticipation). Only where there is room (never on top of an existing onset, never on a beat).
 * opts: {bpb, length, progression, center?, strength 0..1}
 */
export function answerBars(notes, { bpb = 4, length, progression, strength = 1 }) {
  const bars = Math.floor(length / bpb + EPS);
  const barSig = (b) => notes.filter((n) => n.start >= b * bpb - EPS && n.start < (b + 1) * bpb - EPS).map((n) => Math.round((n.start - b * bpb) * 4)).join(',');
  let changed = 0;
  for (let b = 1; b < bars; b += 2) {
    if (barSig(b) !== barSig(b - 1) || !barSig(b)) continue;
    const inBar = notes.filter((n) => n.start >= b * bpb - EPS && n.start < (b + 1) * bpb - EPS).sort((x, y) => x.start - y.start);
    const last = inBar[inBar.length - 1];
    const end = (b + 1) * bpb;
    const pick = end - 0.25;
    if (last && strength > 0 && !inBar.some((n) => Math.abs(n.start - pick) < 0.05) && last.start < pick - 0.2) {
      const nextC = chordAt(progression, end + 0.01);
      let p = last.pitch;
      if (end < length - EPS && rootPc(nextC) !== mod12(last.pitch)) p = near(rootPc(nextC), last.pitch);
      if (last.start + last.dur > pick) last.dur = r4(Math.max(0.1, pick - last.start - 0.02));
      notes.push(createNote(p, r4(pick), 0.2, vel(last.vel * 0.92)));
      changed++;
    }
    if (b % 4 === 3 && strength >= 0.5 && last && last.start % 1 > 0.4 && last.start - 0.25 > b * bpb + 2) {
      const prev = inBar[inBar.length - 2];
      if (!prev || prev.start < last.start - 0.3) { last.start = r4(last.start - 0.25); last.dur = r4(last.dur + 0.25 > 0.5 ? 0.45 : last.dur + 0.2); changed++; }
    }
  }
  notes.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
  notes.answered = changed;
  return notes;
}
