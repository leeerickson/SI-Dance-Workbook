// Tests the Recital Live plugin: the REST API from PROTOCOL.md and the phone page in a browser.
//   Local (PHP stand-in for WordPress):  node wordpress-plugin/test/recital-live-test.js
//   Real WordPress site (shows made by the workflow, see .github/workflows/recital-live-plugin.yml):
//     WP_URL=http://localhost:8888 RL_KEY=<spring-2027 desktop key> RL_DRAFT_KEY=<draft-show key> node wordpress-plugin/test/recital-live-test.js
// Screenshots: SHOTS=<folder> (also writes recital-live-phone.png to SHOT_FILE if set).
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const KEY = process.env.RL_KEY || 'k3yK3yk3yK3yk3yK3yk3yK3yk3yK3y12';
const DRAFT_KEY = process.env.RL_DRAFT_KEY || 'draftdraftdraftdraftdraftdraft12';
const SHOT_FILE = process.env.SHOT_FILE || '';
const SHOTS = process.env.SHOTS || '';

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const program = {
  show: 'Spring Recital 2027',
  updated: 1767225600000,
  tracks: [
    { id: 't1', n: 1, title: 'Twinkle Toes', dance: 'Tiny Tots Ballet', class: 'Pre-Ballet', duration: 125, type: 'audio', transition: 'stop', notes: 'Bring the tiny tots from Room 2', cues: [{ t: 2, type: 'light', text: 'LX 3 go' }] },
    { id: 't2', n: 2, title: 'Shake It Off', dance: 'Junior Hip Hop', class: 'Hip Hop 1', duration: 150, type: 'audio', transition: 'stop' },
    { id: 't3', n: 3, title: 'Moon River', dance: 'Lyrical Duet', class: 'Lyrical 3', duration: 180, type: 'audio', transition: 'straight' },
    {
      id: 't4', n: 4, title: 'Rise Up', dance: 'Senior Jazz', class: 'Jazz 4', duration: 192.4, type: 'audio', transition: 'stop',
      notes: 'Teacher: Ms Kim — quote "test" \\ backslash', show_props: true, props: ['2 chairs SL', 'Red umbrella'],
      cues: [
        { t: 12, type: 'light', text: 'LX 14 go' },
        { t: 40, type: 'light', text: 'LX 22 go' },
        { t: 58.5, type: 'spot', text: 'Spot 1 pick up Ava DSL' },
        { t: 70, type: 'sound', text: 'Thunder SFX' },
        { t: 95, type: 'light', text: 'LX 23 go' },
        { t: 120, type: 'prop', text: 'Strike umbrella' },
        { t: 150, type: 'stage', text: 'Fly in star drop' },
        { t: 180, type: 'note', text: 'Bows' },
      ],
    },
    { id: 't5', n: 5, title: 'Hallelujah', dance: 'Senior Lyrical', class: 'Lyrical 5', duration: 210, type: 'audio', transition: 'crossfade', show_props: true, props: ['Bench CS'], cues: [{ t: 5, type: 'light', text: 'LX 30 go' }] },
    { id: 't6', n: 6, title: '<img src=x onerror="window.__xss=1">', dance: 'Finale & Bows <b>bold</b>', class: 'Everyone', duration: 240, type: 'audio', transition: 'stop' },
  ],
};

const playing = position => ({
  state: 'playing', sent_at: Date.now(), index: 3, track_id: 't4', position, duration: 192.4, rate: 1,
  show_remaining: 900, next_track_id: 't5',
  cue: { t: 40, type: 'light', text: 'LX 22 go' },
  next_cue: { t: 58.5, type: 'spot', text: 'Spot 1 pick up Ava DSL' },
  upcoming_cues: [{ t: 58.5, type: 'spot', text: 'Spot 1 pick up Ava DSL' }, { t: 70, type: 'sound', text: 'Thunder SFX' }, { t: 95, type: 'light', text: 'LX 23 go' }],
  props: ['2 chairs SL', 'Red umbrella'],
  message: 'Please silence your phones',
});

function freePort() {
  return new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function startHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recital-live-'));
  const db = path.join(dir, 'db.json');
  const show = (ID, post_name, post_title, post_status = 'publish') => ({ ID, post_type: 'recital_show', post_name, post_title, post_status });
  fs.writeFileSync(db, JSON.stringify({
    options: {},
    posts: [
      show(1, 'spring-2027', 'Spring Recital 2027'),
      show(2, 'winter-2026', 'Winter Showcase 2026'),
      show(3, 'secret-show', 'Secret Rehearsal'),
      show(4, 'draft-show', 'Draft Show', 'draft'),
      { ID: 5, post_type: 'page', post_name: 'about', post_title: 'About', post_status: 'publish' },
    ],
    meta: {
      1: { _rl_key: KEY, _rl_crew_code: 'STAGE', _rl_listed: '1' },
      2: { _rl_key: 'winterwinterwinterwinterwinter12' },
      3: { _rl_key: 'secretsecretsecretsecretsecret12', _rl_listed: '0' },
      4: { _rl_key: DRAFT_KEY },
    },
  }));
  const port = await freePort();
  const php = spawn('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=-1', '-S', `127.0.0.1:${port}`, path.join(__dirname, 'recital-live-harness.php')], {
    env: { ...process.env, RL_DB: db, PHP_CLI_SERVER_WORKERS: '4' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = ''; php.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/wp-json/recital-live/v1/ping'); if (r.ok) break; } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  return { base, php, log: () => log, dir };
}

const api = base => base + '/wp-json/recital-live/v1';

async function post(base, slug, what, body, key = KEY) {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== null) headers['X-Recital-Key'] = key;
  const r = await fetch(`${api(base)}/shows/${slug}/${what}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json };
}
async function get(base, p, headers = {}) {
  const r = await fetch(api(base) + p, { headers });
  let json = null; try { json = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json, headers: r.headers };
}

async function apiTests(base, harness) {
  const ping = await get(base, '/ping');
  ok(ping.status === 200 && ping.json.ok === true && ping.json.plugin === 'recital-live' && typeof ping.json.version === 'string' && typeof ping.json.server_now === 'number', 'GET /ping answers with ok, plugin, version and server_now');

  let r = await post(base, 'spring-2027', 'program', program, 'wrong-key-wrong-key-wrong-key-00');
  ok(r.status === 403 && r.json && r.json.code === 'recital_bad_key', 'POST program with the wrong key → 403 recital_bad_key');
  r = await post(base, 'spring-2027', 'status', playing(1), null);
  ok(r.status === 403 && r.json && r.json.code === 'recital_bad_key', 'POST status with no key → 403 recital_bad_key');
  r = await post(base, 'no-such-show', 'status', playing(1));
  ok(r.status === 404, 'POST to an unknown show → 404');
  r = await post(base, 'spring-2027', 'program', '[1,2,3]');
  ok(r.status === 400, 'POST program that is not a JSON object → 400');
  r = await post(base, 'spring-2027', 'program', 'not json at all');
  ok(r.status === 400, 'POST program that is not JSON → 400');
  r = await post(base, 'spring-2027', 'program', JSON.stringify({ show: 'x', pad: 'a'.repeat(530 * 1024) }));
  ok(r.status === 413, 'POST program over 512 KB → 413');

  r = await post(base, 'spring-2027', 'program', program);
  ok(r.status === 200 && r.json.ok === true && typeof r.json.server_now === 'number', 'POST program with the right key → ok + server_now');
  const before = Date.now();
  r = await post(base, 'spring-2027', 'status', playing(41.2));
  ok(r.status === 200 && r.json.ok === true && typeof r.json.server_now === 'number', 'POST status with the right key → ok + server_now');
  r = await post(base, 'draft-show', 'status', { state: 'idle' }, DRAFT_KEY);
  ok(r.status === 200, 'the desk can send to a show that is still a draft');

  const pub = await get(base, '/shows/spring-2027');
  const cc = pub.headers.get('cache-control') || '';
  ok(pub.status === 200 && /no-store/.test(cc), `GET show sends Cache-Control: no-store (${cc})`);
  ok(pub.json.show && pub.json.show.slug === 'spring-2027' && pub.json.show.title === 'Spring Recital 2027' && pub.json.show.has_code === true, 'GET show has show {slug, title, has_code}');
  ok(pub.json.crew === false, 'no crew code given → crew:false');
  const t4 = pub.json.program.tracks[3];
  ok(pub.json.program.tracks.length === 6 && t4.title === 'Rise Up' && !('cues' in t4) && !('props' in t4) && !('notes' in t4) && !('notes' in pub.json.program.tracks[0]), 'not crew: cues, props and notes are removed from every track');
  const s = pub.json.status;
  ok(s && s.state === 'playing' && !('cue' in s) && !('next_cue' in s) && !('upcoming_cues' in s) && !('props' in s) && s.message === 'Please silence your phones' && s.show_remaining === 900, 'not crew: cue, next_cue, upcoming_cues and props are removed from the status, the rest is kept');
  ok(typeof pub.json.received_at === 'number' && pub.json.received_at >= before - 5000 && pub.json.server_now >= pub.json.received_at, 'received_at is server time in ms, server_now is after it');

  const crew = await get(base, '/shows/spring-2027', { 'X-Recital-Code': ' stage ' });
  ok(crew.json.crew === true && crew.json.program.tracks[3].cues.length === 8 && crew.json.status.next_cue.text === 'Spot 1 pick up Ava DSL' && crew.json.status.props.length === 2, 'crew code in X-Recital-Code (any case, spaces trimmed) → crew:true with cues and props');
  ok(crew.json.program.tracks[3].notes === program.tracks[3].notes, 'quotes, dashes and backslashes in the program come back exactly');
  const crewQ = await get(base, '/shows/spring-2027?code=STAGE');
  ok(crewQ.json.crew === true && Array.isArray(crewQ.json.status.upcoming_cues), 'crew code as ?code= also works');
  const wrong = await get(base, '/shows/spring-2027', { 'X-Recital-Code': 'nope' });
  ok(wrong.json.crew === false && !('cues' in wrong.json.program.tracks[3]), 'wrong crew code → crew:false, no cues');
  const winter = await get(base, '/shows/winter-2026');
  ok(winter.status === 200 && winter.json.crew === true && winter.json.show.has_code === false && winter.json.program === null && winter.json.status === null && winter.json.received_at === null, 'show without a crew code: everyone is crew; nothing sent yet → program/status/received_at null');
  ok((await get(base, '/shows/draft-show')).status === 404, 'a draft show is not readable (404)');
  ok((await get(base, '/shows/nothing-here')).status === 404, 'unknown show → 404');

  const list = await get(base, '/shows');
  const slugs = (list.json.shows || []).map(x => x.slug);
  ok(list.status === 200 && slugs.includes('spring-2027') && slugs.includes('winter-2026') && !slugs.includes('secret-show') && !slugs.includes('draft-show'), `GET /shows lists listed, published shows only (${slugs.join(', ')})`);
  const sp = list.json.shows.find(x => x.slug === 'spring-2027');
  ok(sp && sp.title === 'Spring Recital 2027' && /\/recital\/spring-2027\/$/.test(sp.url), 'each listed show has {slug, title, url}');

  const pr = await fetch(base + '/?rest_route=/recital-live/v1/shows/spring-2027');
  ok(pr.status === 200 && (await pr.json()).show.slug === 'spring-2027', 'the API also works with ?rest_route= (sites without pretty permalinks)');

  // Manifest, service worker, pages
  const man = await fetch(base + '/recital/spring-2027/manifest.webmanifest');
  const mj = await man.json();
  ok(man.status === 200 && /manifest\+json/.test(man.headers.get('content-type')) && mj.name === 'Spring Recital 2027' && /\/recital\/spring-2027\/$/.test(mj.start_url) && /\/recital\/spring-2027\/$/.test(mj.scope) && mj.display === 'standalone', 'manifest: show name, start_url and scope /recital/{slug}/, standalone');
  const icon = mj.icons.find(i => i.sizes === '512x512');
  const ir = await fetch(new URL(icon.src, base));
  ok(ir.status === 200 && /png/.test(ir.headers.get('content-type')) && mj.icons.some(i => i.sizes === '192x192'), 'manifest icons (192 and 512 PNG) are served');
  const sw = await fetch(base + '/recital/sw.js');
  const swText = await sw.text();
  ok(sw.status === 200 && /javascript/.test(sw.headers.get('content-type')) && !swText.includes('__RL_') && swText.includes('app.js'), '/recital/sw.js is served with the page files filled in');
  const swFile = path.join(os.tmpdir(), `rl-sw-${process.pid}.js`); fs.writeFileSync(swFile, swText);
  let swOk = true; try { execFileSync(process.execPath, ['--check', swFile], { stdio: 'pipe' }); } catch (e) { swOk = false; } fs.unlinkSync(swFile);
  ok(swOk, 'the served service worker is valid JavaScript');
  const page = await fetch(base + '/recital/spring-2027/');
  const html = await page.text();
  ok(page.status === 200 && html.includes('<title>Spring Recital 2027</title>') && html.includes('manifest.webmanifest') && !html.includes('wp-content/themes'), '/recital/{slug}/ serves the standalone phone page');
  ok((await fetch(base + '/recital/nothing-here/')).status === 404, 'phone page for an unknown show → 404');
  if (harness) {
    ok((await fetch(base + '/?recital_show=spring-2027')).status === 200, '?recital_show=slug works without pretty permalinks');
    const fm = await fetch(base + '/?recital_manifest=spring-2027');
    ok(fm.status === 200 && (await fm.json()).name === 'Spring Recital 2027', '?recital_manifest=slug works');
    const fs2 = await fetch(base + '/?recital_sw=1');
    ok(fs2.status === 200 && (await fs2.text()).includes("'recital-live-'") && /javascript/.test(fs2.headers.get('content-type')), '?recital_sw=1 works');
    ok((await fetch(base + '/some-other-page/')).status === 404, 'other addresses are left to WordPress');

    const sc = await (await fetch(base + '/__shortcode?show=spring-2027')).text();
    ok(/<iframe class="recital-live-frame" src="http:\/\/127\.0\.0\.1:\d+\/recital\/spring-2027\/"[^>]*height:700px/.test(sc), '[recital_live show="spring-2027" height="700"] embeds the phone page');
    const adm = await (await fetch(base + '/__admin?id=1')).text();
    const code = (/id="rl_connection"[^>]*>([^<]+)</.exec(adm) || [])[1] || '';
    let decoded = {}; try { decoded = JSON.parse(Buffer.from(code, 'base64').toString('utf8')); } catch (e) { /* bad code */ }
    ok(decoded.url === base && decoded.show === 'spring-2027' && decoded.key === KEY, 'connection code is base64 of {url, show, key}');
    ok(/Last update from the desk<\/th>\s*<td>\d+ seconds? ago<\/td>/.test(adm) && adm.includes('href="' + base + '/recital/spring-2027/"'), 'settings box shows the phone link and "N seconds ago"');
    const adm2 = await (await fetch(base + '/__admin?id=2')).text();
    ok(/Last update from the desk<\/th>\s*<td>Never<\/td>/.test(adm2), 'settings box says "Never" before the desk has sent anything');
  }
}

async function pageTests(base) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const url = base + '/recital/spring-2027/';
  const text = sel => page.locator(sel).textContent();
  const secs = s => { const m = /(-?)(\d+):(\d\d)/.exec(s || ''); return m ? (+m[2] * 60 + +m[3]) : NaN; };

  // Clock correction: the status was sent 3 s before the phone opens the page.
  await post(base, 'spring-2027', 'status', playing(41.2));
  await sleep(3000);
  await page.goto(url);
  await page.locator('#nowDance').filter({ hasText: 'Senior Jazz' }).waitFor({ timeout: 10000 });
  const e0 = secs(await text('#elapsed'));
  ok(e0 >= 44 && e0 <= 47, `timers include how old the status is (elapsed ${await text('#elapsed')}, sent at 0:41 three seconds ago)`);
  ok((await text('#nowNum')) === '#4 of 6' && (await text('#nowTitle')) === 'Rise Up' && (await text('#nowClass')) === 'Jazz 4', 'NOW card: dance, track title, class, #4 of 6');
  ok((await text('#state')) === 'Playing', 'state label says Playing');
  const r0 = secs(await text('#remaining'));
  await sleep(2100);
  const e1 = secs(await text('#elapsed')), r1 = secs(await text('#remaining'));
  ok(e1 - e0 >= 1 && e1 - e0 <= 4 && r0 - r1 >= 1, `elapsed counts up and remaining counts down (${e0}→${e1}, ${r0}→${r1})`);
  ok((await text('#nextDance')) === 'Senior Lyrical' && (await text('#nextTitle')) === 'Hallelujah', 'UP NEXT shows the next dance and title');
  ok(/^\d+:\d\d$/.test(await text('#showLeft')) && secs(await text('#showLeft')) < 900, `whole show time left counts down (${await text('#showLeft')})`);
  ok((await text('#msgText')) === 'Please silence your phones' && await page.locator('#banner').isVisible(), 'message from the desk shows in the banner');
  ok((await text('#connText')) === 'Live', 'connection light says Live');
  ok(!(await page.locator('#cues').isVisible()) && !(await page.locator('#props').isVisible()), 'no crew code: cues and props are hidden');
  ok(await page.locator('#crewBox').isVisible() && (await text('#crewBox label')).includes('Crew? Enter the code'), 'crew code box is offered');
  const items = page.locator('#programList > li');
  ok(await items.count() === 6 && (await items.nth(3).getAttribute('class')) === 'current' && (await items.nth(0).getAttribute('class')) === 'done' && (await items.nth(5).getAttribute('class')) === null, 'running order: 6 numbers, current highlighted, finished ones dimmed');
  ok((await items.nth(3).locator('.dur').textContent()) === '3:12', 'running order shows durations');
  ok((await items.nth(5).locator('.pd').textContent()) === 'Finale & Bows <b>bold</b>' && (await page.evaluate(() => window.__xss)) === undefined && await page.locator('#programList img').count() === 0, 'text from the desk is shown as text, never as HTML');

  // Crew code
  await page.fill('#crewCode', 'wrong');
  await page.click('#crewForm button[type=submit]');
  await page.locator('#crewMsg').filter({ hasText: "isn't right" }).waitFor({ timeout: 5000 });
  ok(true, 'a wrong crew code says "That code isn\'t right"');
  await page.fill('#crewCode', 'Stage');
  await page.click('#crewForm button[type=submit]');
  await page.locator('#cues').waitFor({ state: 'visible', timeout: 5000 });
  ok(await page.locator('#props').isVisible() && await page.locator('#crewOn').isVisible(), 'the right crew code unlocks cues and props');
  ok((await page.evaluate(() => localStorage.getItem('recital-live-code:spring-2027'))) === 'Stage', 'crew code is remembered for this show');
  ok((await text('#cueNow .cue-text')) === 'LX 22 go' && (await page.locator('#cueNow').getAttribute('class')).includes('t-light'), 'current cue shows, colored by type');
  ok((await text('#cueNext')) === 'Spot 1 pick up Ava DSL' && /^in 0:1\d$/.test(await text('#cueIn')), `next cue with a countdown (${await text('#cueIn')})`);
  ok(await page.locator('#cueList li').count() >= 3, 'upcoming cues are listed');
  ok((await page.locator('#propsNow li').allTextContents()).join('|') === '2 chairs SL|Red umbrella' && (await page.locator('#propsNext li').allTextContents()).join('|') === 'Bench CS', 'props for this number and the next one');

  await page.click('#chips .chip[data-type="light"]');
  ok((await text('#cueNext')) === 'LX 23 go' && (await text('#cueNow .cue-text')) === 'LX 22 go' && (await page.locator('#cueList li.t-spot').count()) === 0, 'Lighting filter: only lighting cues');
  await page.click('#chips .chip[data-type="light"]');
  await page.click('#chips .chip[data-type="spot"]');
  ok((await text('#cueNext')) === 'Spot 1 pick up Ava DSL' && (await text('#cueNow .cue-text')) === 'No cue yet', 'Spots filter: only spot cues');
  ok((await page.evaluate(() => localStorage.getItem('recital-live-cue-types'))) === '["spot"]', 'cue filter is remembered');
  await page.reload();
  await page.locator('#cues').waitFor({ state: 'visible', timeout: 10000 });
  ok((await page.locator('#chips .chip[data-type="spot"]').getAttribute('aria-pressed')) === 'true' && (await text('#cueNext')) === 'Spot 1 pick up Ava DSL', 'after reloading, crew view and the Spots filter are still on');
  await page.click('#chips .chip[data-type="spot"]');

  await items.nth(3).locator('button').click();
  const det = items.nth(3).locator('.details');
  ok(await det.isVisible() && (await det.textContent()).includes('Strike umbrella') && (await det.textContent()).includes('Red umbrella'), 'tapping a number in the running order shows its cues and props');

  // A cue passing while the phone watches: the current cue changes and flashes.
  await post(base, 'spring-2027', 'status', { ...playing(30), message: '' });
  await page.locator('#cueNow .cue-text').filter({ hasText: 'LX 14 go' }).waitFor({ timeout: 6000 });
  await post(base, 'spring-2027', 'status', { ...playing(39.5), message: '' });
  await page.locator('#cueNow .cue-text').filter({ hasText: 'LX 22 go' }).waitFor({ timeout: 6000 });
  ok((await page.locator('#cueNow').getAttribute('class')).includes('flash'), 'when the cue changes, the current cue flashes');
  ok(!(await page.locator('#banner').isVisible()), 'banner hides when there is no message');

  if (SHOT_FILE || SHOTS) {
    await post(base, 'spring-2027', 'status', playing(41.2));
    await page.reload();
    await page.locator('#cues').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(600);
    if (SHOT_FILE) {
      await page.screenshot({ path: SHOT_FILE });
      await page.screenshot({ path: SHOT_FILE.replace(/\.png$/, '-full.png'), fullPage: true });
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'recital-live-phone.png') });
  }

  // Intermission with a countdown
  await post(base, 'spring-2027', 'status', { state: 'intermission', sent_at: Date.now(), index: 3, track_id: 't4', next_track_id: 't5', show_remaining: 1500, filler: { playing: true, title: 'Intermission mix' }, message: 'Intermission — 15 minutes', countdown_left: 900 });
  await page.locator('#state').filter({ hasText: 'Intermission' }).waitFor({ timeout: 6000 });
  const c0 = secs(await text('#countdown'));
  await sleep(1600);
  const c1 = secs(await text('#countdown'));
  ok((await text('#msgText')) === 'Intermission — 15 minutes' && c0 <= 900 && c0 >= 890 && c1 < c0, `intermission message and countdown (${c0}→${c1})`);
  ok((await text('#nowTitle')) === 'Playing: Intermission mix' && secs(await text('#showLeft')) === 1500, 'intermission: filler music shows, show time left holds still');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'recital-live-intermission.png') });

  await post(base, 'spring-2027', 'status', { state: 'ended', sent_at: Date.now(), index: 5 });
  await page.locator('#state').filter({ hasText: 'Show over' }).waitFor({ timeout: 6000 });
  ok(await items.nth(5).getAttribute('class') === 'done', 'show over: everything in the running order is dimmed');

  // Other shows menu
  const opts = await page.locator('#otherShows option').allTextContents();
  ok(await page.locator('#otherShows').isVisible() && opts.includes('Winter Showcase 2026') && !opts.includes('Secret Rehearsal') && !opts.includes('Spring Recital 2027'), `Other shows menu lists the other listed shows (${opts.join(', ')})`);
  await page.selectOption('#otherShows', { label: 'Winter Showcase 2026' });
  await page.waitForURL(/\/recital\/winter-2026\/$/, { timeout: 10000 });
  await page.locator('#emptyTitle').filter({ hasText: "The show hasn't started yet" }).waitFor({ timeout: 10000 });
  ok(await page.locator('#empty').isVisible() && !(await page.locator('#now').isVisible()) && (await text('#showTitle')) === 'Winter Showcase 2026', 'choosing another show opens it; with nothing sent yet it says "The show hasn\'t started yet"');
  ok(!(await page.locator('#crewBox').isVisible()), 'a show without a crew code asks for no code');

  // Offline: the service worker keeps the last update.
  const scheme = new URL(base);
  if (scheme.hostname === '127.0.0.1' || scheme.hostname === 'localhost' || scheme.protocol === 'https:') {
    await page.goto(url);
    await page.locator('#nowDance').filter({ hasText: "That's the show!" }).waitFor({ timeout: 10000 });
    let swReady = false;
    try { swReady = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise(r => setTimeout(() => r(false), 8000))])); } catch (e) { swReady = false; }
    ok(swReady, 'the service worker installs (scope ' + (await page.evaluate(() => navigator.serviceWorker.controller ? 'controlled' : 'not yet controlling')) + ')');
    await page.reload(); // now the page is controlled, so its data goes through the service worker
    await page.locator('#nowDance').filter({ hasText: "That's the show!" }).waitFor({ timeout: 10000 });
    await sleep(2500);
    await context.setOffline(true);
    await page.locator('#connText').filter({ hasText: 'Offline' }).waitFor({ timeout: 8000 });
    const offlineBanner = await page.locator('#offline').isVisible();
    ok(offlineBanner && (await text('#offline')).includes('Offline — showing the last update') && (await text('#nowDance')) === "That's the show!", 'offline: says "Offline — showing the last update" and keeps the last update on screen');
    await page.reload().catch(() => {});
    let shell = false;
    try { await page.locator('#showTitle').filter({ hasText: 'Spring Recital 2027' }).waitFor({ timeout: 8000 }); shell = true; } catch (e) { shell = false; }
    ok(shell, 'offline: the page itself still opens from the service worker cache');
    await context.setOffline(false);
  }

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
}

(async () => {
  let h = null, base = process.env.WP_URL;
  if (!base) { h = await startHarness(); base = h.base; }
  try {
    await apiTests(base, !!h);
    await pageTests(base);
  } finally {
    if (h) {
      h.php.kill();
      if (/Fatal|Warning|Notice|Deprecated/.test(h.log())) { console.log(h.log().split('\n').filter(l => /Fatal|Warning|Notice|Deprecated/.test(l)).join('\n')); ok(false, 'PHP printed no warnings'); } else ok(true, 'PHP printed no warnings');
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
