// Tests the Android player's web layer in a phone-sized Chromium.
// Usage: node test/player-test.js path/to/file.dance [screenshot-dir]
const playwright = require('playwright'), { devices } = playwright;
// ENGINE=webkit DEVICE='iPhone 15' tests the way an iPhone renders it; default is Chromium on a Pixel 7 (Android).
const ENGINE = process.env.ENGINE || 'chromium', DEVICE = process.env.DEVICE || 'Pixel 7';
const path = require('path');
const http = require('http');
const fs = require('fs');

const www = path.join(__dirname, '..', 'www');
const dance = process.argv[2] || path.join(__dirname, 'fixtures', 'spotlight.dance');
const shots = process.argv[3];
const types = { '.html':'text/html', '.js':'text/javascript', '.woff2':'font/woff2', '.txt':'text/plain' };

(async () => {
  // Serve www/ over http, as the Android WebView does (IndexedDB needs a real origin).
  const server = http.createServer((req, res) => {
    const f = path.join(www, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(www) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  // Chromium gets a fake front camera so "Film yourself" can be tested.
  const browser = await playwright[ENGINE].launch(ENGINE === 'chromium' ? { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } : {});
  const ctx = await browser.newContext({ ...devices[DEVICE], ...(ENGINE === 'chromium' ? { permissions: ['camera'] } : {}) });
  console.log(`Testing with ${ENGINE} as ${DEVICE}`);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

  await page.goto(url);
  await page.waitForSelector('#songs');
  ok((await page.textContent('#songs')).includes('No numbers yet'), 'empty library explains what to do');

  await page.setInputFiles('#openFile', dance);
  await page.waitForSelector('.song');
  const card = await page.textContent('.song');
  ok(card.includes('Spotlight') && card.includes('8 formations') && card.includes('2 props'), 'opening a .dance file adds it to the list');

  await page.click('.song [data-a="open"]');
  await page.waitForFunction(() => document.getElementById('tDur').textContent === '1:07', null, { timeout: 20000 });
  ok(true, 'the demo track plays for a file made from the demo');
  for (let i = 0; i < 4; i++) await page.click('#nextBtn');
  await page.waitForTimeout(300);
  ok((await page.textContent('#noteNow')).includes('pirouette'), 'note for Verse 2 shows');
  ok((await page.textContent('#formName')) === 'Walk into V', 'formation for Verse 2 shows');
  ok(await page.$('#stage.has-floor #stageFloorSlot #stageSvg') !== null, 'with no video, the formation fills the top area');
  ok(await page.isVisible('#noteNow'), 'the note is still shown under it');
  // Layout must not move as counts, notes and formation names change.
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    const spots = new Set(), toggles = new Set();
    for (let i = 0; i < 20; i++){
      await page.click('#nextBtn'); await page.waitForTimeout(60);
      const b = await page.$eval('#playBtn', e => Math.round(e.getBoundingClientRect().top + window.scrollY));
      const t = await page.$eval('#floorBox .view-toggle', e => Math.round(e.getBoundingClientRect().top + window.scrollY));
      spots.add(b); toggles.add(t);
    }
    // mid-travel moments too (long formation names like "Travelling into Pinwheel circle")
    for (const x of [0.22, 0.27, 0.4, 0.71, 0.86, 0.93]){
      const box = await page.$eval('#timeline', e => { const r = e.getBoundingClientRect(); return {x:r.left, y:r.top + r.height/2, w:r.width}; });
      await page.mouse.click(box.x + box.w * x, box.y); await page.waitForTimeout(60);
      spots.add(await page.$eval('#playBtn', e => Math.round(e.getBoundingClientRect().top + window.scrollY)));
      toggles.add(await page.$eval('#floorBox .view-toggle', e => Math.round(e.getBoundingClientRect().top + window.scrollY)));
    }
    ok(spots.size === 1, `play controls stay put while the song moves (${[...spots].join(', ')})`);
    ok(toggles.size === 1, `Audience/Dancer switch stays on its line (${[...toggles].join(', ')})`);
    for (let i = 0; i < 26; i++) await page.click('#prevBtn');
    for (let i = 0; i < 4; i++) await page.click('#nextBtn');
    await page.waitForTimeout(200);
  }
  await page.selectOption('#followSel', 'd4'); await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  if (shots) await page.screenshot({ path: path.join(shots, `player-top-${ENGINE}.png`) });

  // Jump to the Bridge: chairs on stage, and Zoe's view
  await page.selectOption('#repFrom', '3'); await page.selectOption('#repTo', '3'); await page.selectOption('#repTimes', '2');
  await page.uncheck('#repCountIn');
  await page.click('#repGo'); await page.waitForTimeout(400);
  ok((await page.textContent('#repStatus')).includes('Bridge'), 'repeat the Bridge is set');
  await page.click('#playBtn'); await page.waitForTimeout(150); // pause (repeat started playback)
  ok((await page.$$('#stageSvg .st-dyn ellipse, #stageSvg .st-dyn rect')).length >= 2, 'chairs are on stage in the Bridge');
  ok((await page.textContent('#cue')).includes('Zoe'), 'follow a dancer shows their spot');
  await page.click('#repGo');
  await page.selectOption('#followSel', 'crew'); await page.waitForTimeout(200);
  ok((await page.textContent('#cue')).includes('take Chair A off'), 'stage crew view lists the next prop job');
  await page.evaluate(() => window.scrollTo(0, 99999)); await page.waitForTimeout(150);
  if (shots) await page.screenshot({ path: path.join(shots, `player-bottom-${ENGINE}.png`), fullPage: false });

  await page.goBack(); await page.waitForSelector('#libView:not([hidden])');
  ok(true, 'Back returns to the list');

  // New in 0.2: stage size and spike numbers, facing, staggered timing, curved paths, formation notes, 3D view
  await page.setInputFiles('#openFile', path.join(__dirname, 'fixtures', 'spotlight-features.dance'));
  await page.waitForFunction(() => document.querySelectorAll('.song').length === 2);
  await page.click('.song:has-text("new features") [data-a="open"]');
  await page.waitForFunction(() => document.getElementById('tDur').textContent === '1:07', null, { timeout: 20000 });
  await page.selectOption('#followSel', 'd0');
  for (let i = 0; i < 3; i++) await page.click('#nextBtn');
  await page.waitForTimeout(250);
  const cue1 = (await page.textContent('#cue')).replace(/\s+/g, ' ');
  ok(cue1.includes('start moving on Verse 2, count 7') && cue1.includes('curved path'), `staggered timing and curved path show in the cue (${cue1.slice(0, 160)})`);
  const marks = await page.$$eval('#stageSvg .st-static text', t => t.map(x => x.textContent));
  ok(marks.includes('7') && !marks.includes('8'), 'a 30 ft stage with marks every 2 ft is numbered 1 to 7');
  ok((await page.$$('#stageSvg .st-dyn path[stroke-dasharray]')).length >= 1, "the dancer's next path is drawn");
  await page.click('#nextBtn'); await page.click('#nextBtn'); await page.waitForTimeout(250);   // Verse 3: Two lines
  const cue2 = await page.textContent('#cue');
  ok(cue2.includes('facing stage left') && cue2.includes('Front row stays low'), `facing and the formation note show (${cue2.replace(/\s+/g, ' ').slice(0, 200)})`);
  const top0 = await page.$eval('#playBtn', e => Math.round(e.getBoundingClientRect().top + window.scrollY));
  await page.click('#floorBox [data-view="3d"]'); await page.waitForTimeout(400);
  ok(await page.isVisible('#stage3d') && !(await page.isVisible('#stageSvg')), '3D view replaces the flat stage');
  const painted = await page.$eval('#stage3d', c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 400) if (d[i] + d[i+1] + d[i+2] > 60) n++; return n; });
  ok(painted > 50, '3D view draws the stage and dancers');
  ok(top0 === await page.$eval('#playBtn', e => Math.round(e.getBoundingClientRect().top + window.scrollY)), 'switching to 3D does not move the controls');
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  if (shots) await page.screenshot({ path: path.join(shots, `player-3d-${ENGINE}.png`) });
  await page.click('#floorBox [data-view="aud"]');

  // Film yourself (Chromium's fake camera)
  if (ENGINE === 'chromium'){
    await page.click('#recBtn');
    await page.waitForSelector('#recBadge:not([hidden])', { timeout: 15000 });
    ok(await page.isVisible('#takeVid'), 'the camera shows in the top area while filming');
    await page.waitForTimeout(3000);
    await page.click('#recBtn');
    await page.waitForSelector('.take', { timeout: 10000 });
    ok((await page.textContent('#takes')).includes('Run 1'), 'the filmed run is saved');
    await page.click('.take [data-w]'); await page.waitForTimeout(500);
    ok(await page.isVisible('#takeVid') && (await page.textContent('.take [data-w]')) === 'Stop watching', 'Watch shows your run next to the counts');
    await page.click('#playBtn'); await page.waitForTimeout(4200);
    const vt = await page.$eval('#takeVid', v => v.currentTime);
    ok(vt > 0.5, `your run plays in time with the music (${vt.toFixed(1)} s in)`);
    await page.click('#playBtn'); await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
    if (shots) await page.screenshot({ path: path.join(shots, `player-compare-${ENGINE}.png`) });
    await page.click('.take [data-w]');
  }

  // Persistence
  await page.goBack(); await page.waitForSelector('#libView:not([hidden])');
  await page.reload(); await page.waitForSelector('.song');
  ok((await page.$$('.song')).length === 2, 'the numbers are still there after restarting');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
