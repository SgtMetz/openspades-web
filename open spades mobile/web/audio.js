// Browser audio device. World positions use renderer coordinates (x, 64-z, y).
export class GameAudio {
  constructor() { this.context = null; this.buffers = new Map(); this._volume = .55; this.active = 0; this.epoch = 0; }
  get volume() { return this._volume; }
  set volume(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.master) this.master.gain.value = this._volume;
  }
  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain(); this.master.gain.value = this._volume;
      // Limit the summed mix so overlapping gunfire does not hard-clip. The trim undoes the
      // compressor's automatic makeup gain, (1 / gain at 0 dBFS)^0.6, so quiet sounds stay put.
      const limiter = this.context.createDynamicsCompressor(), trim = this.context.createGain();
      limiter.threshold.value = -6; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = .002; limiter.release.value = .15;
      trim.gain.value = Math.pow(10, .6 * (-6 + 6 / 20) / 20);
      this.master.connect(limiter).connect(trim).connect(this.context.destination);
    }
    await this.context.resume();
  }
  listener(position, forward, up) {
    if (!this.context) return;
    const l = this.context.listener;
    if (l.positionX) {
      for (const [prefix, v] of [['position', position], ['forward', forward], ['up', up]]) {
        for (const axis of ['X', 'Y', 'Z']) l[prefix + axis].value = v[axis.toLowerCase()];
      }
    } else { l.setPosition(position.x, position.y, position.z); l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z); }
  }
  // Invalidate sounds still downloading when leaving a match.
  reset() { this.epoch++; }
  async play(path, volume = 1, rate = 1, position = null) {
    if (!this.context || this.context.state !== 'running' || this.volume === 0 || this.active >= 32) return;
    const epoch = this.epoch;
    // Reserve before awaiting decode so uncached bursts cannot exceed the voice limit.
    this.active++;
    let source, gain, panner, started = false;
    const release = () => { this.active--; source?.disconnect(); gain?.disconnect(); panner?.disconnect(); };
    try {
      if (!this.buffers.has(path)) {
        const pending = fetch('assets/Sounds/' + path + '.opus')
          .then(r => { if (!r.ok) throw Error(path); return r.arrayBuffer(); })
          .then(b => this.context.decodeAudioData(b));
        this.buffers.set(path, pending);
        pending.catch(() => { if (this.buffers.get(path) === pending) this.buffers.delete(path); });
      }
      const buffer = await this.buffers.get(path);
      if (this.context.state !== 'running' || epoch !== this.epoch) return;
      source = this.context.createBufferSource(); gain = this.context.createGain();
      source.buffer = buffer; source.playbackRate.value = rate; gain.gain.value = volume;
      source.connect(gain);
      if (position) {
        panner = this.context.createPanner(); panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
        panner.refDistance = 8; panner.maxDistance = 256; panner.rolloffFactor = 1;
        if (panner.positionX) { panner.positionX.value = position.x; panner.positionY.value = position.y; panner.positionZ.value = position.z; }
        else panner.setPosition(position.x, position.y, position.z);
        gain.connect(panner).connect(this.master);
      } else gain.connect(this.master);
      source.onended = release; source.start(); started = true;
    } catch { console.warn('Sound unavailable', path); }
    finally { if (!started) release(); }
  }
}
