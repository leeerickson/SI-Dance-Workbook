// Recital Show Player: the show. Playlist, transport (GO / fade / crossfade / straight on),
// cues, props, hot sounds, pre-show music, preflight, test and calibration, phones, recovery.
// Every handler is wrapped so a mistake in one place logs and carries on instead of stopping the music.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const desk = window.desk;
  const E = Engine;

  /* ---------- small helpers ---------- */
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (sec, tenths = false) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    const t = tenths ? '.' + Math.floor(sec * 10 % 10) : '';
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}${t}`;
  };
  const parseTime = str => {
    str = String(str || '').trim(); if (!str) return 0;
    const parts = str.split(':').map(Number); if (parts.some(isNaN)) return NaN;
    return parts.reduce((a, v) => a * 60 + v, 0);
  };
  const mediaUrl = p => 'show://media/' + btoa(unescape(encodeURIComponent(p))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), safe(v)); else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const log = (...a) => { try { desk.log(...a); } catch (_) {} };
  function safe(fn) { return function (...args) { try { const r = fn.apply(this, args); if (r && r.catch) r.catch(oops); return r; } catch (err) { oops(err); } }; }
  function oops(err) { console.error(err); log('error', String(err && err.stack || err)); toast('Something went wrong (it has been logged). The show keeps running.'); }
  window.addEventListener('error', e => log('page error', e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', e => log('page rejection', String(e.reason && e.reason.stack || e.reason)));
  const on = (el, ev, fn) => (typeof el === 'string' ? $(el) : el).addEventListener(ev, safe(fn));
  let toastTimer = 0;
  function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms); }
  function banner(id, text, level = 'warn', actions = []) {
    let b = document.querySelector(`.banner[data-id="${id}"]`);
    if (!b) { b = h('div', { class: 'banner', 'data-id': id }); $('banners').append(b); }
    b.className = 'banner' + (level === 'info' ? ' info' : '');
    b.replaceChildren(h('span', { style: 'flex:1' }, text), ...actions.map(a => h('button', { class: 'btn small', onclick: a.fn }, a.label)), h('button', { class: 'btn small', onclick: () => b.remove() }, 'Dismiss'));
  }
  const unbanner = id => { const b = document.querySelector(`.banner[data-id="${id}"]`); if (b) b.remove(); };
  const b64FromI8 = arr => { let s = ''; const u = new Uint8Array(Int8Array.from(arr).buffer); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const i8FromB64 = str => { const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Int8Array(u.buffer); };

  /* ---------- state ---------- */
  const DEFAULTS = {
    outputId: '', normalize: true, targetLufs: -16, maxBoost: 12, limiterOn: true, ceiling: -1.5, masterDb: 0, balance: 0, trimL: 0, trimR: 0,
    eqOn: true, eq: [0, 0, 0, 0, 0], hpf: false, mbOn: false, mbAmount: 1, defTrans: 'stop', xfade: 5, fadeSec: 3, fadeOutSec: 3, cueWarn: 10,
    fillerAuto: true, autoResume: true, duckDb: -12, hotDb: 0, wpCode: '', wpOn: false, micOffset: null, calTarget: 85
  };
  const newShow = () => ({ id: uid(), name: 'Recital', tracks: [], filler: [], fillerOpts: { loop: true, shuffle: false, levelDb: -6 }, hotCues: Array(8).fill(null) });
  const S = {
    settings: { ...DEFAULTS }, show: newShow(), filePath: null, dirty: false, selectedId: null,
    live: { state: 'idle', currentId: null, standbyId: null, nextId: null, played: new Set(), lastCue: null, lastPos: 0, busy: false, fadingOut: false, xfade: null, endsAt: 0 },
    phones: { message: '', intermissionEnds: 0 }
  };
  const tracks = () => S.show.tracks;
  const byId = id => tracks().find(t => t.id === id) || null;
  const enabled = () => tracks().filter(t => t.enabled);
  const numberOf = t => enabled().indexOf(t) + 1;
  const effStart = t => clamp(+t.startAt || 0, 0, Math.max(0, (t.duration || 0) - 0.5));
  const effEnd = t => { const d = t.duration || (t.an && t.an.duration) || 0; return t.endAt > 0 && t.endAt < d ? t.endAt : d; };
  const effLen = t => Math.max(0, effEnd(t) - effStart(t));
  const label = t => t ? (t.dance || t.title || t.name) : '';
  function gainFor(t) {
    let g = +t.trimDb || 0;
    if (S.settings.normalize && t.an && t.an.lufs > -70) g += clamp(S.settings.targetLufs - t.an.lufs, -30, S.settings.maxBoost);
    return clamp(g, -40, 24);
  }
  // The song after this one: the one marked "play this next", otherwise the next one included in the show.
  function nextAfter(id) {
    const L = S.live;
    if (L.nextId && L.nextId !== id) { const n = byId(L.nextId); if (n && n.enabled) return n; }
    const list = tracks(); let i = list.findIndex(t => t.id === id);
    for (let k = i + 1; k < list.length; k++) if (list[k].enabled) return list[k];
    return null;
  }
  const firstTrack = () => enabled()[0] || null;

  /* ---------- decks ---------- */
  const mkVideo = () => { const v = document.createElement('video'); v.playsInline = true; v.disablePictureInPicture = true; $('deckHost').append(v); return v; };
  const decks = [new E.Deck('A', mkVideo()), new E.Deck('B', mkVideo())];
  const fillerBus = E.ctx.createGain(); fillerBus.connect(E.program);
  const fillerDeck = new E.Deck('F', document.createElement('audio'), fillerBus);
  let active = null;        // deck playing the current song
  let preload = { deck: null, id: null, promise: null };
  decks.forEach(d => { d.onError = (deck, err) => deckError(deck, err); });
  fillerDeck.onError = () => { log('filler error', fillerDeck.url); setTimeout(safe(fillerNext), 500); };
  const freeDeck = () => decks.find(d => d !== active && !(S.live.xfade && S.live.xfade.from === d)) || decks.find(d => d !== active);

  /* ---------- settings ---------- */
  function applySettings() {
    E.apply(S.settings);
    fillerBus.gain.value = E.db2g(S.show.fillerOpts.levelDb);
    if (active && active.track) E.ramp(active.trim.gain, E.db2g(gainFor(active.track)), 0.3);
  }
  let settingsTimer = 0;
  function saveSettings() { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => desk.writeSettings(S.settings).catch(oops), 400); }

  /* ---------- dirty / autosave ---------- */
  let autoTimer = 0, programTimer = 0;
  function changed(opts = {}) {
    if (!opts.quiet) { S.dirty = true; $('dirty').hidden = false; }
    clearTimeout(autoTimer); autoTimer = setTimeout(autosave, 700);
    clearTimeout(programTimer); programTimer = setTimeout(pushProgram, 1200);
  }
  async function autosave() { try { await desk.writeAutosave({ show: S.show, filePath: S.filePath, dirty: S.dirty }); } catch (err) { log('autosave failed', String(err)); } }

  /* ---------- adding media ---------- */
  const isVideo = name => /\.(mp4|m4v|mov|webm|mkv)$/i.test(name);
  function makeTrack(info) {
    const base = info.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/^\d{1,3}[\s.\-]+/, '').trim();
    return { id: uid(), path: info.path, name: info.name, title: base || info.name, dance: '', cls: '', notes: '', type: isVideo(info.name) ? 'video' : 'audio',
      transition: S.settings.defTrans, xfade: S.settings.xfade, trimDb: 0, startAt: 0, endAt: 0, enabled: true, showProps: true, props: [], cues: [],
      sig: { size: info.size, mtime: info.mtime }, an: null, duration: 0 };
  }
  async function addFiles(list, where = 'show', index = null) {
    const infos = (list || []).filter(i => i && i.exists !== false && i.path);
    if (!infos.length) return;
    const made = infos.map(makeTrack);
    if (where === 'show') {
      const arr = tracks(); const at = index == null ? arr.length : clamp(index, 0, arr.length);
      arr.splice(at, 0, ...made);
      if (!S.selectedId) S.selectedId = made[0].id;
    } else {
      made.forEach(t => { t.transition = 'straight'; });
      S.show.filler.splice(index == null ? S.show.filler.length : index, 0, ...made);
    }
    made.forEach(t => queueAnalysis(t));
    changed(); renderLists(); renderInspector();
    toast(`Added ${made.length} file${made.length > 1 ? 's' : ''}. Measuring loudness…`);
  }
  async function pathsToInfos(paths) { return (await desk.statMedia(paths)).filter(i => i.exists); }

  /* ---------- loudness + waveform analysis (one at a time, in the background) ---------- */
  const queue = []; let analysing = false;
  const sigOk = (t, info) => t.sig && info && t.sig.size === info.size && Math.abs((t.sig.mtime || 0) - (info.mtime || 0)) < 2000;
  function queueAnalysis(item, opts = {}) { if (!queue.includes(item)) queue.push(item); if (opts.buffer) item._wantBuffer = true; runQueue(); }
  async function runQueue() {
    if (analysing) return;
    analysing = true;
    try {
      while (queue.length) {
        const t = queue.shift();
        try {
          const [info] = await desk.statMedia([t.path]);
          if (!info.exists) { t.missing = true; continue; }
          t.missing = false;
          const wantBuf = t._wantBuffer; delete t._wantBuffer;
          if (t.an && t.an.peaks && sigOk(t, info) && !wantBuf) continue;
          if (t.an && sigOk(t, info) && wantBuf) { await loadHotBuffer(t); continue; }
          const r = await E.analyze(mediaUrl(t.path), { keep: wantBuf });
          t.an = { lufs: r.lufs, peak: r.peak, peaks: b64FromI8(r.peaks), duration: r.duration };
          t.duration = t.duration || r.duration;
          t.sig = { size: info.size, mtime: info.mtime }; t.anError = '';
          if (r.buffer) hotBuffers.set(t.id, r.buffer);
          if (active && active.track === t) E.ramp(active.trim.gain, E.db2g(gainFor(t)), 0.5);
        } catch (err) {
          t.anError = err.message === 'too-large' ? 'Too big to measure; set the volume trim by ear.' : `Couldn't measure: ${err.message}`;
          if (!t.duration) { const p = await probe(t.path).catch(() => null); if (p) { t.duration = p.duration; if (p.video) t.type = 'video'; } }
          log('analysis failed', t.name, err.message);
        }
        changed({ quiet: true }); renderListsSoon(); if (S.selectedId === t.id) renderInspector();
        await new Promise(r => setTimeout(r, 30));
      }
    } finally { analysing = false; }
  }
  // Opens just the file's header to check it plays and get its length. Times out so a bad file can't hang anything.
  function probe(p, timeout = 9000) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
      const done = (ok, val) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); ok ? resolve(val) : reject(val); };
      const timer = setTimeout(() => done(false, new Error('took too long to open')), timeout);
      v.onloadedmetadata = () => done(true, { duration: v.duration, video: v.videoWidth > 0, w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => done(false, new Error(v.error && v.error.code === 4 ? 'format not supported' : 'could not be read'));
      v.src = mediaUrl(p);
    });
  }

  /* ---------- transport ---------- */
  let lastGo = 0;
  function setState(st) { S.live.state = st; renderTransport(); renderListsSoon(); pushStatus(true); snapshot(); }

  async function go() {
    if (Date.now() - lastGo < 600 || S.live.busy) return; // a double press can't skip a song
    lastGo = Date.now();
    const L = S.live;
    if (L.state === 'playing') { toast('Already playing. Press F to fade into the next song, or Esc to fade out.'); return; }
    if (L.state === 'paused') return resume();
    let t = byId(L.standbyId);
    if (!t || !t.enabled) t = L.state === 'idle' ? firstTrack() : null;
    if (!t) { toast(tracks().length ? 'Nothing is standing by. Click a song and choose "Play this next".' : 'Add songs to the show first.'); return; }
    if (fillerState.playing && S.settings.fillerAuto) fillerFadeOut(2.5);
    await startTrack(t);
  }

  // Starts a song on the free deck. With xfade, the current song fades out while this one fades in.
  async function startTrack(t, { xfade = 0, at = null, fadeIn = 0 } = {}) {
    const L = S.live;
    L.busy = true; renderTransport();
    const deck = preload.id === t.id && preload.deck && preload.deck !== active ? preload.deck : freeDeck();
    try {
      if (!(preload.id === t.id && preload.deck === deck && at == null)) await loadDeck(deck, t, at != null ? at : effStart(t));
      else await preload.promise;
      preload = { deck: null, id: null, promise: null };
      const outgoing = active;
      if (outgoing && outgoing !== deck) {
        if (xfade > 0) { outgoing.fade(0, xfade, 'out'); L.xfade = { from: outgoing, until: E.ctx.currentTime + xfade }; setTimeout(safe(() => finishXfade(outgoing)), xfade * 1000 + 80); }
        else outgoing.stop(0.03);
      }
      E.ramp(deck.trim.gain, E.db2g(gainFor(t)), 0.01);
      await deck.play(1, xfade > 0 ? xfade : fadeIn);
      active = deck;
      L.currentId = t.id; L.standbyId = null; if (L.nextId === t.id) L.nextId = null;
      L.played.add(t.id); L.lastPos = deck.time; L.fadingOut = false; L.lastCue = null;
      stall.t = deck.time; stall.at = performance.now();
      showVideo();
      setState('playing');
      log('play', numberOf(t), label(t), xfade ? `crossfade ${xfade}s` : '');
    } catch (err) {
      log('start failed', t.name, err.message);
      banner('play-' + t.id, `Couldn't play “${label(t)}”: ${err.message}. Check the file, or pick another song.`);
      if (!active || !active.playing) { L.standbyId = t.id; setState('standby'); }
    } finally { L.busy = false; renderTransport(); }
  }
  async function loadDeck(deck, t, startAt) {
    if (!t.path) throw new Error('no file');
    await deck.load(t, mediaUrl(t.path), gainFor(t), startAt);
    if (!t.duration && deck.el.duration) t.duration = deck.el.duration;
    if (deck.el.videoWidth > 0 && t.type !== 'video') { t.type = 'video'; changed({ quiet: true }); }
  }
  function finishXfade(deck) {
    if (S.live.xfade && S.live.xfade.from === deck) S.live.xfade = null;
    if (deck !== active) { deck.stop(0.02); }
    showVideo();
  }
  // Fade to next (F): crossfade into the next song right now.
  async function fadeToNext() {
    const L = S.live;
    if (L.state !== 'playing' || L.busy || L.xfade) { if (L.state === 'standby') toast('Press GO (Space) to start the song that is standing by.'); return; }
    const next = nextAfter(L.currentId);
    if (!next) return fadeOut();
    await startTrack(next, { xfade: S.settings.fadeSec });
  }
  // Fade out (Esc): fade the music away, then stand by on the next song.
  function fadeOut() {
    const L = S.live;
    if (!active || (L.state !== 'playing' && L.state !== 'paused') || L.fadingOut) return;
    const cur = byId(L.currentId), sec = S.settings.fadeOutSec, deck = active;
    if (L.state === 'paused') { stopNow(false); return; }
    L.fadingOut = true; deck.fade(0, sec, 'out'); renderTransport();
    setTimeout(safe(() => { if (active === deck && L.fadingOut) { deck.stop(0.02); endOf(cur); } }), sec * 1000 + 50);
  }
  // Stop (Shift+Esc): stop at once. Stand by on the same song (to restart it) unless told otherwise.
  function stopNow(sameSong = true) {
    const L = S.live, cur = byId(L.currentId);
    decks.forEach(d => d.stop(0.05));
    L.xfade = null; L.fadingOut = false;
    if (sameSong && cur) { L.standbyId = cur.id; L.currentId = null; active = null; setState('standby'); }
    else endOf(cur);
    showVideo();
  }
  function pause() {
    const L = S.live;
    if (L.state !== 'playing') return L.state === 'paused' ? resume() : undefined;
    if (L.xfade) finishXfade(L.xfade.from);
    if (L.fadingOut) { stopNow(false); return; }
    active && active.pause();
    setState('paused');
  }
  async function resume() { if (S.live.state !== 'paused' || !active) return; await active.resume(); stall.at = performance.now(); setState('playing'); }
  // The song finished (or was faded out): stand by on the next, or the show is over.
  function endOf(t) {
    const L = S.live;
    const next = t ? nextAfter(t.id) : null;
    if (active) { active.stop(0.02); }
    active = null; L.currentId = null; L.fadingOut = false;
    if (next) { L.standbyId = next.id; setState('standby'); }
    else { L.standbyId = null; setState(t ? 'ended' : 'idle'); }
    showVideo();
  }
  function cueNext(id) {
    const L = S.live, t = byId(id); if (!t) return;
    if (!t.enabled) { t.enabled = true; changed(); }
    if (L.state === 'playing' || L.state === 'paused') { L.nextId = id === L.currentId ? null : id; preload = { deck: null, id: null, promise: null }; toast(`Next: ${label(t)}`); }
    else { L.standbyId = id; if (L.state === 'idle' || L.state === 'ended') L.state = 'standby'; toast(`Standing by: ${label(t)}. Press GO.`); }
    renderTransport(); renderLists(); pushStatus(true);
  }
  function deckError(deck, err) {
    log('deck error', deck.name, deck.url, err && err.code);
    if (deck === active && S.live.state === 'playing') {
      // Try once to carry on from the same place; if that fails, stand by on the next song.
      const t = deck.track, pos = deck.time;
      if (!deck._retried) {
        deck._retried = true;
        banner('deck', `Playback problem on “${label(t)}”. Trying to carry on…`);
        loadDeck(deck, t, pos).then(() => deck.play(1, 0.2)).then(() => { deck._retried = false; unbanner('deck'); }).catch(() => { banner('deck', `“${label(t)}” stopped: the file couldn't be read. Standing by on the next song.`); endOf(t); });
      }
    }
  }

  /* ---------- the clock: transitions, cues, stalls ---------- */
  const stall = { t: 0, at: 0, warned: false };
  function tick() {
    const L = S.live;
    if (L.state !== 'playing' || !active || !active.track || L.busy) return;
    const t = active.track, pos = active.time, end = effEnd(t), left = end - pos;
    // cues crossed since the last tick
    if (pos >= L.lastPos && pos - L.lastPos < 1.5) {
      for (const c of t.cues) if (c.t > L.lastPos && c.t <= pos) fireCue(t, c);
    }
    L.lastPos = pos;
    // stall watchdog: the clock should move while playing
    const nowMs = performance.now();
    if (Math.abs(pos - stall.t) > 0.001) { stall.t = pos; stall.at = nowMs; if (stall.warned) { stall.warned = false; unbanner('stall'); } }
    else if (nowMs - stall.at > 1500 && !active.el.paused) {
      if (!stall.warned) { stall.warned = true; log('stall', label(t), pos); banner('stall', `“${label(t)}” seems stuck at ${fmt(pos)}. Trying to restart it…`); active.el.play().catch(() => {}); }
      if (nowMs - stall.at > 5000) { stall.at = nowMs; active.el.currentTime = pos + 0.05; active.el.play().catch(() => {}); }
    }
    if (L.fadingOut || L.xfade) { if (left <= 0.02 || active.el.ended) { if (!L.xfade) endOf(t); } return; }
    const next = nextAfter(t.id);
    // get the next song ready on the other deck
    if (next && (preload.id !== next.id) && left < 45 && !L.xfade) {
      const d = freeDeck();
      if (d && d !== active) { const p = loadDeck(d, next, effStart(next)); p.catch(err => { log('preload failed', next.name, err.message); preload = { deck: null, id: null, promise: null }; }); preload = { deck: d, id: next.id, promise: p }; }
    }
    if (next && t.transition === 'crossfade') {
      const xf = clamp(+t.xfade || 5, 0.5, Math.max(0.5, effLen(next) / 2));
      if (left <= xf) { startTrack(next, { xfade: Math.max(0.3, left) }); return; }
    } else if (next && t.transition === 'straight') {
      if (left <= 0.045 || active.el.ended) { startTrack(next); return; }
    }
    if (left <= 0.02 || active.el.ended) {
      if (t.endAt > 0 && !active.el.ended) active.stop(0.04); // a set end point: tiny fade, no click
      endOf(t);
    }
  }
  function fireCue(t, c) {
    S.live.lastCue = { trackId: t.id, cue: c, at: Date.now() };
    const box = $('cueNowBox'); box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
    box.style.setProperty('--cue', `var(--c-${c.type})`);
    renderCues(); pushStatus(true);
  }

  /* ---------- show remaining ---------- */
  function showRemaining() {
    const L = S.live; let total = 0, t = null;
    if ((L.state === 'playing' || L.state === 'paused') && active && active.track) { t = active.track; total += Math.max(0, effEnd(t) - active.time); }
    else { t = byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null); if (!t) return 0; total += effLen(t); }
    const seen = new Set([t.id]);
    let cur = t, n = nextAfter(t.id);
    while (n && !seen.has(n.id)) {
      seen.add(n.id); total += effLen(n);
      if (cur.transition === 'crossfade') total -= Math.min(+cur.xfade || 0, effLen(n) / 2);
      cur = n; n = nextAfter(n.id); if (S.live.nextId && n && n.id === S.live.nextId) n = null; // the "next" override only applies once
    }
    return Math.max(0, total);
  }

  /* ---------- current / next cue ---------- */
  function cueInfo() {
    const L = S.live;
    const cur = active && (L.state === 'playing' || L.state === 'paused') ? active.track : null;
    const pos = cur ? active.time : 0;
    let nextCue = null, nextIn = null, nextTrack = null;
    if (cur) {
      const c = cur.cues.filter(c => c.t > pos).sort((a, b) => a.t - b.t)[0];
      if (c) { nextCue = c; nextIn = c.t - pos; nextTrack = cur; }
      else {
        const nx = nextAfter(cur.id);
        const c2 = nx && nx.cues.slice().sort((a, b) => a.t - b.t).find(c => c.t >= effStart(nx));
        if (c2) { nextCue = c2; nextTrack = nx; nextIn = cur.transition === 'stop' ? null : (effEnd(cur) - pos) + (c2.t - effStart(nx)) - (cur.transition === 'crossfade' ? +cur.xfade || 0 : 0); }
      }
    } else {
      const sb = byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null);
      const c = sb && sb.cues.slice().sort((a, b) => a.t - b.t).find(c => c.t >= effStart(sb));
      if (c) { nextCue = c; nextTrack = sb; nextIn = null; }
    }
    const upcoming = cur ? cur.cues.filter(c => c.t > pos).sort((a, b) => a.t - b.t).slice(0, 8) : [];
    return { cur, pos, nextCue, nextIn, nextTrack, upcoming };
  }

  /* ---------- rendering: playlist ---------- */
  const TR = { stop: 'Wait for GO', straight: 'Straight on', crossfade: 'Crossfade' };
  const TRS = { stop: '■ wait', straight: '→ straight', crossfade: '⤨ xfade' };
  let renderSoon = 0;
  function renderListsSoon() { if (!renderSoon) renderSoon = requestAnimationFrame(() => { renderSoon = 0; renderLists(); }); }
  function renderLists() {
    const L = S.live, list = $('plist');
    const nextT = L.state === 'playing' || L.state === 'paused' ? nextAfter(L.currentId) : null;
    let n = 0;
    const rows = tracks().map(t => {
      if (t.enabled) n++;
      const cls = ['row'];
      if (t.id === S.selectedId) cls.push('sel');
      if (t.id === L.currentId && (L.state === 'playing' || L.state === 'paused')) cls.push('playing');
      else if (t.id === L.standbyId && L.state === 'standby') cls.push('standby');
      else if (nextT && t.id === nextT.id) cls.push('next');
      else if (L.played.has(t.id)) cls.push('done');
      if (!t.enabled) cls.push('off');
      if (t.missing || (t.anError && !t.duration)) cls.push('bad');
      const g = t.an ? `${gainFor(t) >= 0 ? '+' : ''}${gainFor(t).toFixed(1)} dB` : t.anError ? '!' : '…';
      return h('li', { class: cls.join(' '), 'data-id': t.id, draggable: 'true', title: t.path },
        h('span', { class: 'n' }, t.enabled ? n : '–'),
        h('span', { class: 't1' }, label(t), t.type === 'video' ? h('span', { class: 'badge v', style: 'margin-left:6px' }, 'VIDEO') : null, t.missing ? h('span', { class: 'badge', style: 'margin-left:6px;color:var(--warn)' }, 'MISSING') : null),
        h('span', { class: 't2' }, t.dance ? t.title : (t.cls || t.name)),
        h('span', { class: 'meta' }, h('span', null, fmt(effLen(t))), h('span', { class: 'tr' }, TRS[t.transition] || ''), h('span', { title: 'Volume change to even it out' }, g)));
    });
    list.replaceChildren(...rows);
    $('showCount').textContent = enabled().length;
    const tot = enabled().reduce((a, t) => a + effLen(t), 0);
    $('showTotal').textContent = enabled().length ? `${enabled().length} songs · ${fmt(tot)}` : '';
    // filler
    const fl = $('flist');
    fl.replaceChildren(...S.show.filler.map((t, i) => h('li', { class: 'row' + (fillerState.id === t.id && fillerState.playing ? ' playing' : '') + (fillerState.sel === t.id ? ' sel' : '') + (t.missing ? ' bad' : ''), 'data-id': t.id, draggable: 'true', title: t.path },
      h('span', { class: 'n' }, i + 1), h('span', { class: 't1' }, t.title), h('span', { class: 't2' }, t.name),
      h('span', { class: 'meta' }, h('span', null, fmt(t.duration || (t.an && t.an.duration) || 0)), h('button', { class: 'xbtn', title: 'Remove', 'data-a': 'del' }, '×')))));
    $('fillCount').textContent = S.show.filler.length;
    $('fillLoop').checked = !!S.show.fillerOpts.loop; $('fillShuffle').checked = !!S.show.fillerOpts.shuffle;
  }

  /* ---------- rendering: inspector ---------- */
  const sel = () => byId(S.selectedId);
  function renderInspector() {
    const t = sel();
    $('inspEmpty').hidden = !!t; $('inspBody').hidden = !t;
    if (!t) return;
    $('iHead').textContent = `Song ${t.enabled ? numberOf(t) : '(not in show)'}`;
    $('iFile').textContent = t.path + (t.missing ? '  (missing)' : '');
    const setv = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    setv('iDance', t.dance); setv('iTitle', t.title); setv('iClass', t.cls); setv('iNotes', t.notes);
    $('iTrans').value = t.transition; setv('iXfade', t.xfade); $('iXfade').disabled = t.transition !== 'crossfade';
    setv('iStart', t.startAt ? fmt(t.startAt, true) : ''); setv('iEnd', t.endAt ? fmt(t.endAt, true) : ''); setv('iTrim', t.trimDb);
    $('iShowProps').checked = t.showProps !== false; $('iEnabled').checked = t.enabled;
    $('iLufs').textContent = t.an ? `Measured ${t.an.lufs} LUFS, peak ${t.an.peak} dBFS · plays at ${gainFor(t) >= 0 ? '+' : ''}${gainFor(t).toFixed(1)} dB · ${fmt(t.duration)}` : (t.anError || 'Measuring loudness…');
    renderCues();
    $('iProps').replaceChildren(...t.props.map(p => h('li', { class: 'prow' },
      h('input', { type: 'text', value: p.text, 'aria-label': 'Prop', oninput: e => { p.text = e.target.value; changed(); renderPropsBox(); } }),
      h('button', { class: 'xbtn', title: 'Remove prop', onclick: () => { t.props = t.props.filter(x => x !== p); changed(); renderInspector(); renderPropsBox(); } }, '×'))));
  }
  function renderCues() {
    const t = sel(); if (!t) return;
    const L = S.live, isCur = active && active.track === t && (L.state === 'playing' || L.state === 'paused'), pos = isCur ? active.time : -1;
    t.cues.sort((a, b) => a.t - b.t);
    const live = L.lastCue && L.lastCue.trackId === t.id ? L.lastCue.cue : null;
    const focusedCue = document.activeElement && document.activeElement.closest && document.activeElement.closest('.cue');
    if (focusedCue && $('iCues').contains(focusedCue)) return; // don't rebuild under the typist
    $('iCues').replaceChildren(...t.cues.map(c => h('li', { class: 'cue' + (isCur && c.t <= pos ? ' past' : '') + (c === live ? ' live' : ''), style: `border-left-color:var(--c-${c.type})` },
      h('input', { type: 'text', class: 'mono', value: fmt(c.t, true), 'aria-label': 'Cue time', onchange: e => { const v = parseTime(e.target.value); if (!isNaN(v)) { c.t = clamp(v, 0, t.duration || 36000); changed(); } renderCues(); } }),
      h('select', { 'aria-label': 'Cue type', onchange: e => { c.type = e.target.value; changed(); renderCues(); } },
        ...['light', 'prop', 'spot', 'sound', 'stage', 'note'].map(v => h('option', { value: v, selected: v === c.type }, CT[v]))),
      h('input', { type: 'text', value: c.text, placeholder: 'What to call', 'aria-label': 'Cue text', oninput: e => { c.text = e.target.value; changed(); } }),
      h('button', { class: 'xbtn', title: 'Delete cue', onclick: () => { t.cues = t.cues.filter(x => x !== c); changed(); renderCues(); } }, '×'))));
    if (!t.cues.length) $('iCues').append(h('li', { class: 'muted' }, 'No cues yet. Press C during the song, or "+ Cue at playhead".'));
  }
  const CT = { light: 'Lighting', prop: 'Props', spot: 'Spots', sound: 'Sound', stage: 'Stage', note: 'Note' };
  function addCue(t, at) {
    if (!t) return;
    const c = { id: uid(), t: Math.round(at * 10) / 10, type: $('cueType').value, text: '' };
    t.cues.push(c); changed();
    if (S.selectedId !== t.id) { S.selectedId = t.id; renderLists(); }
    renderInspector();
    setTimeout(() => { const rows = [...$('iCues').querySelectorAll('.cue')]; const i = t.cues.sort((a, b) => a.t - b.t).indexOf(c); const inp = rows[i] && rows[i].querySelectorAll('input')[1]; if (inp) inp.focus(); }, 30);
    toast(`Cue added at ${fmt(c.t, true)}. Type what to call.`);
  }

  /* ---------- rendering: transport + now ---------- */
  const STATE_TXT = { idle: 'Not started', standby: 'Standing by', playing: 'Playing', paused: 'Paused', ended: 'Show over' };
  function renderTransport() {
    const L = S.live;
    $('stateChip').textContent = L.fadingOut ? 'Fading out' : STATE_TXT[L.state];
    $('stateChip').className = 'state ' + L.state;
    const sb = byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null);
    const go = $('bGo');
    const ready = (L.state === 'standby' || L.state === 'idle' || L.state === 'paused') && (sb || L.state === 'paused');
    go.classList.toggle('ready', !!ready && !L.busy);
    go.classList.toggle('busy', L.state === 'playing' || L.busy);
    $('goSub').textContent = L.state === 'paused' ? 'Resume' : L.state === 'playing' ? 'Playing' : sb ? label(sb) : 'Space';
    $('pauseTxt').textContent = L.state === 'paused' ? 'Resume' : 'Pause';
    const cur = active && active.track && (L.state === 'playing' || L.state === 'paused') ? active.track : sb;
    document.querySelectorAll('#segTrans button').forEach(b => b.setAttribute('aria-checked', String(!!cur && cur.transition === b.dataset.v)));
    renderNowText();
  }
  function renderNowText() {
    const L = S.live;
    const playing = active && active.track && (L.state === 'playing' || L.state === 'paused');
    const t = playing ? active.track : (byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null));
    $('nowDance').textContent = t ? label(t) : (L.state === 'ended' ? 'That was the last song' : tracks().length ? 'Nothing standing by' : 'Add songs to start');
    $('nowTitle').textContent = t ? [t.dance ? t.title : '', t.cls].filter(Boolean).join(' · ') : '';
    $('nowNum').textContent = t && t.enabled ? `#${numberOf(t)} of ${enabled().length}` : '';
    $('nowTrans').textContent = t ? `then: ${TR[t.transition]}${t.transition === 'crossfade' ? ` ${t.xfade}s` : ''}` : '';
    const nx = playing ? nextAfter(t.id) : (t ? nextAfter(t.id) : null);
    const showNext = playing ? nx : t;
    // "Up next": while playing, the song after this one; while standing by, the one that GO starts.
    $('nextDance').textContent = (playing ? nx : t) ? label(playing ? nx : t) : '–';
    const ref = playing ? nx : t;
    $('nextInfo').textContent = ref ? [ref.dance ? ref.title : '', fmt(effLen(ref)), playing ? (t.transition === 'stop' ? 'starts on GO' : t.transition === 'straight' ? 'plays straight on' : `crossfades in ${t.xfade}s`) : 'press GO to start'].filter(Boolean).join(' · ') : (playing ? 'This is the last song' : '');
    renderPropsBox(playing ? t : null, playing ? nx : showNext);
  }
  function renderPropsBox(cur, nx) {
    if (cur === undefined) { const L = S.live; const playing = active && active.track && (L.state === 'playing' || L.state === 'paused'); cur = playing ? active.track : null; nx = playing ? nextAfter(cur.id) : (byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null)); }
    const li = t => !t ? [h('li', { class: 'muted' }, '–')] : (t.showProps === false ? [h('li', { class: 'muted' }, 'Hidden')] : t.props.filter(p => p.text.trim()).length ? t.props.filter(p => p.text.trim()).map(p => h('li', null, p.text)) : [h('li', { class: 'muted' }, 'None')]);
    $('propsNow').replaceChildren(...li(cur)); $('propsNext').replaceChildren(...li(nx));
  }

  /* ---------- frame loop: timers, waveform, cue countdown, meters ---------- */
  let frameN = 0;
  function frame() {
    requestAnimationFrame(frame);
    try {
      frameN++;
      const L = S.live;
      const playing = active && active.track && (L.state === 'playing' || L.state === 'paused');
      const t = playing ? active.track : null;
      if (frameN % 3 === 0) {
        const pos = t ? active.time - effStart(t) : 0, left = t ? effEnd(t) - active.time : (byId(L.standbyId) ? effLen(byId(L.standbyId)) : 0);
        $('tElapsed').textContent = fmt(pos);
        $('tLeft').textContent = fmt(left);
        const big = $('tLeft').parentElement; big.classList.toggle('amber', !!t && left < 30 && left >= 10); big.classList.toggle('red', !!t && left < 10);
        const rem = showRemaining(); $('tShow').textContent = fmt(rem);
        $('tEnds').textContent = rem > 0 ? new Date(Date.now() + rem * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–';
        // cues
        const ci = cueInfo();
        const lc = L.lastCue && (!t || L.lastCue.trackId === t.id) ? L.lastCue.cue : null;
        setCueText($('cueNow'), lc);
        setCueText($('cueNext'), ci.nextCue, ci.nextTrack && t && ci.nextTrack !== t ? `${label(ci.nextTrack)}: ` : (!t && ci.nextTrack ? `${label(ci.nextTrack)}: ` : ''));
        $('cueNextIn').textContent = ci.nextIn != null ? `in ${fmt(ci.nextIn, ci.nextIn < 10)}` : ci.nextCue ? (t ? 'after GO' : `at ${fmt(ci.nextCue.t)} after GO`) : '';
        $('cueNextBox').classList.toggle('warnsoon', ci.nextIn != null && ci.nextIn <= S.settings.cueWarn);
        $('cueNextBox').style.borderLeftColor = ci.nextCue ? `var(--c-${ci.nextCue.type})` : '';
        $('cueNowBox').style.borderLeftColor = lc ? `var(--c-${lc.type})` : '';
        $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (S.phones.intermissionEnds) { const s = (S.phones.intermissionEnds - Date.now()) / 1000; $('intLeft').textContent = s > 0 ? fmt(s) : '0:00'; if (s <= 0 && s > -1.5) toast('Intermission timer is up.'); }
        renderFillerStrip();
        hotProgress();
      }
      drawWave();
      if (frameN % 2 === 0) drawMeters();
    } catch (err) { if (frameN % 300 === 0) log('frame error', String(err)); }
  }
  function setCueText(el, c, prefix = '') {
    const key = c ? prefix + c.id + c.text + c.type : '';
    if (el._key === key) return; el._key = key;
    el.replaceChildren(...(c ? [h('span', { class: 'ctype', style: `background:var(--c-${c.type})` }, CT[c.type]), prefix, c.text || '(no text)'] : ['–']));
  }

  // Waveform: the playing song, or the one standing by, or the selected one.
  const wave = $('wave'); const wctx = wave.getContext('2d');
  const peakCache = new Map();
  let waveCache = { key: '', img: null };
  function waveTrack() {
    const L = S.live;
    if (active && active.track && (L.state === 'playing' || L.state === 'paused')) return { t: active.track, pos: active.time };
    const t = byId(L.standbyId) || sel() || (L.state === 'idle' ? firstTrack() : null);
    return t ? { t, pos: effStart(t) } : null;
  }
  function drawWave() {
    const dpr = window.devicePixelRatio || 1, W = Math.round(wave.clientWidth * dpr), H = Math.round(wave.clientHeight * dpr);
    if (!W || !H) return;
    if (wave.width !== W || wave.height !== H) { wave.width = W; wave.height = H; waveCache.key = ''; }
    const css = getComputedStyle(document.documentElement);
    const wt = waveTrack();
    wctx.clearRect(0, 0, W, H);
    if (!wt) { wctx.fillStyle = css.getPropertyValue('--muted'); wctx.font = `${13 * dpr}px Inter`; wctx.fillText('The waveform shows here', 12 * dpr, H / 2); return; }
    const { t, pos } = wt, dur = t.duration || (t.an && t.an.duration) || 0;
    if (!dur) return;
    const x = s => s / dur * W;
    const key = `${t.id}|${W}|${H}|${t.an ? t.an.peaks.length : 0}`;
    if (waveCache.key !== key) {
      const off = document.createElement('canvas'); off.width = W; off.height = H; const o = off.getContext('2d');
      if (t.an && t.an.peaks) {
        let pk = peakCache.get(t.an.peaks); if (!pk) { pk = i8FromB64(t.an.peaks); peakCache.set(t.an.peaks, pk); }
        const nb = pk.length / 2, mid = H / 2;
        o.fillStyle = '#fff';
        for (let px = 0; px < W; px++) {
          const b0 = Math.floor(px / W * nb), b1 = Math.max(b0 + 1, Math.floor((px + 1) / W * nb));
          let mn = 0, mx = 0; for (let b = b0; b < b1; b++) { if (pk[b * 2] < mn) mn = pk[b * 2]; if (pk[b * 2 + 1] > mx) mx = pk[b * 2 + 1]; }
          const y0 = mid - mx / 127 * mid * 0.95, y1 = mid - mn / 127 * mid * 0.95;
          o.fillRect(px, y0, 1, Math.max(1, y1 - y0));
        }
      }
      waveCache = { key, img: off };
    }
    // unplayed in muted, played in accent (tinted by compositing the cached white shape)
    const accent = css.getPropertyValue('--accent').trim(), muted = css.getPropertyValue('--muted').trim();
    wctx.save(); wctx.drawImage(waveCache.img, 0, 0); wctx.globalCompositeOperation = 'source-in'; wctx.fillStyle = muted; wctx.fillRect(0, 0, W, H); wctx.restore();
    wctx.save(); wctx.beginPath(); wctx.rect(0, 0, x(pos), H); wctx.clip(); wctx.drawImage(tint(waveCache.img, accent), 0, 0); wctx.restore();
    // trimmed-off parts
    wctx.fillStyle = 'rgba(0,0,0,.45)';
    if (effStart(t) > 0) wctx.fillRect(0, 0, x(effStart(t)), H);
    if (effEnd(t) < dur) wctx.fillRect(x(effEnd(t)), 0, W - x(effEnd(t)), H);
    if (t.transition === 'crossfade' && nextAfter(t.id)) { wctx.fillStyle = 'rgba(245,184,61,.16)'; wctx.fillRect(x(effEnd(t) - (+t.xfade || 0)), 0, x(+t.xfade || 0), H); }
    // cues
    wctx.font = `600 ${11 * dpr}px Inter`;
    for (const c of t.cues) {
      const cx = x(c.t); wctx.fillStyle = css.getPropertyValue(`--c-${c.type}`).trim() || '#fff';
      wctx.fillRect(cx - dpr / 2, 0, Math.max(1, dpr * 1.5), H);
      wctx.fillRect(cx, 0, Math.min(140 * dpr, wctx.measureText(c.text || CT[c.type]).width + 8 * dpr), 15 * dpr);
      wctx.fillStyle = '#111'; wctx.fillText((c.text || CT[c.type]).slice(0, 30), cx + 4 * dpr, 11 * dpr);
    }
    // playhead
    wctx.fillStyle = css.getPropertyValue('--ink').trim(); wctx.fillRect(x(pos) - dpr, 0, 2 * dpr, H);
  }
  const tintCache = { src: null, color: '', c: null };
  function tint(img, color) {
    if (tintCache.src === img && tintCache.color === color) return tintCache.c;
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const o = c.getContext('2d');
    o.drawImage(img, 0, 0); o.globalCompositeOperation = 'source-in'; o.fillStyle = color; o.fillRect(0, 0, c.width, c.height);
    Object.assign(tintCache, { src: img, color, c }); return c;
  }
  const waveTime = e => { const wt = waveTrack(); if (!wt) return null; const r = wave.getBoundingClientRect(); return { t: wt.t, at: clamp((e.clientX - r.left) / r.width, 0, 1) * (wt.t.duration || 0) }; };
  on(wave, 'click', e => {
    const w = waveTime(e); if (!w) return;
    const L = S.live;
    if (active && active.track === w.t && (L.state === 'playing' || L.state === 'paused')) {
      if (!e.shiftKey) { toast('Hold Shift and click to jump to a point in the song.'); return; }
      active.el.currentTime = clamp(w.at, effStart(w.t), effEnd(w.t) - 0.2); L.lastPos = active.el.currentTime; stall.t = L.lastPos; stall.at = performance.now(); pushStatus(true);
    }
  });
  on(wave, 'dblclick', e => { const w = waveTime(e); if (w) addCue(w.t, w.at); });

  function drawMeters() {
    const m = E.meters();
    const pct = db => clamp((db + 60) / 60 * 100, 0, 100) + '%';
    $('mL').style.width = pct(m.peakL); $('mR').style.width = pct(m.peakR);
    $('hL').style.left = pct(m.holdL); $('hR').style.left = pct(m.holdR);
    if (frameN % 12 === 0) $('meterTxt').textContent = `Peak ${Math.max(m.holdL, m.holdR).toFixed(1)} dBFS · limiter ${m.gr < -0.1 ? m.gr.toFixed(1) + ' dB' : 'idle'}${E.duckGain.gain.value < 0.95 ? ' · ducked' : ''}`;
  }

  /* ---------- system utilisation ---------- */
  const sys = { cpu: [], app: [], lag: [], last: null, maxLag: 0 };
  let lagT = performance.now();
  setInterval(() => { const n = performance.now(); const lag = Math.max(0, n - lagT - 250); lagT = n; if (lag > sys.maxLag) sys.maxLag = lag; if (lag > 300) log('event loop lag', Math.round(lag)); }, 250);
  desk.onStats(safe(s => {
    sys.last = s;
    sys.cpu.push(s.cpu); sys.app.push(s.appCpu); sys.lag.push(sys.maxLag); sys.maxLag = 0;
    for (const a of [sys.cpu, sys.app, sys.lag]) while (a.length > 60) a.shift();
    const c = $('sysGraph'), x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const line = (arr, color, max = 100) => { x.strokeStyle = color; x.lineWidth = 1.5; x.beginPath(); arr.forEach((v, i) => { const px = W - (arr.length - 1 - i) * (W / 59), py = H - 2 - clamp(v / max, 0, 1) * (H - 4); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); };
    line(sys.cpu, css.getPropertyValue('--muted').trim());
    line(sys.app, css.getPropertyValue('--accent').trim());
    const memUsed = 100 * (1 - s.freeMem / s.totalMem);
    $('sysCpu').textContent = `CPU ${Math.round(s.cpu)}% · app ${Math.round(s.appCpu)}%`;
    $('sysMem').textContent = `RAM ${Math.round(memUsed)}% · lag ${Math.round(sys.lag[sys.lag.length - 1])}ms`;
    $('sysBox').classList.toggle('hot', s.cpu > 85 || memUsed > 92 || sys.lag[sys.lag.length - 1] > 150);
    $('sysBox').title = `Computer CPU (grey) and this app (purple), last minute.\nApp memory ${Math.round(s.appMem / 1048576)} MB, free ${Math.round(s.freeMem / 1048576)} MB.\nAudio: ${E.ctx.sampleRate} Hz, latency ${Math.round((E.ctx.baseLatency + (E.ctx.outputLatency || 0)) * 1000)} ms.`;
  }));

  /* ---------- hot sounds ---------- */
  const hotBuffers = new Map();
  async function loadHotBuffer(hc) {
    try { hotBuffers.set(hc.id, await E.decode(mediaUrl(hc.path))); hc.bad = false; }
    catch (err) { hc.bad = true; log('hot sound failed', hc.path, err.message); }
    renderHots();
  }
  function renderHots() {
    $('hots').replaceChildren(...S.show.hotCues.map((hc, i) => {
      if (!hc) return h('button', { class: 'hot empty', 'data-i': i, title: 'Click to choose a sound, or drop a file here' }, h('span', { class: 'k' }, i + 1), h('span', { class: 'l' }, '+ Add'));
      return h('button', { class: 'hot has' + (E.hotPlaying(hc.id) ? ' on' : '') + (hc.bad ? ' bad' : ''), 'data-i': i, style: `--hc:var(--tape-${hc.color || 1})`, title: `${hc.label} (${i + 1})` + (hc.bad ? '\nThis file can\'t be played' : '') },
        h('span', { class: 'k' }, i + 1), h('span', { class: 'l' }, hc.label), h('span', { class: 'edit', 'data-a': 'edit', title: 'Edit' }, '✎'), h('span', { class: 'prog' }));
    }));
  }
  function hotProgress() {
    document.querySelectorAll('#hots .hot.has').forEach(b => {
      const hc = S.show.hotCues[+b.dataset.i]; if (!hc) return;
      const playing = E.hotPlaying(hc.id);
      b.classList.toggle('on', playing);
      b.querySelector('.prog').style.width = playing ? (100 - E.hotProgress(hc.id) * 100) + '%' : '0';
    });
  }
  function fireHot(i) {
    const hc = S.show.hotCues[i];
    if (!hc) return chooseHot(i);
    if (E.hotPlaying(hc.id)) { E.stopHot(hc.id); renderHots(); return; }
    const buf = hotBuffers.get(hc.id);
    if (!buf) { toast(hc.bad ? `“${hc.label}” can't be played. Choose another file.` : 'Still loading that sound…'); return; }
    let g = (+hc.levelDb || 0);
    if (S.settings.normalize && hc.an && hc.an.lufs > -70) g += clamp(S.settings.targetLufs - hc.an.lufs, -30, S.settings.maxBoost);
    E.playHot(hc.id, buf, g, () => renderHots(), hc.duck !== false);
    renderHots();
    log('hot', i + 1, hc.label);
  }
  async function chooseHot(i, existing) {
    const [info] = await desk.chooseMedia('Choose a sound effect or voice-over');
    if (!info) return;
    setHotFile(i, info, existing);
  }
  function setHotFile(i, info, existing) {
    const hc = existing || { id: uid(), label: info.name.replace(/\.[^.]+$/, '').slice(0, 24), color: (i % 6) + 1, levelDb: 0, duck: true };
    Object.assign(hc, { path: info.path, name: info.name, sig: { size: info.size, mtime: info.mtime }, an: null, bad: false });
    S.show.hotCues[i] = hc; changed(); renderHots();
    queueAnalysis(hc, { buffer: true });
  }
  let hotEditing = -1;
  function editHot(i) {
    const hc = S.show.hotCues[i]; if (!hc) return;
    hotEditing = i;
    $('hNum').textContent = i + 1; $('hLabel').value = hc.label; $('hColor').value = hc.color || 1; $('hLevel').value = hc.levelDb || 0; $('hDuck').checked = hc.duck !== false;
    $('hFile').textContent = hc.path + (hc.an ? ` · ${hc.an.lufs} LUFS · ${fmt(hc.an.duration, true)}` : '');
    $('dlgHot').showModal();
  }
  on('dlgHot', 'close', () => {
    const hc = S.show.hotCues[hotEditing];
    if ($('dlgHot').returnValue === 'ok' && hc) { hc.label = $('hLabel').value.trim() || hc.label; hc.color = +$('hColor').value; hc.levelDb = +$('hLevel').value || 0; hc.duck = $('hDuck').checked; changed(); renderHots(); }
  });
  on('hChange', 'click', () => { const i = hotEditing; $('dlgHot').close(); chooseHot(i, S.show.hotCues[i]); });
  on('hRemove', 'click', () => { const hc = S.show.hotCues[hotEditing]; if (hc) { E.stopHot(hc.id); hotBuffers.delete(hc.id); } S.show.hotCues[hotEditing] = null; $('dlgHot').close(); changed(); renderHots(); });
  on('hots', 'click', e => {
    const b = e.target.closest('.hot'); if (!b) return;
    const i = +b.dataset.i;
    if (e.target.closest('[data-a="edit"]')) return editHot(i);
    fireHot(i);
  });
  on('hots', 'contextmenu', e => { const b = e.target.closest('.hot'); if (b) { e.preventDefault(); if (S.show.hotCues[+b.dataset.i]) editHot(+b.dataset.i); } });
  on('hots', 'dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  on('hots', 'drop', async e => {
    const b = e.target.closest('.hot'); if (!b || !e.dataTransfer.files.length) return; e.preventDefault();
    const [info] = await pathsToInfos([desk.pathForFile(e.dataTransfer.files[0])]);
    if (info) setHotFile(+b.dataset.i, info, S.show.hotCues[+b.dataset.i]);
  });

  /* ---------- pre-show / intermission music ---------- */
  const fillerState = { playing: false, id: null, sel: null, fading: false };
  async function fillerPlay(id) {
    const list = S.show.filler.filter(t => !t.missing);
    if (!list.length) { toast('Add pre-show music first (Pre-show & intermission tab).'); return; }
    let t = S.show.filler.find(x => x.id === (id || fillerState.sel)) || (S.show.fillerOpts.shuffle ? list[Math.floor(Math.random() * list.length)] : list[0]);
    try {
      fillerState.fading = false;
      await fillerDeck.load(t, mediaUrl(t.path), gainFor(t), 0);
      if (!t.duration) t.duration = fillerDeck.el.duration;
      await fillerDeck.play(1, fillerState.playing ? 0 : 1.5);
      fillerState.playing = true; fillerState.id = t.id;
      log('filler', t.name);
    } catch (err) { log('filler failed', t.name, err.message); t.missing = true; toast(`Couldn't play “${t.title}”. Skipping it.`); setTimeout(safe(fillerNext), 300); }
    renderLists(); pushStatus(true);
  }
  function fillerNext() {
    const list = S.show.filler.filter(t => !t.missing);
    if (!list.length) { fillerStop(); return; }
    let i = list.findIndex(t => t.id === fillerState.id), n;
    if (S.show.fillerOpts.shuffle && list.length > 1) { do { n = list[Math.floor(Math.random() * list.length)]; } while (n.id === fillerState.id); }
    else if (i + 1 < list.length) n = list[i + 1];
    else if (S.show.fillerOpts.loop) n = list[0];
    if (!n) { fillerStop(); return; }
    fillerState.sel = null;
    fillerPlay(n.id);
  }
  function fillerFadeOut(sec = 3) {
    if (!fillerState.playing) return;
    fillerState.fading = true; fillerDeck.fade(0, sec, 'out');
    setTimeout(safe(() => { if (fillerState.fading) fillerStop(); }), sec * 1000 + 50);
    pushStatus(true);
  }
  function fillerStop() { fillerDeck.stop(0.05); fillerState.playing = false; fillerState.fading = false; renderLists(); pushStatus(true); }
  fillerDeck.el.addEventListener('ended', safe(() => { if (fillerState.playing && !fillerState.fading) fillerNext(); }));
  function renderFillerStrip() {
    const t = S.show.filler.find(x => x.id === fillerState.id);
    const txt = fillerState.playing && t ? `${fillerState.fading ? 'Fading: ' : '♪ '}${t.title} · ${fmt((t.duration || 0) - fillerDeck.time)} left` : 'Stopped';
    if ($('fillNow').textContent !== txt) $('fillNow').textContent = txt;
  }
  on('fPlay', 'click', () => fillerState.playing && !fillerState.fading ? fillerNext() : fillerPlay());
  on('fNext', 'click', () => fillerNext());
  on('fStop', 'click', () => fillerFadeOut(3));
  on('fLevel', 'input', e => { S.show.fillerOpts.levelDb = +e.target.value; E.ramp(fillerBus.gain, E.db2g(+e.target.value), 0.1); $('fLevelTxt').textContent = `${e.target.value} dB`; changed(); });
  on('fillLoop', 'change', e => { S.show.fillerOpts.loop = e.target.checked; changed(); });
  on('fillShuffle', 'change', e => { S.show.fillerOpts.shuffle = e.target.checked; changed(); });
  on('flist', 'click', e => {
    const row = e.target.closest('.row'); if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('[data-a="del"]')) { if (fillerState.id === id && fillerState.playing) fillerNext(); S.show.filler = S.show.filler.filter(t => t.id !== id); changed(); renderLists(); return; }
    fillerState.sel = id; renderLists();
  });
  on('flist', 'dblclick', e => { const row = e.target.closest('.row'); if (row) fillerPlay(row.dataset.id); });

  /* ---------- playlist interactions: select, drag to reorder, drop files ---------- */
  on('plist', 'click', e => { const row = e.target.closest('.row'); if (!row) return; S.selectedId = row.dataset.id; renderLists(); renderInspector(); });
  on('plist', 'dblclick', e => { const row = e.target.closest('.row'); if (row) cueNext(row.dataset.id); });
  function setupDrag(listId, getArr, setArr, where) {
    const list = $(listId);
    let dragId = null;
    const clear = () => list.querySelectorAll('.drop-before,.drop-after').forEach(r => r.classList.remove('drop-before', 'drop-after'));
    const target = e => { const rows = [...list.querySelectorAll('.row')]; for (const r of rows) { const b = r.getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) return { row: r, before: true }; } return rows.length ? { row: rows[rows.length - 1], before: false } : null; };
    on(list, 'dragstart', e => { const row = e.target.closest('.row'); if (!row) return; dragId = row.dataset.id; e.dataTransfer.setData('text/x-sp-' + where, dragId); e.dataTransfer.effectAllowed = 'move'; });
    on(list, 'dragend', () => { dragId = null; clear(); list.classList.remove('over'); });
    on(list, 'dragover', e => {
      const types = e.dataTransfer.types;
      if (!(types.includes('text/x-sp-' + where) || types.includes('Files'))) return;
      e.preventDefault(); clear();
      const tg = target(e); if (tg) tg.row.classList.add(tg.before ? 'drop-before' : 'drop-after'); else list.classList.add('over');
    });
    on(list, 'dragleave', e => { if (!list.contains(e.relatedTarget)) { clear(); list.classList.remove('over'); } });
    on(list, 'drop', async e => {
      e.preventDefault(); const tg = target(e); clear(); list.classList.remove('over');
      const arr = getArr();
      let idx = tg ? arr.findIndex(t => t.id === tg.row.dataset.id) + (tg.before ? 0 : 1) : arr.length;
      const moving = e.dataTransfer.getData('text/x-sp-' + where);
      if (moving) {
        const from = arr.findIndex(t => t.id === moving); if (from < 0) return;
        const [item] = arr.splice(from, 1); if (from < idx) idx--;
        arr.splice(idx, 0, item); setArr(arr);
        preload = preload.id ? { deck: null, id: null, promise: null } : preload; // the next song may have changed
        changed(); renderLists(); renderTransport(); pushStatus(true);
      } else if (e.dataTransfer.files.length) {
        const infos = await pathsToInfos([...e.dataTransfer.files].map(f => desk.pathForFile(f)).filter(Boolean));
        await addFiles(infos, where, idx);
      }
    });
  }
  setupDrag('plist', () => S.show.tracks, a => { S.show.tracks = a; }, 'show');
  setupDrag('flist', () => S.show.filler, a => { S.show.filler = a; }, 'filler');
  for (const [zone, where] of [['dropShow', 'show'], ['dropFill', 'filler']]) {
    on(zone, 'dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); $(zone).classList.add('over'); } });
    on(zone, 'dragleave', () => $(zone).classList.remove('over'));
    on(zone, 'drop', async e => { e.preventDefault(); $(zone).classList.remove('over'); await addFiles(await pathsToInfos([...e.dataTransfer.files].map(f => desk.pathForFile(f)).filter(Boolean)), where); });
  }
  // Files dropped anywhere else go to the show playlist instead of opening in the window.
  document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', safe(async e => { if (e.defaultPrevented) return; e.preventDefault(); if (e.dataTransfer.files.length) await addFiles(await pathsToInfos([...e.dataTransfer.files].map(f => desk.pathForFile(f)).filter(Boolean)), $('panelFiller').hidden ? 'show' : 'filler'); }));
  function moveSelected(dir) {
    const arr = tracks(), i = arr.findIndex(t => t.id === S.selectedId); if (i < 0) return;
    const j = clamp(i + dir, 0, arr.length - 1); if (i === j) return;
    [arr[i], arr[j]] = [arr[j], arr[i]]; preload = { deck: null, id: null, promise: null };
    changed(); renderLists(); renderTransport(); pushStatus(true);
  }

  /* ---------- inspector bindings ---------- */
  const bind = (id, ev, fn) => on(id, ev, e => { const t = sel(); if (!t) return; fn(t, e.target); changed(); renderListsSoon(); renderNowText(); });
  bind('iDance', 'input', (t, el) => { t.dance = el.value; });
  bind('iTitle', 'input', (t, el) => { t.title = el.value; });
  bind('iClass', 'input', (t, el) => { t.cls = el.value; });
  bind('iNotes', 'input', (t, el) => { t.notes = el.value; });
  bind('iTrans', 'change', (t, el) => { t.transition = el.value; $('iXfade').disabled = t.transition !== 'crossfade'; renderTransport(); });
  bind('iXfade', 'change', (t, el) => { t.xfade = clamp(+el.value || 5, 0.5, 30); });
  bind('iStart', 'change', (t, el) => { const v = parseTime(el.value); t.startAt = isNaN(v) ? t.startAt : clamp(v, 0, Math.max(0, (t.duration || 0) - 1)); renderInspector(); });
  bind('iEnd', 'change', (t, el) => { const v = el.value.trim() ? parseTime(el.value) : 0; t.endAt = isNaN(v) ? t.endAt : (v > 0 ? clamp(v, (t.startAt || 0) + 1, t.duration || v) : 0); renderInspector(); });
  bind('iTrim', 'change', (t, el) => { t.trimDb = clamp(+el.value || 0, -20, 12); if (active && active.track === t) E.ramp(active.trim.gain, E.db2g(gainFor(t)), 0.3); renderInspector(); });
  bind('iShowProps', 'change', (t, el) => { t.showProps = el.checked; renderPropsBox(); });
  bind('iEnabled', 'change', (t, el) => { if (!el.checked && t.id === S.live.currentId && S.live.state === 'playing') { el.checked = true; toast("The song that's playing stays in the show."); return; } t.enabled = el.checked; renderInspector(); });
  on('iRemove', 'click', () => {
    const t = sel(); if (!t) return;
    if (t.id === S.live.currentId && (S.live.state === 'playing' || S.live.state === 'paused')) { toast("You can't remove the song that's playing."); return; }
    if (!confirm(`Remove “${label(t)}” from the playlist? Its cues and props go too.`)) return;
    const i = tracks().indexOf(t); S.show.tracks.splice(i, 1);
    if (S.live.standbyId === t.id) S.live.standbyId = nextAfter(t.id) ? nextAfter(t.id).id : null;
    if (S.live.nextId === t.id) S.live.nextId = null;
    S.selectedId = (tracks()[i] || tracks()[i - 1] || {}).id || null;
    changed(); renderLists(); renderInspector(); renderTransport();
  });
  on('iCueNext', 'click', () => { const t = sel(); if (t) cueNext(t.id); });
  on('bAddCue', 'click', () => {
    const t = sel(); if (!t) return;
    const L = S.live, isCur = active && active.track === t && (L.state === 'playing' || L.state === 'paused');
    addCue(t, isCur ? active.time : (t.cues.length ? Math.max(...t.cues.map(c => c.t)) + 5 : effStart(t)));
  });
  const addProp = () => { const t = sel(), v = $('propNew').value.trim(); if (!t || !v) return; t.props.push({ id: uid(), text: v }); $('propNew').value = ''; changed(); renderInspector(); renderPropsBox(); };
  on('bAddProp', 'click', addProp);
  on('propNew', 'keydown', e => { if (e.key === 'Enter') addProp(); });
  on('segTrans', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const L = S.live, t = active && active.track && (L.state === 'playing' || L.state === 'paused') ? active.track : byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null);
    if (!t) return;
    t.transition = b.dataset.v; changed(); renderTransport(); renderLists(); renderInspector();
  });

  /* ---------- transport buttons + keys ---------- */
  on('bGo', 'click', go);
  on('bFade', 'click', fadeToNext);
  on('bFadeOut', 'click', fadeOut);
  on('bPause', 'click', pause);
  on('bStop', 'click', () => stopNow(true));
  document.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.closest('dialog')) b.blur(); }, true);
  document.addEventListener('keydown', safe(e => {
    const tg = e.target;
    if (tg.closest && tg.closest('input,textarea,select,[contenteditable="true"]')) { if (e.key === 'Escape') tg.blur(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') { e.preventDefault(); if (!e.repeat) go(); }
    else if (k === 'Escape') { e.preventDefault(); e.shiftKey ? stopNow(true) : fadeOut(); }
    else if (k === 'f' || k === 'F') fadeToNext();
    else if (k === 'p' || k === 'P') pause();
    else if (k === 'c' || k === 'C') { const L = S.live; if (active && active.track && (L.state === 'playing' || L.state === 'paused')) addCue(active.track, active.time); else if (sel()) $('bAddCue').click(); }
    else if (k === 'b' || k === 'B') fillerState.playing && !fillerState.fading ? fillerFadeOut(3) : fillerPlay();
    else if (/^[1-8]$/.test(k) && !e.repeat) fireHot(+k - 1);
    else if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); moveSelected(k === 'ArrowUp' ? -1 : 1); }
    else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); const arr = tracks(), i = arr.findIndex(t => t.id === S.selectedId); const j = clamp(i + (k === 'ArrowUp' ? -1 : 1), 0, arr.length - 1); if (arr[j]) { S.selectedId = arr[j].id; renderLists(); renderInspector(); } }
    else if (k === 'Enter' && sel()) cueNext(S.selectedId);
  }), true);

  /* ---------- tabs ---------- */
  on('tabShow', 'click', () => setTab('show'));
  on('tabFiller', 'click', () => setTab('filler'));
  function setTab(t) { $('tabShow').setAttribute('aria-selected', t === 'show'); $('tabFiller').setAttribute('aria-selected', t === 'filler'); $('panelShow').hidden = t !== 'show'; $('panelFiller').hidden = t !== 'filler'; }

  /* ---------- show files ---------- */
  function cleanForSave() { return JSON.parse(JSON.stringify(S.show, (k, v) => (k === 'missing' || k === 'bad' || k === '_wantBuffer') ? undefined : v)); }
  async function save(saveAs = false) {
    try {
      const r = await desk.saveShow(S.filePath, cleanForSave(), saveAs);
      if (!r) return false;
      S.filePath = r.path; S.dirty = false; $('dirty').hidden = true; autosave();
      toast(`Saved ${r.path.split(/[\\/]/).pop()}`);
      return true;
    } catch (err) { toast(`Couldn't save: ${err.message}`, 6000); log('save failed', err.message); return false; }
  }
  async function confirmLoseChanges() {
    if (S.live.state === 'playing' || S.live.state === 'paused') { toast('Stop the show before opening or starting another one.'); return false; }
    if (!S.dirty || !S.show.tracks.length) return true;
    const r = confirm('Save the changes to this show first?\n\nOK saves, Cancel keeps them unsaved and carries on.');
    if (r) return save();
    return true;
  }
  async function openShow(filePath) {
    if (!(await confirmLoseChanges())) return;
    try {
      const r = await desk.openShow(filePath); if (!r) return;
      loadShow(r.show, r.path, false);
      toast(`Opened ${r.path.split(/[\\/]/).pop()}`);
    } catch (err) { toast(`Couldn't open the show: ${err.message}`, 6000); }
  }
  function loadShow(show, filePath, dirty) {
    const base = newShow();
    S.show = { ...base, ...show, fillerOpts: { ...base.fillerOpts, ...(show.fillerOpts || {}) } };
    S.show.hotCues = Array.from({ length: 8 }, (_, i) => (show.hotCues || [])[i] || null);
    for (const t of [...S.show.tracks, ...S.show.filler]) { t.props = t.props || []; t.cues = t.cues || []; if (t.enabled == null) t.enabled = true; }
    S.filePath = filePath; S.dirty = !!dirty; $('dirty').hidden = !S.dirty;
    S.selectedId = S.show.tracks[0] ? S.show.tracks[0].id : null;
    const L = S.live; Object.assign(L, { state: 'idle', currentId: null, standbyId: null, nextId: null, lastCue: null }); L.played = new Set();
    active = null; decks.forEach(d => d.unload()); hotBuffers.clear(); fillerStop();
    $('showName').value = S.show.name;
    $('fLevel').value = S.show.fillerOpts.levelDb; $('fLevelTxt').textContent = `${S.show.fillerOpts.levelDb} dB`;
    applySettings();
    renderLists(); renderInspector(); renderTransport(); renderHots();
    // check files, re-measure anything that changed, load hot sounds
    [...S.show.tracks, ...S.show.filler].forEach(t => queueAnalysis(t));
    S.show.hotCues.filter(Boolean).forEach(hc => queueAnalysis(hc, { buffer: true }));
    changed({ quiet: true }); pushProgram();
  }
  on('bNew', 'click', async () => { if (await confirmLoseChanges()) { loadShow(newShow(), null, false); } });
  on('bOpen', 'click', () => openShow());
  on('bSave', 'click', () => save());
  on('showName', 'input', e => { S.show.name = e.target.value; changed(); });
  on('bAdd', 'click', async () => addFiles(await desk.chooseMedia(), 'show'));
  on('bAddFill', 'click', async () => addFiles(await desk.chooseMedia('Add pre-show and intermission music'), 'filler'));
  desk.onIncomingShow(safe(p => openShow(p)));
  desk.onMenu(safe(name => {
    const acts = { new: () => $('bNew').click(), open: () => openShow(), save: () => save(), saveas: () => save(true), add: () => $('bAdd').click(),
      preflight: () => openPreflight(), test: () => openTest(), settings: () => openSettings(), video: () => toggleVideo(), keys: () => $('dlgKeys').showModal() };
    (acts[name] || (() => {}))();
  }));

  /* ---------- video output ---------- */
  let outWin = null;
  function showVideo() {
    const t = active && active.track;
    const isVid = !!(t && t.type === 'video');
    decks.forEach(d => d.el.classList.toggle('show', d === active && isVid));
    $('vprev').hidden = !(isVid || (outWin && !outWin.closed));
    if (outWin && !outWin.closed) {
      try {
        const v = outWin.document.getElementById('v'), slate = outWin.document.getElementById('slate');
        if (isVid) {
          const stream = active.el.captureStream();
          const setTracks = () => { const vt = stream.getVideoTracks(); v.srcObject = vt.length ? new MediaStream(vt) : null; v.play().catch(() => {}); };
          setTracks(); stream.onaddtrack = setTracks;
          slate.hidden = true;
        } else { v.srcObject = null; slate.hidden = false; slate.textContent = ''; }
      } catch (err) { log('video output error', String(err)); }
    }
  }
  async function toggleVideo() {
    if (outWin && !outWin.closed) { outWin.close(); outWin = null; showVideo(); $('bVideo').textContent = 'Video output'; return; }
    const ds = await desk.displays();
    const target = ds.find(d => !d.primary) || ds[0];
    await desk.chooseDisplay(target.id);
    outWin = window.open('output.html', 'videoout');
    if (!outWin) { toast("Couldn't open the video window."); return; }
    outWin.addEventListener('load', safe(() => { showVideo(); }));
    $('bVideo').textContent = 'Close video output';
    toast(ds.length > 1 ? `Video output is on ${target.label} (${target.width}×${target.height}).` : 'Only one screen is connected, so the video window opened here. Connect a projector for full screen.', 5000);
    const watch = setInterval(() => { if (!outWin || outWin.closed) { clearInterval(watch); outWin = null; $('bVideo').textContent = 'Video output'; showVideo(); } }, 1000);
  }
  on('bVideo', 'click', toggleVideo);

  /* ---------- settings dialog ---------- */
  const sl = (id, key, txt, fmtv, apply = true) => {
    const el = $(id); el.value = S.settings[key];
    const show = () => { if (txt) $(txt).textContent = fmtv(+el.value); };
    show();
    el.oninput = safe(() => { S.settings[key] = +el.value; show(); if (apply) applySettings(); saveSettings(); renderListsSoon(); });
  };
  const ck = (id, key, after) => { const el = $(id); el.checked = !!S.settings[key]; el.onchange = safe(() => { S.settings[key] = el.checked; applySettings(); saveSettings(); renderListsSoon(); if (after) after(); }); };
  const nm = (id, key, min, max) => { const el = $(id); el.value = S.settings[key]; el.onchange = safe(() => { S.settings[key] = clamp(+el.value || 0, min, max); el.value = S.settings[key]; applySettings(); saveSettings(); }); };
  async function fillOutputs(selectId) {
    const s = $(selectId);
    let outs = await E.outputs();
    if (outs.length && outs.every(o => !o.label || /^Output /.test(o.label))) { try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach(t => t.stop()); outs = await E.outputs(); } catch (_) {} }
    s.replaceChildren(...outs.map(o => h('option', { value: o.id, selected: o.id === (S.settings.outputId || 'default') }, o.label)));
    if (!outs.length) s.append(h('option', { value: '' }, 'System default'));
    if (S.settings.outputId && !outs.some(o => o.id === S.settings.outputId)) s.prepend(h('option', { value: S.settings.outputId, selected: true }, '(not connected) previous output'));
    s.onchange = safe(async () => { await chooseOutput(s.value); });
  }
  async function chooseOutput(id) {
    try { await E.setOutput(id); S.settings.outputId = id; saveSettings(); $('sOutMsg').textContent = 'Sound is going to the chosen output.'; unbanner('output'); }
    catch (err) { $('sOutMsg').textContent = `Couldn't switch: ${err.message}`; log('setSinkId failed', err.message); }
  }
  function openSettings() {
    fillOutputs('sOut');
    ck('sNorm', 'normalize', () => { if (active && active.track) E.ramp(active.trim.gain, E.db2g(gainFor(active.track)), 0.5); });
    sl('sTarget', 'targetLufs', 'sTargetTxt', v => `${v} LUFS`);
    sl('sBoost', 'maxBoost', 'sBoostTxt', v => `+${v} dB`);
    ck('sLimiter', 'limiterOn'); sl('sCeil', 'ceiling', 'sCeilTxt', v => `${v} dBFS`);
    sl('sMaster', 'masterDb', 'sMasterTxt', v => `${v > 0 ? '+' : ''}${v} dB`);
    sl('sBal', 'balance', 'sBalTxt', v => v === 0 ? 'centre' : v < 0 ? `${Math.round(-v * 100)}% left` : `${Math.round(v * 100)}% right`);
    nm('sTrimL', 'trimL', -12, 12); nm('sTrimR', 'trimR', -12, 12);
    ck('sEqOn', 'eqOn'); ck('sHpf', 'hpf');
    $('sEq').replaceChildren(...E.EQ_BANDS.map((b, i) => {
      const val = h('span', null, `${S.settings.eq[i] > 0 ? '+' : ''}${S.settings.eq[i]} dB`);
      const inp = h('input', { type: 'range', min: -12, max: 12, step: 0.5, value: S.settings.eq[i], 'aria-label': `EQ ${b.f} Hz` });
      inp.oninput = safe(() => { S.settings.eq[i] = +inp.value; val.textContent = `${inp.value > 0 ? '+' : ''}${inp.value} dB`; applySettings(); saveSettings(); });
      return h('label', null, val, inp, b.f >= 1000 ? `${b.f / 1000}k` : `${b.f}`);
    }));
    ck('sMb', 'mbOn'); sl('sMbAmt', 'mbAmount', 'sMbTxt', v => ['gentle', 'light', 'medium', '', 'firm', '', 'strong'][v * 2] || String(v));
    $('sDefTrans').value = S.settings.defTrans; $('sDefTrans').onchange = safe(() => { S.settings.defTrans = $('sDefTrans').value; saveSettings(); });
    nm('sXfade', 'xfade', 0.5, 30); nm('sFade', 'fadeSec', 0.5, 20); nm('sFadeOut', 'fadeOutSec', 0.5, 20); nm('sCueWarn', 'cueWarn', 0, 60);
    ck('sFillAuto', 'fillerAuto'); ck('sResume', 'autoResume');
    sl('sDuck', 'duckDb', 'sDuckTxt', v => `${v} dB`); sl('sHot', 'hotDb', 'sHotTxt', v => `${v > 0 ? '+' : ''}${v} dB`);
    $('sWpCode').value = S.settings.wpCode; $('sWpOn').checked = S.settings.wpOn;
    $('sWpCode').onchange = safe(() => { S.settings.wpCode = $('sWpCode').value.trim(); saveSettings(); configureWp(); showWpLink(); });
    $('sWpOn').onchange = safe(() => { S.settings.wpOn = $('sWpOn').checked; saveSettings(); configureWp(); });
    showWpLink(); $('sWpMsg').textContent = '';
    $('dlgSettings').showModal();
  }
  on('bSettings', 'click', openSettings);
  on('bPhones', 'click', () => { openSettings(); setTimeout(() => $('sWpCode').scrollIntoView({ block: 'center' }), 50); });

  /* ---------- phones: WordPress ---------- */
  function parseWpCode(code) {
    if (!code) return null;
    try { const j = JSON.parse(decodeURIComponent(escape(atob(code.replace(/\s+/g, ''))))); if (j.url && j.show && j.key) return j; } catch (_) {}
    return null;
  }
  function showWpLink() { const c = parseWpCode(S.settings.wpCode); $('sWpLink').textContent = c ? `Phones open: ${c.url.replace(/\/+$/, '')}/recital/${c.show}/` : (S.settings.wpCode ? "That doesn't look like a connection code." : ''); }
  function configureWp() {
    const c = parseWpCode(S.settings.wpCode);
    desk.wpConfigure(S.settings.wpOn && c ? c : null);
    if (S.settings.wpOn && c) { pushProgram(); pushStatus(true); }
    renderWp();
  }
  on('sWpTest', 'click', async () => {
    const c = parseWpCode($('sWpCode').value.trim());
    if (!c) { $('sWpMsg').textContent = "That doesn't look like a connection code."; return; }
    $('sWpMsg').textContent = 'Testing…';
    const r = await desk.wpTest(c);
    $('sWpMsg').textContent = r.ok ? `Connected (Recital Live ${r.version}, ${r.latency} ms).` : r.error;
    if (r.ok) { pushProgram(); pushStatus(true); }
  });
  let wpState = { configured: false };
  desk.onWpState(safe(s => { wpState = s; renderWp(); }));
  function renderWp() {
    const dot = $('wpDot'), txt = $('wpText');
    if (!S.settings.wpOn || !parseWpCode(S.settings.wpCode)) { dot.className = 'dot'; txt.textContent = 'Phones off'; return; }
    const age = wpState.lastOk ? (Date.now() - wpState.lastOk) / 1000 : Infinity;
    if (wpState.fails >= 3 || age > 30) { dot.className = 'dot bad'; txt.textContent = wpState.lastOk ? `Phones: last sent ${fmt(age)} ago` : 'Phones: not connected'; $('bPhones').title = wpState.error || ''; }
    else if (wpState.fails > 0) { dot.className = 'dot warn'; txt.textContent = 'Phones: retrying'; $('bPhones').title = wpState.error || ''; }
    else { dot.className = 'dot ok'; txt.textContent = 'Phones live'; $('bPhones').title = `Sent ${Math.round(age)} s ago (${wpState.latency} ms)`; }
  }
  setInterval(safe(renderWp), 2000);
  const cueOut = c => c ? { t: Math.round(c.t * 10) / 10, type: c.type, text: c.text } : null;
  function buildProgram() {
    return { show: S.show.name, updated: Date.now(), tracks: enabled().map((t, i) => ({
      id: t.id, n: i + 1, title: t.title, dance: t.dance, class: t.cls, duration: Math.round(effLen(t) * 10) / 10, type: t.type, transition: t.transition,
      notes: t.notes, show_props: t.showProps !== false, props: t.showProps !== false ? t.props.map(p => p.text).filter(Boolean) : [],
      cues: t.cues.slice().sort((a, b) => a.t - b.t).map(c => ({ t: Math.round((c.t - effStart(t)) * 10) / 10, type: c.type, text: c.text })) })) };
  }
  function buildStatus() {
    const L = S.live, ci = cueInfo();
    const playing = active && active.track && (L.state === 'playing' || L.state === 'paused');
    const t = playing ? active.track : byId(L.standbyId);
    const nx = t ? (playing ? nextAfter(t.id) : t) : (L.state === 'idle' ? firstTrack() : null);
    let state = L.state;
    if (!playing && S.phones.intermissionEnds > Date.now()) state = 'intermission';
    const off = t ? effStart(t) : 0;
    const shift = c => c ? { ...cueOut(c), t: Math.round((c.t - (ci.nextTrack ? effStart(ci.nextTrack) : off)) * 10) / 10 } : null;
    const st = {
      state, sent_at: Date.now(), index: t && t.enabled ? numberOf(t) - 1 : -1, track_id: t ? t.id : null,
      position: playing ? Math.round((active.time - off) * 10) / 10 : 0, duration: t ? Math.round(effLen(t) * 10) / 10 : 0, rate: 1,
      show_remaining: Math.round(showRemaining()), next_track_id: playing ? (nx ? nx.id : null) : (t ? t.id : nx ? nx.id : null),
      cue: L.lastCue && t && L.lastCue.trackId === t.id ? { ...cueOut(L.lastCue.cue), t: Math.round((L.lastCue.cue.t - off) * 10) / 10 } : null,
      next_cue: ci.nextCue ? { ...shift(ci.nextCue), track_id: ci.nextTrack ? ci.nextTrack.id : null, in: ci.nextIn != null ? Math.round(ci.nextIn * 10) / 10 : null } : null,
      upcoming_cues: ci.upcoming.map(c => ({ ...cueOut(c), t: Math.round((c.t - off) * 10) / 10 })),
      props: t && t.showProps !== false ? t.props.map(p => p.text).filter(Boolean) : [],
      filler: { playing: fillerState.playing && !fillerState.fading, title: (S.show.filler.find(x => x.id === fillerState.id) || {}).title || '' },
      message: S.phones.message || ''
    };
    if (S.phones.intermissionEnds > Date.now()) st.countdown_left = Math.round((S.phones.intermissionEnds - Date.now()) / 1000);
    return st;
  }
  let lastStatus = 0;
  function pushStatus(force) {
    if (!S.settings.wpOn) return;
    if (!force && Date.now() - lastStatus < 1900) return;
    lastStatus = Date.now();
    try { desk.wpStatus(buildStatus()); } catch (err) { log('status build failed', String(err)); }
  }
  function pushProgram() { if (S.settings.wpOn) { try { desk.wpProgram(buildProgram()); } catch (err) { log('program build failed', String(err)); } } }
  setInterval(safe(() => pushStatus(false)), 2000);
  on('phoneMsg', 'input', e => { S.phones.message = e.target.value; clearTimeout(on.msgT); on.msgT = setTimeout(() => pushStatus(true), 600); });
  on('intGo', 'click', () => {
    if (S.phones.intermissionEnds > Date.now()) { S.phones.intermissionEnds = 0; $('intGo').textContent = 'Start intermission timer'; $('intLeft').textContent = ''; }
    else { S.phones.intermissionEnds = Date.now() + clamp(+$('intMin').value || 15, 1, 60) * 60000; $('intGo').textContent = 'Stop timer'; }
    pushStatus(true);
  });

  /* ---------- crash recovery snapshot ---------- */
  function snapshot() {
    const L = S.live;
    try { desk.snapshot({ state: L.state, currentId: L.currentId, standbyId: L.standbyId, nextId: L.nextId, pos: active ? active.time : 0, t: Date.now(), played: [...L.played], showId: S.show.id, filler: fillerState.playing ? fillerState.id : null }); } catch (_) {}
  }
  setInterval(snapshot, 500);
  async function recover() {
    const r = await desk.recovery(); if (!r || r.showId !== S.show.id) return;
    const L = S.live; L.played = new Set(r.played || []); L.nextId = r.nextId;
    const t = byId(r.currentId);
    if (r.crashed && r.state === 'playing' && t && S.settings.autoResume) {
      const at = r.pos + (r.now - r.t) / 1000 + 0.3;
      log('recovering after crash', label(t), at);
      if (at < effEnd(t) - 1) { await startTrack(t, { at, fadeIn: 0.4 }); banner('recovered', `The app restarted and carried on playing “${label(t)}”.`, 'info'); }
      else { L.standbyId = (nextAfter(t.id) || {}).id || null; setState(L.standbyId ? 'standby' : 'ended'); banner('recovered', 'The app restarted. Standing by on the next song.', 'info'); }
      if (r.filler) fillerPlay(r.filler);
      return;
    }
    const where = t || byId(r.standbyId);
    if (where && (r.state === 'playing' || r.state === 'paused' || r.state === 'standby')) {
      L.standbyId = where.id; setState('standby');
      banner('recovered', r.state === 'standby' ? `Picked up where you left off: standing by on “${label(where)}”.` : `Last time the app closed during “${label(where)}” (at ${fmt(r.pos - effStart(where))}). It's standing by. Press GO to start it again.`, 'info');
    }
  }

  /* ---------- output device watch ---------- */
  async function checkOutput() {
    if (!S.settings.outputId || S.settings.outputId === 'default') return;
    const outs = await E.outputs();
    const present = outs.some(o => o.id === S.settings.outputId);
    if (!present && !checkOutput.lost) {
      checkOutput.lost = true; log('output device lost');
      banner('output', 'The chosen sound output was disconnected. Sound has moved to the system default. Reconnect it and it switches back.');
      try { await E.setOutput(''); } catch (_) {}
    } else if (present && checkOutput.lost) {
      checkOutput.lost = false; log('output device back');
      try { await E.setOutput(S.settings.outputId); unbanner('output'); toast('Sound output reconnected.'); } catch (_) {}
    }
  }
  navigator.mediaDevices.addEventListener('devicechange', safe(checkOutput));

  /* ---------- preflight ---------- */
  async function openPreflight() { $('dlgPreflight').showModal(); await runPreflight(); }
  on('bPreflight', 'click', openPreflight);
  on('pfRun', 'click', () => runPreflight());
  on('pfFind', 'click', async () => {
    const all = [...S.show.tracks, ...S.show.filler, ...S.show.hotCues.filter(Boolean)];
    const missing = []; const st = await desk.statMedia(all.map(t => t.path));
    all.forEach((t, i) => { if (!st[i].exists) missing.push(t); });
    if (!missing.length) { toast('No files are missing.'); return; }
    const found = await desk.findMedia([...new Set(missing.map(t => (t.name || t.path.split(/[\\/]/).pop())))]);
    if (!found) return;
    let n = 0;
    for (const t of missing) { const p = found[(t.name || t.path.split(/[\\/]/).pop()).toLowerCase()]; if (p) { t.path = p; t.missing = false; n++; queueAnalysis(t, { buffer: S.show.hotCues.includes(t) }); } }
    changed(); renderLists(); renderInspector();
    toast(n ? `Found ${n} of ${missing.length} missing file${missing.length > 1 ? 's' : ''}.` : 'None of the missing files were in that folder.', 5000);
    runPreflight();
  });
  async function runPreflight() {
    const list = $('pfList'); list.replaceChildren(h('li', { class: 'muted' }, 'Checking…'));
    const items = [];
    const add = (level, title, detail = '') => items.push({ level, title, detail });
    const group = g => items.push({ group: g });
    // Sound
    group('Sound');
    const outs = await E.outputs().catch(() => []);
    const chosen = S.settings.outputId && S.settings.outputId !== 'default' ? outs.find(o => o.id === S.settings.outputId) : null;
    if (S.settings.outputId && S.settings.outputId !== 'default' && !chosen) add('bad', "The chosen sound output isn't connected", 'Connect it, or pick another output in Settings.');
    else add('ok', `Playing through ${chosen ? chosen.label : 'the system default output'}`, `${outs.length} output${outs.length === 1 ? '' : 's'} found`);
    add(E.ctx.state === 'running' ? 'ok' : 'bad', E.ctx.state === 'running' ? 'Audio engine is running' : `Audio engine is ${E.ctx.state}`, `${E.ctx.sampleRate} Hz, about ${Math.round((E.ctx.baseLatency + (E.ctx.outputLatency || 0)) * 1000)} ms output delay`);
    add(S.settings.limiterOn ? 'ok' : 'warn', S.settings.limiterOn ? `Safety limiter on (ceiling ${S.settings.ceiling} dBFS)` : 'Safety limiter is off', S.settings.limiterOn ? '' : 'Turn it on in Settings so a loud file can\'t blast the room.');
    add(S.settings.normalize ? 'ok' : 'warn', S.settings.normalize ? `Song volumes evened out to ${S.settings.targetLufs} LUFS` : 'Volume evening-out is off');
    // Files
    group('Show playlist');
    const all = S.show.tracks;
    const stats = await desk.statMedia(all.map(t => t.path));
    let probs = 0;
    const en = enabled();
    if (!en.length) add('bad', 'The show playlist is empty');
    const probes = await Promise.all(all.map((t, i) => t.enabled && stats[i].exists ? probe(t.path).then(p => p, e => ({ error: e.message })) : null));
    all.forEach((t, i) => {
      if (!t.enabled) return;
      const name = `#${numberOf(t)} ${label(t)}`;
      const st = stats[i], pr = probes[i];
      if (!st.exists) { probs++; t.missing = true; add('bad', `${name}: file is missing`, `${t.path}. Use “Find missing files…”.`); return; }
      if (pr && pr.error) { probs++; add('bad', `${name}: won't play (${pr.error})`, t.path); return; }
      if (pr && pr.duration) t.duration = t.duration || pr.duration;
      if (!sigOk(t, st)) { add('warn', `${name}: file changed since it was measured`, 'Measuring it again now.'); t.an = null; queueAnalysis(t); }
      else if (!t.an) add('warn', `${name}: loudness not measured`, t.anError || 'Still measuring.');
      else if (gainFor(t) >= S.settings.maxBoost - 0.1 && S.settings.normalize) add('warn', `${name}: very quiet recording`, `Turned up the most allowed (+${S.settings.maxBoost} dB). Check it sounds right.`);
      if (t.endAt && t.endAt <= effStart(t) + 1) { probs++; add('bad', `${name}: end point is before the start point`); }
      const lateCues = t.cues.filter(c => c.t > effEnd(t) || c.t < effStart(t));
      if (lateCues.length) add('warn', `${name}: ${lateCues.length} cue${lateCues.length > 1 ? 's' : ''} outside the part that plays`, lateCues.map(c => `${fmt(c.t)} ${c.text}`).join(', '));
      const blank = t.cues.filter(c => !c.text.trim()).length;
      if (blank) add('warn', `${name}: ${blank} cue${blank > 1 ? 's have' : ' has'} no text`);
      if (t.transition === 'crossfade' && +t.xfade > effLen(t) / 2) add('warn', `${name}: crossfade is longer than half the song`);
      if (t.type === 'video' && pr && !pr.video) add('warn', `${name}: marked as video but has no picture`);
    });
    if (en.length && !probs) add('ok', `All ${en.length} songs found and playable`, `Total ${fmt(en.reduce((a, t) => a + effLen(t), 0))}${en.some(t => t.transition === 'stop') ? ' plus waits for GO' : ''}`);
    const noName = en.filter(t => !t.dance).length;
    if (noName) add('warn', `${noName} song${noName > 1 ? 's have' : ' has'} no dance name`, 'Phones and the Up next box show the song title instead.');
    const dupes = en.filter((t, i) => en.findIndex(x => x.path === t.path) !== i);
    if (dupes.length) add('warn', `${dupes.length} song${dupes.length > 1 ? 's are' : ' is'} in the show twice`, dupes.map(label).join(', '));
    // Filler + hot
    group('Pre-show music and hot sounds');
    const fst = await desk.statMedia(S.show.filler.map(t => t.path));
    const fMiss = S.show.filler.filter((t, i) => !fst[i].exists);
    fMiss.forEach(t => { t.missing = true; });
    if (!S.show.filler.length) add('warn', 'No pre-show or intermission music', 'Add some on the Pre-show & intermission tab.');
    else add(fMiss.length ? 'bad' : 'ok', fMiss.length ? `${fMiss.length} pre-show file${fMiss.length > 1 ? 's are' : ' is'} missing` : `${S.show.filler.length} pre-show songs ready`, fMiss.map(t => t.name).join(', '));
    const hcs = S.show.hotCues.filter(Boolean);
    const hst = await desk.statMedia(hcs.map(x => x.path));
    hcs.forEach((x, i) => { if (!hst[i].exists) add('bad', `Hot sound “${x.label}” is missing`, x.path); else if (x.bad || !hotBuffers.has(x.id)) add('warn', `Hot sound “${x.label}” isn't loaded yet`, x.bad ? "The file can't be played." : 'Still loading.'); });
    if (hcs.length && hcs.every((x, i) => hst[i].exists && hotBuffers.has(x.id))) add('ok', `${hcs.length} hot sound${hcs.length > 1 ? 's' : ''} loaded`);
    // Video
    if (en.some(t => t.type === 'video')) {
      group('Video');
      const ds = await desk.displays();
      if (ds.length < 2) add('warn', 'The show has video but only one screen is connected', 'Connect the projector, then open Video output.');
      else add('ok', `${ds.length} screens connected`, ds.map(d => `${d.label} ${d.width}×${d.height}${d.primary ? ' (main)' : ''}`).join(', '));
      add(outWin && !outWin.closed ? 'ok' : 'warn', outWin && !outWin.closed ? 'Video output window is open' : 'Video output window is closed', outWin && !outWin.closed ? '' : 'Click “Video output” in the top bar.');
    }
    // Computer
    group('Computer');
    const info = await desk.systemInfo();
    let bat = null; try { bat = navigator.getBattery ? await navigator.getBattery() : null; } catch (_) {}
    if (info.onBattery || (bat && !bat.charging && bat.level < 1)) add('warn', `Running on battery${bat ? ` (${Math.round(bat.level * 100)}%)` : ''}`, 'Plug the computer in for the show.');
    else add('ok', 'Plugged in');
    add(info.powerBlocked ? 'ok' : 'warn', info.powerBlocked ? 'Screen and computer will stay awake' : 'Sleep prevention is off');
    if (info.disk != null) add(info.disk < 1e9 ? 'warn' : 'ok', `${(info.disk / 1e9).toFixed(1)} GB free disk space`, info.disk < 1e9 ? 'Low space can stop autosave and logs.' : '');
    const freeMb = info.freeMem / 1048576;
    add(freeMb < 500 ? 'warn' : 'ok', `${(info.freeMem / 1073741824).toFixed(1)} GB of ${(info.totalMem / 1073741824).toFixed(0)} GB memory free`, freeMb < 500 ? 'Close other apps.' : '');
    const avgCpu = sys.cpu.length ? sys.cpu.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, sys.cpu.length) : 0;
    add(avgCpu > 70 ? 'warn' : 'ok', `Computer load ${Math.round(avgCpu)}%`, avgCpu > 70 ? 'Close other apps, especially browsers and video calls.' : '');
    const maxLag = Math.max(0, ...sys.lag.slice(-30));
    add(maxLag > 200 ? 'warn' : 'ok', maxLag > 200 ? `The app paused for ${Math.round(maxLag)} ms recently` : 'App is responsive');
    // Phones + saved
    group('Phones and saving');
    if (S.settings.wpOn) {
      const c = parseWpCode(S.settings.wpCode);
      if (!c) add('bad', 'Phones are on but the connection code is missing or wrong');
      else { const r = await desk.wpTest(c); add(r.ok ? 'ok' : 'bad', r.ok ? `Phones connected: ${c.url.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/recital/${c.show}/` : `Phones can't connect: ${r.error}`, r.ok ? `${r.latency} ms` : 'The show still runs; phones just won\'t update.'); if (r.ok) { pushProgram(); pushStatus(true); } }
    } else add('warn', 'Phones are off', 'Turn on in Settings to show the running order and cues on phones.');
    add(S.filePath && !S.dirty ? 'ok' : 'warn', S.filePath ? (S.dirty ? 'The show has unsaved changes' : 'The show is saved') : 'The show has never been saved', S.filePath || 'It is autosaved, but save a copy (Ctrl+S) to keep it.');
    // draw
    renderLists();
    const bad = items.filter(i => i.level === 'bad').length, warn = items.filter(i => i.level === 'warn').length;
    $('pfSummary').textContent = bad ? `${bad} problem${bad > 1 ? 's' : ''} to fix and ${warn} warning${warn === 1 ? '' : 's'}.` : warn ? `Ready, with ${warn} warning${warn === 1 ? '' : 's'} to look at.` : 'All clear. Ready for the show.';
    $('pfDot').className = 'dot ' + (bad ? 'bad' : warn ? 'warn' : 'ok');
    $('bPreflight').title = `Last check ${new Date().toLocaleTimeString()}: ${$('pfSummary').textContent}`;
    list.replaceChildren(...items.map(i => i.group ? h('li', { class: 'pf group' }, i.group) : h('li', { class: 'pf ' + i.level }, h('span', { class: 'ic' }, i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✕'), h('div', null, h('div', null, i.title), i.detail ? h('div', { class: 'd' }, i.detail) : null), h('span'))));
    log('preflight', { bad, warn });
    return { bad, warn, items };
  }

  /* ---------- test & calibrate ---------- */
  let calTimer = 0, autoLevel = null;
  function openTest() {
    fillOutputs('tOut');
    $('tOut').onchange = safe(async () => { await chooseOutput($('tOut').value); });
    $('tLevelTxt').textContent = `${$('tLevel').value} dBFS`;
    $('cTarget').value = S.settings.calTarget;
    E.inputs().then(ins => { $('cMic').replaceChildren(...ins.map(i => h('option', { value: i.id }, i.label))); if (!ins.length) $('cMic').append(h('option', { value: '' }, 'No microphone found')); });
    $('cMsg').textContent = S.settings.micOffset == null ? 'The mic isn\'t calibrated yet, so readings are relative. Type a sound meter reading once and click Calibrate mic for real dB.' : 'Mic is calibrated.';
    $('dlgTest').showModal();
  }
  on('bTest', 'click', openTest);
  on('tLevel', 'input', e => { $('tLevelTxt').textContent = `${e.target.value} dBFS`; });
  on('dlgTest', 'click', e => {
    const b = e.target.closest('[data-test]'); if (!b) return;
    if (S.live.state === 'playing') { if (!confirm('The show is playing. Play a test sound over it?')) return; }
    E.testStart($('tKind').value, b.dataset.test, +$('tLevel').value);
    $('tMsg').textContent = `Playing ${$('tKind').selectedOptions[0].text.toLowerCase()} — ${b.textContent.toLowerCase()} at ${$('tLevel').value} dBFS.`;
  });
  on('tStop', 'click', () => { E.testStop(); $('tMsg').textContent = 'Stopped.'; });
  let songTest = null;
  on('tSong', 'click', async () => {
    const t = sel();
    if (!t) { $('tSongMsg').textContent = 'Select a song in the playlist first.'; return; }
    if (S.live.state === 'playing' || S.live.state === 'paused') { $('tSongMsg').textContent = 'Not while the show is playing.'; return; }
    if (songTest) { songTest.stop(0.3); songTest = null; $('tSong').textContent = 'Play selected song'; $('tSongMsg').textContent = ''; return; }
    let at = effStart(t);
    if (t.an && t.an.peaks) { // loudest 20 seconds from the waveform outline
      const pk = i8FromB64(t.an.peaks), nb = pk.length / 2, per = (t.duration || t.an.duration) / nb, win = Math.max(1, Math.round(20 / per));
      let best = 0, bi = 0, sum = 0; const amp = i => pk[i * 2 + 1] - pk[i * 2];
      for (let i = 0; i < nb; i++) { sum += amp(i); if (i >= win) sum -= amp(i - win); if (i >= win - 1 && sum > best) { best = sum; bi = i - win + 1; } }
      at = clamp(bi * per, effStart(t), Math.max(effStart(t), effEnd(t) - 20));
    }
    const d = decks[1];
    await loadDeck(d, t, at); await d.play(1, 0.3);
    songTest = d; $('tSong').textContent = 'Stop'; $('tSongMsg').textContent = `“${label(t)}” from ${fmt(at)}, at ${gainFor(t) >= 0 ? '+' : ''}${gainFor(t).toFixed(1)} dB`;
    setTimeout(safe(() => { if (songTest === d) { d.stop(1); songTest = null; $('tSong').textContent = 'Play selected song'; } }), 20000);
  });
  const roomDb = raw => S.settings.micOffset == null ? raw : raw + S.settings.micOffset;
  async function calStart() {
    try { await E.micStart($('cMic').value); }
    catch (err) { $('cMsg').textContent = `Couldn't open the microphone: ${err.message}`; return false; }
    // Pink noise at the loudness songs are evened out to, so the room level matches the show.
    E.testStart('pink', 'both', S.settings.targetLufs);
    clearInterval(calTimer);
    const target = () => +$('cTarget').value || 85;
    calTimer = setInterval(safe(() => {
      const l = E.micLevel(); if (!l) return;
      const v = roomDb(l.avg), cal = S.settings.micOffset != null;
      $('cRead').textContent = cal ? `${v.toFixed(1)} dB` : `${v.toFixed(1)} dBFS`;
      $('cRaw').textContent = cal ? `(mic ${l.avg.toFixed(1)} dBFS)` : '(not calibrated)';
      const lo = cal ? 50 : -80, hi = cal ? 110 : 0;
      $('cBar').style.width = clamp((v - lo) / (hi - lo) * 100, 0, 100) + '%';
      $('cTargetMark').style.left = cal ? clamp((target() - lo) / (hi - lo) * 100, 0, 100) + '%' : '-10px';
      if (cal && !autoLevel) { const d = target() - v; $('cMsg').textContent = Math.abs(d) < 1.5 ? 'On target.' : d > 0 ? `${d.toFixed(1)} dB too quiet: turn the amplifier up, or use Auto-level.` : `${(-d).toFixed(1)} dB too loud: turn the amplifier down, or use Auto-level.`; }
    }), 200);
    return true;
  }
  function calStop() { clearInterval(calTimer); E.micStop(); E.testStop(); autoLevel = null; }
  on('cStart', 'click', calStart);
  on('cStop', 'click', () => { calStop(); $('cMsg').textContent = 'Stopped.'; });
  on('cCal', 'click', () => {
    const l = E.micLevel(), m = +$('cMeter').value;
    if (!l) { $('cMsg').textContent = 'Click Start first, then type what your sound meter reads.'; return; }
    if (!m) { $('cMsg').textContent = 'Type the sound meter reading first.'; return; }
    S.settings.micOffset = Math.round((m - l.avg) * 10) / 10; saveSettings();
    $('cMsg').textContent = `Mic calibrated (${S.settings.micOffset > 0 ? '+' : ''}${S.settings.micOffset} dB).`;
  });
  on('cTarget', 'change', e => { S.settings.calTarget = clamp(+e.target.value || 85, 60, 105); saveSettings(); });
  on('cAuto', 'click', async () => {
    if (S.settings.micOffset == null) { $('cMsg').textContent = 'Calibrate the mic with a sound meter reading first, so the app knows real dB.'; return; }
    if (S.live.state === 'playing') { $('cMsg').textContent = 'Not while the show is playing.'; return; }
    if (!calTimer || !E.micLevel()) { if (!(await calStart())) return; }
    const run = autoLevel = { steps: 0 };
    $('cMsg').textContent = 'Auto-levelling…';
    await new Promise(r => setTimeout(r, 2500));
    while (autoLevel === run && run.steps < 14) {
      const l = E.micLevel(); if (!l) break;
      const d = (+$('cTarget').value || 85) - roomDb(l.avg);
      if (Math.abs(d) < 1) { $('cMsg').textContent = `Done: Master is ${S.settings.masterDb > 0 ? '+' : ''}${S.settings.masterDb} dB and the room is on target.`; break; }
      const next = clamp(Math.round((S.settings.masterDb + clamp(d, -6, 6)) * 2) / 2, -30, 12);
      if (next === S.settings.masterDb) { $('cMsg').textContent = d > 0 ? 'Master is at its maximum and the room is still too quiet: turn the amplifier up.' : 'Master is at its minimum and the room is still too loud: turn the amplifier down.'; break; }
      S.settings.masterDb = next; applySettings(); saveSettings(); run.steps++;
      $('cMsg').textContent = `Auto-levelling… Master ${next > 0 ? '+' : ''}${next} dB`;
      await new Promise(r => setTimeout(r, 1800));
    }
    if (autoLevel === run) autoLevel = null;
  });
  on('dlgTest', 'close', () => { calStop(); if (songTest) { songTest.stop(0.3); songTest = null; $('tSong').textContent = 'Play selected song'; } });

  /* ---------- start up ---------- */
  async function boot() {
    try { const s = await desk.readSettings(); if (s) S.settings = { ...DEFAULTS, ...s, eq: (s.eq || DEFAULTS.eq).slice(0, 5) }; } catch (_) {}
    if (S.settings.outputId) { try { await E.setOutput(S.settings.outputId); } catch (err) { log('output not available at start', err.message); banner('output', "The sound output chosen last time isn't connected. Using the system default."); checkOutput.lost = true; } }
    let opened = false;
    try { const a = await desk.readAutosave(); if (a && a.show) { loadShow(a.show, a.filePath, a.dirty); opened = true; } } catch (err) { log('autosave unreadable', String(err)); }
    if (!opened) loadShow(newShow(), null, false);
    const pending = await desk.pendingShow(); if (pending) await openShow(pending);
    applySettings(); configureWp();
    desk.blockSleep(true).catch(() => {});
    await recover();
    renderTransport();
    requestAnimationFrame(frame);
    setInterval(safe(tick), 25);
    log('ready', S.show.name, S.show.tracks.length + ' songs');
  }
  window.addEventListener('beforeunload', () => { snapshot(); autosave(); });

  // for automated tests
  window.SP = { S, decks, get active() { return active; }, go, fadeToNext, fadeOut, stopNow, pause, cueNext, fireHot, addFiles, runPreflight, save, openShow, loadShow,
    fillerPlay, fillerFadeOut, fillerState, buildStatus, buildProgram, showRemaining, gainFor, nextAfter, setHotFile, hotBuffers, E, queue: () => queue.length + (analysing ? 1 : 0) };

  boot().catch(err => { oops(err); requestAnimationFrame(frame); setInterval(safe(tick), 25); });
})();
