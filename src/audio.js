// All sound is synthesized with WebAudio, so there are no audio files to ship.
export class Audio {
  constructor() {
    this.ctx = null;
    try { this.muted = localStorage.getItem('gm.muted') === '1'; } catch { this.muted = false; }
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(this.ctx.destination);
    this.startDrone();
    return true;
  }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem('gm.muted', m ? '1' : '0'); } catch {}
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  startDrone() {
    const c = this.ctx;
    this.droneGain = c.createGain();
    this.droneGain.gain.value = 0.0;
    this.droneFilter = c.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 300;
    this.droneOsc = [55, 82.4, 110.3].map((f, i) => {
      const o = c.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      o.detune.value = (i - 1) * 6;
      o.connect(this.droneFilter);
      o.start();
      return o;
    });
    const lfo = c.createOscillator(), lfoGain = c.createGain();
    lfo.frequency.value = 0.07; lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(this.droneFilter.frequency);
    lfo.start();
    this.droneFilter.connect(this.droneGain).connect(this.master);
  }

  // Pitch the drone with the time warp; fade it when paused.
  drone(speed, playing) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.max(0.5, Math.min(2.2, 1 + Math.log10(Math.max(speed, 0.01)) * 0.25));
    this.droneOsc.forEach((o, i) => o.frequency.setTargetAtTime([55, 82.4, 110.3][i] * k, t, 0.4));
    this.droneGain.gain.setTargetAtTime(playing ? 0.05 : 0.02, t, 0.5);
  }

  noise(dur) {
    const c = this.ctx, n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource();
    s.buffer = buf;
    return s;
  }

  click(pitch = 1) {
    if (!this.ensure() || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square'; o.frequency.value = 1400 * pitch;
    g.gain.setValueAtTime(0.04, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.04);
  }

  launch(power = 0.5) {
    if (!this.ensure() || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noise(0.5), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'bandpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2500 + power * 2000, t + 0.25);
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    n.connect(f).connect(g).connect(this.master); n.start(t);
    const o = c.createOscillator(), og = c.createGain();
    o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.3);
    og.gain.setValueAtTime(0.2, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.35);
  }

  thud(size = 1) {
    if (!this.ensure() || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
    g.gain.setValueAtTime(0.6 * Math.min(1, 0.4 + size), t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 1.5);
    const n = this.noise(1.2), f = c.createBiquadFilter(), ng = c.createGain();
    f.type = 'lowpass'; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(100, t + 1);
    ng.gain.setValueAtTime(0.35, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    n.connect(f).connect(ng).connect(this.master); n.start(t);
  }

  chime() {
    if (!this.ensure() || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    [659.3, 987.8, 1318.5].forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const s = t + i * 0.09;
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.12, s + 0.02); g.gain.exponentialRampToValueAtTime(0.001, s + 0.8);
      o.connect(g).connect(this.master); o.start(s); o.stop(s + 0.9);
    });
  }

  warn() {
    if (!this.ensure() || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.value = 220;
    g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.3);
  }
}
