// End to end: the real Recital Show Player publishes a show to the Recital Live plugin (running on the PHP
// stand-in for WordPress), and a phone-sized browser opens the show's page. Checks that what the phone shows
// matches the desk: dance, timers, up next, cues with countdowns, props, messages, intermission, order changes.
// Needs php, ffmpeg and (on Linux) xvfb-run:   xvfb-run -a node wordpress-plugin/test/recital-live-desk-test.js
const { chromium, _electron: electron } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..', '..');
const KEY = 'deskdeskdeskdeskdeskdeskdeskdesk';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const secs = txt => { const m = /(\d+):(\d+)(?::(\d+))?/.exec(txt || ''); if (!m) return NaN; return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-desk-'));
  // the stand-in WordPress with one show: crew code STAGE
  const db = path.join(tmp, 'db.json');
  fs.writeFileSync(db, JSON.stringify({ options: {}, posts: [{ ID: 1, post_type: 'recital_show', post_name: 'spring-2027', post_title: 'Spring Recital 2027', post_status: 'publish' }], meta: { 1: { _rl_key: KEY, _rl_crew_code: 'STAGE', _rl_listed: '1' } } }));
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const php = spawn('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=-1', '-S', `127.0.0.1:${port}`, path.join(__dirname, 'recital-live-harness.php')], { env: { ...process.env, RL_DB: db, PHP_CLI_SERVER_WORKERS: '4' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let phpLog = ''; php.stderr.on('data', d => { phpLog += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/wp-json/recital-live/v1/ping')).ok) break; } catch (_) {} await sleep(100); }

  // three songs
  const names = [['Rise Up', 'Senior Jazz', 'Jazz 4'], ['Hallelujah', 'Senior Lyrical', 'Lyrical 3'], ['Happy Feet', 'Tiny Tots Tap', 'Tap 1']];
  const files = names.map(([t], i) => { const f = path.join(tmp, `${t}.wav`); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${330 + i * 80}:duration=${[30, 40, 50][i]}`, '-af', 'volume=10dB', f]); return f; });

  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(root, 'show-player'), '--no-sandbox', `--user-data-dir=${path.join(tmp, 'p')}`], env: { ...process.env, SHOW_PLAYER_DATA: path.join(tmp, 'd') } });
  const win = await app.firstWindow();
  const errs = []; win.on('pageerror', e => errs.push('desk: ' + e.message));
  await win.waitForFunction(() => window.SP);
  await win.evaluate(async p => SP.addFiles(await window.desk.statMedia(p), 'show'), files);
  await win.waitForFunction(() => SP.queue() === 0 && SP.S.show.tracks.every(t => t.an), null, { timeout: 60000 });
  const code = Buffer.from(JSON.stringify({ url: base, show: 'spring-2027', key: KEY })).toString('base64');
  await win.evaluate(([n, code]) => {
    SP.S.show.name = 'Spring Recital 2027';
    SP.S.show.tracks.forEach((t, i) => { t.title = n[i][0]; t.dance = n[i][1]; t.cls = n[i][2]; t.transition = 'stop'; t.startAt = 0; t.endAt = 0; });
    const [a, b, c] = SP.S.show.tracks;
    a.startAt = 2; // the song starts 2 s into the file: phone times must be measured from there
    a.cues = [{ id: 'c1', t: 6, type: 'light', text: 'LX 12 go' }, { id: 'c2', t: 22, type: 'spot', text: 'Spot 1 pick up Ava' }];
    a.props = [{ id: 'p1', text: '2 chairs SL' }];
    b.props = [{ id: 'p2', text: 'Secret prop' }]; b.showProps = false;
    b.cues = [{ id: 'c3', t: 5, type: 'prop', text: 'Crew: bench on' }];
    SP.S.settings.wpCode = code; SP.S.settings.wpOn = true;
    SP.cueNext(a.id);
  }, [names, code]);
  await win.click('#bSettings'); await win.click('.set-tab[data-pane=phones]');
  await win.fill('#sWpCode', code); await win.dispatchEvent('#sWpCode', 'change'); await win.check('#sWpOn');
  await win.click('#sWpTest');
  await win.waitForFunction(() => /Connected/.test(document.getElementById('sWpMsg').textContent), null, { timeout: 8000 });
  ok(true, 'the desk connects to the site with the connection code');
  await win.click('#dlgSettings button[value=close]');

  const browser = await chromium.launch();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.on('pageerror', e => errs.push('phone: ' + e.message));
  await phone.goto(base + '/recital/spring-2027/');
  // a parent's phone: no crew code. Count what it asks the site for.
  const parent = await browser.newPage({ viewport: { width: 390, height: 844 } });
  parent.on('pageerror', e => errs.push('parent phone: ' + e.message));
  const asked = { wordpress: 0, file: 0 };
  parent.on('request', r => { const u = r.url(); if (u.includes('/wp-json/recital-live/v1/shows/spring-2027')) asked.wordpress++; else if (u.includes('/wp-content/uploads/recital-live/')) asked.file++; });
  await parent.goto(base + '/recital/spring-2027/');
  const text = id => phone.textContent('#' + id);
  const until = (fn, arg, timeout = 9000) => phone.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

  // standing by, before the show
  ok(await until(() => document.getElementById('nowDance').textContent === 'Senior Jazz' && /Standing by/.test(document.getElementById('state').textContent)), `before GO the phone shows the first dance standing by (${await text('state')}: ${await text('nowDance')})`);
  ok((await phone.$$('#programList > li')).length === 3, 'the running order has all three numbers');

  // GO
  await win.evaluate(() => SP.go());
  await win.waitForFunction(() => SP.S.live.state === 'playing');
  ok(await until(() => /Playing/.test(document.getElementById('state').textContent)), 'after GO the phone says Playing');
  await sleep(2500);
  const d1 = await win.evaluate(() => ({ el: SP.active.time - 2, left: 30 - SP.active.time, show: SP.showRemaining() }));
  const p1 = { el: secs(await text('elapsed')), left: secs(await text('remaining')), show: secs(await text('showLeft')) };
  ok(Math.abs(p1.el - d1.el) <= 2 && Math.abs(p1.left - d1.left) <= 2, `played and left match the desk within 2 s (phone ${p1.el}/${p1.left} s, desk ${d1.el.toFixed(1)}/${d1.left.toFixed(1)} s)`);
  ok(Math.abs(p1.show - d1.show) <= 3, `show time left matches (phone ${p1.show} s, desk ${Math.round(d1.show)} s)`);
  ok((await text('nowTitle')).includes('Rise Up') && (await text('nowClass')).includes('Jazz 4') && (await text('nowNum')).includes('#1 of 3'), 'song title, class and number show');
  ok((await text('nextDance')).includes('Senior Lyrical'), 'Up next shows the next dance');
  const a1 = secs(await text('elapsed')); await sleep(2000); const a2 = secs(await text('elapsed'));
  ok(a2 - a1 >= 1 && a2 - a1 <= 3, `the phone's timer keeps counting between updates (${a1} → ${a2} s)`);

  // public viewers don't get cues or props
  ok(!(await phone.isVisible('#cues')) && !(await phone.isVisible('#props')), 'without the crew code, cues and props are hidden');
  await phone.fill('#crewCode', 'STAGE'); await phone.keyboard.press('Enter');
  ok(await until(() => document.getElementById('cues').offsetParent !== null && /LX 12 go/.test(document.getElementById('cueNow').textContent), null, 12000), 'with the crew code, the cue that has fired shows as the current cue');
  const dn = await win.evaluate(() => 22 - SP.active.time);
  const pn = secs(await text('cueIn'));
  ok((await text('cueNext')).includes('Spot 1 pick up Ava') && Math.abs(pn - dn) <= 2, `the next cue and its countdown match the desk (phone in ${pn} s, desk in ${dn.toFixed(1)} s)`);
  ok((await text('propsNow')).includes('2 chairs SL'), "this number's props show");
  ok(!(await text('propsNext')).includes('Secret prop') && !(await phone.content()).includes('Secret prop'), 'props hidden on the desk are never sent to phones');

  // the parent's phone reads the small public file, not WordPress, and the file holds nothing for crew only
  await sleep(1500);
  const pe = secs(await parent.textContent('#elapsed')), de = await win.evaluate(() => SP.active.time - 2);
  ok(/Playing/.test(await parent.textContent('#state')) && Math.abs(pe - de) <= 2, `a parent's phone (no crew code) shows the same time as the desk (${pe} s, desk ${de.toFixed(1)} s)`);
  ok(asked.file >= 4 && asked.wordpress <= 2, `it reads the small public file, not WordPress (${asked.file} file reads, ${asked.wordpress} WordPress request${asked.wordpress === 1 ? '' : 's'} so far)`);
  const pub = await (await fetch(base + '/wp-content/uploads/recital-live/spring-2027.json')).text();
  ok(pub.includes('Senior Jazz') && !pub.includes('LX 12 go') && !pub.includes('2 chairs SL') && !pub.includes('Spot 1') && !pub.includes(KEY), 'the public file has the running order but no cues, props or keys');
  ok(!(await parent.isVisible('#cues')) && !(await parent.isVisible('#props')), "the parent's phone shows no cues or props");

  // message + intermission countdown
  await win.fill('#phoneMsg', 'Please silence your phones'); await sleep(200);
  ok(await until(() => /Please silence your phones/.test(document.getElementById('msgText').textContent)), 'a message typed on the desk appears on the phone');
  await win.fill('#phoneMsg', '');

  // pause
  await win.evaluate(() => SP.pause());
  ok(await until(() => /Paused/.test(document.getElementById('state').textContent)), 'Pause shows on the phone');
  const q1 = secs(await text('elapsed')); await sleep(2200); const q2 = secs(await text('elapsed'));
  ok(q2 === q1, 'the timer stops while paused');
  await win.evaluate(() => SP.pause());

  // reorder on the desk: Tiny Tots Tap moves up to second
  await win.evaluate(() => { document.activeElement.blur(); SP.S.selectedId = SP.S.show.tracks[2].id; });
  await win.keyboard.press('Alt+ArrowUp'); // the same as dragging the third song up one place
  ok(await until(() => /Tiny Tots Tap/.test(document.getElementById('nextDance').textContent) && /Tiny Tots Tap/.test(document.querySelectorAll('#programList > li')[1].textContent), null, 12000), 'changing the order on the desk updates Up next and the running order on the phone');

  // fade out: stands by on the next number
  await win.evaluate(() => { SP.S.settings.fadeOutSec = 0.5; SP.fadeOut(); });
  await win.waitForFunction(() => SP.S.live.state === 'standby', null, { timeout: 8000 });
  ok(await until(() => /Standing by/.test(document.getElementById('state').textContent) && document.getElementById('nowDance').textContent === 'Tiny Tots Tap'), 'when the song ends, the phone shows the next dance standing by');
  ok(await until(() => document.querySelector('#programList > li').className.includes('done')), 'the finished number is dimmed in the running order');

  // intermission timer
  await win.fill('#intMin', '10'); await win.click('#intGo');
  ok(await until(() => /Intermission/.test(document.getElementById('nowDance').textContent) && document.getElementById('countdownWrap').offsetParent !== null), 'starting the intermission timer shows Intermission and a countdown on the phone');
  const cd = secs(await text('countdown'));
  ok(cd > 570 && cd <= 600, `the intermission countdown is right (${cd} s of 600)`);
  await win.click('#intGo');

  // the site stops answering: the desk carries on and says so; then recovers
  php.kill(); await sleep(300);
  await win.evaluate(() => SP.go());
  await win.waitForFunction(() => SP.S.live.state === 'playing', null, { timeout: 8000 });
  ok(true, 'with the website down, GO still starts the song at once');
  ok(await win.waitForFunction(() => /retrying|not connected|last sent/.test(document.getElementById('wpText').textContent), null, { timeout: 20000 }).then(() => true, () => false), `the desk shows that phones aren't updating (${await win.textContent('#wpText')})`);
  ok(await until(() => /Last update|Offline/i.test(document.getElementById('connText').textContent), null, 20000), `the phone says its information is old (${await text('connText')})`);

  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  const warnings = phpLog.split('\n').filter(l => /Warning|Notice|Deprecated|Fatal/.test(l));
  ok(warnings.length === 0, 'PHP printed no warnings' + (warnings.length ? ': ' + warnings.slice(0, 3).join(' | ') : ''));
  if (process.env.SHOTS) await phone.screenshot({ path: path.join(process.env.SHOTS, 'phone-live.png') });
  await browser.close();
  await app.evaluate(({ app }) => { app.forceQuit = true; });
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch(err => { console.error(err); process.exit(1); });
