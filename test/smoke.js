// Smoke test: launches the real Electron app, opens the demo, saves a .dance file,
// opens it again, and saves the printout as a PDF. Native dialogs are stubbed.
// Run: npm test   (needs the `playwright` package; on Linux run under xvfb-run)
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbook-'));
  const sharePath = path.join(tmp, 'Spotlight.dance'), pdfPath = path.join(tmp, 'Spotlight.pdf');
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), '--no-sandbox', `--user-data-dir=${path.join(tmp, 'profile')}`] });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', e => errors.push(e.message));
  const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

  await win.waitForSelector('.card');
  ok((await win.textContent('#libCount')).includes('1 project'), 'library starts with the demo project');
  await win.click('.card [data-a="open"]');
  await win.waitForFunction(() => document.getElementById('tDur').textContent === '1:07', null, { timeout: 20000 });
  ok(true, 'demo project opens with its 1:07 track');

  for (let i = 0; i < 4; i++) await win.click('#nextBtn');
  await win.waitForTimeout(300);
  ok((await win.textContent('#noteNow')).includes('pirouette'), 'rehearse view shows the note for Verse 2');
  ok((await win.textContent('#rFormName')) === 'Walk into V', 'rehearse view shows the live formation');

  // Repeat sections: Verse through Chorus, 2 times
  await win.selectOption('#repFrom', '1'); await win.selectOption('#repTo', '2'); await win.selectOption('#repTimes', '2');
  await win.uncheck('#repCountIn'); await win.click('#repGo'); await win.waitForTimeout(300);
  ok((await win.textContent('#loopChip')).includes('Repeat: Verse to Chorus (1 of 2)'), 'repeat Verse through Chorus 2 times is set');
  ok((await win.textContent('#repGo')) === 'Stop repeating', 'repeat button switches to Stop repeating');
  await win.click('#repGo'); await win.waitForTimeout(200);
  ok(await win.$eval('#loopChip', e => e.hidden), 'Stop repeating clears the repeat');
  await win.click('#playBtn').catch(() => {}); await win.waitForTimeout(100); await win.click('#playBtn').catch(() => {});

  // Props: the demo brings two chairs on for the Bridge
  await win.click('[data-tab="forms"]');
  await win.click('.fchip:has-text("Bridge rows")'); await win.waitForTimeout(400);
  ok((await win.$$('#plist .prow')).length === 2, 'demo has two props');
  ok((await win.$$('#fStage [data-prop]')).length === 2, 'both chairs are drawn on the stage in Bridge rows');
  const movers = await win.$$eval('#plist select[data-a="who"]', s => s.map(x => x.options[x.selectedIndex].text));
  ok(movers.length === 2 && movers.every(m => m && m !== 'Nobody chosen'), `each chair has a dancer moving it (${movers.join(', ')})`);
  ok((await win.textContent('#wCount')) === 'All clear', 'spacing and prop checks are all clear');
  await win.selectOption('#propKind', 'box'); await win.click('#addProp'); await win.waitForTimeout(300);
  ok((await win.$$('#plist .prow')).length === 3, 'adding a prop works');
  ok((await win.textContent('#wlist')).includes('Nobody is set to move Box 1'), 'a new prop with no mover is flagged');
  await win.selectOption('#plist .prow.sel select[data-a="who"]', 'crew'); await win.waitForTimeout(200);
  ok(!(await win.textContent('#wlist')).includes('Nobody is set to move Box 1'), 'choosing stage crew clears the flag');
  await win.click('#plist .prow.sel [data-a="del"]'); await win.waitForTimeout(200);
  ok((await win.$$('#plist .prow')).length === 2, 'removing a prop works');
  await win.click('[data-tab="share"]'); await win.waitForTimeout(300);
  ok((await win.textContent('#paper')).includes('Bring Chair A on from stage right'), 'printout lists who moves which prop');

  // 0.4: shared stage engine is the same file in both apps
  ok(fs.readFileSync(path.join(__dirname, '..', 'app', 'stagecore.js'), 'utf8') === fs.readFileSync(path.join(__dirname, '..', 'mobile', 'www', 'stagecore.js'), 'utf8'), 'app/stagecore.js and mobile/www/stagecore.js are identical (npm run sync-core)');
  // sections suggested from the music
  await win.click('[data-tab="counts"]'); await win.click('#suggestBtn');
  await win.waitForFunction(() => !document.getElementById('secSuggest').textContent.includes('Listening'), null, { timeout: 30000 });
  const sug = (await win.textContent('#secSuggest')).replace(/\s+/g, ' ');
  ok(['Intro from 8-count 1', 'Verse from 8-count 3', 'Chorus from 8-count 7', 'Bridge from 8-count 11', 'Final chorus from 8-count 13'].every(t => sug.includes(t)), `sections suggested from the demo music match its real sections (${sug.slice(0, 160)})`);
  await win.click('#sugNo');
  // curve a path, turn a dancer, stagger the move
  await win.click('[data-tab="forms"]'); await win.click('.fchip:has-text("Two lines")'); await win.waitForTimeout(300);
  await win.click('#fStage [data-id="d0"]'); await win.waitForTimeout(200);
  const hb = await (await win.$('#fStage [data-handle]')).boundingBox();
  await win.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await win.mouse.down(); await win.mouse.move(hb.x + 70, hb.y - 40, { steps: 6 }); await win.mouse.up(); await win.waitForTimeout(200);
  ok(!!(await win.$('#straightBtn')), 'dragging the path handle curves the path');
  await win.click('#faceR'); await win.click('#faceR'); await win.waitForTimeout(150);
  ok((await win.textContent('.face-txt')) === 'Facing stage left', 'turning a dancer twice to the right faces stage left');
  await win.selectOption('#stagOrder', 'front'); await win.waitForTimeout(200);
  ok((await win.textContent('#fPanel')).includes('Staggered:'), 'front row first staggers the move');
  // stage settings
  await win.selectOption('#stPreset', 'studio'); await win.selectOption('#stSpike', '2'); await win.selectOption('#stLabels', 'ones'); await win.waitForTimeout(200);
  const marks = await win.$$eval('#fStage .st-static text', t => t.map(x => x.textContent));
  ok(marks.includes('7') && !marks.includes('8') && (await win.textContent('#stSizeTxt')) === '30 × 20 ft', 'a 30 × 20 ft studio with marks every 2 ft is numbered 1 to 7');
  ok((await win.textContent('#wlist')).includes('off the stage'), 'dancers outside a smaller stage are flagged');
  await win.selectOption('#stPreset', 'standard'); await win.selectOption('#stSpike', '4'); await win.selectOption('#stLabels', 'pairs'); await win.waitForTimeout(200);
  // 3D view
  await win.click('#tab-forms [data-view="3d"]'); await win.waitForTimeout(400);
  const lit = await win.$eval('#tab-forms canvas.stage3d', c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 400) if (d[i] + d[i+1] + d[i+2] > 60) n++; return n; });
  ok(lit > 50 && !(await win.isVisible('#fStage')), '3D view draws the stage from the audience');
  await win.click('#tab-forms [data-view="aud"]');
  // saved class
  await win.selectOption('#rosterSel', 'save'); await win.fill('#rosterName', 'Jazz Tuesday'); await win.click('#rosterOk'); await win.waitForTimeout(300);
  ok((await win.$$eval('#rosterSel option', o => o.map(x => x.textContent))).includes('Add Jazz Tuesday (8)'), 'dancers can be saved as a class');
  await win.click('[data-tab="share"]'); await win.waitForTimeout(300);

  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, sharePath);
  await win.click('[data-tab="share"]');
  await win.click('#makeShare');
  await win.waitForFunction(() => !document.getElementById('shareOut').hidden, null, { timeout: 10000 });
  const zip = new AdmZip(sharePath), data = JSON.parse(zip.readAsText('project.json'));
  ok(data.app === 'choreo-workbook' && data.format === 1, '.dance file is a zip with project.json');
  ok(data.project.formations.length === 8 && Object.keys(data.project.notes).length === 16, '.dance file holds 8 formations and 16 notes');
  ok(Array.isArray(data.project.props) && data.project.props.length === 2, '.dance file holds the props');
  const tl = data.project.formations.find(f => f.name === 'Two lines');
  ok(tl.paths && tl.paths.d0 && tl.face && tl.face.d0 === 90 && tl.timing && data.project.stage && data.project.stage.w === 36, '.dance file holds curved paths, facing, timing and the stage');

  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, pdfPath);
  await win.click('#pdfBtn');
  await win.waitForFunction(() => document.getElementById('printMsg').textContent.startsWith('Saved'), null, { timeout: 20000 });
  const pdf = fs.readFileSync(pdfPath);
  ok(pdf.slice(0, 4).toString() === '%PDF' && pdf.length > 20000, `printout saved as a PDF (${Math.round(pdf.length / 1024)} KB)`);

  // Video: 9:16 of the Intro
  const videoPath = path.join(tmp, 'Intro.mp4');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, videoPath);
  await win.click('label[for=vs916]'); await win.selectOption('#vFrom', '0'); await win.selectOption('#vTo', '0');
  await win.click('#vMake');
  await win.waitForFunction(() => !document.getElementById('vDone').hidden, null, { timeout: 120000 });
  const mp4 = fs.readFileSync(videoPath);
  ok(mp4.slice(4, 8).toString() === 'ftyp' && mp4.length > 100000, `video saved as an MP4 (${Math.round(mp4.length / 1024)} KB)`);
  const audioFmt = mp4.includes(Buffer.from('mp4a')) ? 'AAC (plays everywhere)' : mp4.includes(Buffer.from('Opus')) ? 'Opus (VLC, browsers, most players)' : 'none';
  console.log(`INFO video sound format on ${process.platform}: ${audioFmt}`);

  // Sync by file: the same number (same uid) is recognised, updated in place, or asked about
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, sharePath);
  await win.click('#backBtn');
  await win.waitForSelector('.card');
  await win.click('#importBtn');
  await win.waitForFunction(() => document.getElementById('toast').textContent.includes('already have this version'), null, { timeout: 10000 });
  ok((await win.$$('.card')).length === 1, 'opening your own unchanged file is recognised, not added twice');
  ok(typeof data.project.uid === 'string' && data.project.updated > 0, '.dance file carries the number\'s id and version');
  const edited = path.join(tmp, 'Spotlight-edited.dance');
  const writeVersion = (file, patch) => { const z = new AdmZip(); z.addFile('project.json', Buffer.from(JSON.stringify({ ...data, project: { ...data.project, ...patch } }))); z.writeZip(file); };
  writeVersion(edited, { title: 'Spotlight (edited on phone)', updated: data.project.updated + 60000, base: data.project.updated });
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, edited);
  await win.click('#importBtn');
  await win.waitForFunction(() => document.getElementById('toast').textContent.startsWith('Updated'), null, { timeout: 10000 });
  ok((await win.$$('.card')).length === 1 && (await win.textContent('#cards')).includes('Spotlight (edited on phone)'), 'a file edited elsewhere updates the number in place');
  // change it here too, then open another edited copy: both changed, so the app asks
  await win.click('.card [data-a="open"]'); await win.waitForSelector('#projView:not([hidden])');
  await win.fill('#pTitle', 'Spotlight (edited here)'); await win.waitForTimeout(400);
  await win.click('#backBtn'); await win.waitForSelector('.card');
  const other = path.join(tmp, 'Spotlight-other.dance');
  writeVersion(other, { title: 'Spotlight (edited by another teacher)', updated: data.project.updated + 120000, base: data.project.updated + 60000 });
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, other);
  await win.click('#importBtn');
  await win.waitForSelector('#importAsk:not([hidden])', { timeout: 10000 });
  ok((await win.textContent('#importAskText')).includes('was changed on this PC and in the file'), 'when both copies changed, the app asks what to do');
  await win.click('#iaBoth');
  await win.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 10000 });
  ok((await win.textContent('#cards')).includes('(from file)') && (await win.textContent('#cards')).includes('Received from a share file'), 'Keep both adds the file as a separate number');

  // library backup and restore
  const libPath = path.join(tmp, 'library.dancelib');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, libPath);
  await win.click('#backupBtn');
  await win.waitForFunction(() => document.getElementById('toast').textContent.startsWith('Backed up'), null, { timeout: 20000 });
  const lib = JSON.parse(new AdmZip(libPath).readAsText('library.json'));
  ok(lib.kind === 'library' && lib.projects.length === 2 && lib.rosters.length === 1, 'Back up library saves every song and saved class');
  const del = await win.$('.card:has-text("Received from a share file") [data-a="del"]'); await del.click(); await del.click();
  await win.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  await win.click('#restoreBtn');
  await win.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 10000 });
  ok((await win.textContent('#toast')).includes('1 new'), 'Restore brings back a deleted song');
  await win.selectOption('#libSort', 'az'); await win.waitForTimeout(300);
  const titles = await win.$$eval('.card h3', x => x.map(e => e.textContent));
  ok(titles.join('|') === [...titles].sort((a, b) => a.localeCompare(b)).join('|'), 'the library can be sorted A to Z');

  await win.screenshot({ path: path.join(tmp, 'library.png') });
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('Artifacts in ' + tmp);
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
