// `slider:<k>` modulation target (Node-safe): the k-th slider() of a code track (src/code/sliders.js).
//
//   sliderInfo(track, k)                      -> { def, value (the target's base: def.min), label, kind:'slider', slider } | null
//   sliderTargetValue(project, track, k, beat, opts) -> the slider value at song beat `beat`, or undefined when a route's
//                                               source can only be known at run time (envelope / follower: the
//                                               ModRunner's live value applies then)
//   makeSliderResolver(project, track, opts)  -> resolve(ns, k, cycle) for strudel-real.js withSliderContext()
//
// The scheduler queries a code track's pattern with makeSliderResolver() in effect, so every hap reads its slider at the
// hap's own time — macro knob, macro automation lane (song mode), LFO / step / random modulators — the same way in
// realtime playback and in an offline render (exact automation, independent of control-rate ticks). The base of the
// target is the slider's minimum and a macro route spans min..max (amount 1 from 0), so the macro IS the slider.
import { parseSliders, sliderDef } from '../../code/sliders.js';
import { routeOffset, combine, modulatorValue } from '../../core/modulation.js';
import { activeLanes, valueAt, fromNorm } from '../../core/automation.js';

const parsed = new Map(); // code -> parseSliders(code) (small LRU)
function slidersOf(code) {
  const k = String(code ?? '');
  let v = parsed.get(k);
  if (!v) {
    v = parseSliders(k);
    parsed.set(k, v);
    if (parsed.size > 64) parsed.delete(parsed.keys().next().value);
  }
  return v;
}

export function sliderInfo(track, k) {
  if (track?.type !== 'code') return null;
  const s = slidersOf(track.code)[k];
  if (!s) return null;
  const def = sliderDef(s);
  return { def, value: def.min, label: `Slider › ${s.name}`, kind: 'slider', slider: s };
}

const sliderRoutes = (track, k) => (track?.mod?.routes || []).filter((r) => r.enabled !== false && r.target === `slider:${k}`);

/** opts: { songAuto (automation lanes play), bpm } */
export function sliderTargetValue(project, track, k, beat, opts = {}) {
  const routes = sliderRoutes(track, k);
  if (!routes.length) return undefined;
  const info = sliderInfo(track, k);
  if (!info) return undefined;
  const mod = track.mod || {};
  const lanes = opts.songAuto ? activeLanes(track) : [];
  const bpm = opts.bpm || project?.bpm || 120;
  const offsets = [];
  for (const r of routes) {
    let v;
    const src = String(r.src);
    if (src.startsWith('macro:')) {
      const i = Number(src.slice(6));
      const lane = lanes.find((l) => l.target === src);
      v = lane ? valueAt(lane.points, beat) : mod.macros?.[i]?.value ?? 0;
    } else {
      const m = (mod.mods || []).find((x) => x.id === src);
      if (!m) continue;
      if (m.type === 'env' || m.type === 'follow') return undefined; // run-time state: the runner's value applies
      v = modulatorValue(m, { t: (beat * 60) / bpm, beat, bpm, noteT: null });
    }
    offsets.push(routeOffset(r, Math.max(0, Math.min(1, Number(v) || 0))));
  }
  return fromNorm(info.def, combine(0, offsets));
}

/**
 * resolve(ns, k, cycle) for a code track's query. beatOf(cycle) maps the code's cycle to the song beat it plays at
 * (clips move code time against song time).
 */
export function makeSliderResolver(project, track, { beatOf, songAuto = false, bpm } = {}) {
  if (!(track?.mod?.routes || []).some((r) => /^slider:\d+$/.test(r.target))) return null;
  const toBeat = beatOf || ((c) => c * 4);
  return {
    resolve(ns, k, cycle) {
      if (ns !== track.id) return undefined;
      return sliderTargetValue(project, track, k, toBeat(cycle), { songAuto, bpm });
    },
  };
}
