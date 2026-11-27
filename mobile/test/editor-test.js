// Tests editing on the phone: a new number from a song, dancers, formations, touch moves, undo, curved paths,
// notes, pinch zoom, sending the .dance file and opening it again (sync by file).
// Usage: node test/editor-test.js [screenshot-dir]
const playwright = require('playwright'), { devices } = playwright;
const ENGINE = process.env.ENGINE || 'chromium', DEVICE = process.env.DEVICE || 'Pixel 7';
const path = require('path'), http = require('http'), fs = require('fs'), os = require('os');
const JSZip = require('jszip');

const www = path.join(__dirname, '..', 'www'), shots = process.argv[2];
const types = { '.html':'text/html', '.js':'text/javascript', '.woff2':'font/woff2', '.txt':'text/plain' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbedit-'));

// A 40-second song at 120 BPM: 2 quiet 8-counts (a click on 1 and 5), then a full beat.
function makeSong(file){
  const sr = 22050, secs = 40, n = sr*secs, d = new Int16Array(n), bl = 0.5, start = 1.0;
  for (let b = 0; start + b*bl < secs - 0.3; b++){
    const quiet = b < 16, t0 = Math.floor((start + b*bl)*sr);
    if (quiet && b % 4) continue;
    const amp = quiet ? 0.35 : (b % 8 === 0 ? 0.95 : 0.7), f = b % 8 === 0 ? 880 : 440;
    for (let i = 0; i < sr*0.12; i++){ const e = Math.exp(-i/(sr*0.03)); d[t0+i] += Math.round(32767*amp*e*Math.sin(2*Math.PI*f*i/sr)); }
    if (!quiet) for (let i = 0; i < sr*0.05; i++) d[t0 + Math.floor(sr*bl/2) + i] += Math.round(8000*(Math.random()*2-1)*Math.exp(-i/(sr*0.01)));
  }
  const buf = Buffer.alloc(44 + n*2); buf.write('RIFF', 0); buf.writeUInt32LE(36 + n*2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr*2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n*2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(d[i], 44 + i*2);
  fs.writeFileSync(file, buf);
}

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(www, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(www) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(0);
  const browser = await playwright[ENGINE].launch();
  const ctx = await browser.newContext({ ...devices[DEVICE], acceptDownloads: true });
  console.log(`Testing editing with ${ENGINE} as ${DEVICE}`);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const song = path.join(tmp, 'Practice Song.wav'); makeSong(song);
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForSelector('#songs');

  // 1. New number from a song
  await page.setInputFiles('#newSong', song);
  await page.waitForSelector('body.editing #editBar:not([hidden])', { timeout: 30000 });
  ok((await page.textContent('#pTitle')) === 'Practice Song', 'a new number starts from a song and opens in edit mode');
  await page.click('#editBar [data-sheet="song"]');
  const bpm = +(await page.inputValue('#sBpm'));
  ok(Math.abs(bpm - 120) < 1.5, `the beat is found from the music (${bpm} BPM)`);
  const secs = await page.$$eval('[data-sn]', x => x.map(e => e.value));
  ok(secs.length >= 2, `sections are suggested from the music (${secs.join(', ')})`);
  await page.click('#eClose');

  // 2. Dancers
  await page.click('#editBar [data-sheet="dancers"]');
  for (const n of ['Maya', 'Ava', 'Zoe']){ await page.fill('#dnNew', n); await page.click('#dnAdd'); await page.waitForTimeout(80); }
  ok((await page.$$('[data-dn]')).length === 3, 'three dancers added');
  await page.fill('#dnClassName', 'Tuesday Jazz'); await page.click('#dnSave'); await page.waitForTimeout(200);
  ok((await page.textContent('#dnClasses')).includes('Tuesday Jazz'), 'the dancers can be saved as a class');
  await page.click('#eClose');

  // 3. First formation, tap to place, drag, undo
  await page.click('#eStrip [data-add]'); await page.waitForTimeout(200);
  ok((await page.$$('#stageSvg [data-id]')).length === 3, 'adding a formation puts the dancers on stage');
  const at = async id => page.$eval(`#stageSvg [data-id="${id}"] circle[fill]:not([fill="transparent"]):not([fill="none"])`, c => [+c.getAttribute('cx'), +c.getAttribute('cy')]);
  const ids = await page.$$eval('#stageSvg [data-id]', g => g.map(x => x.dataset.id));
  const before = await at(ids[0]);
  await page.click(`#stageSvg [data-id="${ids[0]}"]`); await page.waitForTimeout(100);
  const box = await page.$eval('#stageSvg', s => { const r = s.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w*0.3, box.y + box.h*0.3); await page.waitForTimeout(150);
  const moved = await at(ids[0]);
  ok(Math.hypot(moved[0] - before[0], moved[1] - before[1]) > 20, 'tap a dancer, then tap a spot: they move there');
  await page.click('#ebUndo'); await page.waitForTimeout(150);
  const undone = await at(ids[0]);
  ok(Math.hypot(undone[0] - before[0], undone[1] - before[1]) < 1, 'Undo puts them back');
  await page.click('#ebRedo'); await page.waitForTimeout(150);
  ok(Math.hypot((await at(ids[0]))[0] - moved[0], 0) < 1, 'Redo moves them again');
  const b1 = await page.$eval(`#stageSvg [data-id="${ids[1]}"]`, g => { const r = g.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; });
  const p1 = await at(ids[1]);
  await page.mouse.move(b1.x, b1.y); await page.mouse.down(); await page.mouse.move(b1.x + 60, b1.y + 30, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150);
  const p1b = await at(ids[1]);
  ok(Math.hypot(p1b[0] - p1[0], p1b[1] - p1[1]) > 20, 'dragging a dancer moves them');

  // 4. A note for this 8-count
  for (let i = 0; i < 1; i++) await page.click('#nextBtn');
  await page.fill('#noteEdit', 'Walk forward 4, turn on 5-6.'); await page.click('#pTitle'); await page.waitForTimeout(150);

  // 5. Second formation two 8-counts later; curve a path
  await page.click('#nextBtn'); await page.click('#nextBtn'); await page.waitForTimeout(150);
  await page.click('#eStrip [data-add]'); await page.waitForTimeout(200);
  ok((await page.$$('#eStrip [data-at]')).length === 2, 'a second formation is added');
  await page.click(`#stageSvg [data-id="${ids[2]}"]`); await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.w*0.75, box.y + box.h*0.35); await page.waitForTimeout(150);
  const hd = await page.$('#stageSvg [data-handle]'); ok(!!hd, 'the selected dancer gets a curve handle on their path');
  const hb = await hd.boundingBox();
  await page.mouse.move(hb.x + hb.width/2, hb.y + hb.height/2); await page.mouse.down(); await page.mouse.move(hb.x + hb.width/2, hb.y + hb.height/2 + 50, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150);
  await page.click('#eQuick [data-q="dancer"]'); await page.waitForTimeout(100);
  ok((await page.textContent('#eBody')).includes('Curved.'), 'dragging the handle curves the path');
  await page.click('#dR'); await page.click('#dR'); await page.waitForTimeout(100);
  ok((await page.textContent('#eBody')).includes('Facing stage left'), 'facing can be set from the dancer sheet');
  await page.click('#eClose');
  await page.click('#editBar [data-sheet="formation"]');
  await page.fill('#fName', 'Opening V'); await page.press('#fName', 'Tab'); await page.waitForTimeout(150);
  await page.selectOption('#fStag', 'front'); await page.waitForTimeout(150);
  ok((await page.textContent('#eStrip')).includes('Opening V'), 'formations can be renamed');
  await page.click('#eClose');

  // 6. Pinch to zoom (two pointers)
  await page.evaluate(() => {
    const s = document.getElementById('stageSvg'), r = s.getBoundingClientRect(), cx = r.left + r.width/2, cy = r.top + r.height/2;
    const ev = (type, id, x) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: cy, bubbles: true, pointerType: 'touch', isPrimary: id === 1 }));
    ev('pointerdown', 1, cx - 20); ev('pointerdown', 2, cx + 20); ev('pointermove', 2, cx + 60); ev('pointermove', 1, cx - 60); ev('pointerup', 2, cx + 60); ev('pointerup', 1, cx - 60);
  });
  await page.waitForTimeout(100);
  const vb = await page.getAttribute('#stageSvg', 'viewBox');
  ok(vb.split(' ')[2] < 300, `pinching zooms in on the stage (viewBox ${vb})`);
  await page.click('#eQuick [data-q="zoom"]');
  ok((await page.getAttribute('#stageSvg', 'viewBox')).startsWith('0.0 0.0 400.0'), 'Zoom out goes back to the whole stage');
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150);
  if (shots) await page.screenshot({ path: path.join(shots, `editor-${ENGINE}.png`) });

  // 7. Send the .dance file
  await page.click('#editBar [data-sheet="send"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sendGo')]);
  const file = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file)), data = JSON.parse(await zip.file('project.json').async('string')), P = data.project;
  ok(dl.suggestedFilename() === 'Practice Song.dance' && P.dancers.length === 3 && P.formations.length === 2, 'Send saves a .dance file with the dancers and formations');
  ok(Object.values(P.notes).includes('Walk forward 4, turn on 5-6.') && P.formations.some(f => f.paths && Object.keys(f.paths).length) && P.formations.some(f => f.face) && typeof P.uid === 'string', 'the file holds the note, the curved path, facing and the number\'s id');
  await page.click('#eClose');

  // 8. Sync by file
  await page.click('#editBtn'); await page.click('#backBtn'); await page.waitForSelector('#libView:not([hidden])');
  await page.setInputFiles('#openFile', file); await page.waitForTimeout(500);
  ok((await page.textContent('#toast')).includes('already have this version') && (await page.$$('.song')).length === 1, 'opening your own file again is recognised, not added twice');
  const edited = path.join(tmp, 'edited.dance'), z2 = new JSZip();
  z2.file('project.json', JSON.stringify({ ...data, project: { ...P, title: 'Practice Song (teacher edit)', updated: P.updated + 5000, base: P.updated } }));
  fs.writeFileSync(edited, await z2.generateAsync({ type: 'nodebuffer' }));
  await page.setInputFiles('#openFile', edited); await page.waitForTimeout(500);
  ok((await page.textContent('#toast')).startsWith('Updated') && (await page.$$('.song')).length === 1 && (await page.textContent('#songs')).includes('teacher edit'), 'a file edited elsewhere updates the number in place');
  await page.click('.song [data-a="open"]'); await page.waitForSelector('#playView:not([hidden])'); await page.click('#editBtn');
  await page.click('#editBar [data-sheet="song"]'); await page.fill('#sTitle', 'Practice Song (my edit)'); await page.press('#sTitle', 'Tab'); await page.waitForTimeout(400); await page.click('#eClose');
  await page.click('#editBtn'); await page.click('#backBtn'); await page.waitForSelector('#libView:not([hidden])');
  const other = path.join(tmp, 'other.dance'), z3 = new JSZip();
  z3.file('project.json', JSON.stringify({ ...data, project: { ...P, title: 'Practice Song (another edit)', updated: P.updated + 9000, base: P.updated + 5000 } }));
  fs.writeFileSync(other, await z3.generateAsync({ type: 'nodebuffer' }));
  await page.setInputFiles('#openFile', other); await page.waitForSelector('#eSheet:not([hidden])');
  ok((await page.textContent('#eBody')).includes('changed on your phone and in this file'), 'when both copies changed, the phone asks');
  await page.click('#eBody [data-k="both"]'); await page.waitForTimeout(500);
  ok((await page.$$('.song')).length === 2 && (await page.textContent('#songs')).includes('(from file)'), 'Keep both adds the file as a separate number');

  // 9. Tablet layout
  await page.setViewportSize({ width: 1024, height: 1366 });
  await page.click('.song:has-text("my edit") [data-a="open"]'); await page.waitForSelector('#playView:not([hidden])');
  const cols = await page.$eval('.pcols', e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  ok(cols === 2, 'on a tablet the player uses two columns');
  await page.click('#editBtn'); await page.waitForTimeout(200);
  if (shots) await page.screenshot({ path: path.join(shots, `editor-tablet-${ENGINE}.png`) });
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
