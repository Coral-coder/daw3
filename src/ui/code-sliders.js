// The slider() controls of a code track as knobs (device panel "Live code" card). Each slider mapped to a macro
// (src/code/sliders.js) is that macro's knob: right-click -> automation lane / MIDI learn (the macro:<i> target),
// turning it moves the sound live without rewriting the code. "Write to code" puts the current values into the code.
import { h } from './dom.js';
import { knob, button, markAuto } from './components.js';
import { parseSliders, sliderMacroIndex, sliderValueOf, syncSliderMacros, writeSliderValues } from '../code/sliders.js';
import { editMod } from './mod-ui.js';

const NORM = { key: 'slider', label: 'Slider', type: 'number', min: 0, max: 1, default: 0, step: 0.001, curve: 'lin' };
const fmt = (v) => String(+Number(v).toFixed(Math.abs(v) >= 100 ? 0 : 3));

/** -> { el, update(track) } */
export function codeSliderList(app, trackId) {
  const el = h('div.code-sliders');
  let sig = '';
  let rows = [];
  const getTrack = () => app.store.get().tracks.find((t) => t.id === trackId);
  function build(t) {
    el.textContent = '';
    rows = [];
    const sliders = parseSliders(t.code || '');
    if (!sliders.length) return;
    const grid = h('div.code-sliders-row', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'flex-end' } });
    const unmapped = sliders.filter((s) => sliderMacroIndex(t, s.index) < 0);
    for (const s of sliders) {
      const i = sliderMacroIndex(t, s.index);
      const valEl = h('div.knob-value');
      const norm = i >= 0 ? t.mod.macros[i].value : (Number.isFinite(s.num) ? (s.num - s.min) / (s.max - s.min || 1) : 0);
      const k = knob({
        def: { ...NORM, label: s.name }, value: norm, size: 30, label: s.name, showValue: false,
        onChange: (v) => {
          valEl.textContent = fmt(sliderValueOf(s, v));
          if (i >= 0) editMod(app, trackId, `Slider ${s.name}`, (m) => { m.macros[i].value = v; }, { coalesce: true });
        },
      });
      if (i >= 0) markAuto(k, trackId, `macro:${i}`);
      else k.title = `${s.name}: no free macro (8 per track) — plays the value written in the code`;
      valEl.textContent = fmt(sliderValueOf(s, norm));
      k.appendChild(valEl);
      grid.appendChild(h('div.code-slider', { title: `slider(${s.value}, ${s.min}, ${s.max}) — ${i >= 0 ? `Macro ${i + 1}: right-click to automate or MIDI-learn` : 'not mapped'}` }, k));
      rows.push({ k, valEl, s, i });
    }
    el.append(
      h('div.dv-note', { style: { marginTop: '6px' } }, `Sliders (${sliders.length}) — knobs on this track’s macros: automate them on the arrangement, MIDI-learn with right-click.`),
      grid,
      h('div.row', { style: { marginTop: '4px' } },
        unmapped.length ? button('Map sliders to macros', () => app.store.transact('Map sliders to macros', (p) => { const tt = p.tracks.find((x) => x.id === trackId); if (tt) syncSliderMacros(tt); }), { cls: 'small', icon: 'plug' }) : null,
        button('Write values to code', () => {
          const tt = getTrack();
          if (!tt) return;
          const next = writeSliderValues(tt.code || '', tt);
          if (next !== tt.code) app.store.transact('Write slider values to code', (p) => { const x = p.tracks.find((y) => y.id === trackId); if (x) { x.code = next; syncSliderMacros(x); } });
        }, { cls: 'small', title: 'Put the knobs’ current values into the slider() calls of the code' })),
    );
  }
  return {
    el,
    update(t = getTrack()) {
      if (!t) return;
      const s = JSON.stringify([t.code, (t.mod?.routes || []).filter((r) => /^slider:/.test(r.target)).map((r) => [r.src, r.target]), (t.mod?.macros || []).map((m) => m.name)]);
      if (s !== sig) { sig = s; build(t); return; }
      for (const r of rows) {
        if (r.i < 0 || r.k.classList.contains('active')) continue;
        const v = t.mod.macros[r.i].value;
        r.k.setValue(v);
        r.valEl.textContent = fmt(sliderValueOf(r.s, v));
      }
    },
  };
}
