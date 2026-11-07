#!/usr/bin/env node
// Offline render of a generated song in headless Chromium: master WAV + loudness / spectrum stats, and per-track
// stem loudness (gain staging check of the generator's mix).
//   node tools/browser-check/gen-render.mjs <genre> <seed> <out.wav> [startBar] [bars] [--stems]
import { writeFileSync } from 'node:fs';
import { launch, serveRepo } from './browser.mjs';

const [genre = 'trance', seedArg = '1', out = 'gen.wav', startArg, barsArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const stems = process.argv.includes('--stems');
const srv = await serveRepo();
const { browser, page } = await launch();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  const res = await page.evaluate(async ({ genre, seed, startBar, bars, stems }) => {
    const { generateSong } = await import('/src/gen/song.js');
    const { createProject } = await import('/src/core/model.js');
    const { renderOffline } = await import('/src/audio/render.js');
    const { measureLoudness } = await import('/src/audio/dsp/loudness.js');
    const { encodeWav } = await import('/src/audio/wav.js');
    const { truePeakDb } = await import('/src/audio/wav.js');
    const { loadStrudel } = await import('/src/code/strudel.js');
    await loadStrudel();
    const song = generateSong({ genre, seed });
    const p = { ...createProject(), ...song, mode: 'song' };
    const main = song.sections.find((s) => s.kind === 'main');
    const a = startBar != null ? startBar * 4 : Math.max(0, main.start - 8 * 4);
    const b = a + (bars ?? 24) * 4;
    const sr = 44100;
    const t0 = performance.now();
    const buf = await renderOffline(p, { mode: 'song', startBeat: a, endBeat: b, sampleRate: sr, tail: 1, stems });
    const master = stems ? buf.master : buf;
    const ch = [master.getChannelData(0), master.getChannelData(1)];
    const L = measureLoudness(ch, sr);
    // spectrum: energy share per band (4th-order band splits are enough for a balance read)
    const bands = [[20, 60], [60, 150], [150, 400], [400, 1000], [1000, 3000], [3000, 8000], [8000, 16000]];
    const bandShares = async (l, r) => {
      const mono = new Float32Array(l.length);
      for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (l[i] + r[i]);
      const e = [];
      for (const [lo, hi] of bands) {
        const c = new OfflineAudioContext(1, mono.length, sr);
        const src = c.createBufferSource();
        const bb = c.createBuffer(1, mono.length, sr); bb.copyToChannel(mono, 0); src.buffer = bb;
        let node = src;
        for (const [type, f] of [['highpass', lo], ['highpass', lo], ['lowpass', hi], ['lowpass', hi]]) { const q = c.createBiquadFilter(); q.type = type; q.frequency.value = f; q.Q.value = 0.707; node = node.connect(q); }
        node.connect(c.destination); src.start();
        const x = (await c.startRendering()).getChannelData(0);
        let s2 = 0; for (let i = 0; i < x.length; i++) s2 += x[i] * x[i];
        e.push(s2);
      }
      const t = e.reduce((a2, b2) => a2 + b2, 0) || 1;
      return e.map((v) => Math.round((1000 * v) / t) / 10);
    };
    const energy = await bandShares(ch[0], ch[1]);
    
    let side = 0, mid = 0;
    for (let i = 0; i < ch[0].length; i++) { const m = ch[0][i] + ch[1][i], s = ch[0][i] - ch[1][i]; mid += m * m; side += s * s; }
    const stemStats = {};
    if (stems) {
      for (const [id, sb] of Object.entries(buf)) {
        if (id === 'master') continue;
        const t = p.tracks.find((x) => x.id === id);
        const l = sb.getChannelData(0), r = sb.getChannelData(1);
        const lu = measureLoudness([l, r], sr);
        let sm = 0, ss = 0; for (let i = 0; i < l.length; i++) { sm += (l[i] + r[i]) ** 2; ss += (l[i] - r[i]) ** 2; }
        stemStats[t?.name || id] = { lufs: Math.round(lu.integrated * 10) / 10, side: Math.round((ss / (sm || 1)) * 1000) / 1000, bands: lu.integrated > -60 ? (await bandShares(l, r)).join(' / ') : null };
      }
    }
    const wav = encodeWav([ch[0], ch[1]], { sampleRate: sr, bitDepth: 16 });
    const bytes = new Uint8Array(wav instanceof ArrayBuffer ? wav : wav.buffer);
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return {
      wav: btoa(bin), ms: Math.round(performance.now() - t0), bars: (b - a) / 4, fromBar: a / 4, bpm: song.bpm, key: song.key,
      lufs: L.integrated, lra: L.lra, truePeak: truePeakDb(ch), bands: energy.join(' / '),
      sideRatio: side / (mid || 1), tracks: p.tracks.map((t) => t.name), stems: stemStats,
      sections: song.sections.filter((s) => s.start < b && s.start + s.bars * 4 > a).map((s) => s.name),
    };
  }, { genre, seed: Number(seedArg), startBar: startArg != null ? Number(startArg) : null, bars: barsArg != null ? Number(barsArg) : null, stems });
  writeFileSync(out, Buffer.from(res.wav, 'base64'));
  delete res.wav;
  console.log(JSON.stringify(res, null, 1));
  const bad = errors.filter((e) => !/favicon|404|Failed to load resource/.test(e));
  if (bad.length) console.log('console:', [...new Set(bad)].slice(0, 12).join('\n  '));
} finally { await browser.close(); srv.close(); }
