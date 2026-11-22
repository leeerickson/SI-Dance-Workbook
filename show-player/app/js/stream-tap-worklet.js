// Runs on the audio thread, next to what goes to the speakers. While streaming is on, it hands the exact
// samples (stereo, 16-bit) to the page in blocks of 4096 frames, so the stream's sound can't drop or click
// even when the rest of the computer is busy.
class StreamTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.size = 4096;
    this.buf = new Int16Array(this.size * 2);
    this.n = 0;
    this.port.onmessage = e => { this.on = !!e.data.on; this.n = 0; };
  }
  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0];
    const L = input[0], R = input[1] || input[0];
    const frames = L ? L.length : 128;
    for (let i = 0; i < frames; i++) {
      const l = L ? L[i] : 0, r = R ? R[i] : 0;
      this.buf[this.n * 2] = l >= 1 ? 32767 : l <= -1 ? -32768 : (l * 32767) | 0;
      this.buf[this.n * 2 + 1] = r >= 1 ? 32767 : r <= -1 ? -32768 : (r * 32767) | 0;
      if (++this.n === this.size) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(this.size * 2);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('stream-tap', StreamTap);
