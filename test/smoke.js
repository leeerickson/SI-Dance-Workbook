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

  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, sharePath);
  await win.click('[data-tab="share"]');
  await win.click('#makeShare');
  await win.waitForFunction(() => !document.getElementById('shareOut').hidden, null, { timeout: 10000 });
  const zip = new AdmZip(sharePath), data = JSON.parse(zip.readAsText('project.json'));
  ok(data.app === 'choreo-workbook' && data.format === 1, '.dance file is a zip with project.json');
  ok(data.project.formations.length === 8 && Object.keys(data.project.notes).length === 16, '.dance file holds 8 formations and 16 notes');
  ok(Array.isArray(data.project.props) && data.project.props.length === 2, '.dance file holds the props');

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

  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, sharePath);
  await win.click('#backBtn');
  await win.waitForSelector('.card');
  await win.click('#importBtn');
  await win.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 10000 });
  ok((await win.textContent('#cards')).includes('Received from a share file'), 'opening the .dance file adds it to the library');

  await win.screenshot({ path: path.join(tmp, 'library.png') });
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('Artifacts in ' + tmp);
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
