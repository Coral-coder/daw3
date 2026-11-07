// Strudel patches for the generator's layering pass (src/gen/layering.js): two-voice basses, a gated chord-shape
// arp, and unpitched percussion built from superdough's noise sources (moving-decay hats, a noise clap that layers
// the kit's clap, an FM glitch blip, vinyl crackle). Same format as src/audio/strudel-patches.js.
//
// Sound design notes:
//  * roll bass — supersaw (5 voices, wide detune) through a nearly closed low-pass opened per note by a short,
//    303-style envelope (fast decay, low sustain, no resonance), driven a little: the rolling body of the bass.
//  * bass layer — a fully spread supersaw (unison detune at full stereo spread), a resonant envelope that opens
//    further, drive, a feedback echo and a large mostly-wet room: the same rhythm an interval higher, smeared
//    into a wide 150 Hz–1 kHz band.
//  * gate arp — saw + a little noise through a resonant envelope (the envelope, not the gate length, shapes each step),
//    a long feedback echo, a large room and a random pan per note: the chord-shape figure fills the stereo field
//    behind the lead, not on top of it.
//  * noise hat — high-passed white noise with no sustain; the generator varies each note's length, so the
//    audible decay moves (a slow triangle across the bar).
// Gains: set from stem loudness of offline renders (tools/browser-check/gen-render.mjs --stems) so that in a trance
// drop the hats / clap sit ~12 dB and the glitch ~18 dB under the kit (re-measure when the patches change).
const P = (id, name, role, roles, genres, patch, fallbackPreset) => ({ id, name, role, roles, genres, patch, fallbackPreset });

export const LAYER_STRUDEL_PATCHES = [
  P('sd-roll-bass', 'Rolling Supersaw Bass', 'bass', ['bass'], ['trance', 'progressive-house', 'psytrance'],
    { s: 'supersaw', unison: 5, detune: 0.55, spread: 0.7, lpf: 180, lpenv: 3.6, lpattack: 0.003, lpdecay: 0.12, lpsustain: 0.2, lprelease: 0.08,
      attack: 0.002, decay: 0.3, sustain: 0.8, release: 0.06, shape: 0.3, gain: 1.9 }, 'saw-bass'),
  P('sd-bass-layer', 'Noise Bass Layer', 'bass', ['bass'], ['trance', 'progressive-house', 'techno'],
    { s: 'supersaw', unison: 5, detune: 0.25, spread: 1, lpf: 260, resonance: 2, lpenv: 5, lpattack: 0.003, lpdecay: 0.12, lpsustain: 0.2, lprelease: 0.08,
      attack: 0.002, decay: 0.25, sustain: 0.7, release: 0.1, shape: 0.25, delay: 0.3, delaysync: 0.1875, delayfeedback: 0.35, room: 0.55, size: 4, gain: 1.1 }, 'saw-bass'),
  P('sd-gate-arp', 'Gated Shape Arp', 'arp', ['arp', 'lead'], ['trance', 'progressive-house', 'psytrance', 'eurobeat'],
    { s: 'sawtooth', noise: 0.2, lpf: 340, resonance: 2, lpenv: 2.6, lpattack: 0.003, lpdecay: 0.2, lpsustain: 0.2, lprelease: 0.1,
      attack: 0.002, decay: 0.3, sustain: 0.6, release: 0.12, panrand: 1, delay: 0.3, delaysync: 0.1875, delayfeedback: 0.55, room: 0.3, size: 5, gain: 1.34 }, 'arp-saw'),
  P('sd-noise-hat', 'Noise Hat', 'fx', ['fx'], ['trance', 'techno', 'psytrance', 'industrial', 'progressive-house'],
    { s: 'white', hpf: 1200, attack: 0.001, decay: 0.12, sustain: 0, release: 0.015, panrand: 1, gain: 1.5 }, 'noise-sweep'),
  P('sd-noise-clap', 'Noise Clap Layer', 'fx', ['fx'], ['house', 'trance', 'techno', 'garage', 'trap', 'dubstep', 'hardstyle'],
    { s: 'white', lpf: 6500, hpf: 900, attack: 0.002, decay: 0.16, sustain: 0, release: 0.05, room: 0.25, size: 2, gain: 1.4 }, 'noise-sweep'),
  P('sd-glitch-blip', 'FM Glitch Blip', 'fx', ['fx'], ['trance', 'techno', 'idm', 'glitch', 'psytrance', 'minimal', 'industrial'],
    { s: 'square', fm: 5, fmh: 2.71, fmattack: 0.001, fmdecay: 0.04, fmsustain: 0, hpf: 500, attack: 0.001, decay: 0.05, sustain: 0, release: 0.02, crush: 7, gain: 0.9 }, 'fm-zap'),
  P('sd-crackle', 'Vinyl Crackle', 'fx', ['fx'], ['lofi-hip-hop', 'trip-hop', 'downtempo', 'boom-bap'],
    { s: 'crackle', hpf: 300, attack: 0.05, decay: 0.1, sustain: 1, release: 0.3, gain: 0.5 }, 'vinyl-noise'),
];
