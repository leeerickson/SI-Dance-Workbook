// Audio engine: two show decks (so one song can crossfade into the next), a filler deck,
// hot sounds with ducking, EQ, a 3-band compressor, a safety limiter, L/R balance,
// meters, test signals and microphone calibration. Uses the Web Audio API only.
//
//  deck A ─┐
//  deck B ─┼─ program ─ duck ─┐
//  filler ─┘                  ├─ mix ─ high-pass ─ EQ ×5 ─┬─ dry ────────┬─ limiter ─ master ─ balance ─ out
//  hot sounds ─ hotBus ───────┘                           └─ 3-band comp ─┘
//  test signals ───────────────────────────────────────────────────────────────── master
'use strict';
const Engine = (() => {
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const db2g = db => Math.pow(10, db / 20);
  const g2db = g => g > 0.0000001 ? 20 * Math.log10(g) : -140;
  const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  // A splitter keeps a mono signal on the left only, so anything split into L/R goes through this first:
  // fixed at two channels with speaker upmixing, a mono file arrives as the same signal on both sides.
  const stereo = () => { const g = gain(); g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g; };
  const now = () => ctx.currentTime;

  /* ---------- graph ---------- */
  const program = gain(), duck = gain(), hotBus = gain(), mix = gain();
  program.connect(duck); duck.connect(mix); hotBus.connect(mix);
  const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 20; hpf.Q.value = 0.707;
  mix.connect(hpf);
  const EQ_BANDS = [
    { type: 'lowshelf', f: 80 }, { type: 'peaking', f: 250, q: 1 }, { type: 'peaking', f: 1000, q: 1 }, { type: 'peaking', f: 4000, q: 1 }, { type: 'highshelf', f: 10000 }
  ];
  const eq = EQ_BANDS.map(b => { const n = ctx.createBiquadFilter(); n.type = b.type; n.frequency.value = b.f; if (b.q) n.Q.value = b.q; n.gain.value = 0; return n; });
  hpf.connect(eq[0]); for (let i = 1; i < eq.length; i++) eq[i - 1].connect(eq[i]);
  const eqOut = eq[eq.length - 1];

  // 3-band compressor (crossovers at 200 Hz and 3 kHz, 4th-order Linkwitz-Riley), in parallel with a dry path.
  const dry = gain(1), wet = gain(0), limiterIn = gain();
  eqOut.connect(dry); dry.connect(limiterIn);
  const lr = (type, f) => { const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter(); a.type = b.type = type; a.frequency.value = b.frequency.value = f; a.Q.value = b.Q.value = Math.SQRT1_2; a.connect(b); return [a, b]; };
  const comp = () => { const c = ctx.createDynamicsCompressor(); c.threshold.value = -24; c.knee.value = 6; c.ratio.value = 3; c.attack.value = 0.01; c.release.value = 0.25; return c; };
  const mb = { low: comp(), mid: comp(), high: comp() };
  const mbMake = { low: gain(), mid: gain(), high: gain() };
  {
    const [l1, l2] = lr('lowpass', 200); eqOut.connect(l1); l2.connect(mb.low);
    const [h1, h2] = lr('highpass', 200), [m1, m2] = lr('lowpass', 3000); eqOut.connect(h1); h2.connect(m1); m2.connect(mb.mid);
    const [t1, t2] = lr('highpass', 3000); eqOut.connect(t1); t2.connect(mb.high);
    for (const k of ['low', 'mid', 'high']) { mb[k].connect(mbMake[k]); mbMake[k].connect(wet); }
    wet.connect(limiterIn);
  }
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.15;
  const limiterBypass = gain(0), limiterOn = gain(1);
  // Spatial enhancer: mid/side widener. Side (the difference between left and right) is turned up to
  // widen, or down to narrow (0% = mono). Bass in the side signal is never widened, so the low end stays centred.
  //   mid  = (L + R) / 2      side = (L - R) / 2      L' = mid + side·w      R' = mid - side·w
  const wideOut = gain(), spDry = gain(1), spWet = gain(0);
  limiterIn.connect(spDry); spDry.connect(wideOut);
  {
    const split = ctx.createChannelSplitter(2), out = ctx.createChannelMerger(2);
    const mid = gain(), side = gain();
    const lToMid = gain(0.5), rToMid = gain(0.5), lToSide = gain(0.5), rToSide = gain(-0.5);
    const toStereo = stereo(); limiterIn.connect(toStereo); toStereo.connect(split);
    split.connect(lToMid, 0); split.connect(rToMid, 1); split.connect(lToSide, 0); split.connect(rToSide, 1);
    lToMid.connect(mid); rToMid.connect(mid); lToSide.connect(side); rToSide.connect(side);
    // side·all + highpass(side)·extra: exactly the side signal at 100%, with only the part above 150 Hz pushed wider beyond that
    const sideHigh = ctx.createBiquadFilter(); sideHigh.type = 'highpass'; sideHigh.frequency.value = 150; sideHigh.Q.value = Math.SQRT1_2;
    const allW = gain(1), extraW = gain(0), sideSum = gain(), sideInv = gain(-1);
    side.connect(allW); side.connect(sideHigh); sideHigh.connect(extraW); allW.connect(sideSum); extraW.connect(sideSum);
    mid.connect(out, 0, 0); mid.connect(out, 0, 1);
    sideSum.connect(out, 0, 0); sideSum.connect(sideInv); sideInv.connect(out, 0, 1);
    out.connect(spWet); spWet.connect(wideOut);
    var spatial = { allW, extraW };
  }
  wideOut.connect(limiter); limiter.connect(limiterOn); wideOut.connect(limiterBypass);
  const master = gain();
  limiterOn.connect(master); limiterBypass.connect(master);
  const testBus = gain(); testBus.connect(master);
  const splitter = ctx.createChannelSplitter(2), merger = ctx.createChannelMerger(2);
  const balL = gain(), balR = gain();
  const masterStereo = stereo(); master.connect(masterStereo); masterStereo.connect(splitter); splitter.connect(balL, 0); splitter.connect(balR, 1); balL.connect(merger, 0, 0); balR.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  // What the audience hears, for live streaming: the exact samples, taken on the audio thread (see stream-tap-worklet.js).
  let tapNode = null, tapCb = null;
  async function pcmTapStart(cb) {
    if (!tapNode) {
      await ctx.audioWorklet.addModule('js/stream-tap-worklet.js');
      tapNode = new AudioWorkletNode(ctx, 'stream-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      merger.connect(tapNode);
      const silent = gain(0); tapNode.connect(silent); silent.connect(ctx.destination); // keeps the tap running
      tapNode.port.onmessage = e => { if (tapCb) tapCb(e.data); };
    }
    tapCb = cb;
    tapNode.port.postMessage({ on: true });
  }
  function pcmTapStop() { tapCb = null; if (tapNode) tapNode.port.postMessage({ on: false }); }
  const anL = ctx.createAnalyser(), anR = ctx.createAnalyser(); anL.fftSize = anR.fftSize = 2048;
  balL.connect(anL); balR.connect(anR);
  const bufL = new Float32Array(anL.fftSize), bufR = new Float32Array(anR.fftSize);

  // smooth parameter change, never a click
  const ramp = (param, v, t = 0.05) => { const n = now(); param.cancelScheduledValues(n); param.setValueAtTime(param.value, n); param.linearRampToValueAtTime(v, n + t); };

  /* ---------- decks ---------- */
  class Deck {
    constructor(name, el, bus) {
      this.name = name; this.el = el; this.track = null; this.url = '';
      this.src = ctx.createMediaElementSource(el);
      this.trim = gain(); this.fader = gain(0);
      this.src.connect(this.trim); this.trim.connect(this.fader); this.fader.connect(bus || program);
      this.fadeEnd = 0; this.onError = null;
      el.preload = 'auto';
      el.addEventListener('error', () => { if (this.url && this.onError) this.onError(this, el.error); });
    }
    get playing() { return !this.el.paused && !this.el.ended; }
    get time() { return this.el.currentTime || 0; }
    // Loads a file and waits until it can play. Rejects after a timeout so a bad file can't hang the show.
    load(track, url, trimDb, startAt = 0) {
      this.track = track; this.url = url;
      this.trim.gain.value = db2g(trimDb || 0);
      const el = this.el;
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (ok, err) => { if (done) return; done = true; clearTimeout(timer); el.removeEventListener('canplay', onReady); el.removeEventListener('error', onErr); ok ? resolve() : reject(err); };
        const onReady = () => {
          if (startAt > 0 && Math.abs(el.currentTime - startAt) > 0.05) { el.currentTime = startAt; return; } // wait for the seek's canplay
          finish(true);
        };
        const onErr = () => finish(false, new Error(el.error ? `Can't play this file (${['', 'aborted', 'network', 'decode', 'unsupported format'][el.error.code] || el.error.code})` : "Can't play this file"));
        const timer = setTimeout(() => finish(false, new Error('The file took too long to load.')), 12000);
        el.addEventListener('canplay', onReady); el.addEventListener('error', onErr);
        if (el.src !== url) { el.src = url; el.load(); }
        else if (el.readyState >= 3) { if (startAt > 0 || el.currentTime > 0) { el.currentTime = startAt; } else onReady(); }
        else el.load();
      });
    }
    async play(level = 1, fadeIn = 0) {
      this.token = (this.token || 0) + 1; clearTimeout(this.stopTimer);
      const n = now();
      this.fader.gain.cancelScheduledValues(n);
      if (fadeIn > 0) { this.fader.gain.setValueAtTime(0, n); this.fade(level, fadeIn, 'in'); }
      else this.fader.gain.setValueAtTime(level, n);
      await this.el.play();
    }
    // Fades to a level. Equal-power curves for crossfades so the mix doesn't dip in the middle.
    fade(to, sec, shape = 'lin') {
      const n = now(), p = this.fader.gain, from = p.value;
      p.cancelScheduledValues(n);
      if (sec <= 0.01) { p.setValueAtTime(to, n); this.fadeEnd = n; return; }
      const steps = 64, curve = new Float32Array(steps);
      for (let i = 0; i < steps; i++) {
        const x = i / (steps - 1);
        const w = shape === 'in' ? Math.sin(x * Math.PI / 2) : shape === 'out' ? Math.cos((1 - x) * Math.PI / 2) : x;
        curve[i] = shape === 'out' ? to + (from - to) * Math.cos(x * Math.PI / 2) : from + (to - from) * w;
      }
      p.setValueAtTime(from, n);
      try { p.setValueCurveAtTime(curve, n + 0.001, sec); } catch (_) { p.linearRampToValueAtTime(to, n + sec); }
      this.fadeEnd = n + sec;
    }
    pause() { this.el.pause(); }
    resume() { return this.el.play(); }
    // Stops with a tiny fade so there's no click. A play() before the fade ends cancels the stop.
    stop(fadeSec = 0.04) {
      const token = this.token = (this.token || 0) + 1;
      this.fade(0, fadeSec);
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => { if (this.token === token) this.el.pause(); }, fadeSec * 1000 + 40);
    }
    unload() { clearTimeout(this.stopTimer); this.el.pause(); this.el.removeAttribute('src'); this.el.load(); this.track = null; this.url = ''; this.fader.gain.value = 0; }
  }

  /* ---------- hot sounds with ducking ---------- */
  const hot = new Map(); // id -> { src, g }
  let duckDb = -12;
  function updateDuck() {
    const ducking = [...hot.values()].some(h => h.duck);
    const target = ducking ? db2g(duckDb) : 1;
    const n = now(); duck.gain.cancelScheduledValues(n); duck.gain.setValueAtTime(duck.gain.value, n);
    duck.gain.linearRampToValueAtTime(target, n + (ducking ? 0.15 : 0.8));
  }
  function playHot(id, buffer, levelDb = 0, onEnd, duckIt = true) {
    stopHot(id, 0.02);
    const src = ctx.createBufferSource(); src.buffer = buffer;
    const g = gain(db2g(levelDb)); src.connect(g); g.connect(hotBus);
    const item = { src, g, duck: duckIt, started: now() + 0.02, dur: buffer.duration }; hot.set(id, item);
    src.onended = () => { if (hot.get(id) === item) { hot.delete(id); updateDuck(); } try { g.disconnect(); } catch (_) {} if (onEnd) onEnd(); };
    updateDuck();
    src.start(now() + 0.02);
  }
  function stopHot(id, fadeSec = 0.15) {
    const item = hot.get(id); if (!item) return;
    hot.delete(id);
    ramp(item.g.gain, 0, fadeSec);
    try { item.src.stop(now() + fadeSec + 0.01); } catch (_) {}
    updateDuck();
  }
  const hotPlaying = id => hot.has(id);
  const hotProgress = id => { const h = hot.get(id); return h ? Math.max(0, Math.min(1, (now() - h.started) / h.dur)) : 0; };

  /* ---------- test signals ---------- */
  let testNodes = [];
  function pinkNoise(seconds = 8) {
    const n = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, sum = 0;
    for (let i = 0; i < n; i++) { // Paul Kellet's pink filter
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926; sum += d[i] * d[i];
    }
    const k = 0.25 / Math.sqrt(sum / n); // -12 dBFS RMS, so peaks rarely reach full scale; the level gain adds the rest
    for (let i = 0; i < n; i++) d[i] = Math.max(-1, Math.min(1, d[i] * k));
    return b;
  }
  let pinkBuf = null;
  // kind: tone | pink | sweep | voice ; channel: L | R | both | phase ; levelDb: RMS level in dBFS
  function testStart(kind, channel = 'both', levelDb = -20) {
    testStop();
    let src;
    if (kind === 'pink') { pinkBuf = pinkBuf || pinkNoise(); src = ctx.createBufferSource(); src.buffer = pinkBuf; src.loop = true; }
    else {
      src = ctx.createOscillator(); src.type = 'sine';
      if (kind === 'sweep') { src.frequency.setValueAtTime(20, now()); src.frequency.exponentialRampToValueAtTime(20000, now() + 12); }
      else src.frequency.value = kind === 'low' ? 60 : 1000;
    }
    const lvl = gain(kind === 'pink' ? db2g(levelDb + 12.04) : db2g(levelDb) * Math.SQRT2); // sine: peak = RMS × √2
    const merge = ctx.createChannelMerger(2);
    src.connect(lvl);
    if (channel === 'L' || channel === 'both' || channel === 'phase') lvl.connect(merge, 0, 0);
    if (channel === 'R' || channel === 'both') lvl.connect(merge, 0, 1);
    let inv = null;
    if (channel === 'phase') { inv = gain(-1); lvl.connect(inv); inv.connect(merge, 0, 1); }
    const env = gain(0); merge.connect(env); env.connect(testBus);
    ramp(env.gain, 1, 0.05);
    src.start();
    if (kind === 'sweep') src.stop(now() + 12.2);
    testNodes = [src, lvl, merge, env, inv].filter(Boolean);
    testNodes.env = env;
    return src;
  }
  function testStop() {
    const nodes = testNodes; testNodes = [];
    if (!nodes.length) return;
    ramp(nodes.env.gain, 0, 0.05);
    setTimeout(() => nodes.forEach(n => { try { n.stop && n.stop(); } catch (_) {} try { n.disconnect(); } catch (_) {} }), 120);
  }

  /* ---------- microphone (PA calibration) ---------- */
  let mic = null;
  async function micStart(deviceId) {
    micStop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 4096; src.connect(an);
    mic = { stream, src, an, buf: new Float32Array(an.fftSize), smooth: -100 };
    return true;
  }
  function micLevel() {
    if (!mic) return null;
    mic.an.getFloatTimeDomainData(mic.buf);
    let s = 0; for (const v of mic.buf) s += v * v;
    const db = g2db(Math.sqrt(s / mic.buf.length));
    mic.smooth = mic.smooth < -99 ? db : mic.smooth * 0.9 + db * 0.1;
    return { now: db, avg: mic.smooth };
  }
  function micStop() { if (!mic) return; mic.stream.getTracks().forEach(t => t.stop()); try { mic.src.disconnect(); } catch (_) {} mic = null; }

  /* ---------- meters ---------- */
  const meter = { peakL: -90, peakR: -90, holdL: -90, holdR: -90, holdT: 0 };
  function meters() {
    anL.getFloatTimeDomainData(bufL); anR.getFloatTimeDomainData(bufR);
    let pl = 0, pr = 0, sl = 0, sr = 0;
    for (let i = 0; i < bufL.length; i++) { const a = bufL[i], b = bufR[i]; sl += a * a; sr += b * b; const aa = Math.abs(a), bb = Math.abs(b); if (aa > pl) pl = aa; if (bb > pr) pr = bb; }
    const PL = g2db(pl), PR = g2db(pr);
    meter.peakL = Math.max(PL, meter.peakL - 1.2); meter.peakR = Math.max(PR, meter.peakR - 1.2);
    const t = performance.now();
    if (PL > meter.holdL || PR > meter.holdR || t - meter.holdT > 1500) { meter.holdL = Math.max(PL, t - meter.holdT > 1500 ? -90 : meter.holdL); meter.holdR = Math.max(PR, t - meter.holdT > 1500 ? -90 : meter.holdR); meter.holdT = t; }
    return { peakL: meter.peakL, peakR: meter.peakR, rmsL: g2db(Math.sqrt(sl / bufL.length)), rmsR: g2db(Math.sqrt(sr / bufR.length)), holdL: meter.holdL, holdR: meter.holdR, gr: limiter.reduction || 0 };
  }

  /* ---------- settings ---------- */
  function apply(s) {
    s = s || {};
    const eqOn = s.eqOn !== false;
    (s.eq || [0, 0, 0, 0, 0]).forEach((v, i) => { if (eq[i]) ramp(eq[i].gain, eqOn ? Math.max(-12, Math.min(12, +v || 0)) : 0, 0.1); });
    ramp(hpf.frequency, s.hpf ? 60 : 20, 0.1);
    const mbOn = !!s.mbOn;
    ramp(dry.gain, mbOn ? 0 : 1, 0.08); ramp(wet.gain, mbOn ? 1 : 0, 0.08);
    const amt = Math.max(0, Math.min(3, s.mbAmount == null ? 1 : +s.mbAmount)); // 0 gentle … 3 strong
    for (const [k, c] of Object.entries(mb)) {
      c.threshold.value = -12 - 6 * amt - (k === 'mid' ? 0 : 2); c.ratio.value = 1.5 + amt; c.attack.value = k === 'low' ? 0.03 : k === 'mid' ? 0.012 : 0.004; c.release.value = k === 'low' ? 0.35 : 0.2;
      mbMake[k].gain.value = db2g(1.5 * amt);
    }
    // spatial enhancer
    const spOn = !!s.spatialOn, w = Math.max(0, Math.min(2, s.width == null ? 1.4 : +s.width)), bassC = s.bassCentre !== false;
    ramp(spDry.gain, spOn ? 0 : 1, 0.08); ramp(spWet.gain, spOn ? 1 : 0, 0.08);
    // With "keep bass centred", side bass is never widened past 100% (it can still be narrowed). Without it, all of the side signal follows the width.
    ramp(spatial.allW.gain, bassC ? Math.min(1, w) : w, 0.1);
    ramp(spatial.extraW.gain, bassC ? Math.max(0, w - 1) : 0, 0.1);
    const limOn = s.limiterOn !== false;
    limiter.threshold.value = Math.max(-12, Math.min(0, s.ceiling == null ? -1.5 : +s.ceiling));
    ramp(limiterOn.gain, limOn ? 1 : 0, 0.05); ramp(limiterBypass.gain, limOn ? 0 : 1, 0.05);
    ramp(master.gain, db2g(Math.max(-60, Math.min(12, +s.masterDb || 0))), 0.1);
    const bal = Math.max(-1, Math.min(1, +s.balance || 0)); // -1 left … +1 right
    const trimL = db2g(+s.trimL || 0), trimR = db2g(+s.trimR || 0);
    ramp(balL.gain, trimL * (bal > 0 ? 1 - bal : 1), 0.1); ramp(balR.gain, trimR * (bal < 0 ? 1 + bal : 1), 0.1);
    duckDb = Math.max(-40, Math.min(0, s.duckDb == null ? -12 : +s.duckDb));
    ramp(hotBus.gain, db2g(+s.hotDb || 0), 0.1);
    updateDuck();
  }
  const setMasterDb = db => ramp(master.gain, db2g(db), 0.2);

  /* ---------- output device ---------- */
  async function outputs() {
    let list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    return list.map(d => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : 'Output ' + d.deviceId.slice(0, 6)) }));
  }
  async function inputs() {
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Microphone ' + d.deviceId.slice(0, 6) }));
  }
  let sinkId = '';
  async function setOutput(id) {
    if (typeof ctx.setSinkId !== 'function') return false;
    await ctx.setSinkId(id && id !== 'default' ? id : '');
    sinkId = id || '';
    return true;
  }

  /* ---------- analysis ---------- */
  let worker = null, wid = 0;
  const waiting = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('js/loudness-worker.js');
    worker.onmessage = e => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data); } };
    worker.onerror = e => { waiting.forEach(w => w.reject(new Error('Analysis stopped: ' + (e.message || 'worker error')))); waiting.clear(); worker = null; };
    return worker;
  }
  // Decodes a file and measures it. Returns { lufs, peak, peaks, duration }, and the decoded buffer if keep is set (for hot sounds).
  async function analyze(url, { keep = false, maxBytes = 700 * 1024 * 1024 } = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('File not found');
    const len = +res.headers.get('content-length') || 0;
    if (len > maxBytes) { res.body && res.body.cancel(); throw new Error('too-large'); }
    const data = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(data);
    const channels = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(new Float32Array(buf.getChannelData(c)));
    const id = ++wid;
    const result = await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      getWorker().postMessage({ id, rate: buf.sampleRate, channels, buckets: 2400 }, channels.map(c => c.buffer));
    });
    if (keep) result.buffer = buf;
    return result;
  }
  async function decode(url) { const res = await fetch(url); if (!res.ok) throw new Error('File not found'); return ctx.decodeAudioData(await res.arrayBuffer()); }

  // Keeps the audio running: Chromium can suspend a context after device changes.
  setInterval(() => { if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {}); }, 1000);

  return { ctx, Deck, program, db2g, g2db, ramp, apply, setMasterDb, playHot, stopHot, hotPlaying, hotProgress, testStart, testStop, micStart, micLevel, micStop, meters,
    outputs, inputs, setOutput, pcmTapStart, pcmTapStop, get sinkId() { return sinkId; }, analyze, decode, duckGain: duck, master, EQ_BANDS };
})();
