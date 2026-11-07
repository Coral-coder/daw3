// Layering & cadence pass (src/gen/layering.js, src/gen/cadence.js): the trance recipe's layered structure and
// phrasing, the per-genre profiles staying idiomatic, and the Strudel export playing the sidechain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gen/index.js';
import { createRng } from '../src/core/util.js';
import { createProject } from '../src/core/model.js';
import { sectionLayers, layerProfile, LAYER_PROFILES } from '../src/gen/layering.js';
import { rollCells, runsToSteps, longToneLine, answerBars, dyadPhrase, gatedArp, GATE_CELLS } from '../src/gen/cadence.js';
import { songToCode, kickDuck } from '../src/code/song-code.js';
import { generateProgression } from '../src/gen/harmony.js';
import { resolveInstrumentDef } from '../src/audio/presets.js';
import { strudelPatchCode } from '../src/audio/strudel-patches.js';

const EPS = 1e-6;
const trance = G.generateSong({ genre: 'trance', seed: 1 });
const track = (s, pred) => s.tracks.find(pred);
const clipsOf = (s, t) => s.clips.filter((c) => c.trackId === t.id);
const notesAt = (s, t, start) => { const c = s.clips.find((x) => x.trackId === t.id && Math.abs(x.start - start) < EPS); return c ? s.patterns[c.patternId].notes : null; };
const bar = (notes, b, bpb = 4) => notes.filter((n) => n.start >= b * bpb - 0.05 && n.start < (b + 1) * bpb - 0.05);
const steps = (notes, b) => bar(notes, b).map((n) => Math.round((n.start - b * 4) * 4));

test('trance: layered structure — two-voice bass, shape arp, noise hats, clap layer, glitch, sidechain', () => {
  const s = trance;
  const bass = track(s, (t) => t.role === 'bass' && !t.layerOf);
  const layer = track(s, (t) => t.name === 'Bass Layer');
  const arp = track(s, (t) => t.role === 'arp');
  const drums = track(s, (t) => t.role === 'drums');
  assert.equal(bass.instrument.preset, 'sd-roll-bass');
  assert.ok(layer && layer.layerOf === bass.id && layer.instrument.preset === 'sd-bass-layer', 'a second bass voice with its own timbre');
  assert.equal(arp.instrument.preset, 'sd-gate-arp');
  for (const name of ['Noise Hats', 'Clap Layer', 'Glitch']) assert.ok(track(s, (t) => t.name === name), name);
  assert.ok(!s.tracks.some((t) => t.role === 'sub'), 'the two-voice bass replaces the separate sub');
  // the kick ducks the bass voices, the arp and the lead
  for (const t of [bass, layer, arp, track(s, (x) => x.role === 'lead' && !x.layerOf)]) {
    assert.ok(t.fx.some((f) => f.type === 'ducker' && f.params.sourceTrackId === drums.id), `${t.name} ducks under the kick`);
  }
  // per-part gain staging: the layers sit under their parts
  assert.ok(layer.volume < bass.volume, 'bass layer under the bass');
  const hats = track(s, (t) => t.name === 'Noise Hats');
  assert.ok(hats.volume < drums.volume && track(s, (t) => t.name === 'Glitch').volume < hats.volume);
  // complexity: the drops carry many distinct layers, the DJ intro stays sparse
  const L = sectionLayers(s);
  // one job per layer: 9–12 in the drops (like a hand-built track), fewer in breakdowns, a sparse DJ intro
  const at = L.map((x) => `${x.name}:${x.layers}`).join(' ');
  assert.ok(L.filter((x) => x.kind === 'main').every((x) => x.layers >= 9 && x.layers <= 12), at);
  assert.ok(L.filter((x) => x.kind === 'break').every((x) => x.layers <= 7), at);
  assert.ok(L[0].layers <= 3);
  // no doubles of the shape arp's job in the drops: no block chords / pad / counter / strings / vox
  const drop = s.sections.find((x) => x.kind === 'main');
  for (const role of ['chords', 'pad', 'counter', 'strings', 'vox', 'sub']) {
    const t = track(s, (x) => x.role === role && !x.layerOf);
    assert.ok(!t || !notesAt(s, t, drop.start), `${role} doubles the arp in the drop`);
  }
  // width & low end: random pan per arp note, wideners (mono below 250 Hz) on the lead / layer, high-passed layers
  assert.ok(resolveInstrumentDef(arp.instrument).params.panrand > 0);
  for (const t of [layer, track(s, (x) => x.role === 'lead' && !x.layerOf)]) {
    assert.ok(t.fx.some((f) => f.type === 'widener' && f.params.monoBelow >= 200), `${t.name} widened above the low end`);
    assert.ok(t.fx.some((f) => f.type === 'eq8' && f.params.b1On && f.params.b1Type === 'highpass' && f.params.b1Freq >= 250), `${t.name} high-passed`);
  }
});

test('trance: the bass layers share one rhythm; the bass is long tones struck by a call/answer 16-step cell', () => {
  const s = trance;
  const bass = track(s, (t) => t.role === 'bass' && !t.layerOf);
  const layer = track(s, (t) => t.name === 'Bass Layer');
  let shared = 0;
  for (const c of clipsOf(s, layer)) {
    const a = s.patterns[c.patternId].notes, b = notesAt(s, bass, c.start);
    assert.ok(b, 'the layer only plays with the bass');
    assert.deepEqual(a.map((n) => [n.start, n.dur]), b.map((n) => [n.start, n.dur]), 'same onsets and lengths');
    assert.ok(a.some((n, i) => n.pitch - b[i].pitch > 12), 'an interval above the octave');
    shared++;
  }
  assert.ok(shared >= 4);
  const drop = s.sections.find((x) => x.kind === 'main');
  const notes = notesAt(s, bass, drop.start);
  // harmonic rhythm: one pitch held through most of each bar
  for (let b = 0; b < 8; b++) {
    const ps = bar(notes, b).map((n) => n.pitch);
    const top = Math.max(...Object.values(ps.reduce((m, p) => ({ ...m, [p]: (m[p] || 0) + 1 }), {})));
    assert.ok(top / ps.length >= 0.6, `bar ${b}: ${ps}`);
  }
  // fast clock: 16th-based, syncopated, 4-bar cycle [call, answer, contrast, answer]; answers share the call's first half
  const st = [0, 1, 2, 3].map((b) => steps(notes, b));
  assert.ok(st.every((x) => x.length >= 5 && x.length < 16 && x.some((k) => k % 2 === 1)), JSON.stringify(st));
  // the kick owns the quarter notes: the bass rolls in between (no kick + bass stacking)
  assert.ok(st.every((x) => x.every((k) => k % 4 !== 0)), JSON.stringify(st));
  assert.notDeepEqual(st[0], st[1], 'the answer bar differs');
  assert.deepEqual(st[0].filter((k) => k < 8), st[1].filter((k) => k < 8), 'call and answer share the first half');
  assert.deepEqual(steps(notes, 4), st[0], 'the cycle returns after 4 bars');
});

test('trance: the arp is chord shapes through gate cells with rests and an octave / fifth accent cycle', () => {
  const s = trance;
  const arp = track(s, (t) => t.role === 'arp');
  const c = clipsOf(s, arp).find((x) => s.patterns[x.patternId].length >= 64);
  const notes = s.patterns[c.patternId].notes;
  for (let b = 0; b < 4; b++) {
    const st = steps(notes, b);
    assert.ok(st.length >= 8 && st.length <= 14, `bar ${b}: ${st.length} onsets (rests in the gate)`);
  }
  const ps = new Set(notes.map((n) => n.pitch));
  assert.ok(ps.size >= 5 && Math.max(...ps) - Math.min(...ps) >= 12, 'two-note shapes plus octave accents');
  // legato steps (the filter envelope shapes each step), never ringing across a bar line into the next chord
  assert.ok(notes.every((n) => (n.start % 4) + n.dur <= 4 + 0.01));
  // slow filter movement on the arp (a triangle LFO over many bars)
  const lane = arp.automation.find((l) => /:cutoff$/.test(l.target));
  assert.ok(lane && new Set(lane.points.map((p) => p.value)).size >= 6, 'filter LFO on the arp');
});

test('trance: noise hats — 16ths, decay moving on a triangle, swung off-16ths; they replace the kit closed hats', () => {
  const s = trance;
  const hats = track(s, (t) => t.name === 'Noise Hats');
  const drums = track(s, (t) => t.role === 'drums');
  const drop = s.sections.find((x) => x.kind === 'main');
  const ns = notesAt(s, hats, drop.start);
  assert.equal(bar(ns, 0).length, 16);
  const durs = bar(ns, 0).map((n) => n.dur);
  assert.ok(new Set(durs).size >= 3 && Math.max(...durs) > Math.min(...durs) * 1.8, `moving decay ${durs}`);
  const off = bar(ns, 0).filter((n, i) => i % 2 === 1);
  assert.ok(off.every((n) => (n.start * 4) % 1 > 0.05), 'off-16ths late (swing)');
  assert.ok(bar(ns, 0).filter((n, i) => i % 2 === 0).every((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) < 1e-6), 'on-16ths straight');
  assert.ok(!notesAt(s, drums, drop.start).some((n) => n.pitch === 42), 'no kit closed hats under the noise hats');
  // the clap layer sits on the kit's backbeat
  const clap = notesAt(s, track(s, (t) => t.name === 'Clap Layer'), drop.start);
  const kitClaps = new Set(notesAt(s, drums, drop.start).filter((n) => (n.pitch === 39 || n.pitch === 38) && Math.abs(n.start - Math.round(n.start)) < 0.03).map((n) => Math.round(n.start)));
  assert.ok(clap.filter((n) => n.start % 1 === 0).every((n) => kitClaps.has(n.start)));
  assert.ok(clap.some((n) => n.start % 1 !== 0), 'phrase-end flams');
});

test('trance: deterministic per seed, fast', () => {
  const sig = (x) => JSON.stringify(x.tracks.map((t) => [t.name, t.instrument.preset, t.volume]).concat(Object.values(x.patterns).map((p) => p.notes.map((n) => [n.pitch, n.start, n.dur, n.vel]))));
  const t0 = performance.now();
  const a = G.generateSong({ genre: 'trance', seed: 77 });
  assert.ok(performance.now() - t0 < 600);
  assert.equal(sig(a), sig(G.generateSong({ genre: 'trance', seed: 77 })));
  assert.notEqual(sig(a), sig(G.generateSong({ genre: 'trance', seed: 78 })));
});

test('profiles stay idiomatic: house claps, lo-fi crackle, ambient / jazz untouched by percussion layers', () => {
  const names = (genre) => G.generateSong({ genre, seed: 2 }).tracks.map((t) => t.name);
  const house = names('house');
  assert.ok(house.includes('Clap Layer') && !house.includes('Noise Hats') && !house.includes('Glitch') && !house.includes('Bass Layer'));
  const lofi = names('lofi-hip-hop');
  assert.ok(lofi.includes('Vinyl') && !lofi.some((n) => ['Noise Hats', 'Clap Layer', 'Glitch', 'Bass Layer'].includes(n)));
  for (const g of ['ambient', 'jazz', 'bossa-nova', 'folk']) {
    assert.ok(!names(g).some((n) => ['Noise Hats', 'Clap Layer', 'Glitch', 'Bass Layer', 'Vinyl'].includes(n)), g);
  }
  assert.ok(names('techno').includes('Noise Hats'));
  // every profile only names known parts
  for (const [id, p] of Object.entries(LAYER_PROFILES)) {
    assert.ok(G.GENRES[id], id);
    for (const k of Object.keys(p)) assert.ok(['bassRecipe', 'arpRecipe', 'bassLayer', 'hats', 'clap', 'glitch', 'crackle', 'filterLfo', 'duck', 'noSub', 'answerBass', 'thin', 'widen', 'hpf', 'avoidKick', 'levels', 'sends'].includes(k), `${id}.${k}`);
  }
  assert.deepEqual(layerProfile(G.GENRES.blues), {});
  // opts.layering === false / strudel === false: no strudel-only layers
  assert.ok(!G.generateSong({ genre: 'trance', seed: 1, layering: false }).tracks.some((t) => ['Bass Layer', 'Noise Hats'].includes(t.name)));
  assert.ok(G.generateSong({ genre: 'trance', seed: 1, strudel: false }).tracks.every((t) => t.instrument.type !== 'strudel'));
});

test('complexity: minimum distinct layers per section kind, every genre', () => {
  const DANCE = new Set(['house', 'techno', 'trance', 'garage', 'bass', 'dnb', 'breaks', 'hard', 'industrial']);
  for (const id of Object.keys(G.GENRES)) {
    const g = G.GENRES[id];
    const L = sectionLayers(G.generateSong({ genre: id, seed: 3 }));
    const mains = L.filter((x) => x.kind === 'main');
    const min = DANCE.has(g.family) ? (g.family === 'trance' ? 10 : 7) : 4;
    assert.ok(mains.length && mains.every((x) => x.layers >= min), `${id}: ${mains.map((x) => x.layers)}`);
    // builds / verses are fuller than intros
    const intro = L.find((x) => x.kind === 'intro');
    if (intro) assert.ok(Math.max(...mains.map((x) => x.layers)) > intro.layers, id);
  }
});

test('cadence: call/answer cells, long tones with anticipations, answers in looping basslines', () => {
  const rng = createRng(5);
  for (let i = 0; i < 20; i++) {
    const c = rollCells(rng);
    assert.equal(c.length, 4);
    for (const bar of c) assert.equal(bar.reduce((a, b) => a + b, 0), 16);
    const s0 = runsToSteps(c[0]).map((x) => x.step).filter((x) => x < 8);
    assert.deepEqual(runsToSteps(c[1]).map((x) => x.step).filter((x) => x < 8), s0);
  }
  const prog = generateProgression({ key: 9, scale: 'minor', bars: 4, beatsPerBar: 4, rng: createRng(1), progression: 'aeolian-loop' });
  const line = longToneLine(prog, { bpb: 4, length: 16, center: 40 });
  for (let b = 0; b < 4; b++) {
    const ps = Array.from({ length: 16 }, (_, k) => line(b * 4 + k / 4));
    assert.ok(ps.filter((p) => p === ps[0]).length >= 12, `bar ${b} holds its note: ${ps}`);
  }
  // a pulse that repeats bar after bar gets a pickup in every second bar
  const pulse = [];
  for (let b = 0; b < 4; b++) for (const t of [0.5, 1.5, 2.5, 3.5]) pulse.push({ pitch: 45, start: b * 4 + t, dur: 0.4, vel: 0.8 });
  const ans = answerBars(pulse, { bpb: 4, length: 16, progression: prog });
  assert.ok(ans.answered >= 2 && ans.some((n) => Math.abs(n.start - 7.75) < EPS));
  assert.ok(ans.filter((n) => n.start < 4).length === 4, 'the call bar is untouched');
  // gate cells: 8 steps each, a rest in every cell
  for (const c of GATE_CELLS) { assert.equal(c.reduce((a, [, l]) => a + l, 0), 8); assert.ok(c.some(([i]) => i === null)); }
  const shapes = dyadPhrase(prog, { bpb: 4, length: 16, pcs: [9, 11, 0, 2, 4, 5, 7], center: 67, rng: createRng(2) });
  assert.ok(shapes.every((x) => x.hi > x.lo));
  assert.ok(shapes.filter((x) => x.start >= 12).length >= 3, 'bar 4 moves (the phrase ending)');
  const arp = gatedArp(shapes, { bpb: 4, length: 16, rng: createRng(3), pcs: [9, 11, 0, 2, 4, 5, 7] });
  assert.ok(arp.length > 20 && arp.length < 64);
});

test('export: the Strudel code plays the sidechain (own orbits, the kick voice ducks them)', () => {
  const { code } = songToCode({ ...createProject(), ...trance }, { export: true });
  assert.match(code, /s\("[^"]*bd[^"]*"\)\.duck\("\d+(:\d+)*"\)\.duckdepth\(\.\d+\)\.duckattack\(\.\d+\)/);
  assert.match(code, /\.orbit\(2\)/);
  assert.match(strudelPatchCode(resolveInstrumentDef({ preset: 'sd-gate-arp' }).params), /\.pan\(rand\.range\(\.1, \.9\)\)$/, 'random pan per note in code');
  assert.doesNotMatch(code, /hh[^"`]*\)\.duck/, 'hats never duck');
  assert.equal(kickDuck('stack(\n  s("bd*4"),\n  s("~ cp")\n)', { orbits: [2, 3], depth: 0.6, attack: 0.15 }), 'stack(\n  s("bd*4").duck("2:3").duckdepth(.6).duckattack(.15),\n  s("~ cp")\n)');
  // the editable code view stays as it was (no orbits / duck: apply-back untouched)
  assert.doesNotMatch(songToCode({ ...createProject(), ...trance }).code, /\.duck\(/);
});
