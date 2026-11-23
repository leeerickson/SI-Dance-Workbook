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
  // Asks a yes/no question without freezing the app. (The built-in confirm() stops every timer while it's
  // open, which mid-show could hold up the move to the next song.)
  const nativeConfirm = window.confirm;
  let askQueue = Promise.resolve();
  function ask(text, yes = 'OK', no = 'Cancel') {
    if (typeof window.confirm === 'function' && window.confirm !== nativeConfirm) return Promise.resolve(!!window.confirm(text)); // tests swap confirm() to answer
    const run = () => new Promise(resolve => {
      const d = $('dlgAsk');
      $('askText').textContent = text; $('askYes').textContent = yes; $('askNo').textContent = no;
      d.returnValue = 'no';
      d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
      d.showModal(); $('askYes').focus();
    });
    return (askQueue = askQueue.then(run, run));
  }
  const b64FromI8 = arr => { let s = ''; const u = new Uint8Array(Int8Array.from(arr).buffer); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const i8FromB64 = str => { const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Int8Array(u.buffer); };

  /* ---------- state ---------- */
  const DEFAULTS = {
    outputId: '', normalize: true, targetLufs: -16, maxBoost: 12, limiterOn: true, ceiling: -1.5, masterDb: 0, balance: 0, trimL: 0, trimR: 0,
    eqOn: true, eq: [0, 0, 0, 0, 0], hpf: false, mbOn: false, mbAmount: 1, defTrans: 'stop', xfade: 5, fadeSec: 3, fadeOutSec: 3, cueWarn: 10,
    fillerAuto: true, autoResume: true, duckDb: -12, hotDb: 0, wpCode: '', wpOn: false, micOffset: null, calTarget: 85,
    spatialOn: false, width: 1.4, bassCentre: true, videoDisplay: null, trimNew: true,
    stUrl: '', stKey: '', stQ: '720', stTitle: '', stLogo: '', stAccent: 'gold', stProgress: true,
    stService: 'streamingidiot', stYtKey: '', stCredit: true, lcars: false, outGraphics: false,
    stEnc: 'auto', stAuto: true, outBackup: 'default', speed: null, lastRehearsal: null
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
    const picked = (list || []).filter(i => i && i.exists !== false && i.path);
    if (!picked.length) return;
    // .dance files from the Choreography Workbook: take the song out, with the dance name, props and (if wanted) cues.
    const dances = picked.filter(i => /\.dance$/i.test(i.path));
    const metaFor = new Map();
    let infos = picked.filter(i => !/\.dance$/i.test(i.path));
    if (dances.length) {
      const withCues = where === 'show' && await ask(`Bring in the sections and formations as cues too?\n\nSections become Note cues and formations become Stage cues, at their times in the song. You can delete any you don't want.`, 'Music and cues', 'Music only');
      const problems = [];
      for (const d of dances) {
        const r = await desk.importDance(d.path, withCues);
        if (r.error) { problems.push(r.error === 'no-music' ? `“${r.title}” has no music inside. In the Workbook, save the share file with “Everything, including music and video”.` : `${d.name}: ${r.error}`); continue; }
        infos.push(r.info); metaFor.set(r.info.path, r.meta);
      }
      if (problems.length) banner('dance-import', problems.join(' '), 'warn');
      if (!infos.length) return;
    }
    const made = infos.map(i => {
      const t = makeTrack(i), m = metaFor.get(i.path);
      if (m) { t.dance = m.dance; t.cls = m.cls; t.title = m.title || t.title; t.props = m.props.map(text => ({ id: uid(), text })); t.cues = m.cues.map(c => ({ id: uid(), ...c })); t.fromDance = true; }
      return t;
    });
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
    toast(metaFor.size ? `Added ${made.length} song${made.length > 1 ? 's' : ''} (${metaFor.size} from .dance files). Measuring loudness…` : `Added ${made.length} file${made.length > 1 ? 's' : ''}. Measuring loudness…`);
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
          t.sig = { size: info.size, mtime: info.mtime }; t.anError = ''; t.vcodec = null;
          if (r.buffer) hotBuffers.set(t.id, r.buffer);
          if (active && active.track === t) E.ramp(active.trim.gain, E.db2g(gainFor(t)), 0.5);
          if (isVideo(t.name || t.path) && !t.vcodec && S.show.tracks.includes(t)) findCodec([t]);
          if (t._fresh) { delete t._fresh; if (S.settings.trimNew && S.show.tracks.includes(t) && !t.startAt && !t.endAt) trimSilence(t, true); }
        } catch (err) {
          if (isVideo(t.name || t.path) && !t.vcodec && S.show.tracks.includes(t)) findCodec([t]);
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
  async function resetShow() {
    const L = S.live;
    if (L.state === 'playing' || L.state === 'paused') { toast('Stop the music first, then reset the show.'); return; }
    if (L.played.size && !(await ask('Mark every song as not played and stand by on the first one?', 'Reset show'))) return;
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
      if (t.missing || (t.anError && !t.duration) || cantShow(t)) cls.push('bad');
      const g = t.an ? `${gainFor(t) >= 0 ? '+' : ''}${gainFor(t).toFixed(1)} dB` : t.anError ? '!' : '…';
      return h('li', { class: cls.join(' '), 'data-id': t.id, draggable: 'true', title: t.path },
        h('span', { class: 'n' }, t.enabled ? n : '–'),
        h('span', { class: 't1' }, label(t), t.type === 'video' ? h('span', { class: 'badge v', style: 'margin-left:6px' }, 'VIDEO') : null, cantShow(t) ? h('span', { class: 'badge', style: 'margin-left:6px;color:var(--warn)', title: `This is ${CODEC_NAMES[t.vcodec] || t.vcodec} video, which this computer can't play. Convert it in Preflight.` }, "CAN'T PLAY") : null, t.missing ? h('span', { class: 'badge', style: 'margin-left:6px;color:var(--warn)' }, 'MISSING') : null),
        h('span', { class: 't2' }, t.dance ? t.title : (t.cls || t.name)),
        h('span', { class: 'meta' }, h('span', { class: 'len' }, h('b', { class: 'eta', 'data-eta': t.id, title: 'Estimated clock time this song starts, if the show runs straight through from now' }), fmt(effLen(t))), h('span', { class: 'tr' }, TRS[t.transition] || ''), h('span', { title: 'Volume change to even it out' }, g)));
    });
    list.replaceChildren(...rows);
    renderEtas();
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

  // Estimated clock time each upcoming song starts, if the show carries on from now with no waiting:
  // the rest of the current song, then each song's length in order (less any crossfade overlap).
  function etaTimes() {
    const L = S.live, out = new Map();
    const playing = active && active.track && (L.state === 'playing' || L.state === 'paused');
    let cur = playing ? active.track : (byId(L.standbyId) || (L.state === 'idle' ? firstTrack() : null));
    if (!cur) return out;
    let cursor = Date.now() + (playing ? Math.max(0, effEnd(cur) - active.time) : effLen(cur) - fromOffset(cur)) * 1000;
    if (!playing) out.set(cur.id, Date.now());
    const seen = new Set([cur.id]);
    let n = nextAfter(cur.id);
    while (n && !seen.has(n.id)) {
      seen.add(n.id);
      const start = cursor - (cur.transition === 'crossfade' ? Math.min(+cur.xfade || 0, effLen(n) / 2) * 1000 : 0);
      out.set(n.id, start);
      cursor = start + effLen(n) * 1000;
      cur = n; n = nextAfter(n.id);
      if (L.nextId && n && n.id === L.nextId) n = null; // "play this next" only applies once
    }
    return out;
  }
  const clockTxt = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function renderEtas() {
    const times = etaTimes();
    document.querySelectorAll('#plist [data-eta]').forEach(el => { const at = times.get(el.dataset.eta); const v = at ? clockTxt(at) : ''; if (el.textContent !== v) el.textContent = v; });
  }
  setInterval(safe(renderEtas), 5000);

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
  // Which cue is under the pointer: its line (within 5 px) or its label along the top.
  function cueAt(e) {
    const wt = waveTrack(); if (!wt) return null;
    const r = wave.getBoundingClientRect(), dur = wt.t.duration || 0; if (!dur || !r.width) return null;
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    wctx.save(); wctx.font = '600 11px Inter';
    let hit = null;
    for (const c of wt.t.cues) {
      const cx = c.t / dur * r.width, lw = Math.min(140, wctx.measureText(c.text || CT[c.type]).width + 8);
      if (Math.abs(mx - cx) <= 5 || (my <= 16 && mx >= cx && mx <= cx + lw)) hit = { t: wt.t, c, grab: mx - cx };
    }
    wctx.restore();
    return hit;
  }
  let cueDrag = null;
  function cueDragTo(e) {
    const { t, c, grab } = cueDrag, r = wave.getBoundingClientRect();
    const at = clamp((e.clientX - r.left - grab) / r.width * (t.duration || 0), effStart(t), Math.max(effStart(t), effEnd(t) - 0.1));
    const v = Math.round(at * 10) / 10;
    if (v !== c.t) { c.t = v; cueDrag.moved = true; if (S.selectedId === t.id) renderCues(); }
  }
  on(wave, 'mousedown', e => {
    if (e.button !== 0) return;
    const wt = waveTrack(); if (!wt) return;
    const L = S.live, isActive = !!(active && active.track === wt.t && (L.state === 'playing' || L.state === 'paused'));
    // Paused or stopped: a cue can be dragged to a new time. (Not while playing, so a slip can't move one mid-show.)
    if (L.state !== 'playing') { const hit = cueAt(e); if (hit) { cueDrag = { ...hit, moved: false, from: hit.c.t }; e.preventDefault(); return; } }
    if (isActive && L.state === 'playing' && !e.shiftKey) { toast('While a song plays, hold Shift and click to jump. When it is stopped or paused, just drag.'); return; }
    if (L.busy) return;
    scrub = { t: wt.t, active: isActive };
    scrubTo(e);
  });
  window.addEventListener('mousemove', safe(e => { if (cueDrag) cueDragTo(e); else if (scrub) scrubTo(e); }));
  on(wave, 'mousemove', e => { if (!cueDrag && !scrub) wave.style.cursor = S.live.state !== 'playing' && cueAt(e) ? 'ew-resize' : ''; });
  window.addEventListener('mouseup', safe(() => {
    if (!cueDrag) return;
    const d = cueDrag; cueDrag = null;
    if (!d.moved) return;
    d.t.cues.sort((a, b) => a.t - b.t);
    changed(); renderInspector(); pushStatus(true);
    toast(`Cue “${d.c.text || CT[d.c.type]}” moved from ${fmt(d.from, true)} to ${fmt(d.c.t, true)}.`);
    log('cue moved', label(d.t), d.c.text, d.from, d.c.t);
  }));
  window.addEventListener('mouseup', safe(() => {
    if (!scrub) return;
    const sc = scrub; scrub = null;
    if (!sc.active && S.live.cueFrom) toast(`GO will start “${label(sc.t)}” at ${fmt(fromOffset(sc.t))}. Press R to go back to the top.`);
    pushStatus(true);
  }));
  on(wave, 'dblclick', e => { if (cueAt(e)) return; const w = waveTime(e); if (w) addCue(w.t, w.at); });

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
    if (reh.running) rehSample();
    runHealth();
    if ($('dlgSys').open) renderSys();
  }));
  desk.onPower(safe(p => {
    if (p.what === 'on-battery') banner('power', 'The computer is running on battery. Plug the charger back in.', 'warn');
    if (p.what === 'on-ac') { unbanner('power'); toast('Back on mains power.'); }
    if (p.what === 'resume') { glitchQuiet(5000); log('computer woke from sleep'); E.ctx.resume().catch(() => {}); checkOutput(); }
    runHealth();
  }));
  if (navigator.getBattery) navigator.getBattery().then(b => { sys.battery = b; }).catch(() => {});

  /* ---------- audio dropouts ----------
     Counts the times the sound card ran dry (a click or gap in the room). Chromium reports this directly where it
     can (playoutStats). Otherwise it is measured: the sound clock and the computer clock move together, and a
     dropout makes the sound clock fall behind by the length of the gap. Measured four times a second. */
  const glitch = { count: 0, ms: 0, last: 0, base: null, quietUntil: 0, events: [], src: '', ps: null };
  function glitchQuiet(ms = 3000) { glitch.quietUntil = performance.now() + ms; glitch.base = null; glitch.ps = null; }
  function recordGlitch(n, ms) {
    glitch.count += n; glitch.ms += ms; glitch.last = Date.now();
    const where = active && active.track && S.live.state === 'playing' ? `during “${label(active.track)}” at ${fmt(active.time)}` : 'between songs';
    glitch.events.push({ t: Date.now(), ms: Math.round(ms), where }); if (glitch.events.length > 50) glitch.events.shift();
    log('audio dropout', Math.round(ms) + ' ms', where);
  }
  function glitchStep(ctxTime, perfMs, nowMs) { // one measurement; returns ms lost (0 if none). Kept separate so it can be tested.
    if (!ctxTime || !perfMs) return 0;
    const off = ctxTime - perfMs / 1000;
    if (glitch.base == null || nowMs < glitch.quietUntil) { glitch.base = off; return 0; }
    const lost = glitch.base - off;
    if (lost > 0.015) { glitch.base = off; return lost * 1000; }
    glitch.base = off > glitch.base ? off : glitch.base * 0.9 + off * 0.1; // follows the two clocks' slow drift
    return 0;
  }
  setInterval(safe(() => {
    const ctx = E.ctx; if (ctx.state !== 'running') { glitch.base = null; glitch.ps = null; return; }
    if (performance.now() < glitch.quietUntil) { glitch.base = null; glitch.ps = null; return; }
    const ps = ctx.playoutStats;
    if (ps && typeof ps.fallbackFramesEvents === 'number') {
      glitch.src = 'reported by the sound system';
      const ev = ps.fallbackFramesEvents, dur = +ps.fallbackFramesDuration || 0;
      if (glitch.ps && ev > glitch.ps.ev) recordGlitch(ev - glitch.ps.ev, Math.max(0, dur - glitch.ps.dur));
      glitch.ps = { ev, dur };
      return;
    }
    if (typeof ctx.getOutputTimestamp !== 'function') return;
    glitch.src = 'measured from the sound clock';
    const ts = ctx.getOutputTimestamp();
    const lost = glitchStep(ts.contextTime, ts.performanceTime, performance.now());
    if (lost) recordGlitch(1, lost);
  }), 250);

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
    if (checkOutput.lost) add('warn', 'output', `The main sound output isn't working; playing through the backup (${checkOutput.backup || 'system default'}).`, 'Reconnect the main output.');
    if (audioDog.stuck >= 3) add('bad', 'audiodog', 'The sound card stopped responding.', 'Check the cable or USB audio box.');
    // files
    for (const t of [byId(L.currentId), byId(L.standbyId), byId(L.currentId) ? nextAfter(L.currentId) : null]) if (t && cantShow(t) && !items.some(i => i.id === 'codec-' + t.id)) add('bad', 'codec-' + t.id, `“${label(t)}” is ${CODEC_NAMES[t.vcodec] || t.vcodec} video, which this computer can't play.`, 'Convert it to H.264 in Preflight.');
    for (const t of health.missing.values()) add('bad', 'file-' + t.id, `The file for “${label(t)}” can't be found${t.id === L.currentId ? ' (it is playing from memory and may stop)' : ''}.`, 'Reconnect the drive, or use Preflight → Find missing files.');
    // computer
    if (glitch.last && Date.now() - glitch.last < 20000) { const e = glitch.events[glitch.events.length - 1]; add('warn', 'dropout', `The sound dropped out for ${e ? e.ms : '?'} ms ${e ? e.where : ''} (${glitch.count} time${glitch.count === 1 ? '' : 's'} since the app started).`, 'Close other programs, plug in the charger and set Power mode to Best performance. Run Preflight to check.'); }
    // the processor slowed down under load (heat or a power-saving setting)
    health.hot.perf = s.cpuPerf != null && s.cpuPerf < 75 && s.cpu > 40 ? (health.hot.perf || 0) + 1 : 0;
    if (health.hot.perf >= 15) add('warn', 'cpuperf', `The processor has slowed to ${s.cpuPerf}% of its normal speed while busy.`, 'It may be too hot or on a power-saving setting: give it air, plug it in, set Power mode to Best performance.');
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
    else if (streamer.want && streamer.slowSince && Date.now() - streamer.slowSince > 8000) add('warn', 'streamslow', `The live stream is falling behind (${streamer.state.health && streamer.state.health.speed != null ? streamer.state.health.speed.toFixed(2) + '×' : 'slow'}).`, S.settings.stAuto !== false ? 'It lowers the quality by itself if this goes on. The show is not affected.' : 'Lower the stream quality in Settings → Streaming. The show is not affected.');
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
      ['Sound dropouts', glitch.src ? `${glitch.count} since start (${Math.round(glitch.ms)} ms lost) · ${glitch.src}${glitch.events.length ? ` · last ${glitch.events[glitch.events.length - 1].where}` : ''}` : (ps ? 'measuring…' : 'not measurable on this system')],
      ['Processor speed', s.cpuPerf != null ? `${s.cpuPerf}% of normal${s.cpuPerf > 100 ? ' (turbo)' : ''}` : 'not reported by this system'],
      ['Screen pauses', `now ${Math.round(sys.lagNow)} ms · worst in 2 min ${Math.round(Math.max(0, ...sys.lag))} ms`],
      ['Page memory', heap ? mb(heap) : '–'],
      ['Disk space free', s.disk != null ? gb(s.disk) : '–'],
      ['Power', s.onBattery ? `battery${sys.battery ? ` ${Math.round(sys.battery.level * 100)}%` : ''}` : 'mains' + (s.thermal ? ` · ${s.thermal}` : '')],
      ['Running for', upTxt],
      ['Phones', !S.settings.wpOn ? 'off' : wpState.fails ? `retrying (${wpState.error || 'no answer'})` : `live, ${wpState.latency || 0} ms`],
      ['Stream', !streamer.want ? 'off' : streamer.state.live ? `${streamer.dry ? 'practice stream (not online)' : 'live on ' + streamTarget().name} · ${streamHealthText() || streamer.state.stats || ''}` : 'reconnecting']
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
  on('iRemove', 'click', async () => {
    const t = sel(); if (!t) return;
    if (t.id === S.live.currentId && (S.live.state === 'playing' || S.live.state === 'paused')) { toast("You can't remove the song that's playing."); return; }
    if (!(await ask(`Remove “${label(t)}” from the playlist? Its cues and props go too.`, 'Remove'))) return;
    if (t.id === S.live.currentId && (S.live.state === 'playing' || S.live.state === 'paused')) { toast("You can't remove the song that's playing."); return; }
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
    const r = await ask('Save the changes to this show first?', 'Save', "Don't save");
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
  // Graphics for the video window. While streaming, it's the stream's own picture, so the two match exactly.
  // Otherwise the same card is drawn here (without the LIVE badge), only while it's needed.
  const gfx = { canvas: null, g: null, timer: 0, streams: new WeakMap() };
  function gfxStream() {
    let c;
    if (streamer.want && streamer.canvas) { c = streamer.canvas; clearInterval(gfx.timer); gfx.timer = 0; }
    else {
      if (!gfx.canvas) { gfx.canvas = document.createElement('canvas'); gfx.canvas.width = 1280; gfx.canvas.height = 720; gfx.g = gfx.canvas.getContext('2d'); }
      c = gfx.canvas;
      if (!gfx.timer) { const draw = () => { try { drawCard(gfx.g, 1280, 720, { live: false }); } catch (err) { if (!gfx.logged) { gfx.logged = true; log('graphics error', String(err)); } } }; draw(); gfx.timer = setInterval(draw, 33); }
    }
    let st = gfx.streams.get(c); if (!st) { st = c.captureStream(30); gfx.streams.set(c, st); }
    gfx.source = c;
    return st;
  }
  function gfxIdle() { clearInterval(gfx.timer); gfx.timer = 0; gfx.source = null; }
  function renderGfxButton() {
    const on = !!S.settings.outGraphics, b = $('bGfx');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Graphics are live' : 'Take graphics live';
    b.title = on ? 'The video output shows the title graphics when there is no video. Click to go back to black.' : 'Show the title graphics on the video output instead of black when there is no video';
  }
  on('bGfx', 'click', async () => {
    S.settings.outGraphics = !S.settings.outGraphics; saveSettings(); renderGfxButton();
    if (S.settings.outGraphics && !videoOpen()) { toast('Graphics will show on the video output. Choose its screen to open it.', 5000); await openVideoDialog(); }
    showVideo();
    log('graphics on video output', S.settings.outGraphics);
  });
  // small copy of what's going out, in the preview box
  setInterval(safe(() => {
    const p = $('gfxPrev'), showing = !!(gfx.source && videoOpen() && S.settings.outGraphics && !(active && active.track && active.track.type === 'video' && (S.live.state === 'playing' || S.live.state === 'paused')));
    p.hidden = !showing;
    if (showing) p.getContext('2d').drawImage(gfx.source, 0, 0, p.width, p.height);
  }), 200);
  function showVideo(fresh) {
    const t = active && active.track;
    const isVid = !!(t && t.type === 'video');
    decks.forEach(d => d.el.classList.toggle('show', d === active && isVid));
    $('vprev').hidden = !(isVid || (outWin && !outWin.closed));
    if (isVid || !S.settings.outGraphics || !(outWin && !outWin.closed)) gfxIdle();
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
        } else if (S.settings.outGraphics) {
          // "Take graphics live": the same title card the stream shows, instead of black.
          const st = gfxStream();
          if (v.srcObject !== st) v.srcObject = st;
          outFeed.cap = null; v.play().catch(() => {});
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
    if (selectId === 'sOut') {
      const b = $('sOutBackup');
      b.replaceChildren(h('option', { value: 'default' }, 'System default'), ...outs.filter(o => o.id !== 'default').map(o => h('option', { value: o.id }, o.label)));
      if (S.settings.outBackup && S.settings.outBackup !== 'default' && !outs.some(o => o.id === S.settings.outBackup)) b.append(h('option', { value: S.settings.outBackup }, '(not connected) previous backup'));
      b.value = S.settings.outBackup || 'default';
      b.onchange = safe(() => { S.settings.outBackup = b.value; saveSettings(); $('sOutMsg').textContent = b.value === S.settings.outputId ? 'The backup is the same as the main output; pick a different one.' : 'Backup output saved.'; });
    }
  }
  async function chooseOutput(id) {
    try { glitchQuiet(); await E.setOutput(id); S.settings.outputId = id; checkOutput.lost = false; saveSettings(); $('sOutMsg').textContent = 'Sound is going to the chosen output.'; unbanner('output'); }
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

  /* ---------- crew chat (phones ↔ desk) ----------
     New messages arrive with the replies to the status updates the desk already sends. Alerts are silent:
     a badge, a highlight and a short on-screen note. Nothing plays through the sound system. */
  const chat = { messages: [], unread: 0, on: false, loaded: false };
  function renderChat() {
    const list = $('chatList');
    if (!chat.messages.length) list.replaceChildren(h('li', { class: 'muted' }, !S.settings.wpOn ? 'Turn on phones in Settings to chat with crew.' : chat.on || !chat.loaded ? 'Crew with the crew code can message you from their phones.' : 'Chat needs a crew code on the show. Set one in WordPress under Recital Live.'));
    else list.replaceChildren(...chat.messages.slice(-40).map(m => h('li', { class: 'msg ' + (m.role === 'desk' ? 'desk' : 'crew') + (m.fresh ? ' fresh' : '') }, h('b', null, `${m.from} · ${new Date(m.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`), m.text)));
    list.scrollTop = list.scrollHeight;
    $('chatBadge').hidden = !chat.unread; $('chatBadge').textContent = chat.unread;
    $('chatBox').classList.toggle('unread', chat.unread > 0);
  }
  desk.onWpChat(safe(c => {
    chat.on = c.on;
    const known = new Set(chat.messages.map(m => m.id));
    const fresh = c.messages.filter(m => !known.has(m.id));
    const first = !chat.loaded; chat.loaded = true;
    chat.messages.forEach(m => { m.fresh = false; });
    for (const m of fresh) { const fromCrew = m.role !== 'desk'; chat.messages.push({ ...m, fresh: fromCrew && !first }); if (fromCrew && !first) chat.unread++; }
    if (chat.messages.length > 80) chat.messages.splice(0, chat.messages.length - 80);
    const last = fresh.filter(m => m.role !== 'desk').pop();
    if (last && !first) { toast(`${last.from}: ${last.text}`, 7000); log('chat in', last.from, last.text); }
    renderChat();
  }));
  async function chatSend() {
    const el = $('chatReply'), text = el.value.trim(); if (!text) return;
    el.disabled = true;
    const r = await desk.wpChatSend({ text });
    el.disabled = false;
    if (r.ok) { el.value = ''; log('chat out', text); } else toast(r.error, 6000);
    el.focus();
  }
  on('chatSend', 'click', chatSend);
  on('chatReply', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); chatSend(); } });
  const chatRead = () => { if (chat.unread) { chat.unread = 0; renderChat(); } };
  on('chatBox', 'click', chatRead); on('chatReply', 'focus', chatRead);
  on('chatClear', 'click', async () => { if (!(await ask('Clear the chat for everyone?', 'Clear'))) return; const r = await desk.wpChatSend({ clear: true }); if (r.ok) { chat.messages = []; chat.unread = 0; renderChat(); } else toast(r.error, 6000); });
  renderChat();
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
    if (!S.settings.wpOn || reh.running) return; // the dress rehearsal test is not the show
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
    if (reh.running) return; // after a crash mid-test, recovery goes back to before the test
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
  // If the main output disappears (or the sound card stops responding), sound switches to the backup chosen in
  // Settings at once, so the music carries on. When the main one comes back it switches back by itself if
  // nothing is playing; mid-song it asks, so the sound doesn't jump between speakers during a dance.
  const outName = (outs, id) => { const o = outs.find(x => x.id === id); return o ? o.label : 'the system default output'; };
  async function switchToBackup(why) {
    if (checkOutput.lost) return;
    checkOutput.lost = true; glitchQuiet();
    const outs = await E.outputs().catch(() => []);
    const b = S.settings.outBackup && S.settings.outBackup !== 'default' && S.settings.outBackup !== S.settings.outputId && outs.some(o => o.id === S.settings.outBackup) ? S.settings.outBackup : '';
    checkOutput.backup = b ? outName(outs, b) : 'the system default output';
    log('main output lost; switching to backup', why, b ? 'chosen backup' : 'system default');
    try { await E.setOutput(b); } catch (err) { log('backup output failed', err.message); try { await E.setOutput(''); } catch (_) {} }
    banner('output', `The main sound output ${why}. Sound switched to the backup: ${checkOutput.backup}. Reconnect the main output to switch back.`);
    runHealth();
  }
  async function switchBack() {
    try { await E.setOutput(S.settings.outputId); glitchQuiet(); checkOutput.lost = false; unbanner('output'); log('back on the main output'); toast('Sound is back on the main output.'); }
    catch (err) { log('switch back failed', err.message); }
    runHealth();
  }
  async function checkOutput() {
    if (!S.settings.outputId || S.settings.outputId === 'default') return;
    const outs = await E.outputs();
    const present = outs.some(o => o.id === S.settings.outputId);
    if (!present && !checkOutput.lost) await switchToBackup('was disconnected');
    else if (present && checkOutput.lost) {
      const playing = S.live.state === 'playing' || S.live.state === 'paused';
      if (!playing) await switchBack();
      else if (!checkOutput.offered) { checkOutput.offered = true; log('main output back (still on backup while music plays)'); banner('output', `The main sound output is connected again. The music is still playing through the backup (${checkOutput.backup}).`, 'info', [{ label: 'Switch back now', fn: () => { checkOutput.offered = false; switchBack(); } }]); }
    }
    if (!checkOutput.lost) checkOutput.offered = false;
  }
  // Switch back automatically at the next pause between songs.
  setInterval(safe(() => { if (checkOutput.lost && checkOutput.offered && !['playing', 'paused'].includes(S.live.state)) { checkOutput.offered = false; checkOutput().catch(() => {}); } }), 2000);
  // Where the browser engine reports a sound-card error, treat it like a disconnect.
  try { E.ctx.addEventListener('error', safe(() => { log('sound card error event'); if (S.settings.outputId && S.settings.outputId !== 'default') switchToBackup('stopped working'); })); } catch (_) {}
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
    const add = (level, title, detail = '', action = null) => items.push({ level, title, detail, action });
    const group = g => items.push({ group: g });
    // Sound
    group('Sound');
    const outs = await E.outputs().catch(() => []);
    const chosen = S.settings.outputId && S.settings.outputId !== 'default' ? outs.find(o => o.id === S.settings.outputId) : null;
    if (S.settings.outputId && S.settings.outputId !== 'default' && !chosen) add('bad', "The chosen sound output isn't connected", 'Connect it, or pick another output in Settings.');
    else add('ok', `Playing through ${chosen ? chosen.label : 'the system default output'}`, `${outs.length} output${outs.length === 1 ? '' : 's'} found`);
    if (S.settings.outputId && S.settings.outputId !== 'default') {
      const bk = S.settings.outBackup && S.settings.outBackup !== 'default' ? outs.find(o => o.id === S.settings.outBackup) : null;
      if (S.settings.outBackup && S.settings.outBackup !== 'default' && !bk) add('warn', "The backup sound output isn't connected", 'If the main output fails, sound will go to the system default instead.', { label: 'Open Settings', fn: () => openSettings('output') });
      else add('ok', `Backup output: ${bk ? bk.label : 'system default'}`, 'If the main output disconnects or stops, the music switches to it and keeps playing.');
    }
    if (checkOutput.lost) add('warn', `Playing through the backup output (${checkOutput.backup})`, 'The main output is disconnected or stopped working.');
    add(glitch.count ? 'warn' : 'ok', glitch.count ? `The sound has dropped out ${glitch.count} time${glitch.count === 1 ? '' : 's'} since the app started` : 'No sound dropouts so far', glitch.count ? glitch.events.slice(-3).map(e => `${e.ms} ms ${e.where}`).join('; ') : (glitch.src || ''));
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
    await findCodec(all.filter(t => t.enabled && isVideo(t.name || t.path) && !t.vcodec));
    if (videoCaps.avc === null) await testVideoCaps();
    const probes = await Promise.all(all.map((t, i) => t.enabled && stats[i].exists ? probe(t.path).then(p => p, e => ({ error: e.message })) : null));
    all.forEach((t, i) => {
      if (!t.enabled) return;
      const name = `#${numberOf(t)} ${label(t)}`;
      const st = stats[i], pr = probes[i];
      if (!st.exists) { probs++; t.missing = true; add('bad', `${name}: file is missing`, `${t.path}. Use “Find missing files…”.`); return; }
      if (cantShow(t)) { probs++; add('bad', `${name}: ${CODEC_NAMES[t.vcodec] || t.vcodec} video, which this computer can't play`, 'Click “Convert HEVC videos to H.264” above (it makes a copy and keeps the original), or use a computer that plays it.'); return; }
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
    if (en.some(t => t.vcodec && t.vcodec !== 'none')) add(videoCaps.avc === false ? 'bad' : 'ok', videoCaps.avc === false ? "This computer couldn't play the H.264 test clip" : `Video this computer can play: H.264${videoCaps.hevc ? ' and HEVC' : ' (not HEVC)'}`, videoCaps.avc === false ? 'Try Software drawing in Settings → Reliability, or update the graphics driver.' : 'From the video display test (Test & calibrate).');
    $('pfConvert').hidden = !all.some(t => t.enabled && cantShow(t));
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
    // "Show mode": settings that can spoil a show
    const sc = await desk.showCheck().catch(() => null);
    const pwr = { label: 'Open power settings', fn: () => desk.openSettingsPage('power') };
    if (sc && sc.platform === 'win32') {
      const saving = sc.plan === 'Power saver' || sc.mode === 'Best power efficiency';
      const fast = sc.mode === 'Best performance' || sc.plan === 'High performance' || sc.plan === 'Ultimate performance';
      if (saving) add('bad', `Windows is set to save power (${sc.mode === 'Best power efficiency' ? 'Power mode: Best power efficiency' : 'Power plan: Power saver'})`, 'It slows the processor and can cause dropouts. Set Power mode to Best performance.', pwr);
      else if (fast) add('ok', `Power mode: ${sc.mode || sc.plan}`);
      else add('warn', `Power mode: ${sc.mode || sc.plan || 'not known'}`, 'For the show, set Power mode to Best performance (Settings → System → Power & battery).', pwr);
      if (sc.updateRestart) add('warn', 'Windows is waiting to restart for an update', 'Restart the computer before the show (never during it), then pause updates for a week in Windows Update.', { label: 'Open Windows Update', fn: () => desk.openSettingsPage('update') });
      else add('ok', 'No Windows Update restart waiting', 'To be safe, pause updates for a week before the show (Settings → Windows Update).');
      if (sc.notifications === 'on') add('warn', 'Windows notifications are on', 'Turn on Do not disturb so pop-ups can\'t appear on the screen or projector during the show.', { label: 'Open notifications', fn: () => desk.openSettingsPage('notifications') });
      else if (sc.notifications === 'off') add('ok', 'Windows notifications are off');
    } else if (sc && sc.platform === 'darwin') {
      if (sc.lowPower) add('bad', 'Low Power Mode is on', 'It slows the computer. Turn it off in System Settings → Battery.', pwr);
      if (sc.speedLimit != null && sc.speedLimit < 100) add('warn', `The processor is limited to ${sc.speedLimit}% (too hot)`, 'Give the computer air and let it cool down.');
      add('ok', 'Turn on Do Not Disturb (Focus) before the show', 'So notifications can\'t pop up on the screen or projector.');
    }
    if (sys.last && sys.last.cpuPerf != null) {
      const p = sys.last.cpuPerf;
      add(p < 60 && avgCpu > 30 ? 'warn' : 'ok', `Processor running at ${p}% of its normal speed`, p < 60 && avgCpu > 30 ? 'It is slowed down: plug in, give it air, set Power mode to Best performance.' : (p > 100 ? 'Turbo is working.' : 'It speeds up when the show needs it.'));
    }
    // How fast the drive with the show's files is (writes a short test file next to them). Not while music plays.
    const playingNow = S.live.state === 'playing' || S.live.state === 'paused' || streamer.want;
    const enTracks = S.show.tracks.filter(t => t.enabled && t.path);
    if (enTracks.length && !playingNow) {
      const dirs = [...new Set(enTracks.map(t => t.path.replace(/[\\/][^\\/]*$/, '')))];
      const need = Math.max(0, ...enTracks.map(t => t.sig && t.sig.size && t.duration ? t.sig.size / t.duration / 1048576 : 0)); // MB per second the biggest file needs
      const sp = await desk.driveSpeed(dirs).catch(() => []);
      for (const r of sp) {
        if (r.error) continue;
        const slow = r.mbps < Math.max(15, need * 6);
        add(slow ? 'warn' : 'ok', slow ? `The drive with the show files is slow (${r.mbps} MB/s)` : `Show files' drive: ${r.mbps} MB/s`, slow ? `${r.dir}. Copy the show to the computer's own drive (File → Copy all files into the show folder, with the show saved on the internal drive).` : (dirs.length > 1 ? r.dir : 'Fast enough for every file in the show.'));
      }
    } else if (enTracks.length) add('ok', 'Drive speed test skipped while music or the stream is running');
    if (S.settings.lastRehearsal) { const lr = S.settings.lastRehearsal; add(lr.level === 'bad' ? 'warn' : 'ok', `Dress rehearsal test: ${lr.verdict}`, `${new Date(lr.at).toLocaleString()} · ${lr.summary || ''}`, { label: 'Run again', fn: openRehearsal }); }
    else add('warn', 'The dress rehearsal test hasn\'t been run on this computer', 'It plays through the show as a stress test and says whether this computer can handle it.', { label: 'Run it', fn: openRehearsal });
    const maxLag = Math.max(0, ...sys.lag.slice(-30));
    add(maxLag > 200 ? 'warn' : 'ok', maxLag > 200 ? `The app paused for ${Math.round(maxLag)} ms recently` : 'App is responsive');
    // Phones + saved
    group('Phones, streaming and saving');
    if (streamTarget().ready) {
      const chk = await desk.streamCheck();
      add(chk.ok ? 'ok' : 'bad', chk.ok ? (streamer.want ? `Live on ${streamTarget().name}` : `Live streaming to ${streamTarget().name} is set up (not started)`) : chk.error, chk.ok ? (streamer.want ? (streamHealthText() || streamer.state.stats || '') : 'Start it a few minutes before the show and check it on a phone.') : '');
      await loadEncoders();
      const encId = chosenEncoder();
      add('ok', `Stream video encoding: ${(enc.names || {})[encId] || encId}`, encId === 'libx264' ? (S.settings.stEnc === 'cpu' ? 'Set to the processor in Settings → Streaming.' : 'No graphics-chip encoder was found, so the processor does the work.') : 'The graphics chip does the heavy work, so the processor stays free for the show.');
      const sr = S.settings.speed, needMbps = { 1080: 7, 720: 4, 480: 2.1 }[S.settings.stQ] || 4;
      const speedAct = { label: 'Open Streaming settings', fn: () => openSettings('stream') };
      if (!sr || !sr.up) add('warn', "The internet upload speed hasn't been tested", 'Test it at the venue: Settings → Streaming → Test internet speed.', speedAct);
      else if (sr.up < needMbps) add('warn', `${S.settings.stQ}p needs about ${needMbps} Mbps upload; the last test measured ${sr.up} Mbps`, `${recommendQ(sr.up) ? `Use ${recommendQ(sr.up)}p.` : 'This connection is too slow to stream reliably.'} Tested ${new Date(sr.at).toLocaleString()}.`, speedAct);
      else add('ok', `Upload speed ${sr.up} Mbps: enough for ${S.settings.stQ}p`, `Tested ${new Date(sr.at).toLocaleString()}${Date.now() - sr.at > 6 * 3600000 ? '. Test again at the venue if this was somewhere else.' : ''}`);
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
    list.replaceChildren(...items.map(i => i.group ? h('li', { class: 'pf group' }, i.group) : h('li', { class: 'pf ' + i.level }, h('span', { class: 'ic' }, i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✕'), h('div', null, h('div', null, i.title), i.detail ? h('div', { class: 'd' }, i.detail) : null), i.action ? h('button', { class: 'btn small act', type: 'button', onclick: safe(i.action.fn) }, i.action.label) : h('span'))));
    log('preflight', { bad, warn });
    return { bad, warn, items };
  }

  /* ---------- dress rehearsal test ----------
     Runs the show as a stress test: the first and last few seconds of every song and every real transition,
     with the video output and (optionally) a practice stream that is encoded at full quality but sent nowhere.
     Meanwhile it records the processor, memory, graphics, screen pauses, sound dropouts, dropped video frames
     and whether the stream kept up, then says whether this computer is ready for this show. Phones aren't told,
     and the show goes back exactly to where it was afterwards. */
  const reh = { running: false, abort: false, R: null, report: null };
  function openRehearsal() {
    if ($('dlgPreflight').open) $('dlgPreflight').close();
    if ($('dlgSys').open) $('dlgSys').close();
    $('rhGo').textContent = reh.running ? 'Stop test' : 'Start test';
    $('rhStream').disabled = !streamTarget().ready && false;
    $('dlgReh').showModal();
  }
  on('pfReh', 'click', openRehearsal);
  on('rhGo', 'click', () => { if (reh.running) { reh.abort = true; $('rhNow').textContent = 'Stopping…'; } else rehearse({ seg: +$('rhSeg').value, vol: +$('rhVol').value, stream: $('rhStream').checked }); });
  on('dlgReh', 'close', () => { if (reh.running) { reh.abort = true; toast('Dress rehearsal test stopped.'); } });
  on('rhCopy', 'click', () => { if (reh.report) { navigator.clipboard.writeText(reh.report).then(() => toast('Report copied.')).catch(() => toast("Couldn't copy.")); } });
  const wait = (ms, stop) => new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { if (Date.now() - t0 >= ms || (stop && stop())) { clearInterval(iv); res(); } }, 100); });
  function rehSample() { // once a second, from the numbers already collected
    const R = reh.R, s = sys.last; if (!R || !s) return;
    const x = { cpu: s.cpu, app: s.appCpu, mem: s.appMem, free: s.freeMem, gpu: s.gpu, lag: sys.lagNow, perf: s.cpuPerf };
    const hs = streamer.state && streamer.state.health;
    if (streamer.want && streamer.state.live && hs && hs.speed != null && Date.now() - streamer.openedAt > 8000) { x.speed = hs.speed; x.fps = hs.fps; R.streamDrop = hs.drop || 0; }
    for (const d of decks) { // dropped video frames on the players
      const q = d.el.getVideoPlaybackQuality ? d.el.getVideoPlaybackQuality() : null; if (!q) continue;
      const k = d.el.currentSrc, prev = R.vq.get(d) || { src: k, dropped: 0, total: 0 };
      if (prev.src !== k || q.totalVideoFrames < prev.total) { prev.src = k; prev.dropped = 0; prev.total = 0; }
      R.vDropped += Math.max(0, q.droppedVideoFrames - prev.dropped); R.vTotal += Math.max(0, q.totalVideoFrames - prev.total);
      R.vq.set(d, { src: k, dropped: q.droppedVideoFrames, total: q.totalVideoFrames });
    }
    R.samples.push(x);
  }
  async function rehearse({ seg = 8, vol = -20, stream = true } = {}) {
    const L = S.live;
    if (reh.running) return;
    if (L.state === 'playing' || L.state === 'paused' || L.busy) { toast('Stop the music first. The test plays the show itself.'); return; }
    if (streamer.want && !streamer.dry) { toast('Stop the live stream first. The test makes its own practice stream, which doesn\'t go online.', 6000); return; }
    if (fillerState.playing) fillerFadeOut(1.5);
    const list = tracks().filter(t => t.enabled && t.path && !t.missing);
    if (!list.length) { toast('Add songs to the show first.'); return; }
    const saved = { played: new Set(L.played), lastId: L.lastId, standbyId: L.standbyId, nextId: L.nextId, state: L.state };
    const R = reh.R = { t0: Date.now(), samples: [], vq: new Map(), vDropped: 0, vTotal: 0, started: 0, transitions: 0, fails: [], glitch0: glitch.count, glitchMs0: glitch.ms,
      out0: outFeed.reconnects.length, enc: '', q: '', stream, streamDrop: 0, seg, songs: list.length, videoOpen: videoOpen() };
    reh.running = true; reh.abort = false; reh.report = null;
    $('rhGo').textContent = 'Stop test'; $('rhOpts').hidden = true; $('rhProg').hidden = false; $('rhVerdict').hidden = true; $('rhCopy').hidden = true;
    $('rhList').replaceChildren(); $('rhBar').style.width = '0%';
    log('dress rehearsal test start', { songs: list.length, seg, stream });
    E.setMasterDb((+S.settings.masterDb || 0) + vol);
    try {
      if (stream) { await streamStart({ dry: true }); R.enc = (enc.names || {})[chosenEncoder()] || chosenEncoder(); R.q = streamQ(); }
      for (let i = 0; i < list.length && !reh.abort; i++) {
        const t = list[i], next = list[i + 1];
        const step = (what, frac) => { $('rhNow').textContent = `Song ${i + 1} of ${list.length}: “${label(t)}” (${what})`; $('rhBar').style.width = `${Math.round((i + frac) / list.length * 100)}%`; };
        step('start', 0);
        if (L.currentId !== t.id) { // not already playing after an automatic transition from the last song
          if (L.state === 'playing' || L.state === 'paused') stopNow(false);
          L.standbyId = t.id; L.cueFrom = null;
          await startTrack(t);
          if (L.currentId !== t.id) { R.fails.push(`“${label(t)}” didn't start`); unbanner('play-' + t.id); continue; }
        }
        R.started++;
        await wait(seg * 1000, () => reh.abort || L.currentId !== t.id);
        if (reh.abort || L.currentId !== t.id || !active) continue;
        step('end', 0.5);
        const xf = t.transition === 'crossfade' && next ? clamp(+t.xfade || 5, 0.5, Math.max(0.5, effLen(next) / 2)) : 0;
        const to = effEnd(t) - seg - xf;
        if (to > active.time + 1) { active.el.currentTime = to; L.lastPos = to; stall.t = to; stall.at = performance.now(); }
        await wait((seg + xf + 10) * 1000, () => reh.abort || L.currentId !== t.id);
        if (reh.abort) break;
        if (L.currentId === t.id) { R.fails.push(`“${label(t)}” didn't finish on time`); stopNow(false); }
        else if (next && L.currentId === next.id) R.transitions++; // a straight-on or crossfade transition ran by itself
      }
    } catch (err) { log('dress rehearsal error', String(err)); R.fails.push(`The test stopped: ${err.message || err}`); }
    finally {
      const aborted = reh.abort;
      if (L.state === 'playing' || L.state === 'paused') stopNow(false);
      await wait(400);
      if (stream && streamer.dry) await streamStop();
      E.setMasterDb(+S.settings.masterDb || 0);
      L.played = saved.played; L.lastId = saved.lastId; L.nextId = saved.nextId; L.cueFrom = null; L.lastCue = null; L.failed = null;
      L.standbyId = saved.standbyId; reh.running = false;
      setState(saved.state === 'idle' ? 'idle' : saved.standbyId ? 'standby' : saved.state);
      list.forEach(t => unbanner('play-' + t.id));
      renderLists(); pushStatus(true); snapshot();
      $('rhGo').textContent = 'Start test'; $('rhOpts').hidden = false; $('rhProg').hidden = true;
      rehReport(R, aborted);
    }
  }
  function rehReport(R, aborted) {
    const rows = [], add = (level, title, detail = '') => rows.push({ level, title, detail });
    const vals = k => R.samples.map(x => x[k]).filter(v => v != null && isFinite(v));
    const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))]; };
    const mins = Math.max(1, Math.round((Date.now() - R.t0) / 60000));
    if (aborted) add('warn', 'The test was stopped before the end', `${R.started} of ${R.songs} songs were played.`);
    add(R.fails.length ? 'bad' : 'ok', R.fails.length ? `${R.fails.length} song${R.fails.length > 1 ? 's' : ''} had a problem` : `All ${R.started} songs started and finished`, R.fails.length ? R.fails.join('; ') : `${R.transitions} automatic transition${R.transitions === 1 ? '' : 's'} tested; ${R.seg} s from the start and end of each song.`);
    const cpu = vals('cpu'), c95 = pct(cpu, 0.95), cMax = cpu.length ? Math.max(...cpu) : null;
    if (c95 != null) add(c95 >= 95 ? 'bad' : c95 >= 80 ? 'warn' : 'ok', `Processor: ${Math.round(c95)}% most of the time, ${Math.round(cMax)}% at the busiest`, c95 >= 80 ? 'Close other programs, plug in, set Power mode to Best performance, or lower the stream quality.' : 'Plenty of room to spare.');
    const perf = R.samples.filter(x => x.perf != null && x.cpu > 30).map(x => x.perf);
    if (perf.length) { const pMin = Math.min(...perf); add(pMin < 70 ? 'bad' : pMin < 90 ? 'warn' : 'ok', `Processor speed under load: never below ${pMin}% of normal`, pMin < 90 ? 'It slowed down: heat or a power-saving setting. Give it air and set Power mode to Best performance.' : 'No slowing down.'); }
    const free = vals('free'), memApp = vals('mem');
    if (free.length) { const fMin = Math.min(...free); add(fMin < 400 * 1048576 ? 'bad' : fMin < 1073741824 ? 'warn' : 'ok', `Memory: at least ${gb(fMin)} free; this app used up to ${mb(Math.max(...memApp))}`, fMin < 1073741824 ? 'Close other programs, especially web browsers.' : ''); }
    const gpu = vals('gpu');
    if (gpu.length) { const g95 = pct(gpu, 0.95); add(g95 >= 95 ? 'bad' : g95 >= 85 ? 'warn' : 'ok', `Graphics: ${Math.round(g95)}% most of the time`, g95 >= 85 ? 'Lower the stream quality or close other programs that show video.' : ''); }
    else add('ok', 'Graphics load is not reported on this computer');
    const lag = vals('lag'), lMax = lag.length ? Math.max(...lag) : 0;
    add(lMax >= 400 ? 'warn' : 'ok', `Screen pauses: at most ${Math.round(lMax)} ms`, lMax >= 400 ? 'The screen paused noticeably (the music itself plays separately and isn\'t affected by short pauses). Close other programs.' : 'The controls stayed responsive.');
    const dn = glitch.count - R.glitch0, dms = Math.round(glitch.ms - R.glitchMs0);
    add(dn > 2 ? 'bad' : dn ? 'warn' : 'ok', dn ? `${dn} sound dropout${dn > 1 ? 's' : ''} (${dms} ms lost)` : 'No sound dropouts', dn ? glitch.events.slice(-Math.min(dn, 3)).map(e => `${e.ms} ms ${e.where}`).join('; ') : (glitch.src ? `Sound ${glitch.src}.` : 'This system can\'t measure dropouts.'));
    if (R.vTotal > 0) { const dp = R.vDropped / R.vTotal * 100; add(dp >= 3 ? 'bad' : dp >= 0.5 ? 'warn' : 'ok', `Video: ${R.vDropped} of ${R.vTotal} frames dropped (${dp.toFixed(1)}%)`, dp >= 0.5 ? 'Convert large or HEVC videos to H.264, close other programs, or lower the stream quality.' : 'Video played smoothly.'); }
    const outN = outFeed.reconnects.length - R.out0;
    if (R.videoOpen || videoOpen()) add(outN ? 'warn' : 'ok', outN ? `The video output lost the picture ${outN} time${outN > 1 ? 's' : ''} (reconnected by itself)` : 'Video output kept its picture');
    else if (S.show.tracks.some(t => t.enabled && t.type === 'video')) add('warn', 'The video output was closed during the test', 'Open Video output and run the test again to check the projector too.');
    if (R.stream) {
      const sp = vals('speed');
      if (!sp.length) add('bad', 'The practice stream didn\'t get going', 'See Settings → Streaming.');
      else { const sMin = pct(sp, 0.05); add(sMin < 0.9 ? 'bad' : sMin < 0.97 ? 'warn' : 'ok', `Stream (${R.q}p, ${R.enc}): kept up at ${sMin.toFixed(2)}× or better${R.streamDrop ? `, ${R.streamDrop} frames dropped` : ''}`, sMin < 0.97 ? 'It struggled: choose a lower stream quality, or set Video encoding to Automatic so the graphics chip helps.' : 'The computer can encode the stream comfortably. (Upload speed is tested separately: Settings → Streaming.)'); }
    }
    const bad = rows.filter(r => r.level === 'bad').length, warn = rows.filter(r => r.level === 'warn').length;
    const level = bad ? 'bad' : warn ? 'warn' : 'ok';
    const verdict = aborted ? 'Stopped before the end' : bad ? 'Not ready: fix the problems below' : warn ? 'Ready, with things to look at' : 'Ready for the show';
    const v = $('rhVerdict'); v.hidden = false; v.className = 'rh-verdict ' + (aborted ? 'warn' : level); v.textContent = `${verdict} (${mins} min test)`;
    $('rhList').replaceChildren(...rows.map(i => h('li', { class: 'pf ' + i.level }, h('span', { class: 'ic' }, i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✕'), h('div', null, h('div', null, i.title), i.detail ? h('div', { class: 'd' }, i.detail) : null), h('span'))));
    reh.report = [`Dress rehearsal test, ${new Date().toLocaleString()}: ${verdict}`, ...rows.map(r => `${r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✕'} ${r.title}${r.detail ? ' (' + r.detail + ')' : ''}`)].join('\n');
    $('rhCopy').hidden = false;
    if (!aborted) { S.settings.lastRehearsal = { at: Date.now(), verdict, level, summary: rows.filter(r => r.level !== 'ok').map(r => r.title).slice(0, 3).join('; ') || 'everything passed' }; saveSettings(); }
    log('dress rehearsal test result', reh.report);
    return { verdict, level, rows };
  }

  /* ---------- test & calibrate ---------- */
  let calTimer = 0, autoLevel = null;
  function openTest() {
    renderVideoCaps();
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
  on('dlgTest', 'click', async e => {
    const b = e.target.closest('[data-test]'); if (!b) return;
    if (S.live.state === 'playing' && !(await ask('The show is playing. Play a test sound over it?', 'Play test sound'))) return;
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

  /* ---------- video display test: which kinds of video can this computer show? ----------
     Really plays two tiny built-in clips (H.264 and HEVC) and counts decoded frames. Run at start-up and from
     Test & calibrate. Preflight uses the result: a video the computer can't decode is marked unplayable. */
  const videoCaps = { avc: null, hevc: null, at: 0 };
  const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC (H.265)', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', prores: 'ProRes', mpeg2video: 'MPEG-2' };
  // A video whose picture this computer can't show. Only when the test has actually said so.
  function cantShow(t) { return !!t && ((t.vcodec === 'hevc' && videoCaps.hevc === false) || (t.vcodec === 'h264' && videoCaps.avc === false)); }
  function testClip(url, el) {
    return new Promise(resolve => {
      const v = el || document.createElement('video');
      v.muted = true; v.playsInline = true; v.loop = !!el;
      let frames = 0, done = false;
      const fin = (ok, why) => { if (done) return; done = true; clearTimeout(timer); v.onerror = null; if (!el) { v.removeAttribute('src'); v.load(); } resolve({ ok, why }); };
      const timer = setTimeout(() => fin(false, v.videoWidth ? 'opened, but no picture came out' : 'could not be opened'), 5000);
      v.onerror = () => fin(false, 'not supported by this computer');
      const cb = () => { frames++; if (frames >= 3) fin(true); else if (!done) v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
      v.src = `${url}?t=${Date.now()}`;
      v.play().catch(() => {});
    });
  }
  let capsRunning = null;
  function testVideoCaps(show) {
    if (capsRunning) return capsRunning;
    return (capsRunning = (async () => {
      try {
        const a = await testClip('test-media/avc.mp4', show ? $('vtAvc') : null);
        const hv = await testClip('test-media/hevc.mp4', show ? $('vtHevc') : null);
        const changed = videoCaps.hevc !== hv.ok || videoCaps.avc !== a.ok;
        Object.assign(videoCaps, { avc: a.ok, hevc: hv.ok, at: Date.now(), avcWhy: a.why, hevcWhy: hv.why });
        if (changed) { log('video display test', { h264: a.ok, hevc: hv.ok }); renderListsSoon(); }
        renderVideoCaps();
        return videoCaps;
      } finally { capsRunning = null; }
    })());
  }
  function renderVideoCaps() {
    const line = (id, vid, ok, why, name) => {
      const el = $(id); el.className = ok ? 'yes' : ok === false ? 'no' : 'muted';
      el.textContent = ok ? '✓ Plays on this computer' : ok === false ? `✕ Can't play here (${why || 'no picture'})` : 'Not tested yet';
      $(vid).className = ok ? 'yes' : ok === false ? 'no' : '';
    };
    line('vtAvcMsg', 'vtAvc', videoCaps.avc, videoCaps.avcWhy); line('vtHevcMsg', 'vtHevc', videoCaps.hevc, videoCaps.hevcWhy);
    $('vtMsg').textContent = videoCaps.avc === null ? '' : videoCaps.avc && videoCaps.hevc ? 'This computer plays both. All video files are allowed.'
      : videoCaps.avc ? 'This computer plays H.264 only. Preflight will mark HEVC videos as unplayable and offer to convert them.'
      : "This computer couldn't play the H.264 clip. Try Software drawing in Settings → Reliability, or update the graphics driver.";
  }
  on('vtRun', 'click', async () => { $('vtMsg').textContent = 'Testing…'; await testVideoCaps(true); });
  async function findCodec(list) {
    const need = list.filter(t => t.path && !t.vcodec); if (!need.length) return;
    const r = await desk.videoCodec(need.map(t => t.path)).catch(() => ({}));
    let any = false;
    for (const t of need) { const c = r[t.path]; if (c) { t.vcodec = c; any = true; if (c !== 'none' && t.type !== 'video') t.type = 'video'; } }
    if (any) { changed({ quiet: true }); renderListsSoon(); if (need.some(cantShow)) toast("One of those videos is HEVC, which this computer can't play. Run Preflight to convert it.", 7000); }
  }
  // Convert every HEVC video the computer can't play to H.264 (a copy next to the original), one at a time.
  desk.onConvertProgress(safe(p => { $('pfSummary').textContent = `Converting “${p.src.split(/[\\/]/).pop()}”… ${p.duration ? Math.min(99, Math.round(p.done / p.duration * 100)) + '%' : fmt(p.done)}`; }));
  on('pfConvert', 'click', async () => {
    if (S.live.state === 'playing' || S.live.state === 'paused') { toast('Stop the music first. Converting uses a lot of the computer.'); return; }
    const list = S.show.tracks.filter(t => t.enabled && cantShow(t)); if (!list.length) return;
    $('pfConvert').disabled = true;
    let done = 0;
    for (const t of list) {
      $('pfSummary').textContent = `Converting “${label(t)}”…`;
      const r = await desk.convertVideo(t.path, t.duration || 0);
      if (!r.ok) { banner('convert', `Couldn't convert “${label(t)}”: ${r.error}`); continue; }
      t.path = r.info.path; t.name = r.info.name; t.sig = { size: r.info.size, mtime: r.info.mtime }; t.vcodec = 'h264'; t.an = null; t.anError = ''; t.duration = 0; t.missing = false;
      queueAnalysis(t); done++;
    }
    $('pfConvert').disabled = false;
    changed(); renderLists(); renderInspector();
    toast(done ? `Converted ${done} video${done > 1 ? 's' : ''} to H.264. The originals are kept.` : 'Nothing was converted.', 6000);
    await new Promise(r => setTimeout(r, 600));
    runPreflight();
  });

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
  on('sRec', 'click', async () => {
    if (!(await ask('Set the sound settings to the recommended values?\n\nMaster level, balance and left/right trims are left as they are, because they are set for your room.', 'Use recommended'))) return;
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
  const streamer = { want: false, rec: null, canvas: null, g: null, drawTimer: 0, retryTimer: 0, retries: 0, gen: 0, state: {}, startedAt: 0, dry: false, qOverride: null, encOverride: null, slowSince: 0, openedAt: 0 };
  const Q_SIZE = { 1080: [1920, 1080], 720: [1280, 720], 480: [854, 480] };
  const streamQ = () => streamer.qOverride || (Q_SIZE[S.settings.stQ] ? S.settings.stQ : '720');
  const recommendQ = up => up >= 7 ? '1080' : up >= 4 ? '720' : up >= 2.1 ? '480' : null;
  // Which video encoder the stream uses: the graphics chip's own (checked with a test encode when the app starts),
  // unless it failed this session or Settings says processor only.
  const enc = { list: null, names: null, failed: new Set(), loading: null };
  function loadEncoders(force) {
    if (enc.list && !force) return Promise.resolve(enc);
    if (enc.loading && !force) return enc.loading;
    return (enc.loading = desk.streamEncoders(!!force).then(r => { enc.list = r.list; enc.names = r.names; return enc; }).catch(err => { log('encoder check failed', String(err)); enc.list = [{ id: 'libx264', name: 'Processor (x264)' }]; return enc; }).finally(() => { enc.loading = null; renderEncoders(); }));
  }
  function chosenEncoder() {
    if (S.settings.stEnc === 'cpu') return 'libx264';
    if (streamer.encOverride) return streamer.encOverride;
    const ok = (enc.list || []).map(e => e.id).filter(id => !enc.failed.has(id));
    return ok[0] || 'libx264';
  }
  function renderEncoders() {
    const el = $('sStEncMsg'); if (!el) return;
    if (!enc.list) { el.textContent = 'Checking which video encoders this computer has…'; return; }
    const hw = enc.list.filter(e => e.id !== 'libx264' && !enc.failed.has(e.id));
    el.textContent = hw.length ? `This computer can encode video on: ${hw.map(e => e.name).join(', ')}. ${S.settings.stEnc === 'cpu' ? 'Set to the processor only.' : `The stream uses ${hw[0].name}, which leaves the processor free for the show.`}`
      : 'No graphics-chip video encoder was found on this computer, so the processor does the work (at low priority).';
  }
  function streamHealthText() {
    const st = streamer.state || {}, hs = st.health;
    if (!streamer.want || !st.live || !hs || hs.speed == null) return '';
    const behind = streamer.slowSince && Date.now() - streamer.slowSince > 3000;
    return `${behind ? 'Falling behind' : 'Keeping up'} ${hs.speed.toFixed(2)}× · ${Math.round(hs.fps || 0)} fps · ${hs.kbps != null ? Math.round(hs.kbps).toLocaleString() + ' kb/s' : '–'} · ${hs.drop || 0} frames dropped · ${st.quality || streamQ()}p · ${st.encoderName || ''}`;
  }
  // The stream can't keep up: step down a quality level and carry on (the show itself is never touched).
  async function lowerQuality(why) {
    const q = streamQ(), next = { 1080: '720', 720: '480' }[q];
    if (!next || !streamer.want) return false;
    streamer.qOverride = next; streamer.slowSince = 0;
    log('stream quality lowered', q, '→', next, why);
    banner('streamq', `The stream couldn't keep up (${why}), so it switched from ${q}p to ${next}p. The show is not affected.`, 'info', [{ label: 'Streaming settings', fn: () => openSettings('stream') }]);
    streamTeardown(); await desk.streamStop(); await streamOpen();
    return true;
  }
  async function runSpeedTest() {
    const btn = $('sSpeedGo'), msg = $('sSpeedMsg'), use = $('sSpeedUse');
    btn.disabled = true; use.hidden = true; msg.textContent = 'Testing upload speed (about 8 seconds)…';
    try {
      const t = streamTarget();
      const r = await desk.speedTest(t.ready || t.url ? t.url : '');
      const parts = [];
      if (r.upMbps != null) parts.push(`Upload ${r.upMbps} Mbps`);
      if (r.reach) parts.push(r.reach.ok ? `reached ${t.name}'s server in ${r.reach.ms} ms` : r.reach.error);
      if (r.error) parts.push(r.error);
      const rec = r.upMbps != null ? recommendQ(r.upMbps) : null;
      if (r.upMbps != null) { S.settings.speed = { at: Date.now(), up: r.upMbps, reach: r.reach && r.reach.ok ? r.reach.ms : null }; saveSettings(); }
      msg.textContent = parts.join(' · ') + (r.upMbps == null ? '' : rec ? `. Recommended: ${rec}p.` : '. Too slow to stream reliably: use a wired connection or a different network.');
      if (rec && rec !== S.settings.stQ) { use.hidden = false; use.textContent = `Use ${rec}p`; use.onclick = safe(() => { S.settings.stQ = rec; $('sStQ').value = rec; saveSettings(); use.hidden = true; toast(`Stream quality set to ${rec}p.`); }); }
      return r;
    } finally { btn.disabled = false; }
  }
  on('sSpeedGo', 'click', runSpeedTest);
  // Back online: reconnect the stream now instead of waiting out the retry timer.
  window.addEventListener('online', safe(() => { if (streamer.want && streamer.retryTimer && !(streamer.state.live && streamer.state.gen === streamer.gen)) { clearTimeout(streamer.retryTimer); streamer.retryTimer = 0; log('internet back; reconnecting stream now'); desk.streamStop().then(streamOpen); } }));
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
    $('sStQ').onchange = safe(() => { S.settings.stQ = $('sStQ').value; saveSettings(); if (streamer.want) toast('The new quality is used the next time the stream starts.'); });
    $('sStEnc').value = S.settings.stEnc === 'cpu' ? 'cpu' : 'auto'; $('sStEnc').onchange = safe(() => { S.settings.stEnc = $('sStEnc').value; saveSettings(); renderEncoders(); if (streamer.want) toast('The new setting is used the next time the stream starts.'); });
    $('sStAuto').checked = S.settings.stAuto !== false; $('sStAuto').onchange = safe(() => { S.settings.stAuto = $('sStAuto').checked; saveSettings(); });
    const sr = S.settings.speed; if (sr && sr.up) $('sSpeedMsg').textContent = `Last test: upload ${sr.up} Mbps (${new Date(sr.at).toLocaleString()}). Recommended: ${recommendQ(sr.up) ? recommendQ(sr.up) + 'p' : 'too slow to stream'}.`;
    loadEncoders(); renderEncoders();
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
  async function streamStart(opts = {}) {
    if (streamer.want) return;
    const dry = !!(opts && opts.dry);
    const target = streamTarget();
    if (!dry && !target.ready) { toast(target.missing, 5000); openSettings('stream'); return; }
    const chk = await desk.streamCheck();
    if (!chk.ok) { $('sStMsg').textContent = chk.error; toast(chk.error); return; }
    await loadEncoders();
    streamer.want = true; streamer.dry = dry; streamer.retries = 0; streamer.startedAt = Date.now(); streamer.slowSince = 0;
    log(dry ? 'practice stream on' : 'streaming on');
    await streamOpen();
  }
  async function streamOpen() {
    if (!streamer.want) return;
    const qName = streamQ(), q = Q_SIZE[qName];
    const target = streamTarget();
    const r = await desk.streamStart({ url: target.url, key: target.key, quality: qName, encoder: chosenEncoder(), dry: streamer.dry, audioRate: E.ctx.sampleRate });
    streamer.openedAt = Date.now(); streamer.slowSince = 0;
    if (!r.ok) { streamer.want = false; $('sStMsg').textContent = r.error; toast(`Couldn't start the stream: ${r.error}`, 6000); renderStream(); return; }
    streamer.gen = r.gen;
    if (!streamer.canvas || streamer.canvas.width !== q[0]) { streamer.canvas = document.createElement('canvas'); streamer.canvas.width = q[0]; streamer.canvas.height = q[1]; streamer.g = streamer.canvas.getContext('2d'); }
    clearInterval(streamer.drawTimer);
    streamer.drawTimer = setInterval(drawStreamFrame, 33);
    drawStreamFrame();
    // Picture only here; the sound goes separately as exact samples (E.pcmTapStart below).
    const mime = ['video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(new MediaStream(streamer.canvas.captureStream(30).getVideoTracks()), { mimeType: mime, videoBitsPerSecond: q[0] > 1500 ? 9000000 : q[0] > 1000 ? 6000000 : 3000000 });
    rec.ondataavailable = e => { if (e.data && e.data.size && streamer.rec === rec) e.data.arrayBuffer().then(b => { if (streamer.rec === rec) desk.streamData(b); }).catch(() => {}); };
    rec.onerror = e => { log('stream recorder error', String(e.error || e)); streamReconnect('The recording stopped.'); };
    streamer.rec = rec;
    showVideo();
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
    streamer.want = false; streamer.dry = false; streamer.qOverride = null; streamer.slowSince = 0; clearTimeout(streamer.retryTimer); unbanner('streamq');
    streamTeardown();
    await desk.streamStop();
    unbanner('stream'); log('streaming off');
    showVideo();
    renderStream();
  }
  desk.onStreamState(safe(st => {
    streamer.state = st;
    // A graphics-chip encoder that fails at the start: switch to the next one (in the end, the processor) at once.
    if (st.ended && st.gen === streamer.gen && streamer.want && st.encoderFailed) {
      enc.failed.add(st.encoderFailed); streamer.encOverride = null;
      log('stream encoder failed; trying the next', st.encoderFailed, '→', chosenEncoder());
      toast(`${(enc.names || {})[st.encoderFailed] || st.encoderFailed} couldn't encode the stream, so it uses ${(enc.names || {})[chosenEncoder()] || chosenEncoder()} instead.`, 6000);
      streamTeardown(); desk.streamStop().then(streamOpen); renderEncoders(); return;
    }
    // The connection couldn't carry this quality: step down rather than keep failing.
    if (st.ended && st.gen === streamer.gen && streamer.want && /too slow/.test(st.error || '') && S.settings.stAuto !== false && streamQ() !== '480') { lowerQuality('the connection was too slow'); return; }
    // Keeping up? ffmpeg's speed should stay at 1.00×. Ignore the first seconds while it settles.
    const hs = st.health;
    if (st.live && st.gen === streamer.gen && hs && hs.speed != null && Date.now() - streamer.openedAt > 10000) {
      if (hs.speed < 0.95) { if (!streamer.slowSince) { streamer.slowSince = Date.now(); log('stream falling behind', hs.speed); } }
      else streamer.slowSince = 0;
      if (streamer.slowSince && Date.now() - streamer.slowSince > 20000 && S.settings.stAuto !== false && streamQ() !== '480') { lowerQuality(`it was running at ${hs.speed.toFixed(2)}× speed`); return; }
    }
    if (st.ended && st.gen === streamer.gen && streamer.want) streamReconnect(st.error || 'the stream service closed the connection');
    else if (st.live && streamer.retries && st.bytes > 200000) { streamer.retries = 0; unbanner('stream'); }
    renderStream();
  }));
  function renderStream() {
    const st = streamer.state || {}, dot = $('stDot'), txt = $('stText');
    const live = streamer.want && st.live && st.gen === streamer.gen;
    if (!streamer.want) { dot.className = 'dot'; txt.textContent = 'Stream'; }
    else if (streamer.dry) { dot.className = 'dot warn'; txt.textContent = 'Stream test'; }
    else if (live) { dot.className = 'dot live'; txt.textContent = `LIVE ${fmt((Date.now() - streamer.startedAt) / 1000)}`; }
    else { dot.className = 'dot warn'; txt.textContent = 'Stream: reconnecting'; }
    $('bStream').title = live ? `Live on ${streamTarget().name} · ${st.stats || ''}` : `Live stream to ${streamTarget().name}`;
    if ($('sStGo')) {
      $('sStGo').textContent = streamer.want ? 'Stop streaming' : 'Start streaming';
      $('sStGo').classList.toggle('danger', streamer.want);
      const ht = streamHealthText(), he = $('sStHealth');
      he.hidden = !ht; he.textContent = ht; he.className = 'st-health ' + (streamer.slowSince ? 'warn' : 'ok');
      $('sStMsg').textContent = streamer.dry ? 'A practice stream for the dress rehearsal test is running (not online).' : live ? `Live on ${streamTarget().name} for ${fmt((Date.now() - streamer.startedAt) / 1000)} · ${st.stats || 'starting…'}` : streamer.want ? `Connecting to ${streamTarget().name}…` : (st.error || '');
    }
  }
  setInterval(safe(renderStream), 1000);
  on('sStGo', 'click', async () => { if (reh.running) { toast('The dress rehearsal test is using the stream. Stop the test first.'); return; } if (!streamer.want) return streamStart(); if (await ask('Stop the live stream?', 'Stop streaming', 'Keep streaming')) await streamStop(); });
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
  function drawCard(g, W, H, opts) {
    const liveBadge = !(opts && opts.live === false);
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
    if (liveBadge) {
    roundRect(g, W - 190 * k, 44 * k, 134 * k, 38 * k, 19 * k); g.fillStyle = 'rgba(0,0,0,0.45)'; g.fill();
    g.fillStyle = '#E5484D'; g.beginPath(); g.arc(W - 166 * k, 63 * k, (6 + Math.sin(now * 4) * 1.2) * k, 0, 6.3); g.fill();
    g.fillStyle = '#FFF'; g.font = `800 ${Math.round(17 * k)}px Archivo, Arial, sans-serif`; g.textAlign = 'left'; g.fillText('LIVE', W - 150 * k, 64 * k);
    g.fillStyle = '#AEB6CC'; g.font = `600 ${Math.round(15 * k)}px Inter, Arial, sans-serif`; g.fillText(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), W - 102 * k, 64 * k);
    }
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
    if (S.settings.stCredit !== false && liveBadge) g.fillText('Streaming by StreamingIdiot', W / 2, H - 28 * k);
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
    if (audioDog.stuck === 6 && S.settings.outputId && S.settings.outputId !== 'default' && !checkOutput.lost) { switchToBackup('stopped responding'); }
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
    applySettings(); configureWp(); applyTheme(); renderGfxButton();
    desk.blockSleep(true).catch(() => {});
    await recover();
    renderTransport();
    requestAnimationFrame(frame);
    setInterval(updateText, 100);
    setInterval(safe(tick), 25);
    setTimeout(safe(() => testVideoCaps(false)), 1500); // which kinds of video can this computer show?
    setTimeout(safe(() => loadEncoders()), 6000); // which video encoders can the stream use? (a few short test encodes, at low priority)
    log('ready', S.show.name, S.show.tracks.length + ' songs');
  }
  window.addEventListener('beforeunload', () => { snapshot(); autosave(); });

  // for automated tests
  window.SP = { S, E, reh, rehearse, glitch, glitchStep, glitchQuiet, enc, loadEncoders, chosenEncoder, streamer, lowerQuality, runSpeedTest, recommendQ, checkOutput, switchToBackup, decks, videoCaps, testVideoCaps, cantShow, findCodec, gfx, chat, etaTimes, health, sys, runHealth, sysLag: () => sys.lag, applyTheme, streamTarget, openSettings, drawCard, videoOut: () => outWin, outFeed, streamStart, streamStop, streamer, trimSilence, collectFiles, syncMaster, updateText, closeCuePop, restart, resetShow, applySettings, openVideoDialog, get active() { return active; }, go, fadeToNext, fadeOut, stopNow, pause, cueNext, fireHot, addFiles, runPreflight, save, openShow, loadShow,
    fillerPlay, fillerFadeOut, fillerState, buildStatus, buildProgram, showRemaining, gainFor, nextAfter, setHotFile, hotBuffers, E, queue: () => queue.length + (analysing ? 1 : 0) };

  boot().catch(err => { oops(err); requestAnimationFrame(frame); setInterval(updateText, 100); setInterval(safe(tick), 25); });
})();
