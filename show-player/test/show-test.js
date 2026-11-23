// End-to-end test: launches the real Recital Show Player, adds generated songs and a video,
// and checks loudness evening-out, GO / wait, straight on, crossfade, fade to next, cues,
// hot sounds with ducking, pre-show music, drag to reorder, preflight, saving and opening,
// sending status to a stand-in WordPress site, and carrying on after the page crashes.
// Needs ffmpeg. Run: npm test   (on Linux: xvfb-run npm test)
const { _electron: electron } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const os = require('os');
const http = require('http');

// ffmpeg makes the test's songs. Use the one on this computer if there is one, otherwise the one bundled with the app.
const FFMPEG = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch (_) { /* not installed */ }
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch (_) { /* not installed either */ }
  throw new Error('ffmpeg is needed to run this test: install it, or run npm install in show-player.');
})();
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showplayer-'));
  const media = path.join(tmp, 'media'); fs.mkdirSync(media);
  const ff = (name, args) => { const out = path.join(media, name); execFileSync(FFMPEG, ['-v', 'error', '-y', ...args, out]); return out; };
  const tone = (name, freq, db, sec) => ff(name, ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${sec}:sample_rate=48000`, '-af', `volume=${db}dB,aformat=channel_layouts=stereo`]);
  const files = [
    tone('01 Quiet Song.wav', 440, -4, 8),    // ffmpeg's sine is -18 dBFS, so this is about -26 LUFS
    tone('02 Loud Song.wav', 660, 16, 8),
    tone('03 Middle Song.wav', 550, 6, 8),
    ff('04 Video Number.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']),
    tone('05 Finale.wav', 330, 10, 8)
  ];
  const sfx = tone('Applause.wav', 1200, -6, 2);
  const filler = [tone('Walk-in 1.wav', 300, -12, 30), tone('Walk-in 2.wav', 350, -12, 30)];
  const quietEnds = ff('Quiet Ends.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4:sample_rate=48000', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
    '-filter_complex', '[1]volume=10dB,aformat=channel_layouts=stereo[t];[0][t][2]concat=n=3:v=0:a=1']);
  const streamOut = path.join(tmp, 'stream-test.flv');
  const logoPng = path.join(media, 'Studio Logo.png'); execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=#E8508A:s=400x160:d=1', '-frames:v', '1', logoPng]);
  const longVideo = ff('Long Video.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=20', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);

  // Stand-in WordPress site: records what the desk sends.
  const got = { program: [], status: [], badKey: 0 };
  const wp = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/speedtest') { got.speed = (got.speed || 0) + body.length; return send(200, { ok: true }); }
      if (req.url.endsWith('/ping')) return send(200, { ok: true, plugin: 'recital-live', version: '0.1.0', server_now: Date.now() });
      const m = /\/shows\/([^/]+)\/(program|status)$/.exec(req.url);
      if (m && req.method === 'POST') {
        if (req.headers['x-recital-key'] !== 'k'.repeat(32)) { got.badKey++; return send(403, { code: 'recital_bad_key' }); }
        got[m[2]].push(JSON.parse(body)); return send(200, { ok: true, server_now: Date.now() });
      }
      send(404, {});
    });
  }).listen(0);
  const wpUrl = `http://127.0.0.1:${wp.address().port}`;
  const wpCode = Buffer.from(JSON.stringify({ url: wpUrl, show: 'spring-2027', key: 'k'.repeat(32) })).toString('base64');

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--user-data-dir=${path.join(tmp, 'profile')}`],
    env: { ...process.env, SHOW_PLAYER_DATA: path.join(tmp, 'data'), SHOW_PLAYER_MAXIMIZE: '1', SHOW_PLAYER_STREAM_OUT: streamOut, SHOW_PLAYER_SELFTEST_GPU: '1', SHOW_PLAYER_SPEEDTEST_URL: `${wpUrl}/speedtest` }
  });
  let win = await app.firstWindow();
  const errors = []; const watch = w => w.on('pageerror', e => errors.push(e.message));
  watch(win);
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForFunction(() => window.SP && document.getElementById('showName').value !== '', null, { timeout: 20000 });
  ok(true, 'app opens');

  const chooseFiles = list => app.evaluate(({ dialog }, l) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: l }); }, list);
  const sp = (fn, arg) => win.evaluate(fn, arg);
  const waitFor = (fn, arg, timeout = 15000) => win.waitForFunction(fn, arg, { timeout, polling: 50 });
  // Waits up to 2 s for an element's text (the screen refreshes text in its frame loop, so it can lag a few ms).
  const shows = (sel, text, exact = false) => win.waitForFunction(([s, t, e]) => { const v = document.querySelector(s).textContent; return e ? v === t : v.includes(t); }, [sel, text, exact], { timeout: 2000 }).then(() => true, () => false);

  // Add the songs and wait for loudness measuring
  await chooseFiles(files);
  await win.click('#bAdd');
  await waitFor(() => SP.S.show.tracks.length === 5 && SP.queue() === 0 && SP.S.show.tracks.every(t => t.an || t.anError), null, 60000);
  ok((await win.$$('#plist .row')).length === 5, 'five songs are in the playlist');
  const an = await sp(() => SP.S.show.tracks.map(t => ({ title: t.title, lufs: t.an && t.an.lufs, gain: SP.gainFor(t), type: t.type, dur: t.duration })));
  console.log('INFO ' + an.map(a => `${a.title}: ${a.lufs} LUFS → ${a.gain.toFixed(1)} dB`).join(' | '));
  ok(an[0].title === 'Quiet Song' && an[3].type === 'video', 'titles come from file names and the mp4 is marked as video');
  ok(Math.abs(an[0].lufs - an[1].lufs - (-20)) < 1.5, `loudness is measured (quiet ${an[0].lufs}, loud ${an[1].lufs} LUFS: 20 dB apart)`);
  const after = an.map(a => a.lufs + a.gain);
  ok(Math.abs(after[0] - (-16)) < 0.6 && Math.abs(after[1] - (-16)) < 0.6 && Math.abs(after[2] - (-16)) < 0.6, 'normalising brings every song to -16 LUFS');

  // Set up the running order: names, transitions, short end points to keep the test quick
  await sp(() => {
    const [a, b, c, d, e] = SP.S.show.tracks;
    Object.assign(a, { dance: 'Tiny Tots Tap', transition: 'stop', endAt: 2.5 });
    Object.assign(b, { dance: 'Junior Jazz', transition: 'straight', endAt: 2.5, cues: [{ id: 'c1', t: 1.0, type: 'light', text: 'LX 5 go' }, { id: 'c2', t: 2.0, type: 'spot', text: 'Spot 1 pick up Ava' }], props: [{ id: 'p1', text: '2 chairs SL' }] });
    Object.assign(c, { dance: 'Senior Lyrical', transition: 'crossfade', xfade: 1.5, endAt: 4 });
    Object.assign(d, { dance: 'Hip Hop Crew', transition: 'stop' });
    Object.assign(e, { dance: 'Finale', transition: 'stop' });
  });
  await win.click('#plist .row >> nth=1'); await sleep(200);
  ok((await win.inputValue('#iDance')) === 'Junior Jazz', 'clicking a song shows its details');
  ok((await win.$$('#iCues .cue')).length === 2, 'its cues are listed');

  // GO plays song 1, which waits for GO at the end
  await win.keyboard.press('Space');
  await waitFor(() => SP.S.live.state === 'playing');
  const s1 = await sp(() => ({ id: SP.S.live.currentId, t: SP.active.time, paused: SP.active.el.paused }));
  ok(!s1.paused, 'Space (GO) starts the first song');
  await sleep(600);
  ok(await sp(() => SP.active.time) > s1.t + 0.3, 'the song is playing (the clock moves)');
  await win.keyboard.press('Space'); await sleep(100);
  ok(await sp(() => SP.S.live.currentId) === s1.id, 'GO while playing does not skip the song');
  await waitFor(() => SP.S.live.state === 'standby', null, 6000);
  ok(await sp(() => SP.S.live.standbyId === SP.S.show.tracks[1].id), '"Wait for GO": song 1 ends and song 2 stands by');
  ok(await shows('#nowDance', 'Junior Jazz', true), 'standing by shows the next dance');
  ok(await shows('#cueNext', 'LX 5 go'), 'the next cue shows before GO');

  // Song 2 plays straight on into song 3; its cues fire on time
  await win.keyboard.press('Space');
  await waitFor(() => SP.S.live.lastCue && SP.S.live.lastCue.cue.text === 'LX 5 go', null, 4000);
  ok(true, 'cue “LX 5 go” fires at 1.0 s');
  ok(await win.waitForFunction(() => document.getElementById('cueNow').textContent.includes('LX 5 go'), null, { timeout: 2000 }).then(() => true, () => false), 'Cue now shows it');
  ok(await win.waitForFunction(() => document.getElementById('cueNext').textContent.includes('Spot 1 pick up Ava'), null, { timeout: 2000 }).then(() => true, () => false), 'Next cue shows the following cue');
  ok(await shows('#propsNow', '2 chairs SL'), 'props for this number show');
  await waitFor(() => SP.S.live.currentId === SP.S.show.tracks[2].id, null, 5000);
  ok(await sp(() => SP.S.live.state === 'playing'), '"Straight on": song 3 starts by itself');

  // Song 3 crossfades into the video
  await waitFor(() => SP.S.live.xfade, null, 6000);
  const both = await sp(() => SP.decks.filter(d => !d.el.paused).length);
  ok(both === 2, 'crossfade: both songs play at once');
  await waitFor(() => SP.S.live.currentId === SP.S.show.tracks[3].id && !SP.S.live.xfade, null, 5000);
  await sleep(300);
  ok(await sp(() => SP.decks.filter(d => !d.el.paused).length === 1), 'crossfade: the old song stops when the fade ends');
  ok(await sp(() => SP.active.el.videoWidth === 320), 'the video plays');

  // Fade to next (F)
  await win.keyboard.press('f');
  await waitFor(() => SP.S.live.currentId === SP.S.show.tracks[4].id, null, 5000);
  ok(true, 'F crossfades into the next song');
  await sleep(3300);
  ok(await sp(() => SP.decks.filter(d => !d.el.paused).length === 1), 'fade to next finishes');

  // Hot sound with ducking
  await chooseFiles([sfx]);
  await win.click('#hots .hot >> nth=0');
  await waitFor(() => SP.S.show.hotCues[0] && SP.hotBuffers.has(SP.S.show.hotCues[0].id), null, 10000);
  await win.keyboard.press('1');
  await sleep(400);
  const duck = await sp(() => SP.E.duckGain.gain.value);
  ok(duck < 0.4, `hot sound 1 plays and the music ducks (${(20 * Math.log10(duck)).toFixed(1)} dB)`);
  await sleep(2400);
  ok(await sp(() => SP.E.duckGain.gain.value) > 0.9, 'the music comes back up when the hot sound ends');

  // Fade out (Esc): the last song fades and the show is over
  await win.keyboard.press('Escape');
  await waitFor(() => SP.S.live.state === 'ended', null, 6000);
  ok(true, 'Esc fades out; after the last song the show is over');

  // Pre-show music; GO fades it out
  await chooseFiles(filler);
  await win.click('#tabFiller'); await win.click('#bAddFill');
  await waitFor(() => SP.S.show.filler.length === 2);
  await win.keyboard.press('b');
  await waitFor(() => SP.fillerState.playing);
  ok(await win.waitForFunction(() => document.getElementById('fillNow').textContent.includes('Walk-in 1'), null, { timeout: 2000 }).then(() => true, () => false), 'B starts pre-show music');
  await sp(() => { SP.S.show.tracks[0].endAt = 0; SP.cueNext(SP.S.show.tracks[0].id); });
  await win.keyboard.press('Space');
  await waitFor(() => !SP.fillerState.playing, null, 6000).catch(() => {});
  console.log('INFO after GO with pre-show music:', JSON.stringify(await sp(() => ({ state: SP.S.live.state, cur: SP.S.live.currentId, sb: SP.S.live.standbyId, filler: SP.fillerState }))));
  ok(await sp(() => SP.S.live.state === 'playing'), 'GO starts the show and fades out the pre-show music');
  await win.keyboard.press('Shift+Escape');
  await waitFor(() => SP.S.live.state === 'standby');
  ok(await sp(() => SP.S.live.standbyId === SP.S.show.tracks[0].id), 'Shift+Esc stops and stands by on the same song');

  // Restart and play again
  await win.click('#tabShow');
  await sp(() => { SP.S.show.tracks[0].endAt = 3; });
  await win.keyboard.press('Space');
  await waitFor(() => SP.S.live.state === 'playing');
  await sleep(1500);
  await win.keyboard.press('r');
  await sleep(300);
  const rs = await sp(() => ({ id: SP.S.live.currentId, t: SP.active.time, st: SP.S.live.state }));
  ok(rs.st === 'playing' && rs.t < 0.8, `R restarts the playing song from the top (now at ${rs.t.toFixed(2)} s)`);
  await waitFor(() => SP.S.live.state === 'standby', null, 6000);
  ok(await sp(id => SP.S.live.standbyId !== id && SP.S.live.played.has(id), rs.id), 'when it ends, the next song stands by and this one is marked played');
  await win.keyboard.press('r');
  await sleep(200);
  ok(await sp(id => SP.S.live.standbyId === id && !SP.S.live.played.has(id), rs.id), 'R after it ends stands it by again, no longer marked played');
  ok(await win.isVisible('#plist .row.standby') && (await win.textContent('#plist .row.standby .t1')).includes('Tiny Tots Tap'), 'the playlist shows it standing by');
  await sp(() => { SP.S.live.played.add(SP.S.show.tracks[2].id); SP.S.live.standbyId = SP.S.show.tracks[3].id; });
  await win.click('#plist .row >> nth=2'); await sleep(150);
  ok((await win.textContent('#iCueNext')) === 'Play this again', 'a played song offers "Play this again"');
  await win.click('#iCueNext'); await sleep(150);
  ok(await sp(() => SP.S.live.standbyId === SP.S.show.tracks[2].id && !SP.S.live.played.has(SP.S.show.tracks[2].id)), '"Play this again" stands it by and un-dims it');
  await win.evaluate(() => { window.confirm = () => true; });
  await win.click('#bResetShow'); await sleep(150);
  ok(await sp(() => SP.S.live.played.size === 0 && SP.S.live.standbyId === SP.S.show.tracks[0].id), 'Reset show clears every played mark and stands by on the first song');
  await sp(() => { SP.S.show.tracks[0].endAt = 0; });

  // Estimated start times in the playlist
  const eta = await sp(() => { const tr = SP.S.show.tracks, m = SP.etaTimes(), sb = SP.S.live.standbyId, i = tr.findIndex(t => t.id === sb), a = tr[i], b = tr[i + 1];
    const len = t => ((t.endAt > 0 && t.endAt < t.duration ? t.endAt : t.duration) - (t.startAt || 0));
    return { first: Math.abs(m.get(a.id) - Date.now()) < 1500, gap: (m.get(b.id) - m.get(a.id)) / 1000, len: len(a) - (a.transition === 'crossfade' ? Math.min(a.xfade, len(b) / 2) : 0),
      shown: [...document.querySelectorAll('#plist .row')].map(r => r.querySelector('.eta').textContent) }; });
  ok(eta.first && Math.abs(eta.gap - eta.len) < 1, `the playlist works out when each song will start (next one ${eta.gap.toFixed(1)} s after this one, which is ${eta.len.toFixed(1)} s long)`);
  ok(eta.shown.filter(v => /\d{1,2}:\d{2}/.test(v)).length >= 2, `clock times show by the songs still to come (${eta.shown.filter(Boolean).slice(0, 3).join(', ')})`);

  // Drag the waveform while stopped to choose where GO starts; the master slider doesn't swallow Space
  const box = await win.$eval('#wave', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await win.mouse.move(box.x + box.w * 0.2, box.y + box.h / 2); await win.mouse.down();
  await win.mouse.move(box.x + box.w * 0.5, box.y + box.h / 2, { steps: 5 }); await win.mouse.up();
  await sleep(150);
  const from = await sp(() => SP.S.live.cueFrom && { id: SP.S.live.cueFrom.id, at: SP.S.live.cueFrom.at, sb: SP.S.live.standbyId });
  ok(from && from.id === from.sb && Math.abs(from.at - 4) < 0.4, `dragging the waveform while stopped sets where GO starts (${from && from.at.toFixed(1)} s of 8)`);
  ok((await win.textContent('#goSub')).startsWith('From 0:0'), 'the GO button shows the start point');
  await win.keyboard.press('r'); await sleep(100);
  ok(await sp(() => SP.S.live.cueFrom === null), 'R puts the start point back to the top');
  await win.mouse.click(box.x + box.w * 0.5, box.y + box.h / 2); await sleep(150);
  await win.evaluate(() => { const el = document.getElementById('mMaster'); el.value = -3; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); });
  ok(await sp(() => SP.S.settings.masterDb === -3 && document.getElementById('mMasterTxt').textContent === '-3 dB'), 'the master slider on the main page sets the master level');
  await win.keyboard.press('Space');
  await waitFor(() => SP.S.live.state === 'playing');
  const startedAt = await sp(() => SP.active.time);
  ok(Math.abs(startedAt - 4) < 0.6, `Space works with the slider focused, and GO plays from the chosen point (${startedAt.toFixed(1)} s)`);
  await win.evaluate(() => { const el = document.getElementById('mMaster'); el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); });
  await win.keyboard.press('Shift+Escape');
  await waitFor(() => SP.S.live.state === 'standby');
  ok(await sp(() => SP.S.live.cueFrom === null), 'after playing, the start point is cleared');

  // Settings: recommended marks and "Use recommended"
  await win.click('#bSettings');
  const marks = await win.$$eval('#dlgSettings .recmark', els => els.length);
  ok(marks >= 9, `sound sliders have recommended marks (${marks})`);
  ok((await win.textContent('#dlgSettings')).includes('✓ recommended'), 'settings at the recommended value say so');
  await win.evaluate(() => { const el = document.getElementById('sTarget'); el.value = -12; el.dispatchEvent(new Event('input', { bubbles: true })); window.confirm = () => true; });
  ok((await win.textContent('#sTarget >> xpath=ancestor::label')).includes('recommended -16 LUFS'), 'a changed setting shows the recommended value');
  await win.click('#sRec'); await sleep(200);
  ok(await sp(() => SP.S.settings.targetLufs === -16 && SP.S.settings.masterDb === 0), '"Use recommended sound" puts it back');
  ok((await win.textContent('#streamBox legend')).includes('by StreamingIdiot'), 'Settings has Streaming by StreamingIdiot');
  // YouTube: only the stream key is needed
  await win.click('.set-tab[data-pane=stream]');
  await win.click('.svc-card:has(input[value=youtube])');
  ok(await win.isVisible('#sStYtKey') && !(await win.isVisible('#sStUrl')), 'choosing YouTube asks only for the stream key, with steps');
  await win.fill('#sStYtKey', 'abcd-efgh-ijkl-mnop'); await win.dispatchEvent('#sStYtKey', 'change');
  const yt = await sp(() => SP.streamTarget());
  ok(yt.url === 'rtmp://a.rtmp.youtube.com/live2' && yt.key === 'abcd-efgh-ijkl-mnop' && yt.name === 'YouTube', 'YouTube streams go to YouTube\'s address with your key');
  await win.click('.svc-card:has(input[value=streamingidiot])');
  ok(await win.isVisible('#sStUrl') && await sp(() => SP.streamTarget().name === 'StreamingIdiot'), 'switching back to StreamingIdiot shows its address and key');
  // Easter egg: LCARS mode
  await win.click('#sLcars');
  ok(await win.evaluate(() => document.documentElement.dataset.theme === 'lcars' && getComputedStyle(document.querySelector('#bGo b'), '::after').content.includes('ENGAGE')) && await sp(() => SP.S.settings.lcars === true), 'the LCARS mode button turns on the starship look (GO says ENGAGE) and remembers it');
  await win.click('#sLcars');
  ok(await win.evaluate(() => !document.documentElement.dataset.theme), 'pressing it again goes back to the standard look');
  await win.click('#dlgSettings button[value=close]');

  // On a 1366×768 laptop screen, everything that matters fits without scrolling
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1366, 768)); await sleep(700);
  const fit = await win.evaluate(() => { const c = document.querySelector('.col.center'), b = c.getBoundingClientRect(); const ids = ['tLeft', 'cueNextBox', 'bGo', 'hots', 'nextDance', 'mMaster', 'fPlay', 'phoneMsg']; return { scrolls: c.scrollHeight > c.clientHeight + 2, offscreen: ids.filter(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.bottom > window.innerHeight + 1 || r.height === 0; }) }; });
  ok(!fit.scrolls && fit.offscreen.length === 0, `at 1366×768 the timers, cues, GO, hot sounds, master, pre-show and phone message are all on screen (${JSON.stringify(fit)})`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)); await sleep(500);

  // Pressing C opens the New cue box with the cursor in it (and the next-cue countdown counts down)
  await sp(() => { SP.S.show.tracks[0].cues.push({ id: 'cd1', t: 7.5, type: 'stage', text: 'Curtain' }); });
  await sleep(350);
  await win.keyboard.press('Space');
  await waitFor(() => SP.S.live.state === 'playing');
  await sleep(300);
  const secs = txt => { const m = /in (\d+):(\d+(?:\.\d)?)/.exec(txt); return m ? +m[1] * 60 + +m[2] : NaN; };
  const cd1 = secs(await win.textContent('#cueNextIn')); await sleep(1000); const cd2 = secs(await win.textContent('#cueNextIn'));
  ok(cd2 < cd1 - 0.6 && cd2 > cd1 - 1.5, `the next-cue countdown counts down (${cd1} → ${cd2} s)`);
  await sleep(100);
  await win.keyboard.press('c');
  await sleep(150);
  ok(await win.evaluate(() => document.getElementById('dlgCue').open && document.activeElement === document.getElementById('cpText')), 'C opens the New cue box with the cursor in the text box');
  await win.keyboard.press('Tab');
  await win.keyboard.type('Spot 2 fade', { delay: 30 });
  await win.keyboard.press('Enter');
  await sleep(150);
  const pc = await sp(() => { const c = SP.active.track.cues.find(c => c.text === 'Spot 2 fade'); return c ? { t: c.t, type: c.type, open: document.getElementById('dlgCue').open } : null; });
  ok(pc && !pc.open && pc.t >= 1 && pc.t <= 1.6, `typing and Enter saves the cue at the time C was pressed (${pc && pc.t} s)`);
  ok(pc && pc.type !== 'light', `Tab changes the cue type (now ${pc && pc.type})`);
  ok(await sp(() => SP.S.live.state === 'playing'), 'letters typed in the box (f, p, s…) don\'t trigger shortcuts');
  const nCues = await sp(() => SP.active.track.cues.length);
  await win.keyboard.press('c'); await sleep(150);
  await win.keyboard.type('oops');
  await win.keyboard.press('Escape'); await sleep(200);
  ok(await sp(n => SP.active.track.cues.length === n && !document.getElementById('dlgCue').open, nCues), 'Esc cancels the new cue');
  ok(await sp(() => SP.S.live.state === 'playing' && !SP.S.live.fadingOut), 'Esc in the cue box does not fade out the music');
  await win.keyboard.press('Shift+Escape');
  await waitFor(() => SP.S.live.state === 'standby');

  // Drag to reorder: move the Finale to the top
  await win.click('#tabShow');
  await win.dragAndDrop('#plist .row >> nth=4', '#plist .row >> nth=0', { targetPosition: { x: 40, y: 3 } });
  await sleep(200);
  ok(await sp(() => SP.S.show.tracks[0].dance === 'Finale'), 'dragging a row changes the order');
  await win.keyboard.press('Alt+ArrowDown').catch(() => {});

  // Preflight: all files found; then one goes missing
  let pf = await sp(() => SP.runPreflight());
  ok(pf.bad === 0, `preflight passes with no problems (${pf.warn} warnings)`);
  await win.keyboard.press('Escape');
  fs.renameSync(files[2], files[2] + '.moved');
  pf = await sp(() => SP.runPreflight());
  ok(pf.bad > 0 && pf.items.some(i => i.title && i.title.includes('file is missing')), 'preflight finds the missing file');
  fs.renameSync(files[2] + '.moved', files[2]);
  await win.keyboard.press('Escape');

  // Spatial enhancer: a left-only 1 kHz tone, measured at the output meters
  const levels = await sp(async () => {
    const E = SP.E, ctx = E.ctx, n = ctx.sampleRate * 2;
    const make = chans => { const b = ctx.createBuffer(chans, n, ctx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = 0.2 * Math.sin(2 * Math.PI * 1000 * i / ctx.sampleRate); return b; };
    const stereoLeft = make(2), mono = make(1);
    const measure = async (buf, settings) => {
      Object.assign(SP.S.settings, settings); SP.applySettings();
      await new Promise(r => setTimeout(r, 250));
      E.playHot('probe', buf, -6, null, false);
      await new Promise(r => setTimeout(r, 500));
      const m = E.meters(); E.stopHot('probe', 0.01);
      await new Promise(r => setTimeout(r, 150));
      return { L: m.rmsL, R: m.rmsR };
    };
    const out = {
      off: await measure(stereoLeft, { spatialOn: false }),
      w100: await measure(stereoLeft, { spatialOn: true, width: 1 }),
      w200: await measure(stereoLeft, { spatialOn: true, width: 2 }),
      w0: await measure(stereoLeft, { spatialOn: true, width: 0 }),
      mono: await measure(mono, { spatialOn: false }),
      monoWide: await measure(mono, { spatialOn: true, width: 2 })
    };
    Object.assign(SP.S.settings, { spatialOn: false, width: 1.4 }); SP.applySettings();
    return out;
  });
  const db = v => v.toFixed(1);
  console.log('INFO spatial (L/R dBFS): ' + Object.entries(levels).map(([k, v]) => `${k} ${db(v.L)}/${db(v.R)}`).join(' | '));
  ok(levels.off.R < levels.off.L - 40 && levels.w100.R < levels.w100.L - 40, 'spatial at 100% leaves a left-only sound on the left');
  ok(Math.abs((levels.w200.L - levels.w200.R) - 9.54) < 1, `spatial at 200% spreads it: right is ${db(levels.w200.L - levels.w200.R)} dB below left (9.5 expected)`);
  ok(Math.abs(levels.w0.L - levels.w0.R) < 0.5, 'spatial at 0% makes it mono');
  ok(Math.abs(levels.mono.L - levels.mono.R) < 0.5, 'a mono file plays on both speakers');
  ok(Math.abs(levels.monoWide.L - levels.monoWide.R) < 0.5, 'widening leaves a mono file centred');
  await win.click('#bSettings');
  await win.click('.set-tab[data-pane=tone]');
  ok(await win.isVisible('#sSpatial') && (await win.textContent('#sWidthTxt')).includes('140%'), 'Settings has the spatial enhancer (140% to start)');
  await win.click('#dlgSettings button[value=close]');

  // Video output screen chooser
  await win.click('#bVideo');
  await win.waitForSelector('#dlgVideo[open] .screen');
  ok((await win.$$('#vScreens .screen')).length >= 1, 'Video output lists the screens, numbered');
  const nWin = app.windows().length;
  await win.click('#vOpen');
  await waitFor(() => SP.S.settings.videoDisplay && document.getElementById('vOpen').disabled, null, 5000);
  ok(app.windows().length === nWin + 1, 'Open on this screen opens the video window');
  ok((await win.textContent('#vScreens')).includes('Video is here'), 'the chooser shows which screen the video is on');
  ok((await win.textContent('#bVideo')).startsWith('Video: screen'), 'the top bar says which screen has the video');
  await win.click('#vClose'); await sleep(1200);
  ok(app.windows().length === nWin, 'Close video output closes it');
  await win.click('#dlgVideo button[value=close]');

  // Save and open
  const showFile = path.join(tmp, 'Spring Recital.recital');
  await sp(() => { SP.S.show.name = 'Spring Recital'; });
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, showFile);
  await win.keyboard.press('Control+s'); await sleep(200);
  await sp(() => SP.save(true));
  const saved = JSON.parse(fs.readFileSync(showFile, 'utf8'));
  ok(saved.app === 'recital-show-player' && saved.show.tracks.length === 5 && saved.show.tracks.some(t => t.cues.length === 2), 'the show saves with songs and cues');
  ok(saved.show.tracks[0].rel === 'media/05 Finale.wav', 'file paths are also saved relative to the show file');
  await sp(() => SP.loadShow({ name: 'Empty' }, null, false));
  await sp(p => SP.openShow(p), showFile);
  await waitFor(() => SP.S.show.name === 'Spring Recital' && SP.S.show.tracks.length === 5);
  ok(true, 'the show opens again');

  // Phones: connect to the stand-in WordPress site
  await win.click('#bSettings');
  await win.click('.set-tab[data-pane=phones]');
  ok(await win.isVisible('#sWpCode') && !(await win.isVisible('#sSpatial')), 'Settings is split into sections (Phones shows only the phone settings)');
  await win.fill('#sWpCode', wpCode); await win.dispatchEvent('#sWpCode', 'change');
  await win.check('#sWpOn');
  await win.click('#sWpTest');
  await win.waitForFunction(() => /Connected/.test(document.getElementById('sWpMsg').textContent), null, { timeout: 8000 });
  ok(true, 'Test connection reaches the site');
  await win.click('#dlgSettings button[value=close]');
  await sp(() => SP.cueNext(SP.S.show.tracks[2].id));
  await win.keyboard.press('Space');
  await sleep(3000);
  const prog = got.program[got.program.length - 1], st = got.status[got.status.length - 1];
  ok(prog && prog.tracks.length === 5 && prog.show === 'Spring Recital', 'the program is sent to the site');
  ok(prog && prog.tracks.find(t => t.dance === 'Junior Jazz').cues.length === 2 && prog.tracks.find(t => t.dance === 'Junior Jazz').props[0] === '2 chairs SL', 'cues and props are in the program');
  ok(st && st.state === 'playing' && typeof st.position === 'number' && st.track_id, `status is sent while playing (${got.status.length} so far)`);
  ok(got.badKey === 0, 'the desktop key is accepted');
  ok(await shows('#wpText', 'Phones live', true), 'the top bar says Phones live');

  // Video output keeps its picture, and reconnects if the picture feed dies
  await sp(async p => SP.addFiles(await window.desk.statMedia([p]), 'show'), longVideo);
  await waitFor(() => SP.queue() === 0 && SP.S.show.tracks.some(t => t.title === 'Long Video' && t.an), null, 20000);
  await sp(() => { const t = SP.S.show.tracks.find(t => t.title === 'Long Video'); t.startAt = 0; t.endAt = 0; SP.stopNow(false); SP.cueNext(t.id); });
  await win.click('#bVideo'); await win.waitForSelector('#dlgVideo[open] .screen'); await win.click('#vOpen');
  await waitFor(() => document.getElementById('vOpen').disabled, null, 5000);
  await win.click('#dlgVideo button[value=close]');
  await sleep(400); await sp(() => SP.go());
  await waitFor(() => SP.S.live.state === 'playing' && SP.active.track.title === 'Long Video');
  await sleep(1500);
  const f1 = await sp(() => SP.outFeed.frames); await sleep(1500); const f2 = await sp(() => SP.outFeed.frames);
  ok(f2 > f1 + 10, `the video window shows the picture (${f2 - f1} frames in 1.5 s)`);
  ok(await sp(() => { try { const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d'); g.drawImage(SP.active.el, 0, 0, 64, 36); c.toDataURL(); return true; } catch (err) { return false; } }), 'video frames can be used in the stream picture');
  await sp(() => SP.videoOut().document.getElementById('v').srcObject.getVideoTracks().forEach(t => t.stop()));
  await sleep(4500);
  const f3 = await sp(() => SP.outFeed.frames); await sleep(1500); const f4 = await sp(() => SP.outFeed.frames);
  ok(f4 > f3 + 10 && f4 - f3 < (f2 - f1) * 1.5, `when the picture feed dies, the watchdog reconnects it (${f4 - f3} frames in 1.5 s after)`);
  await sp(() => { SP.stopNow(false); });
  // Take graphics live: with no video playing, the video window shows the title graphics instead of black
  const outV = () => sp(() => { const v = SP.videoOut().document.getElementById('v'); return { has: !!v.srcObject, w: v.videoWidth, paused: v.paused, t: v.currentTime }; });
  await sleep(400);
  ok(!(await outV()).has, 'with graphics off, the video window is black when no video is playing');
  await win.click('#bGfx');
  await waitFor(() => SP.videoOut().document.getElementById('v').videoWidth === 1280, null, 6000).catch(() => {});
  const g1 = await outV(); await sleep(1000); const g2 = await outV();
  ok(g1.w === 1280 && g2.t > g1.t && (await win.textContent('#bGfx')) === 'Graphics are live', `"Take graphics live" puts the title graphics on the video window (${g1.w} px wide, moving)`);
  ok(await win.isVisible('#gfxPrev'), 'the preview box shows the graphics that are going out');
  await sp(() => { const t = SP.S.show.tracks.find(t => t.title === 'Long Video'); SP.cueNext(t.id); });
  await sleep(400); await sp(() => SP.go());
  await waitFor(() => SP.S.live.state === 'playing' && SP.videoOut().document.getElementById('v').videoWidth === 320, null, 8000).catch(() => {});
  ok((await outV()).w === 320, 'when a video number starts, the video window switches to the video');
  await sp(() => SP.stopNow(false));
  await waitFor(() => SP.videoOut().document.getElementById('v').videoWidth === 1280, null, 6000).catch(() => {});
  ok((await outV()).w === 1280, 'when it stops, the graphics come back');
  await win.click('#bGfx'); await sleep(400);
  ok(!(await outV()).has && await sp(() => !SP.gfx.timer), 'turning graphics off goes back to black and stops drawing them');
  await win.click('#bVideo'); await win.waitForSelector('#dlgVideo[open] .screen'); await win.click('#vClose'); await sleep(800); await win.click('#dlgVideo button[value=close]');
  await sp(() => { SP.S.show.tracks = SP.S.show.tracks.filter(t => t.title !== 'Long Video'); });

  // A .dance file from the Choreography Workbook: the song comes out, with the dance name, props and cues
  const danceSong = tone('dance-audio.wav', 520, 8, 12);
  const mkDance = (name, withAudio) => { const z = new AdmZip(); z.addFile('project.json', Buffer.from(JSON.stringify({ app: 'choreo-workbook', format: 1, project: { title: 'Spotlight', style: 'Jazz', bpm: 120, offset: 1, phrase: 8,
    sections: [{ name: 'Intro', start: 1 }, { name: 'Verse', start: 2 }], notes: { 1: 'Hold opening pose' }, formations: [{ id: 'f1', name: 'Opening clump', at: 0 }, { id: 'f2', name: 'Walk into V', at: 16 }],
    props: [{ id: 'pa', name: 'Chair A', kind: 'chair' }], audio: { name: 'Spotlight Mix.wav', duration: 12 }, video: null } })));
    if (withAudio) z.addFile('media/audio.wav', fs.readFileSync(danceSong)); const f = path.join(media, name); z.writeZip(f); return f; };
  const danceFile = mkDance('Spotlight.dance', true), danceNoMusic = mkDance('No Music.dance', false);
  await sp(async p => SP.addFiles(await window.desk.statMedia(p), 'show'), [danceFile, danceNoMusic]);
  await waitFor(() => SP.queue() === 0 && SP.S.show.tracks.some(t => t.dance === 'Spotlight' && t.an), null, 20000);
  const dn = await sp(() => { const t = SP.S.show.tracks.find(t => t.dance === 'Spotlight'); return { title: t.title, cls: t.cls, props: t.props.map(p => p.text), cues: t.cues.map(c => `${c.t} ${c.type} ${c.text}`), dur: Math.round(t.duration), lufs: t.an.lufs, path: t.path }; });
  ok(dn.title === 'Spotlight Mix' && dn.cls === 'Jazz' && dn.dur === 12 && fs.existsSync(dn.path), `a .dance file adds its song with the dance name and style (${dn.title}, ${dn.cls}, ${dn.dur} s)`);
  ok(dn.cues.includes('1 note Intro') && dn.cues.includes('5 note Verse') && dn.cues.includes('9 stage Formation: Walk into V') && dn.props[0] === 'Chair A', `sections and formations come in as cues at the right times, and props too (${dn.cues.join(' | ')})`);
  ok((await win.textContent('.banner[data-id=dance-import]')).includes('has no music inside'), 'a .dance file saved without music says how to fix it');
  await sp(() => { document.querySelectorAll('.banner').forEach(b => b.remove()); const t = SP.S.show.tracks.find(t => t.dance === 'Spotlight'); SP.stopNow(false); SP.cueNext(t.id); });
  await sleep(400); await sp(() => SP.go());
  await waitFor(() => SP.S.live.state === 'playing' && SP.active.track.dance === 'Spotlight' && SP.active.time > 0.5, null, 8000);
  ok(true, 'the imported song plays');
  // the question box doesn't freeze the app
  await win.evaluate(() => { delete window.confirm; });
  const tq = await sp(() => SP.active.time);
  await win.click('#tabShow'); await win.click('#plist .row >> nth=0'); await win.click('#iRemove');
  await win.waitForSelector('#dlgAsk[open]'); await sleep(800);
  ok(await sp(t0 => SP.active.time > t0 + 0.5 && SP.S.live.state === 'playing', tq), 'while a question box is open, the song and timers keep running');
  await win.click('#askNo'); await sleep(150);
  ok(await sp(() => SP.S.show.tracks.length >= 6) && !(await win.isVisible('#dlgAsk')), 'Cancel leaves the playlist as it was');
  await win.evaluate(() => { window.confirm = () => true; });
  await sp(() => { SP.stopNow(false); SP.S.show.tracks = SP.S.show.tracks.filter(t => t.dance !== 'Spotlight'); });

  // Drag a cue on the waveform while paused
  await sp(() => { const t = SP.S.show.tracks[0]; t.startAt = 0; t.endAt = 0; t.cues = [{ id: 'dq', t: 2, type: 'light', text: 'LX 9' }]; SP.S.live.played = new Set(); SP.cueNext(t.id); });
  await sleep(400); await sp(() => SP.go());
  await waitFor(() => SP.S.live.state === 'playing' && SP.active.time > 0.6);
  const wb = await win.$eval('#wave', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const dur0 = await sp(() => SP.S.show.tracks[0].duration);
  const cueX = t => wb.x + t / dur0 * wb.w;
  await win.mouse.move(cueX(2), wb.y + wb.h * 0.7); await win.mouse.down(); await win.mouse.move(cueX(5), wb.y + wb.h * 0.7, { steps: 4 }); await win.mouse.up(); await sleep(150);
  ok(await sp(() => SP.S.show.tracks[0].cues[0].t === 2), 'while the song plays, a cue cannot be dragged');
  await sp(() => SP.pause()); await sleep(200);
  const posBefore = await sp(() => SP.active.time);
  await sp(() => { SP.S.dirty = false; });
  await win.mouse.move(cueX(2), wb.y + wb.h * 0.7); await win.mouse.down(); await win.mouse.move(cueX(5), wb.y + wb.h * 0.7, { steps: 6 }); await win.mouse.up(); await sleep(200);
  const moved = await sp(() => ({ t: SP.S.show.tracks[0].cues[0].t, dirty: SP.S.dirty, pos: SP.active.time, row: (document.querySelector('#iCues .cue input') || {}).value }));
  ok(Math.abs(moved.t - 5) < 0.3 && moved.dirty, `paused: dragging a cue on the waveform moves it and saves it (2.0 s → ${moved.t} s)`);
  ok(Math.abs(moved.pos - posBefore) < 0.05, 'dragging a cue does not move the playhead');
  ok(/Cue “LX 9” moved/.test(await win.textContent('#toast')), 'a note says where the cue moved to');
  await sp(() => { SP.stopNow(false); SP.S.show.tracks[0].cues = SP.S.show.tracks[0].cues.filter(c => c.id !== 'dq'); });

  // Skip silence at both ends of a new song
  await sp(async p => SP.addFiles(await window.desk.statMedia([p]), 'show'), quietEnds);
  await waitFor(() => SP.queue() === 0 && SP.S.show.tracks.some(t => t.title === 'Quiet Ends' && t.an), null, 20000);
  const qe = await sp(() => { const t = SP.S.show.tracks.find(t => t.title === 'Quiet Ends'); return { s: t.startAt, e: t.endAt }; });
  ok(Math.abs(qe.s - 1.9) < 0.25 && Math.abs(qe.e - 6.4) < 0.3, `a new song skips its silent start and end (starts ${qe.s} s, ends ${qe.e} s; sound is 2–6 s)`);
  await sp(() => { SP.S.show.tracks = SP.S.show.tracks.filter(t => t.title !== 'Quiet Ends'); });

  // Live streaming (to a test file instead of a stream service)
  await sp(() => { SP.S.settings.stUrl = 'rtmp://example.invalid/live'; SP.S.settings.stKey = 'test'; SP.S.settings.stQ = '480'; });
  await sp(p => { SP.S.settings.stLogo = p; const t = SP.S.show.tracks.find(t => t.dance === 'Finale'); t.endAt = 0; t.startAt = 0; SP.stopNow(false); SP.cueNext(t.id); }, logoPng);
  await sleep(400); await sp(() => SP.go());
  await waitFor(() => SP.S.live.state === 'playing' && SP.active.track.dance === 'Finale');
  await sp(() => SP.streamStart());
  await sleep(6000);
  ok(await sp(() => { try { SP.streamer.canvas.toDataURL(); return true; } catch (err) { return false; } }), 'the stream picture with the studio logo can be sent (not blocked)');
  ok(await sp(() => { const im = new Image(); return new Promise(r => { im.onload = () => r(im.naturalWidth === 400); im.onerror = () => r(false); im.src = 'show://media/' + btoa(unescape(encodeURIComponent(SP.S.settings.stLogo))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }); }), 'the studio logo loads');
  ok((await win.textContent('#stText')).startsWith('LIVE'), `the top bar says LIVE while streaming (${await win.textContent('#stText')})`);
  await sp(() => SP.streamStop());
  await sleep(4500);
  let probe = '';
  // ffmpeg prints what's in the file (to its error output, then stops because no output was asked for)
  { const r = require('child_process').spawnSync(FFMPEG, ['-hide_banner', '-i', streamOut]); probe = ((String(r.stderr).match(/Stream #.*/g) || []).join(' ').match(/h264|aac|\b854x480\b/g) || []).join(' ') || 'could not read the stream file'; }
  ok(/h264/.test(probe) && /aac/.test(probe) && /854x480/.test(probe), `the stream has H.264 video at 480p and AAC sound (${probe})`);
  // the tone in the stream must be smooth: a clean sine never jumps, so every jump is a click or a gap
  const clicks = (() => {
    try {
      const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '1.5', '-t', '3', '-i', streamOut, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 26 });
      const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
      let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
      const d2 = []; for (let i = 1; i < x.length - 1; i++) d2.push(Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]));
      const typical = d2.slice().sort((a, b) => a - b)[Math.floor(d2.length * 0.99)];
      let n = 0, last = -1000; for (let i = 0; i < d2.length; i++) if (d2[i] > Math.max(typical * 6, 0.01) && i - last > 48) { n++; last = i; }
      return { n, samples: x.length, peak };
    } catch (err) { return { n: -1, err: err.message.slice(0, 100) }; }
  })();
  ok(clicks.n === 0 && clicks.samples === 144000 && clicks.peak > 0.05, `the stream's sound has no clicks or gaps (${JSON.stringify(clicks)})`);
  ok((await win.textContent('#stText')) === 'Stream', 'stopping the stream turns the indicator off');

  // Live system checks
  await sp(() => { SP.stopNow(false); });
  await win.click('#sysBox'); await win.waitForSelector('#dlgSys[open]');
  await waitFor(() => /Computer \d+%/.test(document.getElementById('syCpuT').textContent) && document.querySelectorAll('#syProcs tr').length >= 3 && document.querySelectorAll('#syCores i').length >= 1, null, 5000);
  ok(/of .* GB in use/.test(await win.textContent('#syRamT')) && (await win.textContent('#syProcs')).includes('Graphics'), `the System window shows CPU per core, memory and the app's parts (${(await win.textContent('#syCpuT')).slice(0, 60)})`);
  ok((await win.textContent('#syFacts')).includes('Sound engine') && (await win.textContent('#syFacts')).includes('running'), 'it shows the sound engine, disk, power and running time');
  await win.click('#dlgSys button[value=close]');
  ok(Math.abs((await sp(() => window.desk.selftestGpu())) - 42.75) < 0.01, 'graphics-card load is worked out correctly from the Windows counters (sample data)');
  // a song whose file disappears: flagged within seconds, and a failed automatic move doesn't loop
  const tB = path.join(media, 'Ghost Song.wav'); fs.copyFileSync(files[0], tB);
  await sp(async p => SP.addFiles(await window.desk.statMedia([p]), 'show', 1), tB);
  await waitFor(() => SP.queue() === 0 && SP.S.show.tracks[1].title === 'Ghost Song' && SP.S.show.tracks[1].an, null, 20000);
  await sp(() => { const [a, b] = SP.S.show.tracks; a.startAt = 0; a.endAt = 3; a.transition = 'straight'; b.startAt = 0; b.endAt = 0; SP.S.live.played = new Set(); SP.cueNext(a.id); });
  fs.renameSync(tB, tB + '.gone');
  await sleep(400); await sp(() => SP.go());
  await waitFor(() => SP.health.items.some(i => i.id.startsWith('file-')), null, 9000).catch(() => {});
  ok(await sp(() => SP.health.items.some(i => i.id.startsWith('file-')) && document.getElementById('sysHealth').classList.contains('bad')), 'a missing file for the next song is flagged in the top bar while the current song plays');
  await waitFor(() => SP.S.live.state === 'standby', null, 9000).catch(() => {});
  await sleep(1500);
  const logFile = path.join(tmp, 'data', 'logs', fs.readdirSync(path.join(tmp, 'data', 'logs'))[0]);
  const fails = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('start failed')).length;
  if (process.env.DEBUG_AUDIT) console.log('DEBUG', JSON.stringify(await sp(() => ({ st: SP.S.live.state, sb: SP.S.live.standbyId, failed: SP.S.live.failed, banners: [...document.querySelectorAll('.banner')].map(b => b.textContent.slice(0, 80)) }))), fs.readFileSync(logFile, 'utf8').split('\n').slice(-12).join('\n'));
  const preFails = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('preload failed')).length;
  ok(await sp(() => SP.S.live.state === 'standby' && !!document.querySelector('.banner')) && fails <= 2 && preFails <= 3, `when the next song can't load, the current one finishes, it stands by and says so, without retrying over and over (${fails} start attempt, ${preFails} preload attempt${preFails === 1 ? '' : 's'})`);
  fs.renameSync(tB + '.gone', tB);
  await waitFor(() => !SP.health.items.some(i => i.id.startsWith('file-')), null, 9000).catch(() => {});
  ok(await sp(() => !SP.health.items.some(i => i.id.startsWith('file-'))), 'when the file comes back, the warning clears by itself');
  await sp(() => { document.querySelectorAll('.banner').forEach(b => b.remove()); SP.S.live.failed = null; SP.S.show.tracks[0].endAt = 0; SP.S.live.standbyId = null; SP.S.live.state = 'idle'; SP.S.show.tracks.splice(1, 1); });

  // Video display test: which kinds of video this computer plays, and what preflight does about HEVC
  await waitFor(() => SP.videoCaps.avc !== null, null, 15000).catch(() => {});
  const caps = await sp(() => ({ avc: SP.videoCaps.avc, hevc: SP.videoCaps.hevc }));
  ok(caps.avc === true && typeof caps.hevc === 'boolean', `the video display test runs at start-up (H.264 ${caps.avc ? 'plays' : 'does not play'}, HEVC ${caps.hevc ? 'plays' : 'does not play'} on this machine)`);
  await sp(() => document.getElementById('bTest').click());
  await sp(() => document.getElementById('vtRun').click());
  await waitFor(() => /plays|couldn't/.test(document.getElementById('vtMsg').textContent), null, 15000).catch(() => {});
  ok(await sp(() => /Plays on this computer/.test(document.getElementById('vtAvcMsg').textContent) && /Plays|Can't play/.test(document.getElementById('vtHevcMsg').textContent)), 'Test & calibrate shows the result for each kind of video');
  await win.keyboard.press('Escape');
  const hevcFile = path.join(tmp, 'Phone clip.mp4');
  fs.copyFileSync(path.join(__dirname, '..', 'app', 'test-media', 'hevc.mp4'), hevcFile);
  await sp(async p => SP.addFiles(await window.desk.statMedia([p]), 'show'), hevcFile);
  await waitFor(() => SP.S.show.tracks.some(t => t.vcodec === 'hevc'), null, 15000).catch(() => {});
  ok(await sp(() => SP.S.show.tracks.some(t => t.vcodec === 'hevc') && SP.S.show.tracks.filter(t => t.vcodec === 'h264').length > 0), 'each video file is checked for the kind of video inside (HEVC and H.264 told apart)');
  await sp(() => { SP.videoCaps.hevc = true; });
  pf = await sp(() => SP.runPreflight());
  ok(!pf.items.some(i => /can't play/.test(i.title || '')) && await sp(() => document.getElementById('pfConvert').hidden), 'when the computer plays HEVC, preflight allows every video');
  await sp(() => { SP.videoCaps.hevc = false; });
  pf = await sp(() => SP.runPreflight());
  ok(pf.bad > 0 && pf.items.some(i => /Phone clip.*HEVC.*can't play/.test(i.title || '')) && pf.items.filter(i => /can't play/.test(i.title || '')).length === 1, 'when it plays H.264 only, preflight marks the HEVC video as unplayable (and only that one)');
  await sleep(400);
  ok(await sp(() => [...document.querySelectorAll('.badge')].some(b => b.textContent === "CAN'T PLAY") && !document.getElementById('pfConvert').hidden), 'the playlist row is marked and preflight offers to convert it');
  await sp(() => document.getElementById('pfConvert').click());
  await waitFor(() => SP.S.show.tracks.some(t => / \(H\.264\)\.mp4$/.test(t.path) && t.vcodec === 'h264' && t.duration > 0), null, 40000).catch(() => {});
  const conv = await sp(() => { const t = SP.S.show.tracks.find(t => / \(H\.264\)\.mp4$/.test(t.path)); return t ? { path: t.path, d: t.duration, bad: SP.cantShow(t) } : null; });
  ok(conv && fs.existsSync(conv.path) && fs.existsSync(hevcFile) && !conv.bad && conv.d > 0.5, 'Convert makes an H.264 copy, keeps the original and points the song at the copy');
  await sleep(1500);
  pf = await sp(() => SP.runPreflight());
  ok(!pf.items.some(i => /can't play/.test(i.title || '')), 'after converting, preflight no longer complains');
  await win.keyboard.press('Escape');
  await sp(() => { const i = SP.S.show.tracks.findIndex(t => / \(H\.264\)\.mp4$/.test(t.path)); if (i >= 0) SP.S.show.tracks.splice(i, 1); document.querySelectorAll('.banner').forEach(b => b.remove()); });

  // ---------- performance and show-day checks ----------
  // Stream encoders: the graphics-chip encoders are tried; the processor (x264) is always there as the fallback
  const encs = await sp(async () => { await SP.loadEncoders(); return SP.enc.list.map(e => e.id); });
  ok(encs[encs.length - 1] === 'libx264', `the stream's video encoders are checked with a test encode (${encs.join(', ')})`);
  // A graphics-chip encoder that fails: the stream falls back to the processor by itself and keeps going
  await sp(() => { SP.enc.list = [{ id: 'h264_nvenc', name: 'NVIDIA graphics (NVENC)' }, { id: 'libx264', name: 'Processor (x264)' }]; SP.enc.failed.clear(); SP.S.settings.stEnc = 'auto'; SP.S.settings.stQ = '720'; });
  await sp(() => { const t = SP.S.show.tracks.find(t => t.dance === 'Finale'); SP.stopNow(false); SP.cueNext(t.id); });
  await sleep(400); await sp(() => SP.go());
  await sp(() => SP.streamStart());
  await waitFor(() => SP.streamer.state.live && SP.streamer.state.encoder === 'libx264' && SP.streamer.state.health && SP.streamer.state.health.fps > 0 && SP.streamer.state.health.speed > 0, null, 25000).catch(() => {});
  const fb = await sp(() => ({ failed: [...SP.enc.failed], enc: SP.streamer.state.encoder, live: SP.streamer.state.live, h: SP.streamer.state.health, q: SP.streamer.state.quality }));
  ok(fb.failed.includes('h264_nvenc') && fb.enc === 'libx264' && fb.live, `when the graphics-chip encoder fails, the stream switches to the processor and carries on (${JSON.stringify({ failed: fb.failed, enc: fb.enc })})`);
  ok(fb.h && fb.h.fps > 0 && fb.q === '720', `the stream reports whether it's keeping up (${fb.h ? `${fb.h.speed}× · ${fb.h.fps} fps · ${fb.h.kbps} kb/s` : 'nothing'})`);
  await sp(() => SP.openSettings('stream')); await sleep(1300);
  ok(/Keeping up|Falling behind/.test(await win.textContent('#sStHealth')) && /x264|Processor/.test(await win.textContent('#sStHealth')), `Settings → Streaming shows the stream's health (${(await win.textContent('#sStHealth')).slice(0, 90)})`);
  await win.keyboard.press('Escape');
  // Can't keep up: it steps down a quality level and carries on
  await sp(() => SP.lowerQuality('test'));
  await waitFor(() => SP.streamer.state.live && SP.streamer.state.quality === '480', null, 15000).catch(() => {});
  ok(await sp(() => SP.streamer.state.live && SP.streamer.state.quality === '480' && !!document.querySelector('.banner[data-id=streamq]')), 'if the stream falls behind, it switches down to 480p by itself and says so');
  await sp(() => SP.streamStop());
  ok(await sp(() => SP.streamer.qOverride === null && SP.S.settings.stQ === '720'), 'the lower quality only lasts until the stream is stopped');
  await sp(() => SP.stopNow(false));
  await sleep(1500);
  // Internet speed test
  const spd = await sp(() => SP.runSpeedTest());
  ok(spd.upMbps > 0 && (got.speed || 0) > 2e6 && /Upload [\d.]+ Mbps/.test(await win.textContent('#sSpeedMsg')), `the internet speed test measures upload speed (${spd.upMbps} Mbps to the test server; ${(await win.textContent('#sSpeedMsg')).slice(0, 80)})`);
  ok(await sp(() => SP.recommendQ(10) === '1080' && SP.recommendQ(5) === '720' && SP.recommendQ(2.5) === '480' && SP.recommendQ(1) === null), 'it recommends a quality the connection can carry');
  // Sound dropouts: measured from the sound clock against the computer clock
  const gl = await sp(() => {
    const save = { base: SP.glitch.base, q: SP.glitch.quietUntil }; SP.glitch.base = null; SP.glitch.quietUntil = 0;
    const r = [SP.glitchStep(10.000, 5000, 1e9), SP.glitchStep(10.250, 5250, 1e9), SP.glitchStep(10.5, 5500.4, 1e9), SP.glitchStep(10.71, 5750, 1e9), SP.glitchStep(10.96, 6000, 1e9)];
    SP.glitch.base = null; SP.glitch.quietUntil = save.q;
    return { r, src: SP.glitch.src, count: SP.glitch.count };
  });
  ok(gl.r[0] === 0 && gl.r[1] === 0 && gl.r[2] === 0 && Math.abs(gl.r[3] - 40) < 1 && gl.r[4] === 0, `a 40 ms sound dropout is detected, and normal clock jitter isn't (${gl.r.map(x => Math.round(x)).join(', ')})`);
  ok(!!gl.src, `sound dropouts are being counted (${gl.src}; ${gl.count} so far in this test run)`);
  // Backup sound output: main output disappears → backup at once; back → switches back between songs
  await sp(() => {
    window.__real = { outputs: SP.E.outputs, setOutput: SP.E.setOutput }; window.__sink = null; window.__devs = ['default', 'usb', 'hp'];
    const names = { default: 'Default', usb: 'USB audio box', hp: 'Headphones' };
    SP.E.outputs = async () => window.__devs.map(id => ({ id, label: names[id] }));
    SP.E.setOutput = async id => { window.__sink = id; return true; };
    SP.S.settings.outputId = 'usb'; SP.S.settings.outBackup = 'hp'; SP.checkOutput.lost = false;
  });
  await sp(() => { window.__devs = ['default', 'hp']; return SP.checkOutput(); });
  ok(await sp(() => window.__sink === 'hp' && SP.checkOutput.lost && /backup: Headphones/.test((document.querySelector('.banner[data-id=output]') || {}).textContent || '')), 'when the main sound output disconnects, sound switches to the chosen backup and says so');
  await sp(() => SP.runHealth());
  ok(await sp(() => SP.health.items.some(i => i.id === 'output' && /backup/.test(i.text))), 'the health checks show it is on the backup');
  await sp(() => { window.__devs = ['default', 'usb', 'hp']; return SP.checkOutput(); });
  ok(await sp(() => window.__sink === 'usb' && !SP.checkOutput.lost), 'when it comes back between songs, it switches back by itself');
  await sp(() => { const t = SP.S.show.tracks.find(t => t.dance === 'Finale'); SP.stopNow(false); SP.cueNext(t.id); });
  await sleep(400); await sp(() => SP.go()); await waitFor(() => SP.S.live.state === 'playing');
  await sp(() => { window.__devs = ['default', 'hp']; return SP.checkOutput(); });
  await sp(() => { window.__devs = ['default', 'usb', 'hp']; return SP.checkOutput(); });
  ok(await sp(() => window.__sink === 'hp' && /Switch back now/.test((document.querySelector('.banner[data-id=output]') || {}).textContent || '')), 'mid-song it stays on the backup and offers to switch back');
  await sp(() => SP.stopNow(false));
  await waitFor(() => window.__sink === 'usb', null, 6000).catch(() => {});
  ok(await sp(() => window.__sink === 'usb' && !SP.checkOutput.lost), 'and switches back at the next pause between songs');
  // Preflight: backup, show-mode checks, drive speed, stream encoder and upload speed
  pf = await sp(() => SP.runPreflight());
  const pt = pf.items.map(i => i.title || '').join(' | ');
  ok(/Backup output: Headphones/.test(pt), 'preflight shows the backup output');
  ok(/Show files' drive: \d+ MB\/s|drive with the show files is slow/.test(pt), `preflight measures the speed of the drive with the show files (${(pt.match(/[^|]*drive[^|]*/) || [''])[0].trim()})`);
  ok(/Stream video encoding: /.test(pt) && /Upload speed [\d.]+ Mbps|needs about/.test(pt), 'preflight shows the stream encoder and the last upload speed test');
  ok(/dress rehearsal test hasn't been run/i.test(pt) && pf.items.some(i => i.action), 'preflight suggests the dress rehearsal test, with buttons to fix things');
  await win.keyboard.press('Escape');
  await sp(() => { SP.E.outputs = window.__real.outputs; SP.E.setOutput = window.__real.setOutput; SP.S.settings.outputId = ''; SP.S.settings.outBackup = 'default'; document.querySelectorAll('.banner').forEach(b => b.remove()); });
  // Dress rehearsal test: plays the start and end of every song with a practice stream, then reports
  await sp(() => { SP.S.show.tracks.forEach(t => { if (t.vcodec === 'hevc' || t.missing) t.enabled = false; }); SP.S.settings.stQ = '480'; SP.enc.failed.clear(); SP.enc.list = [{ id: 'libx264', name: 'Processor (x264)' }]; });
  const rBefore = await sp(() => ({ state: SP.S.live.state, standby: SP.S.live.standbyId, played: [...SP.S.live.played].sort().join(), n: SP.S.show.tracks.filter(t => t.enabled).length }));
  const statusBefore = got.status.length;
  await sp(() => { document.getElementById('pfReh').click(); });
  await sp(() => { document.getElementById('rhSeg').innerHTML += '<option value="2">2</option>'; document.getElementById('rhSeg').value = '2'; document.getElementById('rhVol').value = '-80'; document.getElementById('rhGo').click(); });
  await waitFor(() => SP.reh.running, null, 5000).catch(() => {});
  ok(await sp(() => SP.reh.running && SP.streamer.dry), 'the dress rehearsal test starts, with a practice stream that does not go online');
  await waitFor(() => !SP.reh.running, null, 240000).catch(() => {});
  const rh = await sp(() => ({ running: SP.reh.running, verdict: document.getElementById('rhVerdict').textContent, rows: [...document.querySelectorAll('#rhList li')].map(li => li.textContent), last: SP.S.settings.lastRehearsal, stream: SP.streamer.want }));
  console.log('INFO dress rehearsal:', rh.verdict, '\n  ' + rh.rows.join('\n  '));
  ok(!rh.running && /Ready|Not ready/.test(rh.verdict) && rh.last && rh.last.at > 0, `the test finishes with a verdict (${rh.verdict})`);
  ok(rh.rows.some(r => new RegExp(`All ${rBefore.n} songs started and finished`).test(r)), `every song in the show was started and finished (${(rh.rows[0] || '').slice(0, 90)})`);
  ok(rh.rows.some(r => /^.Processor: \d+%/.test(r)) && rh.rows.some(r => /Memory: at least/.test(r)) && rh.rows.some(r => /sound dropout|No sound dropouts/.test(r)) && rh.rows.some(r => /Screen pauses/.test(r)), 'the report covers processor, memory, screen pauses and sound dropouts');
  ok(rh.rows.some(r => /Video: \d+ of \d+ frames dropped/.test(r)) && rh.rows.some(r => /Stream \(480p, Processor \(x264\)\): kept up at [\d.]+×/.test(r)), 'it measures dropped video frames and whether the stream kept up');
  const rAfter = await sp(() => ({ state: SP.S.live.state, standby: SP.S.live.standbyId, played: [...SP.S.live.played].sort().join(), banners: [...document.querySelectorAll('.banner')].map(b => b.dataset.id) }));
  ok(rAfter.state === rBefore.state && rAfter.standby === rBefore.standby && rAfter.played === rBefore.played && !rh.stream && !rAfter.banners.some(b => /^play-/.test(b)), `afterwards the show is back exactly where it was (${rAfter.state}, practice stream off)`);
  ok(got.status.length === statusBefore || got.status.slice(statusBefore).length <= 1, `phones were not told about the test songs (${got.status.length - statusBefore} status update${got.status.length - statusBefore === 1 ? '' : 's'}, from the reset at the end)`);
  await win.keyboard.press('Escape');
  pf = await sp(() => SP.runPreflight());
  ok(pf.items.some(i => /^Dress rehearsal test: /.test(i.title || '')), 'preflight remembers the last dress rehearsal result');
  await win.keyboard.press('Escape');

  // Crash the page during a song: it reloads and carries on
  await sp(() => { const t = SP.S.show.tracks.find(t => t.dance === 'Hip Hop Crew'); t.endAt = 0; SP.S.live.state = 'standby'; SP.stopNow(false); SP.cueNext(t.id); });
  await sleep(300);
  await sp(() => SP.go());
  await waitFor(() => SP.S.live.state === 'playing');
  await sleep(1500);
  const before = await sp(() => ({ id: SP.S.live.currentId, t: SP.active.time }));
  await app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 50); });
  // Playwright can't follow a page through a crash, so ask the window directly from the main process.
  const inPage = js => Promise.race([app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code), js).catch(() => null), sleep(1500).then(() => null)]);
  let afterCrash = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    afterCrash = await inPage('window.SP && SP.S.live.state === "playing" && SP.active ? { id: SP.S.live.currentId, t: SP.active.time, banner: !!document.querySelector(".banner[data-id=recovered]") } : null');
    if (afterCrash) break;
  }
  ok(afterCrash && afterCrash.id === before.id && afterCrash.t > before.t, `after a crash the page reloads and carries on (${before.t.toFixed(1)} s → ${afterCrash ? afterCrash.t.toFixed(1) : '?'} s)`);
  ok(afterCrash && afterCrash.banner, 'a banner says it carried on');

  // Screenshot for the README
  const shots = process.env.SHOTS;
  if (shots) {
    await inPage(`(() => { const t = SP.S.show.tracks.find(t => t.dance === 'Hip Hop Crew'); t.cues = [{ id: 'x1', t: 3, type: 'light', text: 'LX 22 go' }, { id: 'x2', t: 7.5, type: 'prop', text: 'Crew strike chairs' }]; t.props = [{ id: 'q', text: 'Boombox DSR' }]; SP.S.selectedId = t.id; return 1; })()`);
    await sleep(1200);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(shots, 'show-player.png'), Buffer.from(png, 'base64'));
  }

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await app.evaluate(({ app }) => { app.forceQuit = true; });
  await app.close().catch(() => {});
  wp.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch(err => { console.error(err); process.exit(1); });
