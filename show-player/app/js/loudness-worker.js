// Measures a song's loudness (ITU-R BS.1770 / EBU R128 integrated loudness, in LUFS),
// its sample peak, and the waveform outline. Runs off the main thread so the show never stutters.
// In:  { id, rate, channels:[Float32Array...], buckets }
// Out: { id, lufs, peak, peaks:[min,max,...] (Int8 scaled), duration }
self.onmessage = e => {
  const { id, rate, channels, buckets } = e.data;
  try {
    const n = channels[0].length;
    const filt = kWeight(rate);
    // 400 ms blocks every 100 ms (75% overlap)
    const hop = Math.round(rate * 0.1), block = hop * 4;
    const hops = Math.floor(n / hop);
    const hopPower = new Float64Array(hops);
    let peak = 0;
    for (const ch of channels) {
      const [b0, b1, b2, a1, a2] = filt.pre, [c0, c1, c2, d1, d2] = filt.rlb;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, w1 = 0, w2 = 0, z1 = 0, z2 = 0;
      for (let h = 0; h < hops; h++) {
        let sum = 0;
        const end = (h + 1) * hop;
        for (let i = h * hop; i < end; i++) {
          const x = ch[i];
          const ax = x < 0 ? -x : x; if (ax > peak) peak = ax;
          const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x; y2 = y1; y1 = y;
          const z = c0 * y + c1 * w1 + c2 * w2 - d1 * z1 - d2 * z2;
          w2 = w1; w1 = y; z2 = z1; z1 = z;
          sum += z * z;
        }
        hopPower[h] += sum;
      }
    }
    const blocks = [];
    for (let h = 0; h + 4 <= hops; h++) blocks.push((hopPower[h] + hopPower[h + 1] + hopPower[h + 2] + hopPower[h + 3]) / block);
    const L = p => -0.691 + 10 * Math.log10(p);
    let lufs = -70;
    const abs = blocks.filter(p => p > 0 && L(p) > -70);
    if (abs.length) {
      const relGate = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
      const rel = abs.filter(p => L(p) > relGate);
      if (rel.length) lufs = L(rel.reduce((a, b) => a + b, 0) / rel.length);
    } else if (n > 0 && n < block) {
      // shorter than one block (very short sound effects): use the whole thing
      const p = hopPower.reduce((a, b) => a + b, 0) / Math.max(1, n);
      if (p > 0) lufs = L(p);
    }
    // waveform outline: per bucket min/max of the channel mix, scaled to -127..127
    const nb = Math.max(1, Math.min(buckets || 2000, n));
    const peaks = new Int8Array(nb * 2);
    const per = n / nb;
    for (let b = 0; b < nb; b++) {
      const s = Math.floor(b * per), e2 = Math.min(n, Math.floor((b + 1) * per));
      let mn = 0, mx = 0;
      for (let i = s; i < e2; i++) {
        let v = 0; for (const ch of channels) v += ch[i]; v /= channels.length;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      peaks[b * 2] = Math.max(-127, Math.round(mn * 127)); peaks[b * 2 + 1] = Math.min(127, Math.round(mx * 127));
    }
    self.postMessage({ id, lufs: Math.round(lufs * 10) / 10, peak: peak > 0 ? Math.round(200 * Math.log10(peak)) / 10 : -96, peaks: Array.from(peaks), duration: n / rate });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};

// K-weighting filter coefficients for any sample rate (same formulas as libebur128).
function kWeight(rate) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / rate);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pre = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / rate);
  a0 = 1 + K / Q + K * K;
  const rlb = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return { pre, rlb };
}
