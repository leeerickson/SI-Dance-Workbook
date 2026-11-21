// Tests the Dance Player plugin's output in a browser.
//   Local stand-in page:  node wordpress-plugin/test/plugin-test.js
//   Real WordPress site:   WP_URL=http://localhost:8888 PAGE_FILE=<page url> PAGE_BLOCK=<url> PAGE_OPEN=<url> node wordpress-plugin/test/plugin-test.js
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const types = { '.html':'text/html', '.js':'text/javascript', '.woff2':'font/woff2', '.dance':'application/zip', '.txt':'text/plain' };

async function localPages(){
  // Build the plugin (copies the player in), render a page with the shortcode, and serve it like WordPress would.
  execFileSync('node', [path.join(root, 'wordpress-plugin', 'build.js')], { stdio:'inherit' });
  const page = execFileSync('php', [path.join(__dirname, 'render-page.php'), JSON.stringify([{ file:'123', open:'no' }])]).toString();
  const pageOpen = execFileSync('php', [path.join(__dirname, 'render-page.php'), JSON.stringify([{}])]).toString();
  const map = { '/wp-content/plugins/dance-player/': path.join(root, 'wordpress-plugin', 'dance-player') + '/', '/uploads/spotlight.dance': path.join(root, 'mobile', 'test', 'fixtures', 'spotlight.dance') };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/page-file') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(page); }
    if (url === '/page-open') { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(pageOpen); }
    for (const [prefix, dir] of Object.entries(map)) if (url.startsWith(prefix)) {
      const f = dir.endsWith('/') ? path.join(dir, url.slice(prefix.length)) : dir;
      if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream'}); return fs.createReadStream(f).pipe(res); }
    }
    res.writeHead(404); res.end();
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, file: base + '/page-file', block: null, open: base + '/page-open' };
}

(async () => {
  const pages = process.env.WP_URL ? { file: process.env.PAGE_FILE, block: process.env.PAGE_BLOCK, open: process.env.PAGE_OPEN } : await localPages();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

  const checkPlayer = async (url, label) => {
    await page.goto(url);
    const frame = page.frameLocator('iframe.dance-player-frame').first();
    await frame.locator('#pTitle').waitFor({ timeout: 30000 });
    ok((await frame.locator('#pTitle').textContent()).includes('Spotlight'), `${label}: the number opens straight away`);
    await frame.locator('#tDur').filter({ hasText: '1:07' }).waitFor({ timeout: 30000 });
    for (let i = 0; i < 4; i++) await frame.locator('#nextBtn').click();
    await page.waitForTimeout(300);
    ok((await frame.locator('#noteNow').textContent()).includes('pirouette'), `${label}: notes show and follow the counts`);
    ok((await frame.locator('#formName').textContent()) === 'Walk into V', `${label}: the formation shows`);
    await page.waitForTimeout(1500);
    const h = await page.$eval('iframe.dance-player-frame', f => f.getBoundingClientRect().height);
    ok(h > 950, `${label}: the player grows to fit, with no inner scrollbar (${Math.round(h)} px tall)`);
  };

  await checkPlayer(pages.file, 'Shortcode with a file');
  ok(await page.frameLocator('iframe.dance-player-frame').first().locator('label[for="openFile"]').evaluate(e => e.hidden), 'open="no" hides "Open a .dance file"');
  const shots = process.env.SHOTS; if (shots) await page.screenshot({ path: path.join(shots, 'wordpress-page.png'), fullPage: true });
  if (pages.block) await checkPlayer(pages.block, 'Dance Player block');

  await page.goto(pages.open);
  const f2 = page.frameLocator('iframe.dance-player-frame').first();
  await f2.locator('#libView').waitFor({ timeout: 30000 });
  ok(await f2.locator('label[for="openFile"]').isVisible(), 'Shortcode with no file: visitors can open their own .dance file');
  await f2.locator('#openFile').setInputFiles(path.join(root, 'mobile', 'test', 'fixtures', 'spotlight.dance'));
  await f2.locator('.song').first().waitFor({ timeout: 15000 });
  ok((await f2.locator('.song').first().textContent()).includes('Spotlight'), 'a visitor-opened file appears in their list');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  if (pages.server) pages.server.close();
})().catch(e => { console.error(e); process.exit(1); });
