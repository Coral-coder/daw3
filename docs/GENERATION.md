# Generation: layering and cadence

Design note for the song generator's layering & phrasing pass (`src/gen/cadence.js`, `src/gen/layering.js`).
The rest of the generator (form, harmony, parts, orchestra, mix) is described in `docs/ARCHITECTURE.md` and
`docs/SOUND.md`.

## What a produced club track does that an arranged one doesn't

Studying hand-built, live-coded trance (≈140 BPM, minor key, everything written in scale degrees) gives a small set
of techniques. None of them is about more notes; they are about **two clocks per part**, **two voices per role**
and **offsets between parts**.

### Layering

* **Two-voice bass on one rhythm.** The body is a supersaw (5 voices, wide detune) through an almost closed
  low-pass that a short, 303-style envelope opens on every note (fast decay, low sustain, no resonance), a little
  drive. A second voice plays *the same 16-step rhythm* a fixed interval higher (octave + fifth) with a slow additive
  interval cycle that runs at 5 per bar against the 16 steps, and a different timbre: saw with white noise mixed into
  the oscillator, more envelope, a resonant peak, drive, a feedback echo and a large, mostly wet room. The body
  stays dry and centred, the layer turns into air.
* **The arp is made of chord shapes, not chords.** Each bar holds one two-note shape (a 7th, an octave, a 10th
  above the root or third); the arp's gate pattern picks the low or high note per 16th and *rests* on some steps.
  A second, polymetric cycle (6 per bar against the 8-step gate) adds an octave or a fifth to some steps, so the
  figure never repeats exactly while the shapes are static. Notes are legato — the filter envelope, not the gate
  length, shapes each step. The filter itself moves on a very slow triangle (many bars per cycle). Long feedback
  echo, a big room, noise in the oscillator, random-ish pan.
* **The kick ducks the bass voices and the arp / lead** (sidechain on their buses), not the drums.
* **Percussion is layers, not a kit.** A looped top; a clap on the backbeat layered with a second clap and an
  occasional double hit; a glitch voice whose sample position is random per 16th but *looped over half a bar*
  (random, yet a pattern); hats made from high-passed white noise whose decay moves on a triangle LFO across the
  bar, shaped transients, a touch of swing on the off-16ths, offset slightly from the grid and panned off-centre.
* **Gain staging per part** (bass voices hot, lead and top lower), each part on its own bus.

### Cadence and phrasing

* **Harmonic rhythm in long notes.** The bass line is written as one degree held for most of the bar with a short
  pickup into it, over a 4-bar root cycle; the 16-step rhythm then re-strikes whatever the long note is. The
  pitch clock is slow, the rhythm clock is fast.
* **Call and answer inside the bar.** The bass rhythm is a 2-bar figure whose second bar keeps the first half and
  re-cuts the ending; bars 3–4 contrast and answer again (a 4-bar rhythm cycle aligned with the harmony).
* **2-bar and 4-bar phrases.** The arp's shapes change on a 4-bar plan (a long shape, a long shape with a short
  fifth at the end, another long shape, then a bar that moves in eighths); the second 4 bars repeat it with a
  *different last gesture*.
* **Offsets between parts.** Straight kick; clap every other beat; hats swung and a hair late; glitch random;
  bass on the off-16ths; the arp's accent cycle drifting against its gate.

## How the generator expresses it

`src/gen/cadence.js` — the phrasing model, pure functions:

| function | technique |
|---|---|
| `longToneLine` | slow clock: chord roots held per bar; an odd (answer) bar anticipates the next root on its last beat, an even bar leans in with a one-step pickup from the next chord's fifth, an odd bar that keeps its chord moves to the fifth |
| `rollCells` / `rollingPart` | fast clock: 4 bars of 16-step run lengths `[call, answer, contrast, answer]`; answers share the first half of their call; notes clipped to 80 % of their run |
| `dyadPhrase` | two-note chord shapes on a 4/8-bar plan with an answering ending; shapes use the chord's own scale (borrowed chords keep their colour) |
| `gatedArp` | gate cells (8 steps, rests included) + an answer cell every 4th bar + a 6-per-bar octave / fifth accent cycle; legato, never across a chord change |
| `answerBars` | rhythmic call & response for looping basslines in other genres: a 16th pickup (into the next root on a chord change) in every second bar, a pushed last note every 4th bar |

`src/gen/layering.js` — per-genre profiles (`LAYER_PROFILES`) and the pass:

* **Recipes** (`layeringPart`, called inside the section loop of `generateSong`): trance's rolling bass and shape arp.
  Recipe parts skip the anti-monotony guard (they are built from call / answer cells already).
* **`addLayering`** (after the orchestra and the rides): the bass layer (copied from the final, grooved bass notes,
  so the rhythm is identical; chord-tone intervals, pickups doubled an octave up), noise hats (they replace the
  kit's closed hats where they play, so the top-end budget of `tests/drum-layers.test.js` still holds), the noise
  clap layer (phrase-end flams instead of random ones — readable in code), the glitch cell (scale tones, at least
  two blips per half bar), vinyl crackle, extra ducker targets, slow filter LFOs (only through sections no other
  automation rides; ≤ 60 points per lane).
* Sounds: Strudel patches in `src/audio/strudel-patches-layers.js` (`sd-roll-bass`, `sd-bass-layer`, `sd-gate-arp`,
  `sd-noise-hat`, `sd-noise-clap`, `sd-glitch-blip`, `sd-crackle`), each with a built-in fallback preset. The
  `noise` control (white noise mixed into a basic oscillator) is a Strudel patch parameter.

Profiles keep genres idiomatic:

| genre | adds |
|---|---|
| trance | everything above; no separate sub (the two-voice bass covers it); lead ducks too |
| progressive house | octave bass layer, noise hats, clap layer, arp filter LFO, bass answers |
| psytrance / techno / industrial | noise hats (straight or lightly swung), glitch; techno bass answers |
| house / tech house / garage | clap layer, bass answers; house filtered stabs (slow LFO); tech house a light glitch |
| trap / drill / phonk / dubstep / hardstyle | clap layer on the snare |
| lo-fi / boom bap / trip-hop | vinyl crackle, a wobbly chord / pad filter — no club percussion |
| ambient / downtempo / chillwave / future bass / synthwave | a slow filter LFO on the pad / chords / arp |
| idm / glitch | dense glitch cell |
| band and acoustic genres | nothing here — their phrasing is bass pickups (`bass.js`) and melodic periods (`melody.js`) |

`opts.layering === false` turns the pass off; `opts.strudel === false` keeps only built-in sounds (no Strudel-only
layers, recipe parts keep the genre's instruments).

## Code views

* Strudel export (`songToCode(project, {export: true})`): every track whose ducker listens to the drums gets its own
  orbit, and the drum track's **kick voice** carries `.duck("2:3:…").duckdepth().duckattack()` — Strudel ducks
  per event, so the hats never pump. The editable code view is unchanged (apply-back is not affected).
* Live-coder view: noise hats are written as a signal, `s("white*16").dec(tri.fast(4).range(.05, .12)).sustain(0)
  .hpf(1200).swingBy(.12, 8)`; the clap layer as `s("[~ white]*2")` with its patch.

## Checks

`tests/layering.test.js`: layered structure (bass voices share onsets and lengths, interval above the octave),
long tones per bar, 4-bar call/answer rhythm cycle, arp gate rests / accent range / no ringing across chords, the
arp filter LFO, hats (16ths, moving decay, swung off-16ths, kit hats removed), the clap on the kit's backbeat,
sidechain targets, gain staging, determinism, speed, per-genre profiles, minimum layers per section, the export's
kick duck. Offline renders: `node tools/browser-check/gen-render.mjs <genre> <seed> <out.wav> [startBar] [bars] [--stems]`
(master WAV, integrated loudness, true peak, band energy shares, per-track stem loudness).
