// La voix du bac — a small Web Audio instrument.
// Five ink voices (pad, FM bell, pluck, bass, breath), a bowed voice for stirring,
// and a drone whose swell follows the energy of the bath. Everything runs through
// a shared delay and a generated convolution reverb.

const NAMES = ['do', 'do♯', 'ré', 'mi♭', 'mi', 'fa', 'fa♯', 'sol', 'sol♯', 'la', 'si♭', 'si'];
// French octave convention: middle C (MIDI 60) is "do3".
export const noteName = m => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 2}`;
export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

const MAX_VOICES = 20;

export class Synth {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.voices = [];
    this.bow = null;
    this.root = 50;
  }

  get live() { return !!this.ctx && !this.muted && this.ctx.state !== 'closed'; }
  get running() { return !!this.ctx && this.ctx.state === 'running' && !this.muted; }
  get activeVoices() {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime;
    return this.voices.filter(v => v.start <= now && v.end > now).length + (this.bow ? 1 : 0);
  }

  // Must be called from inside a user gesture the first time.
  start() {
    if (!this.ctx) this.build();
    this.muted = false;
    this.master.gain.setTargetAtTime(0.9, this.ctx.currentTime, 0.08);
    return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.08);
    if (m) this.bowEnd();
  }

  build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.005;
    comp.release.value = 0.3;

    this.bus = ctx.createGain();
    this.bus.gain.value = 0.7;

    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(3.2);
    const verbSend = ctx.createGain();
    verbSend.gain.value = 0.45;

    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.36;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.34;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2400;
    const delaySend = ctx.createGain();
    delaySend.gain.value = 0.2;

    this.bus.connect(comp);
    this.bus.connect(verbSend).connect(verb).connect(comp);
    this.bus.connect(delaySend).connect(delay);
    delay.connect(tone).connect(feedback).connect(delay);
    tone.connect(comp);
    tone.connect(verbSend);
    comp.connect(this.master).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.buildDrone();
  }

  // Stereo noise with an exponential tail that darkens over time, like a stone room.
  impulse(seconds) {
    const sr = this.ctx.sampleRate, len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const x = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2);
        y += (x - y) * (0.9 - t * 0.75);
        d[i] = y * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
      }
    }
    return buf;
  }

  buildDrone() {
    const ctx = this.ctx;
    this.dGain = ctx.createGain();
    this.dGain.gain.value = 0;
    this.dFilter = ctx.createBiquadFilter();
    this.dFilter.type = 'lowpass';
    this.dFilter.frequency.value = 320;
    this.dFilter.Q.value = 0.8;
    this.dFilter.connect(this.dGain).connect(this.bus);

    const voice = (type, midi, gain, detune = 0) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.value = mtof(midi);
      o.detune.value = detune;
      g.gain.value = gain;
      o.connect(g).connect(this.dFilter);
      o.start();
      return o;
    };
    this.dOsc = [
      [voice('sawtooth', this.root - 12, 0.16), -12],
      [voice('sine', this.root - 5, 0.5), -5],
      [voice('triangle', this.root, 0.22, 7), 0],
    ];
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(this.dFilter.frequency);
    lfo.start();
  }

  setRoot(midi) {
    this.root = midi;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [o, off] of this.dOsc) o.frequency.setTargetAtTime(mtof(midi + off), t, 0.5);
  }

  setEnergy(e) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.dGain.gain.setTargetAtTime(0.035 + e * 0.24, t, 0.25);
    this.dFilter.frequency.setTargetAtTime(240 + e * 1500, t, 0.3);
  }

  // One struck note. `at` schedules it on the audio clock, seconds from now.
  note(midi, kind, { vel = 0.7, pan = 0, bright = 0.5, at = 0 } = {}) {
    if (!this.live) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.005 + at, f = mtof(midi);
    const out = ctx.createGain();
    out.gain.value = 0;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(p).connect(this.bus);
    const srcs = [];
    const osc = (type, freq, gain, dest = out) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g).connect(dest);
      srcs.push(o);
      return o;
    };
    const g = out.gain;
    let end;

    switch (kind) {
      case 'pad': {
        osc('sine', f, 0.6);
        osc('sine', f * 1.0035, 0.5);
        osc('triangle', f * 2, 0.12);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(vel * 0.3, t + 0.35);
        g.setTargetAtTime(vel * 0.16, t + 0.35, 0.6);
        g.setTargetAtTime(0, t + 1.4, 0.9);
        end = t + 5.5;
        break;
      }
      case 'bell': {
        const car = osc('sine', f, 1);
        const mod = ctx.createOscillator(), mg = ctx.createGain();
        mod.frequency.value = f * 3.5;
        mg.gain.setValueAtTime(f * (2 + bright * 6), t);
        mg.gain.setTargetAtTime(f * 0.15, t, 0.45);
        mod.connect(mg).connect(car.frequency);
        srcs.push(mod);
        osc('sine', f * 2.76, 0.12);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(vel * 0.36, t + 0.004);
        g.setTargetAtTime(0, t + 0.004, 0.7);
        end = t + 4.5;
        break;
      }
      case 'pluck': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 5;
        lp.frequency.setValueAtTime(600 + bright * 5200, t);
        lp.frequency.setTargetAtTime(240, t, 0.18);
        lp.connect(out);
        osc('sawtooth', f, 0.5, lp);
        osc('sawtooth', f * 1.007, 0.4, lp);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(vel * 0.32, t + 0.003);
        g.setTargetAtTime(0, t + 0.003, 0.32);
        end = t + 2.6;
        break;
      }
      case 'bass': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        lp.connect(out);
        osc('sine', f, 0.9, lp);
        osc('triangle', f, 0.35, lp);
        const cg = ctx.createGain();
        cg.connect(out);
        osc('sine', f * 4, 1, cg);
        cg.gain.setValueAtTime(0.25, t);
        cg.gain.setTargetAtTime(0, t, 0.02);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(vel * 0.6, t + 0.008);
        g.setTargetAtTime(0, t + 0.008, 0.45);
        end = t + 3;
        break;
      }
      case 'breath': {
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        n.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = 18;
        const ng = ctx.createGain();
        ng.gain.value = 2.2;
        n.connect(bp).connect(ng).connect(out);
        srcs.push(n);
        osc('sine', f, 0.22);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(vel * 0.5, t + 0.09);
        g.setTargetAtTime(0, t + 0.12, 0.5);
        end = t + 3.5;
        break;
      }
      default: return;
    }
    for (const s of srcs) { s.start(t); s.stop(end); }
    const v = { out, start: t, end };
    srcs[0].onended = () => { this.voices = this.voices.filter(x => x !== v); p.disconnect(); };
    this.voices.push(v);
    this.cull();
  }

  cull() {
    const now = this.ctx.currentTime;
    const sounding = this.voices.filter(v => v.start <= now + 0.05);
    for (let i = 0; i < sounding.length - MAX_VOICES; i++) {
      sounding[i].out.gain.cancelScheduledValues(now);
      sounding[i].out.gain.setTargetAtTime(0, now, 0.03);
      sounding[i].end = now;
    }
  }

  // The bowed voice: sustains while the stylus moves, brightness follows speed.
  bowStart(midi) {
    if (!this.live || this.bow) return;
    const ctx = this.ctx, t = ctx.currentTime, f = mtof(midi);
    const out = ctx.createGain();
    out.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.value = 400;
    lp.connect(out).connect(pan).connect(this.bus);
    const vib = ctx.createOscillator(), vibGain = ctx.createGain();
    vib.frequency.value = 5.2;
    vibGain.gain.value = f * 0.006;
    vib.connect(vibGain);
    const oscs = [['sawtooth', 1, 0.45], ['sawtooth', 1.005, 0.4], ['square', 0.5, 0.18]].map(([type, ratio, gain]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.value = f * ratio;
      vibGain.connect(o.frequency);
      g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start(t);
      return [o, ratio];
    });
    vib.start(t);
    this.bow = { out, pan, lp, oscs, vib };
  }

  bowMove(midi, speed, pan) {
    const b = this.bow;
    if (!b) return;
    const t = this.ctx.currentTime, f = mtof(midi);
    for (const [o, ratio] of b.oscs) o.frequency.setTargetAtTime(f * ratio, t, 0.05);
    b.lp.frequency.setTargetAtTime(320 + speed * 4200, t, 0.06);
    b.out.gain.setTargetAtTime(Math.min(0.2, 0.035 + speed * 0.24), t, 0.05);
    b.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.1);
  }

  bowEnd() {
    const b = this.bow;
    if (!b) return;
    this.bow = null;
    const t = this.ctx.currentTime;
    b.out.gain.cancelScheduledValues(t);
    b.out.gain.setTargetAtTime(0, t, 0.22);
    for (const [o] of b.oscs) o.stop(t + 1.5);
    b.vib.stop(t + 1.5);
  }

  // Filtered noise sweep: the sheet of paper, the bath being emptied.
  swish({ dur = 0.8, from = 4000, to = 300, vel = 0.25, at = 0 } = {}) {
    if (!this.live) return;
    const ctx = this.ctx, t = ctx.currentTime + at;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(bp).connect(g).connect(this.bus);
    n.start(t);
    n.stop(t + dur + 0.05);
  }

  get info() {
    if (!this.ctx) return null;
    return {
      rate: this.ctx.sampleRate,
      latency: Math.round(((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000),
      state: this.ctx.state,
    };
  }
}
