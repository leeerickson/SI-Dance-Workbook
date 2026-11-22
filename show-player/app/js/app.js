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
  const oopsSeen = new Map(); let oopsToastAt = 0;
  function oops(err) {
    const text = String(err && err.stack || err), key = text.slice(0, 200), now = Date.now();
    const seen = oopsSeen.get(key) || { n: 0, at: 0 };
    seen.n++;
    if (now - seen.at > 10000) { log('error', seen.n > 1 ? `(x${seen.n}) ` + text : text); seen.at = now; seen.n = 0; console.error(err); }
    oopsSeen.set(key, seen); if (oopsSeen.size > 50) oopsSeen.clear();
    if (now - oopsToastAt > 15000) { oopsToastAt = now; toast('Something went wrong (it has been logged). The show keeps running.'); }
  }
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
    fillerAuto: true, autoResume: true, duckDb: -12, hotDb: 0, wpCode: '', wpOn: false, micOffset: null, calTarget: 85,
    spatialOn: false, width: 1.4, bassCentre: true, videoDisplay: null, trimNew: true,
    stUrl: '', stKey: '', stQ: '720', stTitle: '', stLogo: '', stAccent: 'gold', stProgress: true,
    stService: 'streamingidiot', stYtKey: '', stCredit: true, lcars: false
  };
  // Recommended values, shown with a ▲ mark in Settings. Master, balance and the trims are marked but
  // "Use recommended" leaves them alone, because they're set for the room.
  const REC = { normalize: true, targetLufs: -16, maxBoost: 9, limiterOn: true, ceiling: -1.5, masterDb: 0, balance: 0, trimL: 0, trimR: 0,
    eqOn: true, hpf: true, mbOn: false, mbAmount: 1, spatialOn: false, width: 1.3, bassCentre: true, duckDb: -12, hotDb: 0,
    xfade: 5, fadeSec: 3, fadeOutSec: 3, cueWarn: 10, fillerAuto: true, autoResume: true, trimNew: true };
  const ROOM_KEYS = ['masterDb', 'balance', 'trimL', 'trimR'];
  const newShow = () => ({ id: uid(), name: 'Recital', tracks: [], filler: [], fillerOpts: { loop: true, shuffle: false, levelDb: -6 }, hotCues: Array(8).fill(null) });
  const S = {
    settings: { ...DEFAULTS }, show: newShow(), filePath: null, dirty: false, selectedId: null,
    live: { state: 'idle', currentId: null, standbyId: null, nextId: null, played: new Set(), lastId: null, cueFrom: null, failed: null, lastCue: null, lastPos: 0, busy: false, fadingOut: false, xfade: null, endsAt: 0 },
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
  // Seconds into the song where GO will start it (set by dragging the waveform while stopped).
  const fromOffset = t => (t && S.live.cueFrom && S.live.cueFrom.id === t.id) ? Math.max(0, S.live.cueFrom.at - effStart(t)) : 0;
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
    syncMaster();
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
      sig: { size: info.size, mtime: info.mtime }, an: null, duration: 0, _fresh: true };
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
  const deferred = []; // big files waiting for the music to stop
  setInterval(() => { if (deferred.length && S.live.state !== 'playing' && S.live.state !== 'paused') { deferred.splice(0).forEach(t => { if (t.anError === 'Will be measured when the music stops.') t.anError = ''; queueAnalysis(t); }); } }, 3000);
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
          // Measuring loads the whole file into memory. Mid-song, big files wait until the music stops.
          if (info.size > 80 * 1024 * 1024 && (S.live.state === 'playing' || S.live.state === 'paused') && !(t.an && sigOk(t, info))) {
            if (wantBuf) t._wantBuffer = true;
            deferred.push(t); t.anError = t.anError || 'Will be measured when the music stops.'; continue;
          }
          if (t.an && sigOk(t, info) && wantBuf) { await loadHotBuffer(t); continue; }
          const r = await E.analyze(mediaUrl(t.path), { keep: wantBuf });
          t.an = { lufs: r.lufs, peak: r.peak, peaks: b64FromI8(r.peaks), duration: r.duration };
          t.duration = t.duration || r.duration;
          t.sig = { size: info.size, mtime: info.mtime }; t.anError = '';
          if (r.buffer) hotBuffers.set(t.id, r.buffer);
          if (active && active.track === t) E.ramp(active.trim.gain, E.db2g(gainFor(t)), 0.5);
          if (t._fresh) { delete t._fresh; if (S.settings.trimNew && S.show.tracks.includes(t) && !t.startAt && !t.endAt) trimSilence(t, true); }
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
    // A bounced key can't fire GO twice. (GO already does nothing while a song plays or loads, so this can be short.)
    if (Date.now() - lastGo < 300 || S.live.busy) return;
    lastGo = Date.now();
    const L = S.live;
    if (L.state === 'playing') { toast('Already playing. Press F to fade into the next song, or Esc to fade out.'); return; }
    if (L.state === 'paused') return resume();
    let t = byId(L.standbyId);
    if (!t || !t.enabled) t = L.state === 'idle' ? firstTrack() : null;
    if (!t) { toast(tracks().length ? 'Nothing is standing by. Click a song and choose "Play this next".' : 'Add songs to the show first.'); return; }
    if (fillerState.playing && S.settings.fillerAuto) fillerFadeOut(2.5);
    const from = L.cueFrom && L.cueFrom.id === t.id ? L.cueFrom.at : null;
    await startTrack(t, from != null ? { at: from } : {});
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
      E.ramp(deck.trim.gain, E.db2g(gainFor(t)), 0.01);
      // The new song must be playing before the old one is touched: if it can't start, the old one carries on.
      await deck.play(1, xfade > 0 ? xfade : fadeIn);
      if (outgoing && outgoing !== deck) {
        if (xfade > 0) { outgoing.fade(0, xfade, 'out'); L.xfade = { from: outgoing, until: E.ctx.currentTime + xfade }; setTimeout(safe(() => finishXfade(outgoing)), xfade * 1000 + 80); }
        else outgoing.stop(0.03);
      }
      active = deck; L.failed = null;
      L.currentId = t.id; L.standbyId = null; if (L.nextId === t.id) L.nextId = null;
      L.played.add(t.id); L.lastId = t.id; L.cueFrom = null; L.lastPos = deck.time; L.fadingOut = false; L.lastCue = null;
      stall.t = deck.time; stall.at = performance.now();
      showVideo();
      setState('playing');
      log('play', numberOf(t), label(t), xfade ? `crossfade ${xfade}s` : '');
    } catch (err) {
      log('start failed', t.name, err.message);
      try { deck.el.pause(); } catch (_) {}
      L.failed = { id: t.id, at: Date.now() }; // the automatic move to this song won't be tried again for a while
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
    if (id !== L.currentId) L.played.delete(id);
    if (L.cueFrom && L.cueFrom.id !== id) L.cueFrom = null;
    if (L.state === 'playing' || L.state === 'paused') { L.nextId = id === L.currentId ? null : id; preload = { deck: null, id: null, promise: null }; toast(`Next: ${label(t)}`); }
    else { L.standbyId = id; if (L.state === 'idle' || L.state === 'ended') L.state = 'standby'; toast(`Standing by: ${label(t)}. Press GO.`); }
    renderTransport(); renderLists(); pushStatus(true);
  }
  // Restart (R): while a song plays, jump back to its start and keep going (a quick dip so there's no click).
  // When nothing is playing, stand the song that just played by again, so GO plays it once more.
  function restart() {
    const L = S.live;
    if ((L.state === 'playing' || L.state === 'paused') && active && active.track && !L.busy) {
      const t = active.track, deck = active, wasPaused = L.state === 'paused';
      if (L.xfade) finishXfade(L.xfade.from);
      L.fadingOut = false;
      const go = () => {
        deck.el.currentTime = effStart(t);
        L.lastPos = effStart(t); L.lastCue = null; stall.t = L.lastPos; stall.at = performance.now();
        preload = { deck: null, id: null, promise: null };
        if (!wasPaused) deck.fade(1, 0.12);
        renderTransport(); pushStatus(true);
      };
      if (wasPaused) { deck.fader.gain.value = 1; go(); }
      else { deck.fade(0, 0.06); setTimeout(safe(go), 70); }
      log('restart', label(t));
      toast(`Restarted “${label(t)}” from the top.`);
      return;
    }
    if (L.cueFrom) { L.cueFrom = null; renderTransport(); toast('GO will start the song from the top.'); return; }
    const t = byId(L.lastId) || byId(L.standbyId);
    if (!t) { toast('Nothing has played yet. Click a song and choose "Play this again", or press GO.'); return; }
    cueNext(t.id);
  }
  // Reset show: every song back to "not played", standing by on the first one.
  function resetShow() {
    const L = S.live;
    if (L.state === 'playing' || L.state === 'paused') { toast('Stop the music first, then reset the show.'); return; }
    if (L.played.size && !confirm('Mark every song as not played and stand by on the first one?')) return;
    L.played = new Set(); L.lastId = null; L.nextId = null; L.lastCue = null; L.cueFrom = null;
    const first = firstTrack();
    L.standbyId = first ? first.id : null;
    setState(first ? 'standby' : 'idle');
    renderInspector();
    toast(first ? `Show reset. Standing by on “${label(first)}”.` : 'Show reset.');
    log('reset show');
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
    let next = nextAfter(t.id);
    // If the next song just failed to load, don't keep retrying 40 times a second: let this song finish and stand by.
    const nextFailed = next && L.failed && L.failed.id === next.id && Date.now() - L.failed.at < 60000;
    // get the next song ready on the other deck
    const preWait = next && L.preFail && L.preFail.id === next.id && Date.now() - L.preFail.at < 5000; // a failed preload is retried every 5 s, not every tick
    if (next && !nextFailed && !preWait && (preload.id !== next.id) && left < 45 && !L.xfade) {
      const d = freeDeck();
      if (d && d !== active) { const p = loadDeck(d, next, effStart(next)); p.catch(err => { log('preload failed', next.name, err.message); L.preFail = { id: next.id, at: Date.now() }; preload = { deck: null, id: null, promise: null }; }); preload = { deck: d, id: next.id, promise: p }; }
    }
    if (nextFailed) next = null;
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
    else { t = byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null); if (!t) return 0; total += effLen(t) - fromOffset(t); }
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
      const c = sb && sb.cues.slice().sort((a, b) => a.t - b.t).find(c => c.t >= effStart(sb) + fromOffset(sb));
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
    $('iCueNext').textContent = S.live.played.has(t.id) && t.id !== S.live.currentId ? 'Play this again' : 'Play this next';
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
  // Adds a cue at the exact time (the moment C was pressed), then opens the New cue box to type what to call.
  function addCue(t, at) {
    if (!t) return;
    const c = { id: uid(), t: Math.round(at * 10) / 10, type: $('cueType').value, text: '' };
    t.cues.push(c); changed();
    if (S.selectedId !== t.id) { S.selectedId = t.id; renderLists(); }
    renderInspector();
    openCuePop(t, c);
  }
  let cuePop = null; // { t, c }
  const CUE_TYPES = ['light', 'prop', 'spot', 'sound', 'stage', 'note'];
  function openCuePop(t, c) {
    if (cuePop && cuePop.c !== c) closeCuePop(true);
    cuePop = { t, c };
    $('cpTime').textContent = fmt(c.t, true);
    $('cpSong').textContent = label(t);
    $('cpText').value = c.text;
    renderCueTypes();
    const d = $('dlgCue');
    if (!d.open) d.show();
    $('cpText').focus();
    requestAnimationFrame(() => { if (cuePop && document.activeElement !== $('cpText')) $('cpText').focus(); });
  }
  function renderCueTypes() {
    if (!cuePop) return;
    $('cpTypes').replaceChildren(...CUE_TYPES.map(v => h('button', { type: 'button', role: 'radio', 'aria-checked': String(cuePop.c.type === v), style: `--ct:var(--c-${v})`, tabindex: '-1',
      onmousedown: e => e.preventDefault(), // keep typing in the text box
      onclick: () => setCuePopType(v) }, CT[v])));
  }
  function setCuePopType(v) {
    if (!cuePop) return;
    cuePop.c.type = v; $('cueType').value = v; changed(); renderCueTypes(); renderCues();
  }
  // keep = save what was typed; otherwise (Esc / Cancel) the new cue is removed.
  function closeCuePop(keep) {
    const d = $('dlgCue');
    if (!cuePop) { if (d.open) d.close(); return; }
    const { t, c } = cuePop;
    cuePop = null;
    if (d.open) d.close();
    if (keep) { c.text = $('cpText').value.trim(); toast(c.text ? `Cue saved at ${fmt(c.t, true)}: ${c.text}` : `Cue saved at ${fmt(c.t, true)} with no text. You can type it in the song details.`); }
    else { t.cues = t.cues.filter(x => x !== c); toast('Cue cancelled.'); }
    changed(); renderInspector();
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#dlgCue')) document.activeElement.blur();
  }
  on('cpText', 'input', e => { if (cuePop) { cuePop.c.text = e.target.value; changed(); renderCues(); } });
  on('cpText', 'keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); closeCuePop(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCuePop(false); }
    else if (e.key === 'Tab' && cuePop) { e.preventDefault(); const i = CUE_TYPES.indexOf(cuePop.c.type); setCuePopType(CUE_TYPES[(i + (e.shiftKey ? CUE_TYPES.length - 1 : 1)) % CUE_TYPES.length]); }
  });
  on('cpSave', 'click', () => closeCuePop(true));
  on('cpCancel', 'click', () => closeCuePop(false));
  // Clicking somewhere else in the app saves the cue as typed so far.
  document.addEventListener('mousedown', e => { if (cuePop && !e.target.closest('#dlgCue')) closeCuePop(true); }, true);

  /* ---------- rendering: transport + now ---------- */
  const STATE_TXT = { idle: 'Not started', standby: 'Standing by', playing: 'Playing', paused: 'Paused', ended: 'Show over' };
  function renderTransport() {
    const L = S.live;
    $('stateChip').textContent = L.fadingOut ? 'Fading out' : STATE_TXT[L.state];
    $('stateChip').className = 'state ' + L.state;
    $('nowPanel').className = 'now panel st-' + (L.fadingOut ? 'playing' : L.state);
    const sb = byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null);
    const go = $('bGo');
    const ready = (L.state === 'standby' || L.state === 'idle' || L.state === 'paused') && (sb || L.state === 'paused');
    go.classList.toggle('ready', !!ready && !L.busy);
    go.classList.toggle('busy', L.state === 'playing' || L.busy);
    $('goSub').textContent = L.state === 'paused' ? 'Resume' : L.state === 'playing' ? 'Playing' : sb ? (fromOffset(sb) ? `From ${fmt(fromOffset(sb))} · ${label(sb)}` : label(sb)) : 'Space';
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
  // On-screen numbers (timers, cue countdowns, clock) run on their own 10-a-second timer, not on screen
  // redraws: Windows stops redraws when it thinks the window is covered, and the numbers must keep moving.
  // Each part is separate, so a problem in one can't freeze the others.
  const setTxt = (id, v) => { const el = $(id); if (el._t !== v) { el._t = v; el.textContent = v; } };
  let intermissionToasted = 0;
  function updateText() {
    const L = S.live;
    const playing = active && active.track && (L.state === 'playing' || L.state === 'paused');
    const t = playing ? active.track : null;
    const part = (name, fn) => { try { fn(); } catch (err) { if (!part.logged) { part.logged = true; log('display error', name, String(err)); } } };
    part('timers', () => {
      const sbT = byId(L.standbyId);
      const pos = t ? active.time - effStart(t) : (sbT ? fromOffset(sbT) : 0), left = t ? effEnd(t) - active.time : (sbT ? effLen(sbT) - fromOffset(sbT) : 0);
      setTxt('tElapsed', fmt(pos));
      setTxt('tLeft', fmt(left));
      const big = $('tLeft').parentElement; big.classList.toggle('amber', !!t && left < 30 && left >= 10); big.classList.toggle('red', !!t && left < 10);
      const rem = showRemaining(); setTxt('tShow', fmt(rem));
      setTxt('tEnds', rem > 0 ? new Date(Date.now() + rem * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–');
    });
    part('cues', () => {
      const ci = cueInfo();
      const lc = L.lastCue && (!t || L.lastCue.trackId === t.id) ? L.lastCue.cue : null;
      setCueText($('cueNow'), lc);
      setCueText($('cueNext'), ci.nextCue, ci.nextTrack && t && ci.nextTrack !== t ? `${label(ci.nextTrack)}: ` : (!t && ci.nextTrack ? `${label(ci.nextTrack)}: ` : ''));
      let when = '';
      if (ci.nextIn != null) when = `in ${fmt(ci.nextIn, ci.nextIn < 10)}`;
      else if (ci.nextCue && t) when = `after GO · this song ends in ${fmt(effEnd(t) - active.time)}`; // next song waits for GO
      else if (ci.nextCue) { const nt = ci.nextTrack; when = `${fmt(Math.max(0, ci.nextCue.t - effStart(nt) - fromOffset(nt)))} after GO`; }
      setTxt('cueNextIn', when);
      $('cueNextBox').classList.toggle('warnsoon', ci.nextIn != null && ci.nextIn <= S.settings.cueWarn);
      $('cueNextBox').style.borderLeftColor = ci.nextCue ? `var(--c-${ci.nextCue.type})` : '';
      $('cueNowBox').style.borderLeftColor = lc ? `var(--c-${lc.type})` : '';
    });
    part('clock', () => { setTxt('clock', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); });
    part('intermission', () => {
      if (!S.phones.intermissionEnds) return;
      const s = (S.phones.intermissionEnds - Date.now()) / 1000;
      $('intLeft').textContent = s > 0 ? fmt(s) : '0:00';
      if (s <= 0 && intermissionToasted !== S.phones.intermissionEnds) { intermissionToasted = S.phones.intermissionEnds; toast('Intermission timer is up.'); }
    });
    part('filler', renderFillerStrip);
    part('hot', hotProgress);
  }
  // Screen redraws: just the waveform and meters (they only matter while the window is visible anyway).
  let frameN = 0;
  function frame() {
    requestAnimationFrame(frame);
    frameN++;
    try { drawWave(); } catch (err) { if (frameN % 300 === 0) log('waveform error', String(err)); }
    try { if (frameN % 2 === 0) drawMeters(); } catch (err) { if (frameN % 300 === 0) log('meter error', String(err)); }
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
    return t ? { t, pos: effStart(t) + fromOffset(t) } : null;
  }
  // Theme colours, looked up once every 2 s instead of 60 times a second.
  const themeCss = { at: 0, vals: {}, getPropertyValue(name) { const now = performance.now(); if (now - this.at > 2000) { this.at = now; this.vals = {}; } return this.vals[name] ?? (this.vals[name] = getComputedStyle(document.documentElement).getPropertyValue(name)); } };
  let waveKey = '';
  function drawWave() {
    const dpr = window.devicePixelRatio || 1, W = Math.round(wave.clientWidth * dpr), H = Math.round(wave.clientHeight * dpr);
    if (!W || !H) return;
    if (wave.width !== W || wave.height !== H) { wave.width = W; wave.height = H; waveCache.key = ''; }
    const css = themeCss;
    const wt = waveTrack();
    // Nothing moved by a whole pixel and nothing was edited: leave the picture as it is.
    const drawKey = wt ? [wt.t.id, W, H, Math.round(wt.pos / (wt.t.duration || 1) * W), wt.t.startAt, wt.t.endAt, wt.t.transition, wt.t.xfade, wt.t.an ? wt.t.an.peaks.length : 0, document.documentElement.dataset.theme || '', wt.t.cues.map(c => c.t + c.type + c.text).join('|')].join('~') : `none|${W}|${H}`;
    if (drawKey === waveKey) return;
    waveKey = drawKey;
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
  let scrub = null;
  function scrubTo(e) {
    if (!scrub) return;
    const r = wave.getBoundingClientRect(), t = scrub.t, L = S.live;
    const at = clamp(clamp((e.clientX - r.left) / r.width, 0, 1) * (t.duration || 0), effStart(t), Math.max(effStart(t), effEnd(t) - 0.5));
    if (scrub.active) {
      if (!(active && active.track === t)) { scrub = null; return; }
      active.el.currentTime = at; L.lastPos = at; stall.t = at; stall.at = performance.now();
    } else {
      if (L.standbyId !== t.id) { L.standbyId = t.id; L.played.delete(t.id); if (L.state === 'idle' || L.state === 'ended') L.state = 'standby'; renderListsSoon(); }
      L.cueFrom = at - effStart(t) < 0.3 ? null : { id: t.id, at };
    }
    renderTransport();
  }
  on(wave, 'mousedown', e => {
    if (e.button !== 0) return;
    const wt = waveTrack(); if (!wt) return;
    const L = S.live, isActive = !!(active && active.track === wt.t && (L.state === 'playing' || L.state === 'paused'));
    if (isActive && L.state === 'playing' && !e.shiftKey) { toast('While a song plays, hold Shift and click to jump. When it is stopped or paused, just drag.'); return; }
    if (L.busy) return;
    scrub = { t: wt.t, active: isActive };
    scrubTo(e);
  });
  window.addEventListener('mousemove', safe(e => { if (scrub) scrubTo(e); }));
  window.addEventListener('mouseup', safe(() => {
    if (!scrub) return;
    const sc = scrub; scrub = null;
    if (!sc.active && S.live.cueFrom) toast(`GO will start “${label(sc.t)}” at ${fmt(fromOffset(sc.t))}. Press R to go back to the top.`);
    pushStatus(true);
  }));
  on(wave, 'dblclick', e => { const w = waveTime(e); if (w) addCue(w.t, w.at); });

  function drawMeters() {
    const m = E.meters();
    const pct = db => clamp((db + 60) / 60 * 100, 0, 100) + '%';
    $('mL').style.width = pct(m.peakL); $('mR').style.width = pct(m.peakR);
    $('hL').style.left = pct(m.holdL); $('hR').style.left = pct(m.holdR);
    if (frameN % 12 === 0) $('meterTxt').textContent = `Peak ${Math.max(m.holdL, m.holdR).toFixed(1)} dBFS · limiter ${m.gr < -0.1 ? m.gr.toFixed(1) + ' dB' : 'idle'}${E.duckGain.gain.value < 0.95 ? ' · ducked' : ''}`;
  }

  /* ---------- system utilisation ---------- */
  const HIST = 120; // two minutes of history
  const sys = { cpu: [], app: [], lag: [], ram: [], appMem: [], gpu: [], last: null, maxLag: 0, lagNow: 0, battery: null, heap0: null };
  let lagT = performance.now();
  setInterval(() => { const n = performance.now(); const lag = Math.max(0, n - lagT - 250); lagT = n; if (lag > sys.maxLag) sys.maxLag = lag; if (lag > 300) log('event loop lag', Math.round(lag)); }, 250);
  const mb = b => `${Math.round(b / 1048576)} MB`, gb = b => `${(b / 1073741824).toFixed(1)} GB`;
  const ramUsedPct = s => 100 * (1 - s.freeMem / s.totalMem);
  function sparkline(canvas, series, max = 100) {
    const x = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    x.clearRect(0, 0, W, H);
    for (const { arr, color, fill } of series) {
      if (!arr.length) continue;
      x.beginPath();
      arr.forEach((v, i) => { const px = W - (arr.length - 1 - i) * (W / (HIST - 1)), py = H - 2 - clamp((v || 0) / max, 0, 1) * (H - 4); i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.strokeStyle = color; x.lineWidth = 1.5; x.stroke();
      if (fill) { x.lineTo(W, H); x.lineTo(W - (arr.length - 1) * (W / (HIST - 1)), H); x.closePath(); x.globalAlpha = 0.15; x.fillStyle = color; x.fill(); x.globalAlpha = 1; }
    }
  }
  desk.onStats(safe(s => {
    sys.last = s; sys.lagNow = Math.max(sys.maxLag, s.mainLag || 0); sys.maxLag = 0;
    const push = (k, v) => { sys[k].push(v); if (sys[k].length > HIST) sys[k].shift(); };
    push('cpu', s.cpu); push('app', s.appCpu); push('lag', sys.lagNow); push('ram', ramUsedPct(s)); push('appMem', s.appMem / 1048576); push('gpu', s.gpu);
    const col = n => themeCss.getPropertyValue(n).trim();
    sparkline($('sysGraph'), [{ arr: sys.cpu.slice(-60).concat(), color: col('--muted') }, { arr: sys.app.slice(-60), color: col('--accent') }]);
    setTxt('sysCpu', `CPU ${Math.round(s.cpu)}%${s.gpu != null ? ` · GPU ${Math.round(s.gpu)}%` : ` · app ${Math.round(s.appCpu)}%`}`);
    setTxt('sysMem', `RAM ${Math.round(ramUsedPct(s))}% · app ${mb(s.appMem)}`);
    runHealth();
    if ($('dlgSys').open) renderSys();
  }));
  desk.onPower(safe(p => {
    if (p.what === 'on-battery') banner('power', 'The computer is running on battery. Plug the charger back in.', 'warn');
    if (p.what === 'on-ac') { unbanner('power'); toast('Back on mains power.'); }
    if (p.what === 'resume') { log('computer woke from sleep'); E.ctx.resume().catch(() => {}); checkOutput(); }
    runHealth();
  }));
  if (navigator.getBattery) navigator.getBattery().then(b => { sys.battery = b; }).catch(() => {});

  /* ---------- live health checks ----------
     Every second, from numbers already collected (nothing here does heavy work). A file check for the
     current, standing-by and next songs runs every 5 s. Problems show in the top bar and the System window;
     new serious ones also raise a banner. */
  const health = { items: [], fileAt: 0, missing: new Map(), announced: new Set(), hot: { cpu: 0, gpu: 0, lag: 0 } };
  function avg(arr, n) { const a = arr.slice(-n).filter(v => v != null); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  async function checkFiles() {
    const L = S.live, cur = byId(L.currentId), sb = byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null), nx = cur ? nextAfter(cur.id) : (sb ? nextAfter(sb.id) : null);
    const list = [...new Set([cur, sb, nx].filter(Boolean))];
    if (!list.length) { health.missing.clear(); return; }
    const st = await desk.statMedia(list.map(t => t.path));
    health.missing.clear();
    list.forEach((t, i) => { const gone = !st[i].exists; if (gone) health.missing.set(t.id, t); if (!!t.missing !== gone) { t.missing = gone; renderListsSoon(); } });
  }
  function runHealth() {
    const s = sys.last; if (!s) return;
    const L = S.live, items = [], add = (level, id, text, fix) => items.push({ level, id, text, fix });
    const live = L.state === 'playing' || L.state === 'paused';
    if (Date.now() - health.fileAt > 5000) { health.fileAt = Date.now(); checkFiles().catch(err => log('file check failed', String(err))); }
    // sound
    if (E.ctx.state !== 'running') add('bad', 'audio', `The sound engine is ${E.ctx.state}.`, 'It restarts by itself; if not, use Restart the app in the banner.');
    if (checkOutput.lost) add('warn', 'output', 'The chosen sound output is disconnected (using the system default).', 'Reconnect it.');
    if (audioDog.stuck >= 3) add('bad', 'audiodog', 'The sound card stopped responding.', 'Check the cable or USB audio box.');
    // files
    for (const t of health.missing.values()) add('bad', 'file-' + t.id, `The file for “${label(t)}” can't be found${t.id === L.currentId ? ' (it is playing from memory and may stop)' : ''}.`, 'Reconnect the drive, or use Preflight → Find missing files.');
    // computer
    health.hot.cpu = s.cpu > 90 ? health.hot.cpu + 1 : 0;
    if (health.hot.cpu >= 10) add('warn', 'cpu', `The computer has been at ${Math.round(avg(sys.cpu, 10))}% CPU for 10 seconds.`, 'Close other programs.');
    health.hot.gpu = s.gpu != null && s.gpu > 95 ? health.hot.gpu + 1 : 0;
    if (health.hot.gpu >= 15) add('warn', 'gpu', `The graphics card has been at ${Math.round(s.gpu)}% for 15 seconds.`, 'Close other programs that show video, or lower the stream quality.');
    const freeMb = s.freeMem / 1048576;
    if (s.platform !== 'darwin' && (freeMb < 400 || ramUsedPct(s) > 95)) add(freeMb < 200 ? 'bad' : 'warn', 'ram', `Only ${mb(s.freeMem)} of memory is free.`, 'Close other programs, especially web browsers.');
    if (s.appMem > 2.5 * 1073741824) add('warn', 'appmem', `This app is using ${gb(s.appMem)} of memory.`, 'Restart the app at the next break.');
    health.hot.lag = sys.lagNow > 250 ? health.hot.lag + 3 : Math.max(0, health.hot.lag - 1);
    if (health.hot.lag >= 6) add('warn', 'lag', `The app keeps pausing (up to ${Math.round(Math.max(...sys.lag.slice(-10)))} ms).`, 'Close other programs. The music itself is not affected by short pauses.');
    if (s.disk != null && s.disk < 1e9) add(s.disk < 2e8 ? 'bad' : 'warn', 'disk', `Only ${gb(s.disk)} of disk space is free.`, 'Free some space so autosave and logs keep working.');
    const bat = sys.battery;
    if (s.onBattery) add(bat && bat.level < 0.2 ? 'bad' : 'warn', 'battery', `Running on battery${bat ? ` (${Math.round(bat.level * 100)}%)` : ''}.`, 'Plug the charger in.');
    if (s.thermal && !/nominal|fair/.test(s.thermal)) add('warn', 'thermal', `The computer is hot and slowing down (${s.thermal}).`, 'Give it air; close other programs.');
    // show equipment
    const cur = byId(L.currentId), nxt = cur ? nextAfter(cur.id) : byId(L.standbyId);
    if ((cur && cur.type === 'video' || nxt && nxt.type === 'video') && !videoOpen()) add('warn', 'video', `${cur && cur.type === 'video' ? 'This' : 'The next'} number has video, but the video output window is closed.`, 'Click Video output.');
    if (S.settings.wpOn && parseWpCode(S.settings.wpCode) && wpState.fails >= 3) add('warn', 'phones', "Phones aren't getting updates (the website can't be reached).", 'Check the internet. The show is not affected.');
    if (streamer.want && !(streamer.state.live && streamer.state.gen === streamer.gen)) add('warn', 'stream', 'The live stream is reconnecting.', 'Check the internet. The show is not affected.');
    health.items = items;
    // top bar
    const bad = items.filter(i => i.level === 'bad').length, warn = items.length - bad;
    const el = $('sysHealth');
    setTxt('sysHealth', items.length ? `${items.length} ${items.length === 1 ? 'thing' : 'things'} to check` : 'All systems OK');
    el.className = 'sys-health ' + (bad ? 'bad' : warn ? 'warn' : 'ok');
    $('sysBox').classList.toggle('hot', items.length > 0);
    // new serious problems get a banner once; cleared problems are logged
    for (const i of items) if (!health.announced.has(i.id)) { health.announced.add(i.id); log('health', i.level, i.text); if (i.level === 'bad' && live && !i.id.startsWith('audio')) banner('health-' + i.id, i.text + ' ' + i.fix, 'warn'); }
    for (const id of [...health.announced]) if (!items.some(i => i.id === id)) { health.announced.delete(id); unbanner('health-' + id); log('health cleared', id); }
  }
  function renderSys() {
    const s = sys.last; if (!s) return;
    const col = n => themeCss.getPropertyValue(n).trim();
    $('syHealth').replaceChildren(...(health.items.length ? health.items.map(i => h('li', { class: 'pf ' + i.level }, h('span', { class: 'ic' }, i.level === 'bad' ? '✕' : '!'), h('div', null, h('div', null, i.text), h('div', { class: 'd' }, i.fix)), h('span')))
      : [h('li', { class: 'pf ok' }, h('span', { class: 'ic' }, '✓'), h('div', null, 'All systems OK'), h('span'))]));
    sparkline($('syCpuG'), [{ arr: sys.cpu, color: col('--muted'), fill: true }, { arr: sys.app, color: col('--accent') }]);
    $('syCpuT').textContent = `Computer ${Math.round(s.cpu)}% · this app ${Math.round(s.appCpu)}% (${Math.round(s.appCpuCores)}% of one core) · ${s.coreCount} cores`;
    $('syCores').replaceChildren(...s.cores.map((v, i) => h('i', { title: `Core ${i + 1}: ${Math.round(v)}%`, style: `--v:${Math.round(v)}%`, class: v > 90 ? 'hot' : '' })));
    sparkline($('syRamG'), [{ arr: sys.ram, color: col('--muted'), fill: true }]);
    $('syRamT').textContent = `${gb(s.totalMem - s.freeMem)} of ${gb(s.totalMem)} in use (${Math.round(ramUsedPct(s))}%) · this app ${mb(s.appMem)}`;
    const hasGpu = sys.gpu.some(v => v != null);
    sparkline($('syGpuG'), [{ arr: sys.gpu.map(v => v == null ? 0 : v), color: col('--ok'), fill: true }]);
    const gp = s.procs.Graphics || { cpu: 0, mem: 0 };
    $('syGpuT').textContent = hasGpu ? `Graphics card ${s.gpu != null ? Math.round(s.gpu) + '%' : '–'} · graphics process ${Math.round(gp.cpu)}% of a core, ${mb(gp.mem)}`
      : `This computer doesn't report graphics-card load. Graphics process: ${Math.round(gp.cpu)}% of a core, ${mb(gp.mem)}`;
    $('syProcs').replaceChildren(...Object.entries(s.procs).map(([k, v]) => h('tr', null, h('td', null, k + (v.n > 1 ? ` ×${v.n}` : '')), h('td', { class: 'mono' }, `${v.cpu.toFixed(1)}%`), h('td', { class: 'mono' }, mb(v.mem)))));
    const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const ps = E.ctx.playoutStats; // sound-card glitches, where the browser engine reports them
    const up = s.uptime, upTxt = up >= 3600 ? `${Math.floor(up / 3600)} h ${Math.floor(up % 3600 / 60)} min` : `${Math.floor(up / 60)} min`;
    const rows = [
      ['Sound engine', `${E.ctx.state}, ${E.ctx.sampleRate} Hz, about ${Math.round((E.ctx.baseLatency + (E.ctx.outputLatency || 0)) * 1000)} ms delay`],
      ['Sound glitches', ps ? `${Math.round(ps.fallbackFramesDuration || 0)} ms lost in ${ps.fallbackFramesEvents || 0} dropouts since start` : 'not reported by this system'],
      ['Screen pauses', `now ${Math.round(sys.lagNow)} ms · worst in 2 min ${Math.round(Math.max(0, ...sys.lag))} ms`],
      ['Page memory', heap ? mb(heap) : '–'],
      ['Disk space free', s.disk != null ? gb(s.disk) : '–'],
      ['Power', s.onBattery ? `battery${sys.battery ? ` ${Math.round(sys.battery.level * 100)}%` : ''}` : 'mains' + (s.thermal ? ` · ${s.thermal}` : '')],
      ['Running for', upTxt],
      ['Phones', !S.settings.wpOn ? 'off' : wpState.fails ? `retrying (${wpState.error || 'no answer'})` : `live, ${wpState.latency || 0} ms`],
      ['Stream', !streamer.want ? 'off' : streamer.state.live ? `live on ${streamTarget().name} · ${streamer.state.stats || ''}` : 'reconnecting']
    ];
    $('syFacts').replaceChildren(...rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v))));
  }
  on('sysBox', 'click', () => { renderSys(); $('dlgSys').showModal(); });
  on('syLogs', 'click', () => desk.openLogFolder());
  on('syPre', 'click', () => { $('dlgSys').close(); openPreflight(); });

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
  on('iCueNext', 'click', () => { const t = sel(); if (t) { cueNext(t.id); renderInspector(); } });
  on('bRestart', 'click', restart);
  on('bResetShow', 'click', resetShow);
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
    if (tg.closest && tg.closest('input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable="true"]')) { if (e.key === 'Escape') tg.blur(); return; }
    if (tg.matches && tg.matches('input[type=range]') && /^Arrow/.test(e.key)) return; // arrows still nudge a slider
    if (document.querySelector('dialog:modal')) return;
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') { e.preventDefault(); if (!e.repeat) go(); }
    else if (k === 'Escape') { e.preventDefault(); e.shiftKey ? stopNow(true) : fadeOut(); }
    else if (k === 'f' || k === 'F') fadeToNext();
    else if (k === 'p' || k === 'P') pause();
    else if (k === 'c' || k === 'C') { e.preventDefault(); /* the C itself must not be typed into the New cue box */ const L = S.live; if (active && active.track && (L.state === 'playing' || L.state === 'paused')) addCue(active.track, active.time); else if (sel()) $('bAddCue').click(); }
    else if (k === 'r' || k === 'R') restart();
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
  function cleanForSave() { return JSON.parse(JSON.stringify(S.show, (k, v) => (k === 'missing' || k === 'bad' || k === '_wantBuffer' || k === '_fresh') ? undefined : v)); }
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
    const L = S.live; Object.assign(L, { state: 'idle', currentId: null, standbyId: null, nextId: null, lastId: null, cueFrom: null, lastCue: null }); L.played = new Set();
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
      preflight: () => openPreflight(), test: () => openTest(), settings: () => openSettings(), video: () => toggleVideo(), collect: () => collectFiles(), keys: () => $('dlgKeys').showModal() };
    (acts[name] || (() => {}))();
  }));

  /* ---------- video output ---------- */
  let outWin = null;
  // The video window shows the playing deck's picture through a capture stream. Each deck keeps ONE capture
  // stream for good (held here, so it can't be garbage-collected, which used to make the projector go black
  // after a while), and a watchdog counts the frames the video window actually shows and reconnects if they stop.
  const outFeed = { cap: null, frames: 0, lastFrames: -1, still: 0, reconnects: [], counting: null };
  function captureOf(deck, fresh) {
    const ended = deck.capture && !deck.capture.getVideoTracks().some(t => t.readyState === 'live') && deck.el.videoWidth > 0;
    if (fresh || !deck.capture || ended) deck.capture = deck.el.captureStream();
    return deck.capture;
  }
  function countFrames(v) {
    if ((outFeed.counting && outFeed.counting.v === v) || !v.requestVideoFrameCallback) return;
    const token = outFeed.counting = { v }; // one counter at a time: an older one stops at its next frame
    const tick = () => { if (outFeed.counting !== token) return; outFeed.frames++; v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick);
  }
  function showVideo(fresh) {
    const t = active && active.track;
    const isVid = !!(t && t.type === 'video');
    decks.forEach(d => d.el.classList.toggle('show', d === active && isVid));
    $('vprev').hidden = !(isVid || (outWin && !outWin.closed));
    if (outWin && !outWin.closed) {
      try {
        const v = outWin.document.getElementById('v'), slate = outWin.document.getElementById('slate');
        if (!v) return; // still loading; showVideo runs again when it has
        if (isVid) {
          const cap = captureOf(active, fresh);
          if (v.srcObject !== cap) {
            v.srcObject = cap;
            cap.onaddtrack = () => { try { if (v.srcObject === cap) { v.srcObject = null; v.srcObject = cap; v.play().catch(() => {}); } } catch (_) {} };
          }
          outFeed.cap = cap;
          v.play().catch(() => {});
          countFrames(v);
          slate.hidden = true;
        } else { v.srcObject = null; outFeed.cap = null; slate.hidden = false; slate.textContent = ''; }
      } catch (err) { log('video output error', String(err)); }
    }
  }
  setInterval(safe(() => {
    const v = outWin && !outWin.closed ? outWin.document.getElementById('v') : null;
    const playingVideo = v && active && active.track && active.track.type === 'video' && !active.el.paused && active.el.readyState >= 2 && S.live.state === 'playing';
    if (!playingVideo) { outFeed.still = 0; outFeed.lastFrames = outFeed.frames; return; }
    const live = v.srcObject && v.srcObject.getVideoTracks().some(tr => tr.readyState === 'live');
    if (!live || outFeed.frames === outFeed.lastFrames) outFeed.still++; else outFeed.still = 0;
    outFeed.lastFrames = outFeed.frames;
    if (outFeed.still >= 2) {
      outFeed.still = 0;
      const now = Date.now();
      outFeed.reconnects = outFeed.reconnects.filter(x => now - x < 60000).concat(now);
      log('video output stopped showing frames; reconnecting', { live, tries: outFeed.reconnects.length });
      outFeed.counting = null;
      showVideo(true);
      if (outFeed.reconnects.length >= 4) banner('video', "The video window keeps losing the picture. If it stays black, close and reopen Video output, or turn on Software drawing in Settings → Reliability.", 'warn', [{ label: 'Reopen video output', fn: async () => { closeVideo(); await toggleVideo(); unbanner('video'); } }]);
    }
  }), 1500);
  // Screens are numbered in the order the computer lists them, the same numbers "Identify screens" shows.
  const screenName = (d, i) => `${i + 1} · ${d.label}`;
  function savedScreen(ds) {
    const v = S.settings.videoDisplay; if (!v) return null;
    return ds.find(d => d.id === v.id) || ds.find(d => d.label === v.label && d.width === v.width && d.height === v.height) || null;
  }
  function rememberScreen(d) { S.settings.videoDisplay = { id: d.id, label: d.label, width: d.width, height: d.height }; saveSettings(); }
  const videoOpen = () => !!(outWin && !outWin.closed);
  async function openVideoOn(d, ds) {
    rememberScreen(d);
    if (videoOpen()) {
      await desk.moveVideo(d.id);
      toast(`Video moved to screen ${screenName(d, ds.indexOf(d))}.`);
    } else {
      await desk.chooseDisplay(d.id);
      outWin = window.open('output.html', 'videoout');
      if (!outWin) { toast("Couldn't open the video window."); return; }
      outWin.addEventListener('load', safe(() => { showVideo(); }));
      const watch = setInterval(() => { if (!videoOpen()) { clearInterval(watch); outWin = null; videoButton(); showVideo(); } }, 1000);
      toast(d.primary ? 'The video opened in a window on the main screen. Choose another screen for full screen.' : `Video output is full screen on ${screenName(d, ds.indexOf(d))} (${d.width}×${d.height}).`, 5000);
    }
    videoButton(d, ds);
    showVideo();
  }
  function closeVideo() { if (videoOpen()) outWin.close(); outWin = null; videoButton(); showVideo(); }
  function videoButton(d, ds) { $('bVideo').textContent = videoOpen() && d ? `Video: screen ${ds.indexOf(d) + 1}` : 'Video output'; }
  // Ctrl+Shift+O: open straight on the remembered screen, or close it.
  async function toggleVideo() {
    if (videoOpen()) return closeVideo();
    const ds = await desk.displays(), d = savedScreen(ds);
    if (d) return openVideoOn(d, ds);
    return openVideoDialog();
  }
  let vChoice = null;
  async function openVideoDialog() {
    const ds = await desk.displays();
    const here = videoOpen() ? await desk.videoScreen() : null;
    const pick = ds.find(d => d.id === vChoice) || ds.find(d => d.id === here) || savedScreen(ds) || ds.find(d => !d.primary) || ds[0];
    vChoice = pick ? pick.id : null;
    $('vScreens').replaceChildren(...ds.map((d, i) => h('li', null, h('label', { class: 'screen' },
      h('input', { type: 'radio', name: 'vscreen', value: d.id, checked: d.id === vChoice, onchange: () => { vChoice = d.id; videoDialogButtons(ds, here); } }),
      h('span', { class: 'num' }, i + 1),
      h('span', null, h('span', { class: 'nm' }, d.label, d.id === here ? h('span', { class: 'here' }, 'Video is here') : null),
        h('div', { class: 'sz' }, `${d.width}×${d.height} · ${d.primary ? 'main screen (the controls): opens as a window' : 'full screen'}`))))));
    $('vMsg').textContent = ds.length > 1 ? 'Choose the screen or projector the video plays on. Not sure which is which? Click Identify screens.' : 'Only one screen is connected. Connect the projector, and it appears here.';
    videoDialogButtons(ds, here);
    if (!$('dlgVideo').open) $('dlgVideo').showModal();
  }
  function videoDialogButtons(ds, here) {
    $('vClose').hidden = !videoOpen();
    $('vOpen').textContent = videoOpen() ? (vChoice === here ? 'Video is on this screen' : 'Move video here') : 'Open on this screen';
    $('vOpen').disabled = videoOpen() && vChoice === here;
  }
  on('vOpen', 'click', async () => { const ds = await desk.displays(), d = ds.find(x => x.id === vChoice); if (!d) return openVideoDialog(); await openVideoOn(d, ds); await openVideoDialog(); });
  on('vClose', 'click', async () => { closeVideo(); await openVideoDialog(); });
  on('vIdentify', 'click', () => desk.identifyDisplays());
  // A projector unplugged or plugged back in during the show.
  desk.onDisplaysChanged(safe(async () => {
    const ds = await desk.displays(), want = savedScreen(ds);
    if ($('dlgVideo').open) openVideoDialog();
    if (!videoOpen()) return;
    const here = await desk.videoScreen();
    if (!want && S.settings.videoDisplay) banner('screen', `The video screen “${S.settings.videoDisplay.label}” was disconnected. The video window moved to another screen. Reconnect it, or choose another screen.`, 'warn', [{ label: 'Choose screen', fn: openVideoDialog }]);
    else if (want && here !== want.id) { unbanner('screen'); banner('screen', `Screen “${want.label}” is connected again.`, 'info', [{ label: 'Move video back', fn: async () => { await openVideoOn(want, await desk.displays()); unbanner('screen'); } }]); }
    else unbanner('screen');
  }));
  on('bVideo', 'click', openVideoDialog);

  /* ---------- settings dialog ---------- */
  // Adds the ▲ recommended mark under a slider and a "recommended …" note, once. Returns an updater.
  function recSetup(el, key, fmtv) {
    if (!(key in REC)) return () => {};
    const rec = REC[key];
    if (!el._recHint) {
      const lab = el.closest('label');
      if (el.type === 'range') {
        let box = el.parentElement.classList.contains('rangebox') ? el.parentElement : null;
        if (!box) { box = h('div', { class: 'rangebox' }); el.replaceWith(box); box.append(el); }
        const pct = (rec - +el.min) / (+el.max - +el.min);
        box.append(h('span', { class: 'recmark', style: `left:calc(${pct} * (100% - 16px) + 8px)`, title: `Recommended: ${fmtv(rec)}` }, '▲'));
      }
      const hint = h('span', { class: 'rec-hint' });
      if (el.type === 'checkbox') lab.append(hint);
      else { const txt = lab.querySelector('span.mono'); if (txt) { const row = h('span', { class: 'valrow' }); txt.replaceWith(row); row.append(txt, hint); } else (el.closest('.rangebox') || el).before(hint); }
      el._recHint = hint;
    }
    const hint = el._recHint;
    return v => {
      const same = typeof rec === 'boolean' ? !!v === rec : Math.abs(+v - rec) < 1e-6;
      hint.textContent = same ? '✓ recommended' : `recommended ${fmtv(rec)}`;
      hint.classList.toggle('rec-ok', same);
    };
  }
  const sl = (id, key, txt, fmtv, apply = true) => {
    const el = $(id); el.value = S.settings[key];
    const show = () => { if (txt) $(txt).textContent = fmtv(+el.value); };
    const upd = recSetup(el, key, fmtv);
    show(); upd(+el.value);
    el.oninput = safe(() => { S.settings[key] = +el.value; show(); upd(+el.value); if (apply) applySettings(); saveSettings(); renderListsSoon(); });
  };
  const onOff = v => v ? 'on' : 'off';
  const ck = (id, key, after) => {
    const el = $(id); el.checked = !!S.settings[key];
    const upd = recSetup(el, key, onOff); upd(el.checked);
    el.onchange = safe(() => { S.settings[key] = el.checked; upd(el.checked); applySettings(); saveSettings(); renderListsSoon(); if (after) after(); });
  };
  const nm = (id, key, min, max, unit = '') => {
    const el = $(id); el.value = S.settings[key];
    const upd = recSetup(el, key, v => `${v}${unit}`); upd(+el.value);
    el.onchange = safe(() => { S.settings[key] = clamp(+el.value || 0, min, max); el.value = S.settings[key]; upd(S.settings[key]); applySettings(); saveSettings(); });
  };
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
  // Settings sections (list on the left). Remembers the last one opened.
  let setPane = 'output';
  function showPane(k) {
    setPane = k;
    document.querySelectorAll('.set-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.pane === k)));
    document.querySelectorAll('.set-pane').forEach(p => { p.hidden = p.dataset.pane !== k; });
  }
  on(document.querySelector('.set-nav'), 'click', e => { const b = e.target.closest('.set-tab'); if (b) showPane(b.dataset.pane); });
  function openSettings(pane) {
    showPane(typeof pane === 'string' ? pane : setPane);
    fillOutputs('sOut');
    ck('sNorm', 'normalize', () => { if (active && active.track) E.ramp(active.trim.gain, E.db2g(gainFor(active.track)), 0.5); });
    sl('sTarget', 'targetLufs', 'sTargetTxt', v => `${v} LUFS`);
    sl('sBoost', 'maxBoost', 'sBoostTxt', v => `+${v} dB`);
    ck('sLimiter', 'limiterOn'); sl('sCeil', 'ceiling', 'sCeilTxt', v => `${v} dBFS`);
    sl('sMaster', 'masterDb', 'sMasterTxt', v => `${v > 0 ? '+' : ''}${v} dB`);
    sl('sBal', 'balance', 'sBalTxt', v => v === 0 ? 'centre' : v < 0 ? `${Math.round(-v * 100)}% left` : `${Math.round(v * 100)}% right`);
    nm('sTrimL', 'trimL', -12, 12, ' dB'); nm('sTrimR', 'trimR', -12, 12, ' dB');
    ck('sEqOn', 'eqOn'); ck('sHpf', 'hpf');
    $('sEq').replaceChildren(...E.EQ_BANDS.map((b, i) => {
      const val = h('span', null, `${S.settings.eq[i] > 0 ? '+' : ''}${S.settings.eq[i]} dB`);
      const inp = h('input', { type: 'range', min: -12, max: 12, step: 0.5, value: S.settings.eq[i], 'aria-label': `EQ ${b.f} Hz` });
      inp.oninput = safe(() => { S.settings.eq[i] = +inp.value; val.textContent = `${inp.value > 0 ? '+' : ''}${inp.value} dB`; applySettings(); saveSettings(); });
      return h('label', null, val, inp, b.f >= 1000 ? `${b.f / 1000}k` : `${b.f}`);
    }));
    if (!$('sEq').nextElementSibling || !$('sEq').nextElementSibling.classList.contains('eq-rec')) $('sEq').after(h('p', { class: 'eq-rec' }, '▲ Recommended: all at 0 dB (flat). Only change them if the room needs it, for example −2 dB at 250 Hz for a boomy hall.'));
    ck('sSpatial', 'spatialOn'); ck('sBassC', 'bassCentre');
    sl('sWidth', 'width', 'sWidthTxt', v => `${Math.round(v * 100)}%${v === 0 ? ' · mono' : v < 1 ? ' · narrower' : v === 1 ? ' · unchanged' : ' · wider'}`);
    ck('sMb', 'mbOn'); sl('sMbAmt', 'mbAmount', 'sMbTxt', v => ['gentle', 'light', 'medium', '', 'firm', '', 'strong'][v * 2] || String(v));
    $('sDefTrans').value = S.settings.defTrans; $('sDefTrans').onchange = safe(() => { S.settings.defTrans = $('sDefTrans').value; saveSettings(); });
    nm('sXfade', 'xfade', 0.5, 30, ' s'); nm('sFade', 'fadeSec', 0.5, 20, ' s'); nm('sFadeOut', 'fadeOutSec', 0.5, 20, ' s'); nm('sCueWarn', 'cueWarn', 0, 60, ' s');
    ck('sFillAuto', 'fillerAuto'); ck('sResume', 'autoResume'); ck('sTrimNew', 'trimNew');
    sl('sDuck', 'duckDb', 'sDuckTxt', v => `${v} dB`); sl('sHot', 'hotDb', 'sHotTxt', v => `${v > 0 ? '+' : ''}${v} dB`);
    $('sWpCode').value = S.settings.wpCode; $('sWpOn').checked = S.settings.wpOn;
    $('sWpCode').onchange = safe(() => { S.settings.wpCode = $('sWpCode').value.trim(); saveSettings(); configureWp(); showWpLink(); });
    $('sWpOn').onchange = safe(() => { S.settings.wpOn = $('sWpOn').checked; saveSettings(); configureWp(); });
    showWpLink(); $('sWpMsg').textContent = '';
    openStreamSettings(); openReliabilitySettings();
    if (!$('dlgSettings').open) $('dlgSettings').showModal();
  }
  on('bSettings', 'click', () => openSettings());
  on('bPhones', 'click', () => openSettings('phones'));

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
    try { desk.snapshot({ state: L.state, currentId: L.currentId, standbyId: L.standbyId, nextId: L.nextId, pos: active ? active.time : 0, t: Date.now(), played: [...L.played], showId: S.show.id, filler: fillerState.playing ? fillerState.id : null, streaming: streamer.want }); } catch (_) {}
  }
  setInterval(snapshot, 500);
  async function recover() {
    const r = await desk.recovery();
    // Any stream left over from before a crash is closed; it's started again fresh if it was on.
    await desk.streamStop().catch(() => {});
    if (r && r.crashed && r.streaming) setTimeout(safe(streamStart), 1500);
    if (!r || r.showId !== S.show.id) return;
    const L = S.live; L.played = new Set(r.played || []); L.nextId = r.nextId;
    const t = byId(r.currentId);
    if (r.crashLoop && t) {
      L.standbyId = t.id; setState('standby');
      banner('recovered', `The app restarted several times in a few minutes, so it is standing by on “${label(t)}” instead of carrying on. If this keeps happening, turn on Software drawing (Settings → Reliability) or check that song's file.`, 'warn');
      log('crash loop: standing by');
      return;
    }
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
    const remote = en.filter(t => /^(\\\\|\/\/)/.test(t.path) || /^\/Volumes\//.test(t.path) || /^\/media\//.test(t.path));
    if (remote.length) add('warn', `${remote.length} song${remote.length > 1 ? 's are' : ' is'} on a network or external drive`, 'If it disconnects, the music stops. Use File → Copy all files into the show folder.');
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
      const want = savedScreen(ds);
      if (S.settings.videoDisplay && !want) add('warn', `The chosen video screen “${S.settings.videoDisplay.label}” isn't connected`, 'Connect it, or choose another screen with Video output.');
      else if (want) add('ok', `Video goes to screen ${ds.indexOf(want) + 1}: ${want.label}`);
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
    group('Phones, streaming and saving');
    if (streamTarget().ready) {
      const chk = await desk.streamCheck();
      add(chk.ok ? 'ok' : 'bad', chk.ok ? (streamer.want ? `Live on ${streamTarget().name}` : `Live streaming to ${streamTarget().name} is set up (not started)`) : chk.error, chk.ok ? (streamer.want ? (streamer.state.stats || '') : 'Start it a few minutes before the show and check it on a phone.') : '');
    }
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

  /* ---------- LCARS mode (Easter egg) ---------- */
  function applyTheme() {
    if (S.settings.lcars) document.documentElement.dataset.theme = 'lcars'; else delete document.documentElement.dataset.theme;
    $('sLcars').setAttribute('aria-pressed', String(!!S.settings.lcars));
    $('sLcars').textContent = S.settings.lcars ? 'LCARS mode: on' : 'LCARS mode';
  }
  on('sLcars', 'click', () => { S.settings.lcars = !S.settings.lcars; saveSettings(); applyTheme(); toast(S.settings.lcars ? 'LCARS mode engaged.' : 'Back to the standard look.'); });

  /* ---------- master volume on the main page ---------- */
  const dbTxt = v => `${v > 0 ? '+' : ''}${v} dB`;
  function syncMaster() {
    const el = $('mMaster'); if (!el) return;
    if (document.activeElement !== el) el.value = S.settings.masterDb;
    $('mMasterTxt').textContent = dbTxt(S.settings.masterDb);
    if ($('dlgSettings').open && $('sMaster')) { $('sMaster').value = S.settings.masterDb; $('sMasterTxt').textContent = dbTxt(S.settings.masterDb); }
  }
  {
    const el = $('mMaster');
    el.closest('.rangebox').append(h('span', { class: 'recmark', style: `left:calc(${30 / 42} * (100% - 16px) + 8px)`, title: 'Recommended: 0 dB, with the PA set to the right level' }, '▲'));
    on(el, 'input', () => { S.settings.masterDb = +el.value; applySettings(); saveSettings(); });
    on(el, 'change', () => el.blur()); // so Space goes back to being GO
    on(el, 'dblclick', () => { S.settings.masterDb = 0; el.value = 0; applySettings(); saveSettings(); toast('Master back to 0 dB.'); });
    on('fLevel', 'change', e => e.target.blur());
  }

  /* ---------- use recommended sound settings ---------- */
  on('sRec', 'click', () => {
    if (!confirm('Set the sound settings to the recommended values?\n\nMaster level, balance and left/right trims are left as they are, because they are set for your room.')) return;
    for (const [k, v] of Object.entries(REC)) if (!ROOM_KEYS.includes(k)) S.settings[k] = v;
    S.settings.eq = [0, 0, 0, 0, 0];
    applySettings(); saveSettings(); openSettings(); renderListsSoon();
    toast('Sound settings set to the recommended values.');
  });

  /* ---------- skip silence at the start and end of a song ---------- */
  function silenceBounds(t) {
    if (!t.an || !t.an.peaks) return null;
    const pk = i8FromB64(t.an.peaks), nb = pk.length / 2, dur = t.duration || t.an.duration; if (!dur || !nb) return null;
    const per = dur / nb, loud = i => Math.max(Math.abs(pk[i * 2]), Math.abs(pk[i * 2 + 1])) >= 2; // about −39 dBFS
    let a = 0; while (a < nb && !loud(a)) a++;
    if (a >= nb) return null;
    let z = nb - 1; while (z > a && !loud(z)) z--;
    const start = Math.max(0, a * per - 0.1), end = Math.min(dur, (z + 1) * per + 0.4);
    return { start: start >= 0.4 ? Math.round(start * 10) / 10 : 0, end: dur - end >= 0.6 ? Math.round(end * 10) / 10 : 0 };
  }
  function trimSilence(t, quiet) {
    const b = silenceBounds(t);
    if (!b) { if (!quiet) toast(t.an ? 'This song seems to be silent all the way through.' : 'Still measuring this song. Try again in a moment.'); return false; }
    t.startAt = b.start; t.endAt = b.end;
    changed(); renderInspector(); renderListsSoon();
    if (!quiet) toast(b.start || b.end ? `Skipping silence: starts at ${fmt(b.start, true)}${b.end ? `, ends at ${fmt(b.end, true)}` : ''}.` : 'No silence to skip at either end.');
    else if (b.start || b.end) log('skipped silence', label(t), b);
    return true;
  }
  on('iTrimSil', 'click', () => { const t = sel(); if (t) trimSilence(t); });
  on('iTrimReset', 'click', () => { const t = sel(); if (!t) return; t.startAt = 0; t.endAt = 0; changed(); renderInspector(); renderListsSoon(); toast('Playing the whole file.'); });

  /* ---------- live streaming (Streaming by StreamingIdiot) ---------- */
  const streamer = { want: false, rec: null, canvas: null, g: null, drawTimer: 0, retryTimer: 0, retries: 0, gen: 0, state: {}, startedAt: 0 };
  function openStreamSettings() {
    const showSvc = () => {
      const svc = S.settings.stService || 'streamingidiot';
      document.querySelectorAll('input[name=stsvc]').forEach(r => { r.checked = r.value === svc; });
      $('svcYoutube').hidden = svc !== 'youtube'; $('svcRtmp').hidden = svc === 'youtube';
      $('svcRtmpHelp').hidden = svc !== 'streamingidiot';
    };
    document.querySelectorAll('input[name=stsvc]').forEach(r => { r.onchange = safe(() => { if (streamer.want) { toast('Stop streaming before changing where it goes.'); showSvc(); return; } S.settings.stService = r.value; saveSettings(); showSvc(); renderStream(); }); });
    showSvc();
    $('sStYtKey').value = S.settings.stYtKey; $('sStYtKey').onchange = safe(() => { S.settings.stYtKey = $('sStYtKey').value.trim(); saveSettings(); });
    $('sYtOpen').onclick = safe(() => desk.openExternal('https://studio.youtube.com/'));
    $('sStCredit').checked = S.settings.stCredit !== false; $('sStCredit').onchange = safe(() => { S.settings.stCredit = $('sStCredit').checked; saveSettings(); });
    $('sStUrl').value = S.settings.stUrl; $('sStKey').value = S.settings.stKey; $('sStQ').value = S.settings.stQ; $('sStTitle').value = S.settings.stTitle;
    $('sStUrl').onchange = safe(() => { S.settings.stUrl = $('sStUrl').value.trim(); saveSettings(); });
    $('sStKey').onchange = safe(() => { S.settings.stKey = $('sStKey').value.trim(); saveSettings(); });
    $('sStQ').onchange = safe(() => { S.settings.stQ = $('sStQ').value; saveSettings(); });
    $('sStTitle').oninput = safe(() => { S.settings.stTitle = $('sStTitle').value; saveSettings(); });
    $('sStAccent').value = S.settings.stAccent; $('sStAccent').onchange = safe(() => { S.settings.stAccent = $('sStAccent').value; saveSettings(); });
    $('sStProgress').checked = S.settings.stProgress !== false; $('sStProgress').onchange = safe(() => { S.settings.stProgress = $('sStProgress').checked; saveSettings(); });
    $('sLogoName').textContent = S.settings.stLogo ? S.settings.stLogo.split(/[\\/]/).pop() : 'No logo';
    renderStream();
  }
  // Where the stream goes. YouTube only needs the stream key: its address is built in.
  const YOUTUBE_RTMP = 'rtmp://a.rtmp.youtube.com/live2';
  function streamTarget() {
    const svc = S.settings.stService || 'streamingidiot';
    if (svc === 'youtube') return { svc, name: 'YouTube', url: YOUTUBE_RTMP, key: S.settings.stYtKey, ready: !!S.settings.stYtKey, missing: 'Paste your YouTube stream key first (Settings → Streaming → YouTube).' };
    return { svc, name: svc === 'streamingidiot' ? 'StreamingIdiot' : 'your stream service', url: S.settings.stUrl, key: S.settings.stKey, ready: !!S.settings.stUrl,
      missing: svc === 'streamingidiot' ? 'Paste the stream address from your StreamingIdiot account first (Settings → Streaming).' : 'Paste the stream address first (Settings → Streaming).' };
  }
  async function streamStart() {
    if (streamer.want) return;
    const target = streamTarget();
    if (!target.ready) { toast(target.missing, 5000); openSettings('stream'); return; }
    const chk = await desk.streamCheck();
    if (!chk.ok) { $('sStMsg').textContent = chk.error; toast(chk.error); return; }
    streamer.want = true; streamer.retries = 0; streamer.startedAt = Date.now();
    log('streaming on');
    await streamOpen();
  }
  async function streamOpen() {
    if (!streamer.want) return;
    const q = S.settings.stQ === '480' ? [854, 480] : [1280, 720];
    const target = streamTarget();
    const r = await desk.streamStart({ url: target.url, key: target.key, quality: S.settings.stQ, audioRate: E.ctx.sampleRate });
    if (!r.ok) { streamer.want = false; $('sStMsg').textContent = r.error; toast(`Couldn't start the stream: ${r.error}`, 6000); renderStream(); return; }
    streamer.gen = r.gen;
    if (!streamer.canvas || streamer.canvas.width !== q[0]) { streamer.canvas = document.createElement('canvas'); streamer.canvas.width = q[0]; streamer.canvas.height = q[1]; streamer.g = streamer.canvas.getContext('2d'); }
    clearInterval(streamer.drawTimer);
    streamer.drawTimer = setInterval(drawStreamFrame, 33);
    drawStreamFrame();
    // Picture only here; the sound goes separately as exact samples (E.pcmTapStart below).
    const mime = ['video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(new MediaStream(streamer.canvas.captureStream(30).getVideoTracks()), { mimeType: mime, videoBitsPerSecond: q[0] > 1000 ? 6000000 : 3000000 });
    rec.ondataavailable = e => { if (e.data && e.data.size && streamer.rec === rec) e.data.arrayBuffer().then(b => { if (streamer.rec === rec) desk.streamData(b); }).catch(() => {}); };
    rec.onerror = e => { log('stream recorder error', String(e.error || e)); streamReconnect('The recording stopped.'); };
    streamer.rec = rec;
    await E.pcmTapStart(buf => { if (streamer.rec === rec) desk.streamPcm(buf); });
    rec.start(250);
    renderStream();
  }
  function streamTeardown() {
    const rec = streamer.rec; streamer.rec = null;
    E.pcmTapStop();
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (_) {}
    clearInterval(streamer.drawTimer); streamer.drawTimer = 0;
  }
  // The connection dropped (or ffmpeg stopped): start again with a growing wait, for as long as streaming is wanted.
  function streamReconnect(why) {
    if (!streamer.want) return;
    streamTeardown();
    clearTimeout(streamer.retryTimer);
    const wait = Math.min(30, 2 * 2 ** Math.min(4, streamer.retries++));
    banner('stream', `The live stream dropped (${why || 'connection lost'}). Reconnecting in ${wait} s…`, 'warn', [{ label: 'Stop streaming', fn: streamStop }]);
    log('stream reconnect', why, wait);
    streamer.retryTimer = setTimeout(safe(async () => { await desk.streamStop(); await streamOpen(); }), wait * 1000);
    renderStream();
  }
  async function streamStop() {
    streamer.want = false; clearTimeout(streamer.retryTimer);
    streamTeardown();
    await desk.streamStop();
    unbanner('stream'); log('streaming off');
    renderStream();
  }
  desk.onStreamState(safe(st => {
    streamer.state = st;
    if (st.ended && st.gen === streamer.gen && streamer.want) streamReconnect(st.error || 'the stream service closed the connection');
    else if (st.live && streamer.retries && st.bytes > 200000) { streamer.retries = 0; unbanner('stream'); }
    renderStream();
  }));
  function renderStream() {
    const st = streamer.state || {}, dot = $('stDot'), txt = $('stText');
    const live = streamer.want && st.live && st.gen === streamer.gen;
    if (!streamer.want) { dot.className = 'dot'; txt.textContent = 'Stream'; }
    else if (live) { dot.className = 'dot live'; txt.textContent = `LIVE ${fmt((Date.now() - streamer.startedAt) / 1000)}`; }
    else { dot.className = 'dot warn'; txt.textContent = 'Stream: reconnecting'; }
    $('bStream').title = live ? `Live on ${streamTarget().name} · ${st.stats || ''}` : `Live stream to ${streamTarget().name}`;
    if ($('sStGo')) {
      $('sStGo').textContent = streamer.want ? 'Stop streaming' : 'Start streaming';
      $('sStGo').classList.toggle('danger', streamer.want);
      $('sStMsg').textContent = live ? `Live on ${streamTarget().name} for ${fmt((Date.now() - streamer.startedAt) / 1000)} · ${st.stats || 'starting…'}` : streamer.want ? `Connecting to ${streamTarget().name}…` : (st.error || '');
    }
  }
  setInterval(safe(renderStream), 1000);
  on('sStGo', 'click', () => streamer.want ? (confirm('Stop the live stream?') && streamStop()) : streamStart());
  on('bStream', 'click', () => openSettings('stream'));
  // The picture: the video when a number has one (with the dance name over the start), otherwise the title card.
  function drawStreamFrame() {
    try {
      const c = streamer.canvas, g = streamer.g; if (!c) return;
      const W = c.width, H = c.height, L = S.live;
      const t = active && active.track && (L.state === 'playing' || L.state === 'paused') ? active.track : null;
      if (t && t.type === 'video' && active.el.readyState >= 2 && active.el.videoWidth) {
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        const vw = active.el.videoWidth, vh = active.el.videoHeight, sc = Math.min(W / vw, H / vh);
        g.drawImage(active.el, (W - vw * sc) / 2, (H - vh * sc) / 2, vw * sc, vh * sc);
        const into = active.time - effStart(t);
        if (into < 9) drawLowerThird(g, W, H, 'NOW PERFORMING', label(t), Math.min(1, into / 0.6, (9 - into) / 0.8));
        return;
      }
      drawCard(g, W, H);
    } catch (err) { if (!drawStreamFrame.logged) { drawStreamFrame.logged = true; log('stream picture error', String(err)); } }
  }
  const ACCENTS = { gold: '#F2C200', pink: '#E8508A', teal: '#19A7BC', purple: '#9A6BF7', white: '#FFFFFF' };
  const accent = () => ACCENTS[S.settings.stAccent] || ACCENTS.gold;
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  const logo = { path: '', img: null, ok: false };
  function logoImage() {
    const p = S.settings.stLogo; if (!p) return null;
    if (logo.path !== p) {
      logo.path = p; logo.ok = false;
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { if (logo.img === im) logo.ok = true; };
      im.onerror = () => log('studio logo could not be loaded', p);
      im.src = mediaUrl(p); logo.img = im;
    }
    return logo.ok ? logo.img : null;
  }
  const sparks = Array.from({ length: 50 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 2.2, v: 0.006 + Math.random() * 0.018, a: 0.12 + Math.random() * 0.4, ph: Math.random() * 6.3 }));
  const cardFade = { key: '', at: 0 };
  // What the card says right now.
  function cardInfo() {
    const L = S.live, t = active && active.track && (L.state === 'playing' || L.state === 'paused') ? active.track : null;
    const sb = byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null);
    const sub = x => x ? [x.dance ? x.title : '', x.cls].filter(Boolean).join('  ·  ') : '';
    if (t) { const nx = nextAfter(t.id); return { kicker: 'NOW PERFORMING', big: label(t), sub: sub(t), next: nx ? label(nx) : '', right: fmt(effEnd(t) - active.time), progress: (active.time - effStart(t)) / Math.max(1, effLen(t)) }; }
    if (S.phones.intermissionEnds > Date.now()) return { kicker: 'INTERMISSION', big: `Back in ${fmt((S.phones.intermissionEnds - Date.now()) / 1000)}`, fadeKey: 'intermission', sub: 'Thank you for your patience', next: sb ? label(sb) : '' };
    if (L.state === 'ended') return { kicker: 'THANK YOU', big: 'Thank you for watching', sub: '', next: '' };
    if (L.state === 'idle') return { kicker: 'WELCOME', big: 'The show begins shortly', sub: '', next: sb ? label(sb) : '' };
    if (sb) { const nx = nextAfter(sb.id); return { kicker: 'UP NEXT', big: label(sb), sub: sub(sb), next: nx ? label(nx) : '', nextLabel: 'THEN' }; }
    return { kicker: 'WELCOME', big: S.settings.stTitle || S.show.name, sub: '', next: '' };
  }
  function fitFont(g, text, max, min, width, weight = 850) {
    let size = max;
    for (; size > min; size -= 2) { g.font = `${weight} ${size}px Archivo, Arial, sans-serif`; if (g.measureText(text).width <= width) break; }
    return size;
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function drawCard(g, W, H) {
    const k = W / 1280, now = performance.now() / 1000, acc = accent(), info = cardInfo();
    g.save();
    // background: deep stage blue, sweeping light beams, drifting sparkles, vignette
    const bg = g.createRadialGradient(W / 2, -H * 0.2, 0, W / 2, H * 0.3, W * 0.9);
    bg.addColorStop(0, '#222A50'); bg.addColorStop(0.55, '#0C0F1E'); bg.addColorStop(1, '#040509');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    [0.18, 0.5, 0.82].forEach((x0, i) => {
      const sway = Math.sin(now * 0.22 + i * 2.1) * 0.16, spread = 0.2;
      g.save(); g.translate(W * x0, -20 * k); g.rotate(sway);
      const beam = g.createLinearGradient(0, 0, 0, H * 1.1);
      beam.addColorStop(0, hexA(i === 1 ? acc : '#9FB4FF', 0.2)); beam.addColorStop(1, hexA(i === 1 ? acc : '#9FB4FF', 0));
      g.fillStyle = beam; g.beginPath(); g.moveTo(-10 * k, 0); g.lineTo(10 * k, 0); g.lineTo(H * 1.1 * spread, H * 1.1); g.lineTo(-H * 1.1 * spread, H * 1.1); g.closePath(); g.fill();
      g.restore();
    });
    for (const p of sparks) {
      const y = ((p.y - now * p.v) % 1 + 1) % 1, a = p.a * (0.55 + 0.45 * Math.sin(now * 1.7 + p.ph));
      g.fillStyle = hexA(acc, a * 0.7); g.beginPath(); g.arc((p.x + Math.sin(now * 0.3 + p.ph) * 0.01) * W, y * H, p.r * k, 0, 6.3); g.fill();
    }
    const floor = g.createRadialGradient(W / 2, H * 1.02, 0, W / 2, H * 1.02, W * 0.5);
    floor.addColorStop(0, hexA(acc, 0.16)); floor.addColorStop(1, hexA(acc, 0)); g.fillStyle = floor; g.fillRect(0, H * 0.55, W, H * 0.45);
    g.globalCompositeOperation = 'source-over';
    const vig = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.6)'); g.fillStyle = vig; g.fillRect(0, 0, W, H);
    // top-left: studio logo (or the tape mark); top-right: LIVE and the time
    const img = logoImage();
    if (img && img.naturalWidth) {
      const bw = 230 * k, bh = 110 * k, sc = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
      g.drawImage(img, 56 * k, 40 * k, img.naturalWidth * sc, img.naturalHeight * sc);
    } else {
      ['#F2C200', '#E8508A', '#19A7BC'].forEach((col, i) => { g.save(); g.translate(60 * k + i * 7 * k, 52 * k + i * 17 * k); g.rotate(-0.1); g.fillStyle = col; g.fillRect(0, 0, 72 * k, 12 * k); g.restore(); });
    }
    g.textBaseline = 'middle';
    roundRect(g, W - 190 * k, 44 * k, 134 * k, 38 * k, 19 * k); g.fillStyle = 'rgba(0,0,0,0.45)'; g.fill();
    g.fillStyle = '#E5484D'; g.beginPath(); g.arc(W - 166 * k, 63 * k, (6 + Math.sin(now * 4) * 1.2) * k, 0, 6.3); g.fill();
    g.fillStyle = '#FFF'; g.font = `800 ${Math.round(17 * k)}px Archivo, Arial, sans-serif`; g.textAlign = 'left'; g.fillText('LIVE', W - 150 * k, 64 * k);
    g.fillStyle = '#AEB6CC'; g.font = `600 ${Math.round(15 * k)}px Inter, Arial, sans-serif`; g.fillText(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), W - 102 * k, 64 * k);
    // show title, letter-spaced, with an accent rule under it
    g.textAlign = 'center';
    g.letterSpacing = `${Math.round(6 * k)}px`;
    g.fillStyle = '#C9D0E6'; fitFont(g, (S.settings.stTitle || S.show.name || '').toUpperCase(), Math.round(26 * k), Math.round(14 * k), W * 0.6, 700);
    g.fillText((S.settings.stTitle || S.show.name || '').toUpperCase(), W / 2, 150 * k);
    g.letterSpacing = '0px';
    g.fillStyle = acc; g.fillRect(W / 2 - 50 * k, 178 * k, 100 * k, 3 * k);
    // the main message fades and lifts in when it changes
    const key = info.kicker + '|' + (info.fadeKey || info.big); // a ticking countdown isn't a new message
    if (cardFade.key !== key) { cardFade.key = key; cardFade.at = now; }
    const f = Math.min(1, (now - cardFade.at) / 0.7), ease = 1 - Math.pow(1 - f, 3);
    g.globalAlpha = ease; const lift = (1 - ease) * 18 * k;
    g.letterSpacing = `${Math.round(4 * k)}px`; g.font = `800 ${Math.round(18 * k)}px Archivo, Arial, sans-serif`;
    const kw = g.measureText(info.kicker).width + 40 * k;
    roundRect(g, W / 2 - kw / 2, 262 * k + lift, kw, 40 * k, 20 * k); g.strokeStyle = hexA(acc, 0.85); g.lineWidth = 2 * k; g.stroke();
    g.fillStyle = acc; g.fillText(info.kicker, W / 2 + 2 * k, 283 * k + lift);
    g.letterSpacing = '0px';
    const bigSize = fitFont(g, info.big, Math.round(108 * k), Math.round(44 * k), W * 0.86);
    g.save(); g.shadowColor = hexA(acc, 0.45); g.shadowBlur = 40 * k; g.fillStyle = '#FFFFFF';
    g.font = `850 ${bigSize}px Archivo, Arial, sans-serif`; g.fillText(info.big, W / 2, 380 * k + lift); g.restore();
    if (info.sub) { g.fillStyle = '#C9CEDD'; fitFont(g, info.sub, Math.round(32 * k), Math.round(18 * k), W * 0.8, 500); g.fillText(info.sub, W / 2, 462 * k + lift); }
    g.globalAlpha = 1;
    if (S.phones.message) { g.fillStyle = acc; fitFont(g, S.phones.message, Math.round(26 * k), Math.round(16 * k), W * 0.8, 650); g.fillText(S.phones.message, W / 2, 530 * k); }
    // lower third: up next, and time left in the song
    if (info.next || info.right) {
      const x = 80 * k, y = 588 * k, w = W - 160 * k, h = 64 * k;
      roundRect(g, x, y, w, h, 14 * k); g.fillStyle = 'rgba(255,255,255,0.07)'; g.fill();
      g.fillStyle = acc; g.fillRect(x, y + 12 * k, 5 * k, h - 24 * k);
      g.textAlign = 'left';
      if (info.next) {
        g.letterSpacing = `${Math.round(3 * k)}px`; g.fillStyle = acc; g.font = `800 ${Math.round(15 * k)}px Archivo, Arial, sans-serif`;
        const lab = info.nextLabel || 'UP NEXT'; g.fillText(lab, x + 26 * k, y + h / 2); const lw = g.measureText(lab).width;
        g.letterSpacing = '0px'; g.fillStyle = '#FFF'; fitFont(g, info.next, Math.round(26 * k), Math.round(15 * k), w * 0.62, 750); g.fillText(info.next, x + 46 * k + lw, y + h / 2);
      }
      if (info.right) { g.textAlign = 'right'; g.fillStyle = '#AEB6CC'; g.font = `600 ${Math.round(22 * k)}px "JetBrains Mono", monospace`; g.fillText(info.right, x + w - 26 * k, y + h / 2); }
    }
    if (info.progress != null && S.settings.stProgress !== false) {
      g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(0, H - 6 * k, W, 6 * k);
      g.fillStyle = acc; g.fillRect(0, H - 6 * k, W * clamp(info.progress, 0, 1), 6 * k);
    }
    g.textAlign = 'center'; g.fillStyle = '#56607A'; g.font = `600 ${Math.round(14 * k)}px Inter, Arial, sans-serif`; g.letterSpacing = `${Math.round(1 * k)}px`;
    if (S.settings.stCredit !== false) g.fillText('Streaming by StreamingIdiot', W / 2, H - 28 * k);
    g.restore();
  }
  // "Now performing" over the start of a video number.
  function drawLowerThird(g, W, H, kicker, name, alpha) {
    const k = W / 1280, acc = accent();
    g.save(); g.globalAlpha = Math.max(0, alpha); g.textBaseline = 'middle'; g.textAlign = 'left';
    const x = 60 * k, y = H - 150 * k, w = Math.min(W * 0.7, 760 * k), h = 86 * k;
    const grd = g.createLinearGradient(x, 0, x + w, 0); grd.addColorStop(0, 'rgba(6,8,16,0.85)'); grd.addColorStop(1, 'rgba(6,8,16,0)');
    g.fillStyle = grd; g.fillRect(x, y, w, h); g.fillStyle = acc; g.fillRect(x, y, 6 * k, h);
    g.letterSpacing = `${Math.round(3 * k)}px`; g.fillStyle = acc; g.font = `800 ${Math.round(15 * k)}px Archivo, Arial, sans-serif`; g.fillText(kicker, x + 26 * k, y + 26 * k);
    g.letterSpacing = '0px'; g.fillStyle = '#FFF'; fitFont(g, name, Math.round(36 * k), Math.round(18 * k), w - 50 * k); g.fillText(name, x + 26 * k, y + 58 * k);
    g.restore();
  }
  // Live preview in Settings → Streaming.
  setInterval(safe(() => {
    if (!$('dlgSettings').open || setPane !== 'stream') return;
    const c = $('sStPreview'); drawCard(c.getContext('2d'), c.width, c.height);
  }), 100);
  on('sLogoPick', 'click', async () => { const p = await desk.chooseImage(); if (!p) return; S.settings.stLogo = p; saveSettings(); $('sLogoName').textContent = p.split(/[\\/]/).pop(); });
  on('sLogoClear', 'click', () => { S.settings.stLogo = ''; saveSettings(); $('sLogoName').textContent = 'No logo'; });

  /* ---------- reliability ---------- */
  async function openReliabilitySettings() {
    const prefs = await desk.startupPrefs().catch(() => ({}));
    $('sSoftDraw').checked = !!prefs.softwareDrawing;
    $('sSoftDraw').onchange = safe(async () => { await desk.setStartupPrefs({ softwareDrawing: $('sSoftDraw').checked }); toast('Saved. It takes effect the next time Recital Show Player starts.', 5000); });
  }
  // Copy every file into a folder next to the show file, so nothing depends on a USB stick or network drive.
  async function collectFiles() {
    if (S.live.state === 'playing' || S.live.state === 'paused') { toast('Stop the music first, then copy the files.'); return; }
    if (!S.filePath) { toast('Save the show first, so the app knows where to put the files.'); if (!(await save())) return; }
    const items = [...S.show.tracks, ...S.show.filler, ...S.show.hotCues.filter(Boolean)].filter(t => t.path);
    $('sCollectMsg').textContent = 'Copying…'; toast('Copying files into the show folder…');
    const r = await desk.collectMedia(S.filePath, items.map(t => t.path));
    let moved = 0;
    for (const t of items) { const np = r.map[t.path]; if (np && np !== t.path) { t.path = np; t.name = np.split(/[\\/]/).pop(); t.missing = false; moved++; } }
    changed(); renderLists(); renderInspector();
    await save();
    $('sCollectMsg').textContent = `Done: ${r.copied} copied, ${r.skipped} already there, into “${r.dir}”.`;
    toast(`All files are now in the show folder (${r.copied} copied).`, 5000);
  }
  desk.onCollectProgress(safe(pr => { $('sCollectMsg').textContent = `Copying… ${pr.done} of ${pr.total}`; }));
  on('sCollect', 'click', collectFiles);
  // Keys only work while this window is the active one: say so when it isn't (e.g. after clicking the video window).
  let blurTimer = 0;
  window.addEventListener('blur', () => { clearTimeout(blurTimer); blurTimer = setTimeout(() => { if (!document.hasFocus()) $('focusWarn').hidden = false; }, 600); });
  window.addEventListener('focus', () => { clearTimeout(blurTimer); $('focusWarn').hidden = true; });
  on('focusWarn', 'click', () => { $('focusWarn').hidden = true; window.focus(); });
  // Sound card watchdog: the audio clock must keep moving. If it stops, try to wake it, then offer a restart.
  const audioDog = { last: -1, stuck: 0, tried: false };
  setInterval(safe(async () => {
    const now = E.ctx.currentTime;
    if (E.ctx.state === 'running' && now === audioDog.last) audioDog.stuck++; else { if (audioDog.stuck >= 3) { unbanner('audio'); log('sound card running again'); } audioDog.stuck = 0; audioDog.tried = false; }
    audioDog.last = now;
    if (audioDog.stuck === 3) {
      log('sound card stopped responding');
      banner('audio', 'The sound card stopped responding. Trying to wake it…', 'warn', [{ label: 'Restart the app', fn: () => { snapshot(); desk.relaunch(); } }]);
      if (!audioDog.tried) { audioDog.tried = true; try { await E.setOutput(S.settings.outputId || ''); await E.ctx.resume(); } catch (err) { log('wake sound card failed', String(err)); } }
    }
    if (audioDog.stuck === 8) banner('audio', "The sound card still isn't responding. Check the cable or USB audio box, or restart the app (it picks up the show where it was).", 'warn', [{ label: 'Restart the app', fn: () => { snapshot(); desk.relaunch(); } }]);
  }), 1000);
  let gpuCrashes = 0;
  desk.onGpuGone(safe(() => { gpuCrashes++; outFeed.counting = null; setTimeout(safe(() => showVideo(true)), 1000); log('graphics process restarted', gpuCrashes); if (gpuCrashes >= 2) banner('gpu', 'The graphics driver has restarted more than once. If the screen flickers or freezes, turn on Software drawing in Settings → Reliability.', 'info', [{ label: 'Open Settings', fn: () => openSettings('reliability') }]); }));

  /* ---------- start up ---------- */
  async function boot() {
    try { const s = await desk.readSettings(); if (s) S.settings = { ...DEFAULTS, ...s, eq: (s.eq || DEFAULTS.eq).slice(0, 5) }; } catch (_) {}
    if (S.settings.outputId) { try { await E.setOutput(S.settings.outputId); } catch (err) { log('output not available at start', err.message); banner('output', "The sound output chosen last time isn't connected. Using the system default."); checkOutput.lost = true; } }
    let opened = false;
    try { const a = await desk.readAutosave(); if (a && a.show) { loadShow(a.show, a.filePath, a.dirty); opened = true; } } catch (err) { log('autosave unreadable', String(err)); }
    if (!opened) loadShow(newShow(), null, false);
    const pending = await desk.pendingShow(); if (pending) await openShow(pending);
    applySettings(); configureWp(); applyTheme();
    desk.blockSleep(true).catch(() => {});
    await recover();
    renderTransport();
    requestAnimationFrame(frame);
    setInterval(updateText, 100);
    setInterval(safe(tick), 25);
    log('ready', S.show.name, S.show.tracks.length + ' songs');
  }
  window.addEventListener('beforeunload', () => { snapshot(); autosave(); });

  // for automated tests
  window.SP = { S, decks, health, sys, runHealth, sysLag: () => sys.lag, applyTheme, streamTarget, openSettings, drawCard, videoOut: () => outWin, outFeed, streamStart, streamStop, streamer, trimSilence, collectFiles, syncMaster, updateText, closeCuePop, restart, resetShow, applySettings, openVideoDialog, get active() { return active; }, go, fadeToNext, fadeOut, stopNow, pause, cueNext, fireHot, addFiles, runPreflight, save, openShow, loadShow,
    fillerPlay, fillerFadeOut, fillerState, buildStatus, buildProgram, showRemaining, gainFor, nextAfter, setHotFile, hotBuffers, E, queue: () => queue.length + (analysing ? 1 : 0) };

  boot().catch(err => { oops(err); requestAnimationFrame(frame); setInterval(updateText, 100); setInterval(safe(tick), 25); });
})();
