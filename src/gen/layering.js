// Layering & complexity pass for generated songs (pure, deterministic). See docs/GENERATION.md "Layering and cadence".
//
// generateSong writes the band (song.js) and the orchestra (orchestra.js); this pass adds what makes a club track
// sound produced rather than merely arranged, per genre profile:
//
//   recipes    — idiomatic rewrites of a core part inside the section loop (layeringPart): the trance rolling bass
//                (a slow harmonic clock struck by a 16-step call/answer cell, src/gen/cadence.js) and the trance
//                chord-shape arp (two-note shapes, gate cells with rests, a polymetric octave / fifth accent cycle)
//   bassLayer  — a second bass voice on the SAME rhythm (copied from the final bass notes), a fixed interval higher
//                with a slow additive interval cycle, its own timbre (noise-blended saw, echo, room, drive), ducked
//   hats       — noise hats: high-passed white noise 16ths whose decay moves on a triangle LFO, swung off-16ths, an
//                accent family; they replace the kit's closed hats where they play (the top-end budget is unchanged)
//   clap       — a noise clap layered on the kit's backbeat claps / snares, with an occasional flam (a double hit)
//   glitch     — a short FM blip on a looped half-bar random cell (re-rolled on 4-bar answers), high-passed
//   crackle    — vinyl crackle bed (lo-fi / trip-hop: their "texture" layer is the record, not a synth)
//   filterLfo  — slow triangle filter movement on a part across sections (not where other automation already rides)
//   duck       — extra sidechain targets (the lead / layers breathe with the kick)
//   answerBass — rhythmic call & response in looping basslines (cadence.js answerBars)
//
// Profiles keep each genre idiomatic: trance gets every layer, house a clap layer, filtered stabs and bass answers,
// techno noise hats and a light glitch, lo-fi only crackle and a wobbly chord filter, ambient a very slow pad
// filter — band / acoustic genres get nothing here (their phrasing lives in bass.js pickups and melody.js periods).
import { createRng, clamp, dbToGain } from '../core/util.js';
import { createTrack, createPattern, createClip, createNote, createEffect, TRACK_COLORS } from '../core/model.js';
import { keyPitchClasses, mod12, chordPitchClasses } from '../theory/index.js';
import { mixTrack } from './mix.js';
import { AutomationBuilder } from './arrange.js';
import { rollingPart, dyadPhrase, gatedArp, answerBars, chordAt } from './cadence.js';

/** The chord tone (pitch classes `pcs`) nearest to `p` (ties go up). */
const nearestChordTone = (p, pcs) => { for (let d = 0; d < 7; d++) { if (pcs.includes(mod12(p + d))) return p + d; if (pcs.includes(mod12(p - d))) return p - d; } return p; };

const EPS = 1e-6;
const r3 = (x) => Math.round(x * 1000) / 1000;
const hash = (...xs) => xs.reduce((h, x) => (Math.imul(h ^ (typeof x === 'number' ? x : [...String(x)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), 2654435761) >>> 0), 0x51ed270b);

// ------------------------------------------------------------------------------------------- profiles
const TRANCE = {
  bassRecipe: 'roll', arpRecipe: 'shape-gate',
  // an octave + fifth above the bass, a 5-per-bar additive cycle (third / octave) drifting over the 16-step rhythm
  bassLayer: { base: 7, adds: [0, 0, 2, 0, 4], preset: 'sd-bass-layer', db: -4.5 },
  hats: { swing: 0.12, decay: [0.05, 0.12], lfo: 4, db: -15, pan: -0.3 },
  clap: { flam: 0.12, db: -11 },
  glitch: { density: 0.45, db: -16, pan: 0.3 },
  filterLfo: [{ role: 'arp', lo: 1400, hi: 9000, bars: 20 }],
  duck: { lead: 0.35 },
  noSub: true,
  // one job per layer: the shape arp carries the harmony in grooves / drops (no block chords / pad there), the
  // two-voice bass replaces the sub, no counter / string / vox doubles; width from the arp's random pan, wideners
  // above 250 Hz on the lead and the bass layer; the layer and the lead leave the low end to the bass
  thin: { extras: ['sub', 'counter', 'strings', 'vox'] },
  widen: { lead: 1.15, layer: 1.35 },
  hpf: { lead: 250, layer: 150 },
  // the hook lead: the genre's supersaw, darker (acid-style envelope on a low cutoff) and fully spread
  leadTone: { lpf: 750, resonance: 3, lpenv: 2.8, lpattack: 0.004, lpdecay: 0.22, lpsustain: 0.3, lprelease: 0.15, detune: 0.25, spread: 0.7, room: 0.3, size: 5, gain: 0.75 },
  // the arp is the bed now: up front, into the ping-pong delay and the big room (stereo width from the returns)
  sends: { arp: [0.3, 0.32], lead: [0.28, 0.2] },
  avoidKick: true,
};
export const LAYER_PROFILES = {
  trance: TRANCE,
  'progressive-house': {
    bassLayer: { base: 0, adds: [0, 0, 0, 0, 4], preset: 'sd-bass-layer', db: -7 },
    hats: { swing: 0.08, decay: [0.04, 0.1], lfo: 2, db: -17, pan: -0.25 }, clap: { flam: 0.08, db: -12 },
    filterLfo: [{ role: 'arp', lo: 1600, hi: 8000, bars: 16 }], answerBass: 1,
  },
  psytrance: { hats: { swing: 0, decay: [0.03, 0.08], lfo: 2, db: -16, pan: -0.2 }, glitch: { density: 0.5, db: -15, pan: 0.35 }, filterLfo: [{ role: 'arp', lo: 1200, hi: 6000, bars: 8 }] },
  techno: { hats: { swing: 0.06, decay: [0.03, 0.1], lfo: 1, db: -17, pan: -0.2 }, glitch: { density: 0.25, db: -18, pan: 0.3 }, answerBass: 1 },
  minimal: { glitch: { density: 0.2, db: -18, pan: 0.25 }, answerBass: 0.5 },
  industrial: { hats: { swing: 0, decay: [0.02, 0.09], lfo: 2, db: -16, pan: -0.2 }, glitch: { density: 0.4, db: -16, pan: 0.3 } },
  house: { clap: { flam: 0.1, db: -12 }, answerBass: 1, filterLfo: [{ role: 'chords', lo: 900, hi: 6000, bars: 16 }] },
  'deep-house': { answerBass: 0.5, filterLfo: [{ role: 'chords', lo: 1200, hi: 7000, bars: 32 }] },
  'tech-house': { clap: { flam: 0.15, db: -12 }, glitch: { density: 0.2, db: -18, pan: 0.3 }, answerBass: 1 },
  'uk-garage': { clap: { flam: 0.1, db: -12 }, answerBass: 0.5 }, 'two-step': { clap: { flam: 0.1, db: -12 }, answerBass: 0.5 },
  trap: { clap: { flam: 0.04, db: -12 } }, drill: { clap: { flam: 0, db: -13 } }, phonk: { clap: { flam: 0, db: -12 } },
  'lofi-hip-hop': { crackle: { db: -24 }, filterLfo: [{ role: 'chords', lo: 1800, hi: 4500, bars: 8 }] },
  'boom-bap': { crackle: { db: -26 } }, 'trip-hop': { crackle: { db: -24 }, filterLfo: [{ role: 'pad', lo: 900, hi: 4000, bars: 16 }] },
  dubstep: { clap: { flam: 0, db: -12 } }, brostep: { clap: { flam: 0, db: -12 } },
  'future-bass': { filterLfo: [{ role: 'chords', lo: 1500, hi: 9000, bars: 8 }] },
  ambient: { filterLfo: [{ role: 'pad', lo: 900, hi: 5000, bars: 32 }] },
  downtempo: { filterLfo: [{ role: 'pad', lo: 1100, hi: 6000, bars: 16 }] }, chillwave: { filterLfo: [{ role: 'pad', lo: 1500, hi: 7000, bars: 16 }] },
  synthwave: { filterLfo: [{ role: 'arp', lo: 1500, hi: 7000, bars: 16 }], answerBass: 0.5 },
  eurobeat: { clap: { flam: 0.05, db: -12 }, answerBass: 0.5 },
  idm: { glitch: { density: 0.6, db: -15, pan: 0.3 } }, glitch: { glitch: { density: 0.7, db: -14, pan: 0.3 } },
  hardstyle: { clap: { flam: 0, db: -11 } },
  pop: { answerBass: 0.5 }, kpop: { answerBass: 0.5 },
};
/** The layering profile of a genre ({} = nothing added). */
export const layerProfile = (g) => LAYER_PROFILES[g?.id] || {};

/** Extra-role pruning (call after planExtras): a genre whose bass is two-voiced drops the separate sub. */
export function pruneExtras(g, extras, sections, opts = {}) {
  const p = layerProfile(g);
  if (!p.noSub || opts.strudel === false || opts.soundfonts === false || opts.layering === false) return extras;
  const drop = new Set(['sub', ...(p.thin?.extras || [])]);
  for (const s of sections) if (s.extra) s.extra = s.extra.filter((r) => !drop.has(r));
  return extras.filter((r) => !drop.has(r));
}

/**
 * Section roles under a thinning profile (call after planSections): in grooves and drops the shape arp takes the
 * harmony job, so block chords and the pad leave (they stay in breakdowns / builds, where the arp is not the bed);
 * an arp that sits out enters halfway (the section keeps evolving). Mutates `sections`.
 */
export function thinSections(g, sections, { available, opts = {} } = {}) {
  const p = layerProfile(g);
  if (!p.thin || p.arpRecipe !== 'shape-gate' || opts.layering === false || opts.strudel === false || opts.soundfonts === false) return sections;
  if (available && !available.has('arp')) return sections;
  for (const s of sections) {
    if (!(s.kind === 'main' || s.kind === 'verse')) continue;
    const has = s.roles.includes('arp') || (s.enter || []).includes('arp');
    if (!has && s.kind === 'verse') continue;
    s.roles = s.roles.filter((r) => r !== 'chords' && r !== 'pad');
    if (s.enter) s.enter = s.enter.filter((r) => r !== 'chords' && r !== 'pad');
    // the section still evolves: an arp that held back enters halfway (the drop opens on bass, lead and drums)
    if (!s.roles.includes('arp') && !(s.enter || []).includes('arp')) (s.enter ||= []).push('arp');
  }
  return sections;
}

// ------------------------------------------------------------------------------------------- recipes (core parts)
/**
 * Idiomatic rewrite of a core part for one section (null = keep the generator's part). Called by song.js before
 * the groove; recipe parts skip the anti-monotony guard (they are built from call / answer cells already).
 * ctx: {g, s, progression, bpb, length, rng, root, scale}
 */
export function layeringPart(role, ctx) {
  const p = layerProfile(ctx.g);
  const { s, progression, bpb, length, rng, root, scale } = ctx;
  if (!progression?.length || bpb !== 4) return null;
  const pcs = keyPitchClasses(root, scale);
  if (role === 'bass' && p.bassRecipe === 'roll') {
    const soft = s.kind === 'intro' || s.kind === 'outro';
    return rollingPart(progression, { bpb, length, rng, keyRoot: root, pcs, center: 40, clip: soft ? 0.6 : 0.8, avoidKick: !!p.avoidKick });
  }
  if (role === 'arp' && p.arpRecipe === 'shape-gate') {
    const shapes = dyadPhrase(progression, { bpb, length, pcs, center: 67, rng });
    return gatedArp(shapes, { bpb, length, rng, pcs, vel: 0.6 + s.energy * 0.15 });
  }
  return null;
}

/** Rhythmic answers for a generated bassline (song.js, non-recipe basses). */
export function answerBass(g, notes, { bpb, length, progression }) {
  const k = layerProfile(g).answerBass;
  if (!k || !progression?.length) return notes;
  return answerBars(notes, { bpb, length, progression, strength: k });
}

// ------------------------------------------------------------------------------------------- unpitched layer parts
/** Triangle 0..1 at phase x (cycles). */
const tri = (x) => { const f = x - Math.floor(x); return f < 0.5 ? f * 2 : 2 - f * 2; };

/**
 * Noise hats for a section: 16ths (8ths in the first half of a build), each note's length = a decay that moves on a
 * triangle LFO (`lfo` cycles per bar, between decay[0] and decay[1] seconds), off-16ths swung late by swing/4 of
 * a beat (Strudel's swingBy(swing, 8) on a one-bar cycle), accents on the off-8ths. -> notes (noise ignores the pitch: the key root, so key moves leave it alone)
 */
export function noiseHatPart(s, { bpb, bpm, hats, pitch = 72 }) {
  const len = s.bars * bpb;
  const steps = Math.round(bpb * 4);
  const soft = s.kind === 'intro' || s.kind === 'outro' || s.energy < 0.4;
  const [d0, d1] = hats.decay;
  const out = [];
  for (let i = 0; i < s.bars * steps; i++) {
    const t = i / 4;
    if (s.kind === 'build' && t < len / 2 && i % 2 === 1) continue;
    if (s.kind === 'build' && s.next?.kind === 'main' && t >= len - 0.5) continue;
    const st = i % steps;
    const sec = d0 + (d1 - d0) * tri((t / bpb) * (hats.lfo || 4));
    const dur = clamp((sec * bpm) / 60, 0.03, 0.24);
    const swing = st % 2 === 1 ? (hats.swing || 0) * 0.25 : 0;
    const accent = st % 4 === 2;
    const v = (accent ? 0.62 : st % 2 ? 0.42 : 0.5) * (soft ? 0.75 : 1) * (s.kind === 'build' ? 0.8 + 0.2 * (t / len) : 1);
    out.push(createNote(pitch, r3(t + swing), r3(dur), Math.round(v * 100) / 100));
  }
  return out;
}

/**
 * Noise clap on the kit's on-beat backbeats (claps / snares). The flam (a double hit a 32nd later) marks phrase
 * ends: the last backbeat of every 4th bar, and with a stronger `flam` also the first backbeat of every 8th bar.
 */
export function clapLayerPart(s, { bpb, kit, clap, pitch = 60 }) {
  const len = s.bars * bpb;
  const hits = [...new Set((kit || []).filter((n) => (n.pitch === 39 || n.pitch === 38) && Math.abs(n.start - Math.round(n.start)) < 0.03 && Math.round(n.start) % 2 === 1).map((n) => Math.round(n.start)))].sort((a, b) => a - b);
  const out = [];
  for (const t of hits) {
    if (t >= len - EPS) continue;
    out.push(createNote(pitch, t, 0.25, 0.8));
    const bar = Math.floor(t / bpb), pos = t - bar * bpb;
    const flam = clap.flam > 0 && ((bar % 4 === 3 && pos === bpb - 1) || (clap.flam >= 0.1 && bar % 8 === 7 && pos === 1));
    if (flam && t + 0.125 < len) out.push(createNote(pitch, r3(t + 0.125), 0.12, 0.55));
  }
  return out;
}

/** Glitch blips: a looped half-bar random cell (8 sixteenths), re-rolled on the second half of every 4th bar. */
export function glitchPart(s, { bpb, glitch, rng, pcs = [0, 2, 3, 5, 7, 8, 10] }) {
  const len = s.bars * bpb;
  const tones = [];
  for (let m = 60; m <= 96; m++) if (pcs.includes(mod12(m))) tones.push(m);
  const roll = () => {
    const c = Array.from({ length: 8 }, () => (rng.chance(glitch.density) ? { p: tones[rng.int(0, tones.length - 1)], v: 0.4 + rng.int(0, 30) / 100 } : null));
    // never an (almost) empty cell: at least two blips per half bar
    for (let k = 0; c.filter(Boolean).length < 2 && k < 16; k++) { const i = rng.int(0, 7); c[i] ||= { p: tones[rng.int(0, tones.length - 1)], v: 0.5 }; }
    return c;
  };
  const cell = roll();
  const answer = roll();
  const out = [];
  for (let i = 0; i * 0.25 < len - EPS; i++) {
    const bar = Math.floor(i / (bpb * 4));
    const half = Math.floor((i % (bpb * 4)) / 8);
    const c = bar % 4 === 3 && half === 1 ? answer : cell;
    const x = c[i % 8];
    if (!x) continue;
    out.push(createNote(x.p, r3(i * 0.25), 0.12, x.v));
  }
  return s.kind === 'build' && s.next?.kind === 'main' ? out.filter((n) => n.start < len - 0.5) : out;
}

// ------------------------------------------------------------------------------------------- the pass
const KIT_HATS = new Set([42, 44]);

/**
 * Add the profile's layers to a song being generated (mutates the passed collections, like addOrchestra).
 * ctx: {g, sections, progs, tracks, patterns, clips, sectionSlots, sectionNotes, patternHarmony, auto, buses,
 *       drumTrackId, ensureFilter, seed, bpb, bpm, root, scale, opts}
 * Returns {added: [track names], hatsRemoved, lfo: n lanes}.
 */
export function addLayering(ctx) {
  const { g, sections, tracks, patterns, clips, sectionSlots, sectionNotes, patternHarmony, auto, buses, seed, bpb, bpm, root, scale, opts = {} } = ctx;
  const p = layerProfile(g);
  const report = { added: [], hatsRemoved: 0, lfo: 0 };
  if (!Object.keys(p).length) return report;
  const strudelOk = opts.strudel !== false && opts.soundfonts !== false;
  const drums = tracks.find((t) => t.role === 'drums' && !t.layerOf);
  const bass = tracks.find((t) => t.role === 'bass' && !t.layerOf);
  const sidechain = !!drums && bass?.fx.some((f) => f.type === 'ducker');

  const newTrack = ({ name, role, preset, fallback, color, mixRole, db, pan = 0, layerOf = null, rev = 0, dly = 0 }) => {
    const instrument = strudelOk ? { type: 'strudel', preset, params: {}, fallbackPreset: fallback } : { type: 'synth', preset: fallback, params: {} };
    const t = createTrack({ name, color, role, instrument, sends: {} });
    if (mixRole) {
      mixTrack(t, { genre: g.id, role: mixRole, instrument, drumTrackId: drums?.id, buses });
      t.volume = r3(clamp(t.volume * dbToGain(db), 0.02, 1.5));
    } else {
      // unpitched percussion layers: a fixed level, a high-pass, small sends — no ducking, no kit compression
      t.volume = r3(clamp(0.8 * dbToGain(db), 0.02, 1.5));
      t.fx = [createEffect('eq8', { b1On: true, b1Type: 'highpass', b1Freq: 400, b1Q: 0.7 })];
      t.sends = {};
      if (buses[0] && rev > 0) t.sends[buses[0].id] = rev;
      if (buses[1] && dly > 0) t.sends[buses[1].id] = dly;
    }
    t.pan = pan;
    if (layerOf) t.layerOf = layerOf;
    tracks.push(t);
    auto.set(t.id, new AutomationBuilder());
    report.added.push(name);
    return t;
  };
  const place = (t, si, notes, { melodic = false } = {}) => {
    const s = sections[si];
    const len = s.bars * bpb;
    const clean = notes.filter((n) => n.start >= -EPS && n.start < len - EPS).map((n) => createNote(n.pitch, Math.max(0, n.start), Math.max(0.01, Math.min(n.dur, len - n.start)), n.vel));
    if (!clean.length) return false;
    const pat = createPattern(t.id, { name: `${t.name} – ${s.label}`, length: len, notes: clean, color: t.color });
    patterns[pat.id] = pat;
    if (melodic) {
      const src = Object.values(sectionSlots[si].slots).map((id) => patternHarmony[id]).find(Boolean);
      if (src) patternHarmony[pat.id] = src;
    }
    sectionSlots[si].slots[t.id] = pat.id;
    clips.push(createClip(t.id, { patternId: pat.id, start: s.start, length: len, name: s.label }));
    (sectionNotes[si] ||= {})[t.role] = clean;
    return true;
  };
  const prune = (t) => { if (!sectionSlots.some((x) => x.slots[t.id])) { tracks.splice(tracks.indexOf(t), 1); auto.delete(t.id); report.added.splice(report.added.indexOf(t.name), 1); } };

  // ---- the bass layer: same rhythm (the bass's final, grooved notes), an interval up, its own timbre
  if (p.bassLayer && bass) {
    const L = p.bassLayer;
    const t = newTrack({ name: 'Bass Layer', role: 'bass', preset: L.preset, fallback: 'saw-bass', color: bass.color, mixRole: 'bass', db: L.db, layerOf: bass.id });
    sections.forEach((s, si) => {
      const src = sectionNotes[si]?.bass;
      if (!src?.length || !sectionSlots[si].slots[bass.id]) return;
      if (s.kind === 'intro' && s.energy < 0.35) return;
      const mod = s.modulation || 0;
      const seg = bpb / L.adds.length;
      const notes = src.map((n) => {
        const c = chordAt(ctx.progs[si], n.start + 0.01);
        const croot = mod12((c?.chord?.root ?? 0) + mod);
        const pcs = c?.chord ? chordPitchClasses(croot, c.chord.type) : [croot];
        // on the chord root: the layer's interval (5th above the octave by default) plus the slow additive cycle,
        // always a chord tone; pickups / anticipations are doubled an octave up (they lead, the layer follows)
        let pitch = n.pitch + 12;
        if (mod12(n.pitch) === croot) {
          const k = L.adds[Math.min(L.adds.length - 1, Math.floor(((n.start % bpb) + EPS) / seg))];
          const iv = (L.base ?? 7) + (k === 2 ? -3 : k === 4 ? 5 : 0); // 5th -> (3rd | octave)
          const want = n.pitch + 12 + iv;
          pitch = nearestChordTone(want, pcs);
        }
        return { ...n, pitch, vel: Math.min(1, n.vel * 0.9) };
      });
      place(t, si, notes, { melodic: true });
    });
    prune(t);
  }

  if (strudelOk && drums) {
    // ---- noise hats (replace the kit's closed hats where they play)
    if (p.hats) {
      const t = newTrack({ name: 'Noise Hats', role: 'hats', preset: 'sd-noise-hat', fallback: 'noise-sweep', color: TRACK_COLORS[0], db: p.hats.db, pan: p.hats.pan ?? -0.3, rev: 0.05 });
      // the idea behind the notes, for the code views (src/code/livecoder.js writes it as Strudel signals)
      t.layerIdea = { kind: 'noise-hats', decay: [...p.hats.decay], lfo: p.hats.lfo || 4, swing: p.hats.swing || 0, hpf: 1200 };
      sections.forEach((s, si) => {
        const kitPid = sectionSlots[si].slots[drums.id];
        if (!kitPid || !s.roles.includes('drums')) return;
        if (!place(t, si, noiseHatPart(s, { bpb, bpm, hats: p.hats, pitch: 60 + mod12(root + (s.modulation || 0)) }))) return;
        const pat = patterns[kitPid];
        const before = pat.notes.length;
        pat.notes = pat.notes.filter((n) => !KIT_HATS.has(n.pitch));
        report.hatsRemoved += before - pat.notes.length;
        if (sectionNotes[si]?.drums) sectionNotes[si].drums = sectionNotes[si].drums.filter((n) => !KIT_HATS.has(n.pitch));
      });
      prune(t);
    }
    // ---- clap layer on the kit's backbeat
    if (p.clap) {
      const t = newTrack({ name: 'Clap Layer', role: 'clap', preset: 'sd-noise-clap', fallback: 'noise-sweep', color: TRACK_COLORS[0], db: p.clap.db, pan: 0, rev: 0.12 });
      t.layerIdea = { kind: 'clap-layer', flam: p.clap.flam };
      sections.forEach((s, si) => {
        const kitPid = sectionSlots[si].slots[drums.id];
        if (!kitPid || s.energy < 0.45) return;
        place(t, si, clapLayerPart(s, { bpb, kit: patterns[kitPid].notes, clap: p.clap, pitch: 60 + mod12(root + (s.modulation || 0)) }));
      });
      prune(t);
    }
    // ---- glitch blips in grooves and drops
    if (p.glitch) {
      const t = newTrack({ name: 'Glitch', role: 'glitch', preset: 'sd-glitch-blip', fallback: 'fm-zap', color: TRACK_COLORS[10], db: p.glitch.db, pan: p.glitch.pan ?? 0.3, rev: 0.08, dly: 0.12 });
      sections.forEach((s, si) => {
        if (!s.roles.includes('drums') || !(s.kind === 'main' || s.kind === 'verse' || s.kind === 'build') || s.energy < 0.55) return;
        place(t, si, glitchPart(s, { bpb, glitch: p.glitch, rng: createRng(hash(seed, s.type, s.bars, 'glitch')), pcs: keyPitchClasses(mod12(root + (s.modulation || 0)), scale) }));
      });
      prune(t);
    }
  }
  // ---- vinyl crackle bed under every section with harmony
  if (strudelOk && p.crackle) {
    const t = newTrack({ name: 'Vinyl', role: 'texture', preset: 'sd-crackle', fallback: 'vinyl-noise', color: TRACK_COLORS[8], db: p.crackle.db, pan: 0 });
    sections.forEach((s, si) => {
      if (!s.roles.some((r) => r !== 'drums' && r !== 'fx')) return;
      const notes = [];
      for (let b = 0; b < s.bars; b++) notes.push(createNote(60 + mod12(root + (s.modulation || 0)), b * bpb, bpb, 0.7));
      place(t, si, notes);
    });
    prune(t);
  }

  // ---- width & low end: wideners above the low end, high-passes so only the bass owns it, the recipe arp centred
  const lead = tracks.find((t) => t.role === 'lead' && !t.layerOf);
  const layerT = tracks.find((t) => t.name === 'Bass Layer');
  const arpT = tracks.find((t) => t.role === 'arp' && !t.layerOf);
  const hp = (t, hz) => { const eq = t?.fx.find((f) => f.type === 'eq8' && f.params.b1On && f.params.b1Type === 'highpass'); if (eq) eq.params.b1Freq = Math.max(eq.params.b1Freq, hz); else if (t) t.fx.unshift(createEffect('eq8', { b1On: true, b1Type: 'highpass', b1Freq: hz, b1Q: 0.75 })); };
  if (p.hpf?.lead) hp(lead, p.hpf.lead);
  if (p.hpf?.layer) hp(layerT, p.hpf.layer);
  for (const [t, w] of [[lead, p.widen?.lead], [layerT, p.widen?.layer]]) {
    if (!t || !w || t.fx.some((f) => f.type === 'widener')) continue;
    t.fx.push(createEffect('widener', { width: w, monoBelow: 250 }));
  }
  if (arpT && p.arpRecipe && arpT.instrument?.preset === 'sd-gate-arp') arpT.pan = 0;
  for (const [role, db] of Object.entries(p.levels || {})) for (const t of tracks.filter((x) => x.role === role && !x.layerOf)) t.volume = r3(clamp(t.volume * dbToGain(db), 0.02, 1.5));
  for (const [role, [rv, dl]] of Object.entries(p.sends || {})) {
    for (const t of tracks.filter((x) => x.role === role && !x.layerOf)) {
      if (buses[0]) t.sends[buses[0].id] = Math.max(t.sends[buses[0].id] || 0, rv);
      if (buses[1]) t.sends[buses[1].id] = Math.max(t.sends[buses[1].id] || 0, dl);
    }
  }

  // ---- extra sidechain targets
  if (sidechain && p.duck) {
    for (const [role, amount] of Object.entries(p.duck)) {
      for (const t of tracks.filter((x) => x.role === role)) {
        if (t.fx.some((f) => f.type === 'ducker')) continue;
        t.fx.push(createEffect('ducker', { sourceTrackId: drums.id, amount, threshold: -22, attack: 0.004, release: 0.16 }));
      }
    }
  }

  // ---- slow filter LFOs (a triangle in song time), only through sections no other automation rides
  for (const spec of p.filterLfo || []) {
    const t = tracks.find((x) => x.role === spec.role && !x.layerOf);
    if (!t || !ctx.ensureFilter) continue;
    const b = auto.get(t.id);
    const fx = ctx.ensureFilter(t);
    const target = `fx:${fx.id}:cutoff`;
    const taken = (b.map.get(target) || []).map((x) => x.beat);
    const period = spec.bars * bpb;
    const value = (x) => Math.round(spec.lo * (spec.hi / spec.lo) ** tri(x / period + 0.25));
    const build = (step) => {
      const pts = [];
      for (const s of sections) {
        const a = s.start, z = s.start + s.bars * bpb;
        const plays = s.roles.includes(spec.role) || (s.enter || []).includes(spec.role);
        if (!plays || s.kind === 'build' || taken.some((x) => x > a - 0.05 && x < z + 0.05)) continue;
        for (let x = a + 0.02; x < z - 0.03; x += step * bpb) pts.push({ beat: r3(x), value: value(x) });
        pts.push({ beat: r3(z - 0.03), value: value(z - 0.03) });
      }
      return pts;
    };
    let pts = build(2);
    if (pts.length > 60) pts = build(4);
    if (pts.length > 60) pts = build(8);
    if (pts.length >= 2) { b.add(target, pts); report.lfo++; }
  }
  return report;
}

/**
 * Distinct sounding layers per section of a generated song (tracks with notes in a clip that starts there; layers of
 * one part count once per track). -> [{name, kind, layers, roles}] — the complexity check used by the tests.
 */
export function sectionLayers(song) {
  const bpb = (song.timeSig?.[0] || 4) * (4 / (song.timeSig?.[1] || 4));
  return (song.sections || []).map((s) => {
    const a = s.start, z = s.start + s.bars * bpb;
    const ts = new Set();
    for (const c of song.clips) if (c.start >= a - EPS && c.start < z - EPS && song.patterns[c.patternId]?.notes.length) ts.add(c.trackId);
    const roles = [...ts].map((id) => song.tracks.find((t) => t.id === id)?.role).filter(Boolean);
    return { name: s.name, kind: s.kind, layers: ts.size, roles };
  });
}

/** The sound a recipe part plays (null: keep the genre's instrument). Strudel only (opts.strudel === false keeps the built-in sounds). */
export function recipeInstrument(role, g, opts = {}) {
  if (opts.strudel === false || opts.soundfonts === false) return null;
  const p = layerProfile(g);
  if (role === 'bass' && p.bassRecipe === 'roll') return { type: 'strudel', preset: 'sd-roll-bass', params: {}, fallbackPreset: 'saw-bass' };
  if (role === 'arp' && p.arpRecipe === 'shape-gate') return { type: 'strudel', preset: 'sd-gate-arp', params: {}, fallbackPreset: 'arp-saw' };
  if (role === 'lead' && p.leadTone) return { type: 'strudel', preset: 'sd-supersaw-lead', params: { ...p.leadTone }, fallbackPreset: 'supersaw-lead' };
  return null;
}
