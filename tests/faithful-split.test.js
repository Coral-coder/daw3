// Faithful Strudel split (src/code/faithful-split.js), slider() controls as macros (src/code/sliders.js), the
// slider:<k> modulation target (src/audio/mod/slider-target.js) and code-track clips in the scheduler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as strudel from '../src/code/strudel.js';
import { setPrebake, prebakeStatus, sliderValue, setSliderValue } from '../src/code/strudel-real.js';
import { parseSliders, syncSliderMacros, sliderMacroIndex, sliderValueOf, writeSliderValues, sliderKey } from '../src/code/sliders.js';
import { findParts, faithfulSplitToProject, importStrudelFaithful, patternPeriod } from '../src/code/faithful-split.js';
import { sliderTargetValue, makeSliderResolver } from '../src/audio/mod/slider-target.js';
import { modTargetInfo, modTargets } from '../src/audio/mod/targets.js';
import { ModRunner } from '../src/audio/mod/runner.js';
import { createProject, createTrack, createClip } from '../src/core/model.js';
import { createAutomationLane } from '../src/core/automation.js';
import { createModulator, createRoute, normalizeMod } from '../src/core/modulation.js';
import { CodeCache, collectEvents } from '../src/audio/scheduler.js';
import { Store } from '../src/core/store.js';
import { MappingEngine } from '../src/control/mapping.js';
import { applyNorm, targetNorm } from '../src/control/targets.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (±${eps})`);
const ready = strudel.loadStrudel();

// a tiny prebake: a gain curve and a helper (the split's tracks must see both, like the code as one)
const PREBAKE = `setGainCurve(x => Math.pow(x, 2))
register('boost', (x, pat) => pat.gain(x).postgain(1.5))`;

const SONG = `setcpm(120/4)
const mel = "<0 2 4 5>"
$LEAD: n(mel).scale("c:minor").s("sawtooth").lpf(slider(800, 100, 4000)).boost(slider(0.5))
$KICK: s("bd*4").duck("2")
_$OFF: s("hh*8").gain(slider(0.3))
`;

test('parseSliders: transpiler offsets, ranges, names from the method they feed', () => {
  const code = 'n("0").lpf(slider(800, 100, 4000, 1)).gain(slider(.5)) // slider(9)\n.room("slider(1)").delay(slider(0.2).add(sine))';
  const s = parseSliders(code);
  assert.equal(s.length, 3); // not the one in the comment / string
  assert.deepEqual(s.map((x) => x.from), [code.indexOf('800'), code.indexOf('.5)'), code.indexOf('0.2')]);
  assert.deepEqual(s.map((x) => x.name), ['lpf', 'gain', 'delay']);
  assert.equal(s[0].min, 100); assert.equal(s[0].max, 4000); assert.equal(s[0].step, 1);
  assert.equal(s[1].min, 0); assert.equal(s[1].max, 1); near(s[1].num, 0.5);
  const dup = parseSliders('s("a").acidenv(slider(.1))\ns("b").acidenv(slider(.2))');
  assert.deepEqual(dup.map((x) => x.name), ['acidenv 1', 'acidenv 2']);
});

test('syncSliderMacros: one named macro per slider, routed to slider:<k>; code edits follow; removal frees it', () => {
  const t = createTrack({ type: 'code', code: 'n("0").lpf(slider(800, 100, 4000)).gain(slider(.5))' });
  assert.equal(syncSliderMacros(t), true);
  assert.equal(t.mod.macros[0].name, 'lpf');
  near(t.mod.macros[0].value, (800 - 100) / 3900);
  assert.equal(t.mod.macros[1].name, 'gain');
  assert.equal(sliderMacroIndex(t, 1), 1);
  assert.deepEqual(t.mod.routes.map((r) => [r.src, r.target, r.amount, r.min]), [['macro:0', 'slider:0', 1, 0], ['macro:1', 'slider:1', 1, 0]]);
  assert.equal(syncSliderMacros(t), false); // idempotent
  // the knob moved, the code unchanged: the knob keeps its value
  t.mod.macros[1].value = 0.9;
  syncSliderMacros(t);
  near(t.mod.macros[1].value, 0.9);
  // the number in the code edited: the macro follows the code
  t.code = 'n("0").lpf(slider(800, 100, 4000)).gain(slider(.25))';
  syncSliderMacros(t);
  near(t.mod.macros[1].value, 0.25);
  // a renamed macro keeps its name
  t.mod.macros[0].name = 'Cutoff';
  syncSliderMacros(t);
  assert.equal(t.mod.macros[0].name, 'Cutoff');
  // write back
  t.mod.macros[1].value = 0.75;
  assert.equal(writeSliderValues(t.code, t), 'n("0").lpf(slider(800, 100, 4000)).gain(slider(0.75))');
  // slider removed: route gone, macro free again
  t.code = 'n("0").lpf(slider(800, 100, 4000))';
  syncSliderMacros(t);
  assert.equal(t.mod.routes.length, 1);
  assert.equal(t.mod.macros[1].name, 'Macro 2');
  assert.equal(t.mod.macros[1].slider, undefined);
  // survives a save / load
  const back = normalizeMod(JSON.parse(JSON.stringify(t.mod)));
  assert.deepEqual(back.macros[0].slider, t.mod.macros[0].slider);
});

test('slider ids are namespaced per track: two tracks with a slider at the same offset never share a value', async () => {
  await ready;
  const code = 's("bd*2").gain(slider(0.5))';
  const a = strudel.evaluate(code, { sliderNs: 'trkA' });
  const b = strudel.evaluate(code, { sliderNs: 'trkB' });
  assert.equal(a.widgets[0].key, 'trkA#0');
  near(sliderValue(sliderKey('trkA', 0)), 0.5);
  setSliderValue(sliderKey('trkA', 0), 0.9);
  const ga = strudel.queryEvents(a, 0, 1).map((e) => e.value.gain);
  const gb = strudel.queryEvents(b, 0, 1).map((e) => e.value.gain);
  assert.deepEqual(ga, [0.9, 0.9]);
  assert.deepEqual(gb, [0.5, 0.5]);
  // a query context resolves the value per hap, at the hap's time
  const r = strudel.withSliderContext({ resolve: (ns, k, cycle) => (ns === 'trkB' ? cycle : undefined) }, () => strudel.queryEvents(b, 2, 3));
  assert.deepEqual(r.map((e) => e.value.gain), [2, 2.5]);
});

test('slider:<k> mod target: macro, macro automation lane at the hap time, LFO; ModRunner writes the live value', async () => {
  await ready;
  const p = createProject({ bpm: 120 });
  const t = createTrack({ type: 'code', code: 's("bd*4").lpf(slider(800, 100, 4000))' });
  syncSliderMacros(t);
  p.tracks.push(t);
  const info = modTargetInfo(p, t, 'slider:0');
  assert.equal(info.kind, 'slider');
  assert.equal(info.def.min, 100); assert.equal(info.def.max, 4000);
  assert.ok(modTargets(p, t).some((x) => x.target === 'slider:0' && x.label === 'lpf'));
  near(sliderTargetValue(p, t, 0, 0), 800);
  t.mod.macros[0].value = 1;
  near(sliderTargetValue(p, t, 0, 0), 4000);
  // automation of the macro: a ramp over 16 beats, read at each beat (song mode)
  t.automation.push(createAutomationLane('macro:0', [{ beat: 0, value: 0 }, { beat: 16, value: 1 }]));
  near(sliderTargetValue(p, t, 0, 8, { songAuto: true }), 100 + 3900 * 0.5);
  near(sliderTargetValue(p, t, 0, 8, { songAuto: false }), 4000); // pattern mode: the knob
  // an LFO routed on top
  const lfo = createModulator('lfo', { shape: 'saw', sync: true, div: '1/1' });
  t.mod.mods.push(lfo);
  t.mod.routes.push(createRoute(lfo.id, 'slider:0', { amount: -0.5 }));
  t.automation.length = 0;
  near(sliderTargetValue(p, t, 0, 2), 100 + 3900 * (1 - 0.5 * 0.5)); // saw at half a bar
  // the control-rate runner also writes the live value, for tracks with no other route too
  const graph = { ctx: { currentTime: 0, createConstantSource() { return { offset: { setTargetAtTime() {}, setValueAtTime() {}, cancelScheduledValues() {} }, connect() {}, start() {} }; } }, tracks: new Map([[t.id, { strip: { fxOv: new Map(), setFxMod() {} } }]]), setModInst() {} };
  t.mod.routes = t.mod.routes.filter((r) => r.src === 'macro:0');
  t.mod.macros[0].value = 0.5;
  new ModRunner(graph).tick(p, 0, { beat: 0, bpm: 120 });
  near(sliderValue(sliderKey(t.id, 0)), 100 + 3900 * 0.5);
});

test('scheduler: a code track reads its sliders per hap from the macro automation (exact, song mode)', async () => {
  await ready;
  const p = createProject({ bpm: 120 });
  p.mode = 'song';
  const t = createTrack({ type: 'code', code: 's("bd*4").gain(slider(0.5))' });
  syncSliderMacros(t);
  t.automation.push(createAutomationLane('macro:0', [{ beat: 0, value: 0 }, { beat: 16, value: 1 }]));
  p.tracks.push(t);
  const cache = new CodeCache();
  const evs = collectEvents(p, 0, 16, { mode: 'song', codeCache: cache });
  assert.equal(evs.length, 16);
  for (const e of evs) near(e.value.gain, e.beat / 16, 1e-6);
  // pattern mode: the knob value
  t.mod.macros[0].value = 0.25;
  for (const e of collectEvents(p, 0, 4, { mode: 'pattern', codeCache: cache })) near(e.value.gain, 0.25);
  // a resolver only answers for its own track's namespace
  const res = makeSliderResolver(p, t, { beatOf: (c) => c * 4 });
  assert.equal(res.resolve('other', 0, 1), undefined);
  near(res.resolve(t.id, 0, 0), 0.25);
});

test('scheduler: code clips gate a code track and move its code time (offset)', async () => {
  await ready;
  const p = createProject({ bpm: 120 });
  p.mode = 'song';
  const t = createTrack({ type: 'code', code: 'n("<0 1 2 3>").s("sine")' });
  p.tracks.push(t);
  const cache = new CodeCache();
  // no clips: plays everywhere (as before)
  assert.equal(collectEvents(p, 0, 16, { codeCache: cache }).length, 4);
  // a clip over bar 2 (beats 4..8) with code time = song time, a clip moved to bar 4 that plays bar 1 of the code
  p.clips.push(createClip(t.id, { type: 'code', start: 4, length: 4, offset: 4 }));
  p.clips.push(createClip(t.id, { type: 'code', start: 12, length: 4, offset: 0 }));
  const evs = collectEvents(p, 0, 16, { codeCache: cache });
  assert.deepEqual(evs.map((e) => [e.beat, e.value.n]), [[4, 1], [12, 0]]);
  assert.equal(evs[1].cycle, 0); // Strudel's own time inside the clip
  // pattern mode ignores clips
  assert.equal(collectEvents(p, 0, 16, { mode: 'pattern', codeCache: cache }).length, 4);
});

test('faithful split: one code track per part, the shared preamble and the prebake apply to each', async () => {
  await ready;
  setPrebake([{ id: 'test', name: 'test prebake', code: PREBAKE }]);
  try {
    assert.ok(prebakeStatus().sources[0].ok, JSON.stringify(prebakeStatus().sources));
    assert.ok(prebakeStatus().methods.includes('boost'));
    const { parts } = findParts(SONG);
    assert.deepEqual(parts.map((x) => [x.name, x.muted]), [['LEAD', false], ['KICK', false], ['OFF', true]]);
    for (const x of parts) {
      assert.match(x.code, /setcpm\(120\/4\)/);
      assert.match(x.code, /const mel/);
      assert.equal((x.code.match(/^\s*\$\w*:/gm) || []).length, 1, x.code);
    }
    assert.match(parts[2].code, /^\$OFF:/m); // un-muted inside its (muted) track
    const p = createProject();
    const s = faithfulSplitToProject(p, SONG, { replace: true, prebake: [{ name: 'pb', code: PREBAKE }] });
    assert.equal(s.error, undefined);
    assert.equal(p.mode, 'song');
    assert.equal(p.bpm, 120);
    const [lead, kick, off, orig] = p.tracks;
    assert.deepEqual(p.tracks.map((t) => [t.name, t.type, !!t.mute]), [['LEAD', 'code', false], ['KICK', 'code', false], ['OFF', 'code', true], ['Strudel (original)', 'code', true]]);
    assert.deepEqual(lead.mod.macros.slice(0, 2).map((m) => m.name), ['lpf', 'boost']);
    assert.equal(off.mod.macros[0].name, 'gain');
    assert.ok(p.prebake.some((r) => r.code === PREBAKE));
    // clips of type 'code' over the piece (16 bars minimum), code time = song time
    const clips = p.clips.filter((c) => c.trackId === lead.id);
    assert.deepEqual(clips.map((c) => [c.type, c.start, c.length, c.offset]), [['code', 0, 64, 0]]);
    // the parts' events add up to the code's own events (values from the prebake helper included)
    const cache = new CodeCache();
    const whole = createProject(); whole.mode = 'song';
    const wt = createTrack({ type: 'code', code: SONG }); syncSliderMacros(wt); whole.tracks.push(wt);
    const sig = (evs) => evs.map((e) => JSON.stringify([e.beat, e.value])).sort();
    const split = collectEvents(p, 0, 32, { codeCache: cache });
    const one = collectEvents(whole, 0, 32, { codeCache: cache });
    assert.ok(split.length > 20);
    assert.deepEqual(sig(split), sig(one));
    assert.ok(split.some((e) => e.value.postgain === 1.5 && e.value.gain === 0.5)); // boost(slider(0.5))
    // duck sources stay in time order across tracks (orbit creation order, see scheduler.js)
    for (let i = 1; i < split.length; i++) assert.ok(split[i].beat >= split[i - 1].beat - 1e-9);
    void kick; void orig;
  } finally { setPrebake([]); }
});

test('faithful split: stack members and sound consts become parts; arrange() sections become clips', async () => {
  await ready;
  const stackCode = 'stack(\n  // drums\n  s("bd*4"),\n  note("c3 e3").s("sawtooth")\n).room(.2)';
  const st = findParts(stackCode).parts;
  assert.deepEqual(st.map((x) => x.name), ['drums', 'sawtooth']);
  assert.match(st[0].code, /stack\(\n {2}\/\/ drums\n {2}s\("bd\*4"\),\n {2}silence\n\)\.room\(\.2\)/);
  const arr = 'const drums = s("bd*4")\nconst bass = note("c2*2").s("sawtooth")\narrange(\n  [2, drums], // intro\n  [2, stack(drums, bass)], // drop\n)';
  const ap = findParts(arr).parts;
  assert.deepEqual(ap.map((x) => x.name), ['drums', 'bass']);
  assert.match(ap[0].code, /const bass = silence/);
  const p = createProject();
  faithfulSplitToProject(p, arr, { replace: true, keepOriginal: false });
  const bass = p.tracks.find((t) => t.name === 'bass');
  const drums = p.tracks.find((t) => t.name === 'drums');
  assert.deepEqual(p.clips.filter((c) => c.trackId === bass.id).map((c) => [c.start, c.length, c.offset]), [[8, 8, 8]]);
  assert.deepEqual(p.clips.filter((c) => c.trackId === drums.id).map((c) => [c.start, c.length]), [[0, 16]]);
  assert.deepEqual(p.markers.map((m) => m.name), ['intro', 'drop']);
  assert.equal(patternPeriod(strudel.evaluate('s("<bd sd hh>")')), 3);
});

test('render to tracks routing: importStrudelFaithful adds the parts, mutes the source, one undo step', async () => {
  await ready;
  const p = createProject();
  const src = createTrack({ type: 'code', name: 'Code', code: SONG });
  p.tracks.push(src);
  const store = new Store(p);
  const before = store.undoStack.length;
  const s = await importStrudelFaithful(store, SONG, { replace: false, keepOriginal: false, muteTrackId: src.id, label: 'Render code to tracks' });
  assert.equal(s.error, undefined);
  const q = store.get();
  assert.deepEqual(q.tracks.map((t) => t.name), ['Code', 'LEAD', 'KICK', 'OFF']);
  assert.equal(q.tracks[0].mute, true);
  assert.equal(store.undoStack.length, before + 1);
  store.undo();
  assert.equal(store.get().tracks.length, 1);
  // broken code: nothing happens
  const bad = await importStrudelFaithful(store, '$: s("bd".', {});
  assert.ok(bad.error);
  assert.equal(store.get().tracks.length, 1);
});

test('MIDI learn on a slider macro: a CC moves the slider value the scheduler plays', async () => {
  await ready;
  const p = createProject();
  const t = createTrack({ type: 'code', code: 's("bd").lpf(slider(1000, 200, 5000))' });
  syncSliderMacros(t);
  p.tracks.push(t);
  const host = { getNorm: (tg) => targetNorm(p, tg.owner, tg.target), setNorm: (tg, n) => applyNorm(p, tg.owner, tg.target, n) };
  const eng = new MappingEngine(host);
  eng.startLearn({ owner: t.id, target: 'macro:0' });
  const cc = (v) => [0xb0, 74, v];
  for (let i = 0; i < 6; i++) eng.handle('Knobs', cc(20 + i), i * 10);
  assert.equal(eng.mappings.length, 1);
  eng.handle('Knobs', cc(127), 1000);
  near(t.mod.macros[0].value, 1);
  near(sliderTargetValue(p, t, 0, 0), 5000);
  eng.handle('Knobs', cc(0), 1010);
  near(sliderTargetValue(p, t, 0, 0), 200);
});
