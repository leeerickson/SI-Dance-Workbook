// Tests the Android player's web layer in a phone-sized Chromium.
// Usage: node test/player-test.js path/to/file.dance [screenshot-dir]
const { chromium, devices } = require('playwright');
const path = require('path');
const http = require('http');
const fs = require('fs');

const www = path.join(__dirname, '..', 'www');
const dance = process.argv[2];
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
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
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
  await page.selectOption('#followSel', 'd4'); await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  if (shots) await page.screenshot({ path: path.join(shots, 'player-top.png') });

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
  if (shots) await page.screenshot({ path: path.join(shots, 'player-bottom.png'), fullPage: false });

  // Persistence and back navigation
  await page.goBack(); await page.waitForSelector('#libView:not([hidden])');
  ok(true, 'Back returns to the list');
  await page.reload(); await page.waitForSelector('.song');
  ok((await page.$$('.song')).length === 1, 'the number is still there after restarting');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
