// End-to-end test: launches the real Recital Show Player, adds generated songs and a video,
// and checks loudness evening-out, GO / wait, straight on, crossfade, fade to next, cues,
// hot sounds with ducking, pre-show music, drag to reorder, preflight, saving and opening,
// sending status to a stand-in WordPress site, and carrying on after the page crashes.
// Needs ffmpeg. Run: npm test   (on Linux: xvfb-run npm test)
const { _electron: electron } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showplayer-'));
  const media = path.join(tmp, 'media'); fs.mkdirSync(media);
  const ff = (name, args) => { const out = path.join(media, name); execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, out]); return out; };
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
  const logoPng = path.join(media, 'Studio Logo.png'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=#E8508A:s=400x160:d=1', '-frames:v', '1', logoPng]);
  const longVideo = ff('Long Video.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=20', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);

  // Stand-in WordPress site: records what the desk sends.
  const got = { program: [], status: [], badKey: 0 };
  const wp = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
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
    env: { ...process.env, SHOW_PLAYER_DATA: path.join(tmp, 'data'), SHOW_PLAYER_MAXIMIZE: '1', SHOW_PLAYER_STREAM_OUT: streamOut }
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
  await win.click('#bVideo'); await win.waitForSelector('#dlgVideo[open] .screen'); await win.click('#vClose'); await sleep(800); await win.click('#dlgVideo button[value=close]');
  await sp(() => { SP.S.show.tracks = SP.S.show.tracks.filter(t => t.title !== 'Long Video'); });

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
  try { probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', streamOut]).toString().trim().replace(/\s+/g, ' '); } catch (err) { probe = 'ffprobe failed: ' + err.message.slice(0, 120); }
  ok(/h264/.test(probe) && /aac/.test(probe) && /854/.test(probe), `the stream has H.264 video at 480p and AAC sound (${probe})`);
  // the tone in the stream must be smooth: a clean sine never jumps, so every jump is a click or a gap
  const clicks = (() => {
    try {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1.5', '-t', '3', '-i', streamOut, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 26 });
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
