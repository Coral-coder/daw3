#!/usr/bin/env node
// Split fidelity: does Strudel code split into tracks sound THE SAME as the code played as one?
//
//   node tools/browser-check/split-fidelity-check.mjs --code song.strudel [--prebake prebake.strudel] [--out dir]
//        [--bars 16] [--stems] [--pin] [--standins] [--variants ABCD] [--sweep]
//
// Renders through daW³'s normal offline export (src/audio/render.js, song mode, master chain included):
//   A  the code alone (no prebake) — one code track          B  the code with the prebake, one code track
//   C  the code split into tracks (src/code/faithful-split.js) D  the "editable instruments" conversion (reference)
// and writes A.wav … D.wav (+ B_<part>.wav / C_<part>.wav stems with --stems: B's stems silence the other parts with
// .postgain(0) so their sidechain ducking still happens; C's are daW³'s stem export) to --out. Then compares B and C:
// integrated LUFS, per-part RMS, 1/3-octave spectrum difference, onset alignment and a null test (residual of B − C).
//   --pin       pins Math.random (page + AudioWorklets) to a seeded PRNG, reset before every render — superdough's
//               noise / supersaw phases / reverb impulses are random, so without it two renders of the same code differ
//   --standins  aliases sample names neither strudel.cc's default maps nor the prebake provide to stand-in sounds
//               (so drums and the kick's sidechain are heard); the aliases are printed
//   --sweep     automation check: a ramp on the first slider macro of the first part with sliders; renders that part
//               with and without it and prints the spectral centroid per bar
// Samples are fetched from their hosts: pass the proxy via HTTPS_PROXY (used as Chromium's --proxy-server).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, serveRepo, repoRoot } from './browser.mjs';
import { measureLoudness } from '../../src/audio/dsp/loudness.js';

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const codePath = arg('--code');
if (!codePath) { console.error('usage: split-fidelity-check.mjs --code song.strudel [--prebake pb.strudel] [--out dir] [--bars 16] [--stems] [--pin] [--standins] [--sweep]'); process.exit(2); }
const code = readFileSync(resolve(codePath), 'utf8');
const prebake = arg('--prebake') ? readFileSync(resolve(arg('--prebake')), 'utf8') : '';
const out = resolve(arg('--out', '/tmp/split-fidelity'));
const BARS = Number(arg('--bars', 16));
const VARIANTS = arg('--variants', 'ABCD');
const SR = 44100;
mkdirSync(out, { recursive: true });

// stand-ins for sample names no default map provides (only with --standins)
const STANDINS = { tbd: 'RolandTR909_bd', top: 'RolandTR909_hh', jcp: 'RolandTR909_cp', dsd: 'RolandTR909_sd', jglitch: 'glitch' };

// ------------------------------------------------------------------------------------------------ browser side
const srv = await serveRepo();
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const { browser, page } = await launch({ args: ['--ignore-certificate-errors', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
const logs = new Map();
page.on('console', (m) => { const t = m.text().replace(/\s+at .*/s, '').slice(0, 160); if (/AudioContext was not allowed|core loaded/.test(t)) return; logs.set(t, (logs.get(t) || 0) + 1); });
page.on('pageerror', (e) => { const t = 'pageerror: ' + String(e.message).slice(0, 160); logs.set(t, (logs.get(t) || 0) + 1); });
const takeLogs = () => { const l = [...logs].map(([k, n]) => `${n}× ${k}`); logs.clear(); return l; };

const t0 = Date.now();
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  await page.evaluate(async ({ pin }) => {
    // seeded PRNG (mulberry32): page side, and in every AudioWorklet global scope before superdough's processors
    const PRNG = 'function __mk(s){let a=s>>>0;return function(){a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}';
    if (pin) {
      // eslint-disable-next-line no-new-func
      const mk = new Function(`${PRNG}; return __mk;`)();
      window.__reseed = (s) => { Math.random = mk(s); };
      window.__reseed(1);
      // buffers filled with random samples right after they are created (superdough's noise sources and reverb impulse
      // responses): reseeded from their size, so each gets the same content whatever else ran before it
      const cb = BaseAudioContext.prototype.createBuffer;
      BaseAudioContext.prototype.createBuffer = function (c, n, sr) { window.__reseed((c * 2654435761 + n * 40503 + sr) >>> 0); return cb.call(this, c, n, sr); };
      const url = URL.createObjectURL(new Blob([`${PRNG}; Math.random = __mk(7);
      // each processor gets its own PRNG, seeded from the render frame it first processes at and its first parameter
      // values (so the same note gets the same random phases whichever other nodes exist and in whatever order the
      // render thread processes parallel nodes); Math.random is that PRNG while it processes
      { const reg = registerProcessor;
        const hash = (a) => { let h = 2166136261; for (const x of a) { h = Math.imul(h ^ (x | 0), 16777619); h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); } return h >>> 0; };
        globalThis.registerProcessor = (name, cls) => reg(name, class extends cls {
          process(i, o, p) {
            if (!this.__r) { const v = [1]; for (const k of Object.keys(p || {}).sort()) v.push(Math.round((p[k][0] || 0) * 1000)); this.__r = __mk(hash(v)); }
            const m = Math.random; Math.random = this.__r; try { return super.process(i, o, p); } finally { Math.random = m; }
          }
        }); }
      registerProcessor('daw3-seed-' + Date.now(), class extends AudioWorkletProcessor { process() { return false; } });`], { type: 'text/javascript' }));
      const orig = AudioWorklet.prototype.addModule;
      const seeded = new WeakMap();
      AudioWorklet.prototype.addModule = function (u, o) {
        if (!seeded.has(this)) seeded.set(this, orig.call(this, url));
        return seeded.get(this).then(() => orig.call(this, u, o));
      };
    } else window.__reseed = () => {};
    const S = await import('/src/code/strudel.js');
    await S.loadStrudel();
    const R = await import('/src/code/strudel-real.js');
    await R.loadStrudelAudio();
    await R.strudelSoundsReady();
    // superdough's worklets load on an offline context once they worked on a realtime one (strudel-instrument.js)
    const { StrudelInstrument } = await import('/src/audio/strudel-instrument.js');
    const ac = new AudioContext();
    const wi = new StrudelInstrument(ac, ac.createGain());
    await wi.whenReady();
    window.__F = await import('/src/code/faithful-split.js');
    window.__SP = await import('/src/code/import-split.js');
    window.__M = await import('/src/core/model.js');
    window.__A = await import('/src/core/automation.js');
    window.__SL = await import('/src/code/sliders.js');
    window.__R = R;
    window.__render = (await import('/src/audio/render.js')).renderOffline;
    window.__bufs = {};
  }, { pin: flag('--pin') });

  const setPrebake = (code) => page.evaluate((c) => { window.__R.setPrebake(c ? [{ id: 'pb', name: 'prebake', code: c }] : []); return window.__R.prebakeStatus(); }, code);
  const standins = async () => {
    if (!flag('--standins')) return [];
    return page.evaluate(async (map) => {
      const sd = window.__R.strudelAudio().superdough;
      const done = [];
      const has = (n) => !!(sd.soundMap?.get?.()?.[n] || sd.getSound?.(n));
      if (!sd.soundAlias) return ['(superdough has no soundAlias)', Object.keys(sd).filter((k) => /sound/i.test(k)).join(',')];
      for (const [alias, orig] of Object.entries(map)) {
        if (has(alias)) continue; // provided after all
        if (!has(orig)) { done.push(`${alias}: ${orig} missing`); continue; }
        sd.soundAlias(orig, alias);
        done.push(`${alias} → ${orig}`);
      }
      return done;
    }, STANDINS);
  };
  /** Renders a project (built in the page by `build`, a function source) -> { key -> {frames} } stored in window.__bufs. */
  const render = (name, build, opts = {}) => page.evaluate(async ({ name, build, bars, sr, opts }) => {
    window.__reseed(1);
    const M = window.__M;
    const p = M.createProject({ bpm: 120 });
    // eslint-disable-next-line no-new-func
    const info = await new Function('p', 'M', 'F', 'SP', 'A', 'SL', `return (async () => { ${build} })();`)(p, M, window.__F, window.__SP, window.__A, window.__SL);
    const bpb = M.beatsPerBar(p);
    const t = performance.now();
    const res = await window.__render(p, { mode: 'song', startBeat: 0, endBeat: bars * bpb, sampleRate: sr, tail: 2, stems: !!opts.stems });
    const ms = performance.now() - t;
    const store = (key, buf) => { window.__bufs[key] = [buf.getChannelData(0), buf.getChannelData(1)]; return buf.length; };
    const keys = [];
    if (opts.stems) {
      store(name, res.master); keys.push(name);
      for (const tr of p.tracks) if (res[tr.id]) { const k = `${name}_${tr.name.replace(/[^\w-]+/g, '_')}`; store(k, res[tr.id]); keys.push(k); }
    } else { store(name, res); keys.push(name); }
    return { keys, ms, info, bpm: p.bpm, tracks: p.tracks.map((x) => ({ name: x.name, mute: x.mute, type: x.type })) };
  }, { name, build, bars: BARS, sr: SR, opts });
  const fetchBuf = async (key) => {
    const b64 = await page.evaluate((k) => {
      const [l, r] = window.__bufs[k];
      const inter = new Float32Array(l.length * 2);
      for (let i = 0; i < l.length; i++) { inter[2 * i] = l[i]; inter[2 * i + 1] = r[i]; }
      const u8 = new Uint8Array(inter.buffer);
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      delete window.__bufs[k];
      return btoa(s);
    }, key);
    const inter = new Float32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);
    const n = inter.length / 2;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }
    writeWav(join(out, `${key}.wav`), [L, R], SR);
    return [L, R];
  };

  const CODE = JSON.stringify(code);
  const single = `const t = M.createTrack({ type: 'code', name: 'Strudel', code: ${CODE} }); SL.syncSliderMacros(t); p.tracks.push(t); const r = (await import('/src/code/strudel.js')).evaluate(t.code); if (r.cps) p.bpm = r.cps * 60 * M.beatsPerBar(p); p.mode = 'song'; return { error: r.error, warnings: r.warnings };`;
  const report = {};
  const audio = {};

  // ---- A: no prebake
  if (VARIANTS.includes('A')) {
    await setPrebake('');
    const r = await render('A', single);
    audio.A = await fetchBuf('A');
    report.A = { ...r, logs: takeLogs() };
    console.log(`A (no prebake): ${r.ms.toFixed(0)} ms — evaluation: ${r.info.error || 'ok'}${r.info.warnings?.length ? ` · ${r.info.warnings.length} warnings: ${r.info.warnings.slice(0, 6).join(' | ')}` : ''}`);
    for (const l of report.A.logs.slice(0, 12)) console.log('    ' + l);
  }
  const pbStatus = await setPrebake(prebake);
  if (prebake) console.log(`prebake: ${pbStatus.names.length} names, errors: ${JSON.stringify(pbStatus.sources.map((s) => s.errors))}, controls: ${JSON.stringify(pbStatus.controls || [])}`);
  const alias = await standins();
  if (alias.length) console.log(`stand-ins (--standins): ${alias.join(', ')}`);

  // parts (for B's stems)
  const parts = await page.evaluate((c) => window.__F.findParts(c).parts.map((x) => ({ name: x.name, muted: x.muted })), code);
  console.log(`parts: ${parts.map((x) => x.name).join(', ')}`);

  // warm-up: loads every sample the code plays and builds superdough's cached noise buffers, so the measured renders
  // start from the same state (with --pin a buffer built in one render only would shift the PRNG of the next)
  for (let i = 0; i < 2; i++) {
    await render('warmup', single);
    await page.evaluate(() => { delete window.__bufs.warmup; });
  }
  takeLogs();

  // ---- B: with prebake, one code track
  if (VARIANTS.includes('B')) {
    const r = await render('B', single);
    audio.B = await fetchBuf('B');
    report.B = { ...r, logs: takeLogs() };
    console.log(`B (code + prebake): ${r.ms.toFixed(0)} ms — ${r.info.error || 'ok'} · bpm ${r.bpm}`);
    for (const l of report.B.logs.slice(0, 12)) console.log('    ' + l);
    if (flag('--stems')) {
      audio.Bstems = {};
      for (let i = 0; i < parts.length; i++) {
        // the code with every other part silenced by .postgain(0) at the end of its block (its sidechain still ducks)
        const build = `const S = (await import('/src/code/strudel-real.js')).strudelModules();
          const src = ${CODE}; const ast = S.acornParse(src, { ecmaVersion: 2022 });
          const labels = ast.body.filter((n) => n.type === 'LabeledStatement');
          let s = src; for (const [j, l] of [...labels.entries()].reverse()) if (j !== ${i}) { const e = l.body.type === 'ExpressionStatement' ? l.body.expression.end : l.end; s = s.slice(0, e) + '.postgain(0)' + s.slice(e); }
          const t = M.createTrack({ type: 'code', name: 'Strudel', code: s }); SL.syncSliderMacros(t); p.tracks.push(t); p.mode = 'song';
          const r = (await import('/src/code/strudel.js')).evaluate(s); if (r.cps) p.bpm = r.cps * 60 * M.beatsPerBar(p); return { error: r.error };`;
        const key = `B_${parts[i].name.replace(/[^\w-]+/g, '_')}`;
        await render(key, build);
        audio.Bstems[parts[i].name] = await fetchBuf(key);
        takeLogs();
      }
    }
  }

  // ---- B again: is a render of the code repeatable at all? (randomness that --pin does not reach shows here)
  if (VARIANTS.includes('R') && audio.B) {
    await render('B_repeat', single);
    const again = await fetchBuf('B_repeat');
    takeLogs();
    console.log(`B rendered twice: null ${nullTest(audio.B, again).toFixed(1)} dB (the floor any split can reach)`);
  }

  // ---- C: faithful split
  if (VARIANTS.includes('C')) {
    const r = await render('C', `const s = F.faithfulSplitToProject(p, ${CODE}, { replace: true, keepOriginal: false }); return { error: s.error, tracks: s.tracks?.map((t) => t.name + (t.macros.length ? ' [' + t.macros.join(', ') + ']' : '')), notes: s.notes };`, { stems: flag('--stems') });
    for (const k of r.keys) audio[k] = await fetchBuf(k);
    report.C = { ...r, logs: takeLogs() };
    console.log(`C (split into tracks): ${r.ms.toFixed(0)} ms — ${r.info.error || 'ok'} · tracks: ${(r.info.tracks || []).join(' · ')}`);
    for (const l of report.C.logs.slice(0, 12)) console.log('    ' + l);
  }

  // ---- D: editable instruments (reference)
  if (VARIANTS.includes('D')) {
    const r = await render('D', `const a = SP.analyzeStrudel(${CODE}, {}); if (a.error) return { error: a.error }; const s = SP.splitStrudelToProject(p, a, { replace: true }); return { tracks: s.tracks?.map((t) => t.name + ': ' + t.instrument) };`);
    audio.D = await fetchBuf('D');
    report.D = { ...r, logs: takeLogs() };
    console.log(`D (editable instruments): ${r.ms.toFixed(0)} ms — ${r.info.error || 'ok'} · ${(r.info.tracks || []).join(' · ')}`);
  }

  // ---- slider automation: ramp the first slider macro of the first part with sliders
  if (flag('--sweep')) {
    const build = (ramp) => `const s = F.faithfulSplitToProject(p, ${CODE}, { replace: true, keepOriginal: false });
      const t = p.tracks.find((x) => x.mod?.macros?.some((m) => m.slider));
      const i = t.mod.macros.findIndex((m) => m.slider);
      for (const o of p.tracks) if (o !== t) o.mute = true;
      ${ramp ? `t.automation.push(A.createAutomationLane('macro:' + i, [{ beat: 0, value: 0 }, { beat: ${BARS} * M.beatsPerBar(p), value: 1 }]));` : `t.mod.macros[i].value = 0;`}
      return { track: t.name, macro: t.mod.macros[i].name };`;
    const r0 = await render('SWEEP_flat', build(false));
    const flat = await fetchBuf('SWEEP_flat');
    const r1 = await render('SWEEP_ramp', build(true));
    const ramp = await fetchBuf('SWEEP_ramp');
    takeLogs();
    const bar = (60 / report.C?.bpm || 60 / 140) * 4;
    const barSec = 240 / (report.B?.bpm || report.C?.bpm || 140);
    const cf = centroids(flat[0], SR, barSec, BARS), cr = centroids(ramp[0], SR, barSec, BARS);
    console.log(`\nslider automation (${r1.info.track} › ${r1.info.macro}: lane 0 → 1 over ${BARS} bars; flat = macro at 0)`);
    console.log(`  spectral centroid per bar, flat: ${cf.map((x) => x.toFixed(0)).join(' ')}`);
    console.log(`  spectral centroid per bar, ramp: ${cr.map((x) => x.toFixed(0)).join(' ')}`);
    const rising = cr[cr.length - 1] > cr[0] * 1.5 && cr[cr.length - 1] > cf[cf.length - 1] * 1.5;
    console.log(`  ${rising ? 'PASS' : 'FAIL'} the sweep is in the render (last bar ${cr[cr.length - 1].toFixed(0)} Hz vs first ${cr[0].toFixed(0)} Hz; flat ${cf[cf.length - 1].toFixed(0)} Hz)`);
    void bar; void r0;
  }

  // ------------------------------------------------------------------------------------------------ comparison
  if (audio.B && audio.C) {
    console.log('\n=== B (code + prebake) vs C (split into tracks) ===');
    const lB = measureLoudness(audio.B, SR, { truePeak: false }), lC = measureLoudness(audio.C, SR, { truePeak: false });
    console.log(`integrated loudness: B ${lB.integrated.toFixed(2)} LUFS · C ${lC.integrated.toFixed(2)} LUFS · Δ ${(lC.integrated - lB.integrated).toFixed(2)} LU`);
    const lag = bestLag(audio.B[0], audio.C[0], 256);
    const nul = nullTest(audio.B, audio.C);
    console.log(`null test (B − C): residual ${nul.toFixed(1)} dB relative to B (best alignment lag ${lag} samples)`);
    const bands = bandDiff(audio.B, audio.C, SR);
    console.log(`1/3-octave spectrum difference (C − B): max |Δ| ${bands.max.toFixed(2)} dB, mean |Δ| ${bands.mean.toFixed(2)} dB over ${bands.n} bands (31 Hz–16 kHz)`);
    console.log(`  bands: ${bands.list.map((b) => `${b.f < 1000 ? b.f.toFixed(0) : (b.f / 1000).toFixed(1) + 'k'}:${b.d >= 0 ? '+' : ''}${b.d.toFixed(1)}`).join(' ')}`);
    const on = onsetMatch(audio.B, audio.C, SR);
    console.log(`onsets: B ${on.nb}, C ${on.nc}, matched within 5 ms: ${on.matched} (${(100 * on.matched / Math.max(1, on.nb)).toFixed(1)}%), mean |offset| ${on.meanMs.toFixed(2)} ms`);
    if (audio.Bstems) {
      console.log('per-part RMS (dBFS): part — B stem · C stem · Δ · null');
      for (const name of Object.keys(audio.Bstems)) {
        const ck = `C_${name.replace(/[^\w-]+/g, '_')}`;
        const b = audio.Bstems[name], c = audio[ck];
        if (!c) { console.log(`  ${name}: no C stem (muted / silent)`); continue; }
        const rb = rmsDb(b), rc = rmsDb(c);
        console.log(`  ${name.padEnd(10)} ${fmtDb(rb)} · ${fmtDb(rc)} · Δ ${Number.isFinite(rb) && Number.isFinite(rc) ? (rc - rb).toFixed(2) : '—'} dB · null ${Number.isFinite(rb) ? nullTest(b, c).toFixed(1) : '—'} dB`);
      }
    }
  }
  if (audio.D && audio.B) {
    const lB = measureLoudness(audio.B, SR, { truePeak: false }), lD = measureLoudness(audio.D, SR, { truePeak: false });
    const bands = bandDiff(audio.B, audio.D, SR);
    console.log(`\nD (editable instruments) vs B, for reference: Δ loudness ${(lD.integrated - lB.integrated).toFixed(2)} LU · null ${nullTest(audio.B, audio.D).toFixed(1)} dB · 1/3-octave max |Δ| ${bands.max.toFixed(1)} dB, mean ${bands.mean.toFixed(1)} dB`);
  }
  if (audio.A && audio.B) console.log(`A (no prebake) vs B: null ${nullTest(audio.B, audio.A).toFixed(1)} dB · Δ loudness ${(measureLoudness(audio.A, SR, { truePeak: false }).integrated - measureLoudness(audio.B, SR, { truePeak: false }).integrated).toFixed(2)} LU`);
  console.log(`\nWAVs in ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
} finally {
  await browser.close();
  srv.close();
}

// ------------------------------------------------------------------------------------------------ analysis
function writeWav(path, chans, sr) {
  const n = chans[0].length, nc = chans.length;
  const buf = Buffer.alloc(44 + n * nc * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * nc * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(nc, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * nc * 4, 28); buf.writeUInt16LE(nc * 4, 32); buf.writeUInt16LE(32, 34); buf.write('data', 36); buf.writeUInt32LE(n * nc * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { buf.writeFloatLE(chans[c][i], o); o += 4; }
  writeFileSync(path, buf);
}
function rms(ch) { let s = 0, n = 0; for (const c of ch) { for (let i = 0; i < c.length; i++) s += c[i] * c[i]; n += c.length; } return Math.sqrt(s / Math.max(1, n)); }
function rmsDb(ch) { const r = rms(ch); return r > 0 ? 20 * Math.log10(r) : -Infinity; }
function fmtDb(x) { return Number.isFinite(x) ? `${x.toFixed(2)} dBFS` : 'silent'; }
function nullTest(a, b) {
  const n = Math.min(a[0].length, b[0].length);
  let s = 0, r = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { const d = a[c][i] - b[c][i]; s += d * d; r += a[c][i] * a[c][i]; }
  return r > 0 ? 10 * Math.log10(s / r) : (s > 0 ? Infinity : -Infinity);
}
function bestLag(a, b, max) {
  let best = 0, bv = -Infinity;
  const n = Math.min(a.length, b.length, SR * 10);
  for (let lag = -max; lag <= max; lag += 1) {
    let s = 0;
    for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i += 7) s += a[i] * b[i + lag];
    if (s > bv) { bv = s; best = lag; }
  }
  return best;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function powerSpectrum(ch, sr, N = 8192) {
  const acc = new Float64Array(N / 2);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  for (const c of ch) for (let s = 0; s + N <= c.length; s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = c[s + i] * win[i];
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  }
  return { acc, df: sr / N };
}
function bandDiff(a, b, sr) {
  const A = powerSpectrum(a, sr), B = powerSpectrum(b, sr);
  const list = [];
  for (let i = -15; i <= 9; i++) {
    const f = 1000 * Math.pow(2, i / 3);
    const lo = f / Math.pow(2, 1 / 6), hi = f * Math.pow(2, 1 / 6);
    let ea = 0, eb = 0;
    for (let k = Math.max(1, Math.floor(lo / A.df)); k <= Math.min(A.acc.length - 1, Math.ceil(hi / A.df)); k++) { ea += A.acc[k]; eb += B.acc[k]; }
    if (ea <= 0 && eb <= 0) continue;
    list.push({ f, d: 10 * Math.log10((eb + 1e-20) / (ea + 1e-20)) });
  }
  const abs = list.map((x) => Math.abs(x.d));
  return { list, n: list.length, max: Math.max(...abs), mean: abs.reduce((s, x) => s + x, 0) / Math.max(1, abs.length) };
}
function onsets(ch, sr) {
  const hop = Math.round(sr * 0.002), win = hop * 4;
  const e = [];
  for (let s = 0; s + win < ch[0].length; s += hop) { let v = 0; for (let i = 0; i < win; i++) { const x = ch[0][s + i] + ch[1][s + i]; v += x * x; } e.push(Math.log10(1e-9 + v / win)); }
  const out = [];
  for (let i = 3; i < e.length - 1; i++) {
    const rise = e[i] - Math.min(e[i - 3], e[i - 2]);
    if (rise > 0.6 && e[i] > -5 && (!out.length || i - out[out.length - 1] > 12)) out.push(i);
  }
  return out.map((i) => (i * hop) / sr);
}
function onsetMatch(a, b, sr) {
  const oa = onsets(a, sr), ob = onsets(b, sr);
  let matched = 0, sum = 0, j = 0;
  for (const t of oa) {
    while (j < ob.length - 1 && ob[j + 1] <= t) j++;
    const cands = [ob[j], ob[j + 1]].filter((x) => x != null);
    const d = Math.min(...cands.map((x) => Math.abs(x - t)));
    if (d <= 0.005) { matched++; sum += d; }
  }
  return { nb: oa.length, nc: ob.length, matched, meanMs: matched ? (1000 * sum) / matched : 0 };
}
function centroids(ch, sr, barSec, bars) {
  const out = [];
  const N = 4096;
  for (let b = 0; b < bars; b++) {
    const s0 = Math.round(b * barSec * sr), s1 = Math.min(ch.length, Math.round((b + 1) * barSec * sr));
    let num = 0, den = 0;
    for (let s = s0; s + N <= s1; s += N) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = ch[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      fft(re, im);
      for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; num += p * k * (sr / N); den += p; }
    }
    out.push(den > 0 ? num / den : 0);
  }
  return out;
}
void repoRoot;
