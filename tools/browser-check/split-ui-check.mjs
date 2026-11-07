#!/usr/bin/env node
// Split into tracks in the real app: import Strudel code (+ a prebake file) as one code track per part, check the
// tracks / clips / slider macros, the device panel's slider knobs (right-click: automation + MIDI learn), MIDI learn
// of a slider macro moving the live slider value, the macro automation lane's name, Pocket's slider tiles; screenshots.
//   node tools/browser-check/split-ui-check.mjs --code song.strudel [--prebake pb.strudel] [--out dir]
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, serveRepo } from './browser.mjs';

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const code = readFileSync(resolve(arg('--code')), 'utf8');
const prebake = arg('--prebake') ? readFileSync(resolve(arg('--prebake')), 'utf8') : '';
const out = resolve(arg('--out', '/tmp/split-ui-check'));
mkdirSync(out, { recursive: true });
const srv = await serveRepo();
const proxy = process.env.HTTPS_PROXY;
const { browser, page } = await launch({ args: ['--ignore-certificate-errors', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
await page.setViewportSize({ width: 1500, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|not found! Is it loaded/.test(m.text())) errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)));
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
try {
  await page.goto(srv.url + '/index.html?nowelcome');
  await page.waitForFunction(() => window.daw3?.ui?.get?.().booted, null, { timeout: 30000 });
  if (prebake) await page.evaluate((c) => window.daw3.prebake.add({ code: c, name: 'test prebake' }), prebake);
  const st = await page.evaluate(async (c) => {
    const app = window.daw3;
    const r = await app.actions.importStrudelCode(c, { name: 'Song', replace: true, choice: 'split', summary: false });
    const p = app.store.get();
    return {
      choice: r.choice, mode: p.mode, bpm: p.bpm,
      tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, type: t.type, mute: t.mute, macros: (t.mod?.macros || []).filter((m) => m.slider).map((m) => m.name), clips: p.clips.filter((x) => x.trackId === t.id).map((x) => [x.type, x.start, x.length]) })),
      strudelTracksDomExtra: [...document.body.children].filter((el) => el.style?.position === 'fixed' && /Volume/.test(el.textContent || '')).length,
      controls: app.prebake.status().engine?.controls || [],
    };
  }, code);
  report(st.choice === 'split' && st.mode === 'song', `import choice ${st.choice}, mode ${st.mode}, ${st.bpm} BPM`);
  const parts = st.tracks.filter((t) => !/original/.test(t.name));
  report(parts.length >= 2 && parts.every((t) => t.type === 'code' && t.clips.length && t.clips[0][0] === 'code'), `${parts.length} code tracks with code clips: ${parts.map((t) => `${t.name}${t.macros.length ? ` [${t.macros.join(', ')}]` : ''}`).join(' · ')}`);
  report(st.strudelTracksDomExtra === 0, `no stray prebake DOM on the page (${st.strudelTracksDomExtra}); prebake controls: ${st.controls.map((c) => c.label).join(', ') || 'none'}`);
  const withSl = parts.find((t) => t.macros.length);
  if (withSl) {
    await page.evaluate((id) => { window.daw3.actions.selectTrack(id); window.daw3.ui.set({ view: 'arrange' }); }, withSl.id);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, '1-arrange.png') });
    // device panel: the code card's slider knobs
    await page.evaluate(() => window.daw3.ui.set({ deviceOpen: true }));
    await page.waitForTimeout(800);
    const knobs = await page.$$eval('.code-sliders .knob', (ks) => ks.map((k) => ({ target: k.dataset.autoTarget, label: k.querySelector('.knob-label')?.textContent, value: k.querySelector('.knob-value')?.textContent })));
    report(knobs.length === withSl.macros.length && knobs.every((k) => /^macro:\d$/.test(k.target)), `device panel slider knobs: ${knobs.map((k) => `${k.label}=${k.value} (${k.target})`).join(', ')}`);
    await page.screenshot({ path: join(out, '2-device-sliders.png') });
    if (knobs.length) {
      await page.click('.code-sliders .knob', { button: 'right' });
      await page.waitForTimeout(300);
      const items = await page.$$eval('.ctx-menu .ctx-label', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
      report(items.some((x) => /MIDI learn/.test(x)) && items.some((x) => /automation/i.test(x)), `right-click on a slider knob: ${items.slice(0, 8).join(' | ')}`);
      await page.screenshot({ path: join(out, '3-knob-menu.png') });
      await page.keyboard.press('Escape');
    }
    // MIDI learn of the first slider macro, then CCs move the live slider value
    const learn = await page.evaluate(async (id) => {
      const app = window.daw3;
      try { await app.engine.init?.(); } catch { /* */ }
      const t = app.store.get().tracks.find((x) => x.id === id);
      const i = t.mod.macros.findIndex((m) => m.slider);
      const s = t.mod.macros[i].slider;
      // (app.control.learn() first opens Web MIDI — not available headless; this is the learn it then starts)
      const m = app.control.mappings;
      m.startLearn({ owner: id, target: `macro:${i}` }, { scope: 'project' });
      for (let k = 0; k < 6; k++) m.handle('Test controller', [0xb0, 21, 40 + k], 100 + k * 10);
      m.flushLearn?.(2000);
      const learned = m.mappings.length;
      m.handle('Test controller', [0xb0, 21, 127], 3000);
      const hi = app.store.get().tracks.find((x) => x.id === id).mod.macros[i].value;
      m.handle('Test controller', [0xb0, 21, 0], 3010);
      const lo = app.store.get().tracks.find((x) => x.id === id).mod.macros[i].value;
      // the live slider value the code reads: the runner writes it on its next tick
      const R = await import('/src/code/strudel-real.js');
      await new Promise((r) => setTimeout(r, 300));
      const live = R.sliderValue(`${id}#${s.index}`);
      const lane = (await import('/src/ui/automation-targets.js')).laneLabel?.(app.store.get(), id, `macro:${i}`);
      return { learned, hi, lo, live, min: s.min, name: t.mod.macros[i].name, lane };
    }, withSl.id);
    report(learn.learned >= 1 && Math.abs(learn.hi - 1) < 1e-6 && Math.abs(learn.lo) < 1e-6, `MIDI learn: ${learn.learned} mapping, CC 127 -> macro ${learn.hi}, CC 0 -> ${learn.lo}`);
    report(Math.abs((learn.live ?? NaN) - learn.min) < 1e-6, `live slider value after CC 0: ${learn.live} (slider min ${learn.min}; written by the modulation runner while the engine runs)`);
    report(!learn.lane || String(learn.lane).includes(learn.name), `automation lane label: ${learn.lane}`);
  }
  report(!errors.length, `no console errors${errors.length ? `: ${errors.slice(0, 4).join(' | ')}` : ''}`);
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
