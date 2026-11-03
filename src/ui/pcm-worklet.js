'use strict';
const CAPACITY = 48000 * 2;
const PREBUFFER = 4800;
const MAX_QUEUE = 24000;
const TAP_FRAMES = 4800;

class PcmSource extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.playing = false;
    this.fade = 0;
    this.port.onmessage = ({ data }) => {
      const samples = new Int16Array(data);
      for (let i = 0; i + 1 < samples.length; i += 2) {
        this.left[this.write] = samples[i] / 32768;
        this.right[this.write] = samples[i + 1] / 32768;
        this.write = (this.write + 1) % CAPACITY;
      }
      if (this.queued() > MAX_QUEUE) this.read = (this.write - PREBUFFER + CAPACITY) % CAPACITY;
    };
  }

  queued() { return (this.write - this.read + CAPACITY) % CAPACITY; }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.playing && this.queued() >= PREBUFFER) this.playing = true;
    for (let i = 0; i < left.length; i++) {
      if (!this.playing || this.queued() === 0) {
        // Ease out instead of cutting to zero, which is what makes a click.
        this.playing = false;
        this.fade *= 0.9;
        left[i] = this.lastLeft * this.fade || 0;
        right[i] = this.lastRight * this.fade || 0;
        continue;
      }
      this.fade += (1 - this.fade) * 0.1;
      this.lastLeft = this.left[this.read];
      this.lastRight = this.right[this.read];
      left[i] = this.lastLeft * this.fade;
      right[i] = this.lastRight * this.fade;
      this.read = (this.read + 1) % CAPACITY;
    }
    return true;
  }
}

// Hands the finished mix to the main process in small blocks.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(TAP_FRAMES * 2);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    const frames = channels[0] ? channels[0].length : 128;
    for (let i = 0; i < frames; i++) {
      const left = channels[0] ? channels[0][i] : 0;
      const right = channels[1] ? channels[1][i] : left;
      this.buffer[this.filled++] = Math.max(-1, Math.min(1, left)) * 32767;
      this.buffer[this.filled++] = Math.max(-1, Math.min(1, right)) * 32767;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-source', PcmSource);
registerProcessor('pcm-tap', PcmTap);
