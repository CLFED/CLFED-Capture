'use strict';
const CAPACITY = 48000 * 2;
const MAX_QUEUE = 14400;

class PcmSource extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.port.onmessage = ({ data }) => {
      const samples = new Int16Array(data);
      for (let i = 0; i + 1 < samples.length; i += 2) {
        this.left[this.write] = samples[i] / 32768;
        this.right[this.write] = samples[i + 1] / 32768;
        this.write = (this.write + 1) % CAPACITY;
      }
      // Drop old audio when delivery falls behind, so latency cannot keep growing.
      if ((this.write - this.read + CAPACITY) % CAPACITY > MAX_QUEUE) this.read = (this.write - 4800 + CAPACITY) % CAPACITY;
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    for (let i = 0; i < left.length; i++) {
      if (this.read === this.write) { left[i] = 0; right[i] = 0; continue; }
      left[i] = this.left[this.read];
      right[i] = this.right[this.read];
      this.read = (this.read + 1) % CAPACITY;
    }
    return true;
  }
}
registerProcessor('pcm-source', PcmSource);
