'use strict';
// All sound is synthesized with WebAudio: no audio files needed.
window.SFX = (() => {
  let ac = null, master, sfx, music, noiseBuf, eng = null, seq = null, musicOn = true;

  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ac = new AC(); } catch (e) { return; }
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 5;
    comp.connect(ac.destination);
    master = ac.createGain(); master.gain.value = 0.8; master.connect(comp);
    sfx = ac.createGain(); sfx.gain.value = 0.9; sfx.connect(master);
    music = ac.createGain(); music.gain.value = musicOn ? 0.38 : 0; music.connect(master);
    const len = ac.sampleRate * 2;
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    startEngine();
  }
  const now = () => ac.currentTime;
  const mtof = n => 440 * Math.pow(2, (n - 69) / 12);

  function env(g, t, peak, attack, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function noise(dur, o = {}) {
    if (!ac) return;
    const t = (o.time ?? now()) + (o.delay || 0);
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = o.filter || 'lowpass'; f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.freq || 2000, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + dur);
    const g = ac.createGain(); env(g, t, o.gain ?? 0.4, o.attack || 0.004, dur);
    src.connect(f); f.connect(g); g.connect(o.bus || sfx);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }

  function tone(freq, dur, o = {}) {
    if (!ac) return;
    const t = (o.time ?? now()) + (o.delay || 0);
    const osc = ac.createOscillator(); osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = ac.createGain(); env(g, t, o.gain ?? 0.15, o.attack || 0.004, dur);
    let n = osc;
    if (o.lp) {
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; f.Q.value = o.q ?? 0.8;
      osc.connect(f); n = f;
    }
    n.connect(g); g.connect(o.bus || sfx);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- jet engine drone
  function startEngine() {
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500; f.Q.value = 0.7;
    const g = ac.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(sfx); src.start();
    const osc = ac.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 50;
    const of = ac.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 260;
    const og = ac.createGain(); og.gain.value = 0;
    osc.connect(of); of.connect(og); og.connect(sfx); osc.start();
    eng = { f, g, osc, og };
  }
  function engine(level, thrust) {
    if (!eng) return;
    const t = now();
    eng.g.gain.setTargetAtTime(level * (0.08 + thrust * 0.16), t, 0.12);
    eng.f.frequency.setTargetAtTime(350 + thrust * 1500, t, 0.2);
    eng.osc.frequency.setTargetAtTime(42 + thrust * 40, t, 0.25);
    eng.og.gain.setTargetAtTime(level * 0.06, t, 0.12);
  }

  // ---------------------------------------------------------------- effects
  const gun = () => {
    noise(0.07, { filter: 'bandpass', freq: 1600 + Math.random() * 600, q: 1.4, gain: 0.22 });
    tone(140, 0.05, { type: 'square', gain: 0.05, freqEnd: 70 });
  };
  const missile = () => noise(0.8, { filter: 'bandpass', freq: 500, freqEnd: 2600, q: 2.5, gain: 0.4, attack: 0.04 });
  const explode = big => {
    noise(big ? 1.8 : 0.9, { filter: 'lowpass', freq: big ? 1400 : 2400, freqEnd: 60, gain: big ? 0.95 : 0.6 });
    tone(big ? 70 : 110, big ? 0.9 : 0.4, { type: 'sine', freqEnd: 28, gain: big ? 0.7 : 0.4 });
  };
  const small = () => noise(0.25, { filter: 'lowpass', freq: 3000, freqEnd: 300, gain: 0.3 });
  const lock = () => tone(1480, 0.05, { type: 'square', gain: 0.06 });
  const alarm = () => {
    tone(1046, 0.09, { type: 'square', gain: 0.07 });
    tone(784, 0.09, { type: 'square', gain: 0.07, delay: 0.11 });
  };
  const hit = () => {
    noise(0.5, { filter: 'lowpass', freq: 3500, freqEnd: 200, gain: 0.8 });
    tone(220, 0.35, { type: 'sawtooth', freqEnd: 50, gain: 0.25 });
  };
  const roll = () => noise(0.6, { filter: 'bandpass', freq: 300, freqEnd: 1400, q: 3, gain: 0.35, attack: 0.1 });
  const select = () => { tone(660, 0.08, { gain: 0.1 }); tone(990, 0.12, { delay: 0.08, gain: 0.1 }); };
  const jingle = () => [72, 76, 79, 84, 79, 84].forEach((n, i) =>
    tone(mtof(n), i === 5 ? 0.6 : 0.12, { delay: i * 0.11, gain: 0.1, type: 'square', lp: 4000 }));
  const warning = () => {
    for (let i = 0; i < 4; i++) {
      tone(440, 0.22, { type: 'sawtooth', gain: 0.12, delay: i * 0.5, lp: 2000 });
      tone(330, 0.22, { type: 'sawtooth', gain: 0.12, delay: i * 0.5 + 0.25, lp: 2000 });
    }
  };
  const blip = () => tone(1800, 0.03, { type: 'triangle', gain: 0.05 });
  const thunder = () => noise(2.5, { filter: 'lowpass', freq: 400, freqEnd: 40, gain: 0.8, attack: 0.08, delay: 0.3 });
  const gameover = () => [67, 63, 60, 55].forEach((n, i) =>
    tone(mtof(n), 0.35, { delay: i * 0.3, gain: 0.12, type: 'triangle' }));
  const evade = () => tone(880, 0.15, { type: 'triangle', freqEnd: 1760, gain: 0.08 });

  // ---------------------------------------------------------------- music (original tune)
  const BPM = 148, STEP = 60 / BPM / 4;
  // chord roots + triads: Em, C, D, B
  const CH = [[40, [64, 67, 71]], [36, [60, 64, 67]], [38, [62, 66, 69]], [35, [63, 66, 71]]];
  const LEAD = [
    [76, 0, 0, 79, 0, 0, 83, 0, 81, 0, 79, 0, 78, 0, 76, 0],
    [79, 0, 0, 76, 0, 0, 84, 0, 83, 0, 81, 0, 79, 0, 0, 0],
    [78, 0, 0, 81, 0, 0, 86, 0, 88, 0, 86, 0, 81, 0, 78, 0],
    [83, 0, 0, 0, 81, 0, 79, 0, 78, 0, 0, 0, 75, 0, 78, 0],
  ];
  const kick = t => tone(150, 0.2, { time: t, type: 'sine', freqEnd: 42, gain: 0.85, bus: music });
  const snare = (t, g = 1) => {
    noise(0.15, { time: t, filter: 'highpass', freq: 1300, gain: 0.4 * g, bus: music });
    tone(190, 0.09, { time: t, type: 'triangle', gain: 0.22 * g, bus: music });
  };
  const hat = (t, g) => noise(0.035, { time: t, filter: 'highpass', freq: 8000, gain: g, bus: music });

  function playStep(step, t) {
    const bar = Math.floor(step / 16), s = step % 16, sec = Math.floor(bar / 4) % 4, ci = bar % 4;
    const [root, tri] = CH[ci];
    if (s % 4 === 0 || (sec >= 2 && s === 10)) kick(t);
    if (s === 4 || s === 12) snare(t);
    if (ci === 3 && sec % 2 === 1 && s >= 13) snare(t, 0.6);
    if (s % 2 === 0) hat(t, s % 4 === 2 ? 0.09 : 0.05);
    if (s % 2 === 0) tone(mtof(root + (s % 4 === 2 ? 12 : 0)), STEP * 1.8, { time: t, type: 'sawtooth', gain: 0.22, lp: 700, bus: music });
    if (sec < 2) {
      const row = LEAD[ci], n = row[s];
      if (n) {
        let gap = 1;
        while (s + gap < 16 && !row[s + gap] && gap < 4) gap++;
        const d = gap * STEP * 0.95;
        tone(mtof(n), d, { time: t, type: 'square', gain: 0.075, lp: 3200, bus: music });
        if (sec === 1) tone(mtof(n - 12), d, { time: t, type: 'sawtooth', gain: 0.05, lp: 2000, bus: music, detune: 6 });
      }
    } else {
      const n = tri[s % 3] + (Math.floor(s / 3) % 2 ? 12 : 0);
      tone(mtof(n), STEP * 0.9, { time: t, type: 'square', gain: 0.045, lp: 2600, bus: music });
      if (s === 0) for (const p of tri) tone(mtof(p - 12), STEP * 16, { time: t, type: 'sawtooth', gain: 0.03, lp: 1100, bus: music, attack: 0.15 });
    }
  }

  function startMusic() {
    if (!ac || seq) return;
    seq = { step: 0, next: now() + 0.08 };
    seq.timer = setInterval(() => {
      if (now() - seq.next > 0.3) seq.next = now() + 0.05; // tab was throttled; don't burst
      while (seq.next < now() + 0.14) {
        if (musicOn) playStep(seq.step, seq.next);
        seq.next += STEP;
        seq.step = (seq.step + 1) % 256;
      }
    }, 25);
  }
  function setMusic(on) {
    musicOn = on;
    if (music) music.gain.setTargetAtTime(on ? 0.38 : 0, now(), 0.1);
  }

  return {
    init, engine, startMusic, setMusic,
    gun, missile, explode, small, lock, alarm, hit, roll, select, jingle, warning, blip, thunder, gameover, evade,
  };
})();
