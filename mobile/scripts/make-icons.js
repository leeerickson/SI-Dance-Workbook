// Renders the Android launcher icons and splash screens from one design.
// Run from mobile/: node scripts/make-icons.js   (needs playwright)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const res = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const BG = '#191E33';
const mark = `<g transform="rotate(-6 256 256)"><rect x="96" y="132" width="250" height="58" rx="6" fill="#F2C200"/><rect x="150" y="226" width="270" height="58" rx="6" fill="#E8508A"/><rect x="96" y="320" width="250" height="58" rx="6" fill="#19A7BC"/></g><circle cx="392" cy="138" r="34" fill="#F3F4FA"/>`;
const svg = (w, h, body) => `<html><body style="margin:0;background:transparent"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${body}</svg></body></html>`;
// Legacy square icon, round icon, adaptive foreground (art kept inside the middle 66%).
const legacy = s => svg(s, s, `<svg viewBox="0 0 512 512" width="${s}" height="${s}"><rect x="16" y="16" width="480" height="480" rx="104" fill="${BG}"/>${mark}</svg>`);
const round = s => svg(s, s, `<svg viewBox="0 0 512 512" width="${s}" height="${s}"><circle cx="256" cy="256" r="248" fill="${BG}"/><g transform="translate(40 40) scale(.84)">${mark}</g></svg>`);
const fg = s => svg(s, s, `<svg viewBox="0 0 512 512" width="${s}" height="${s}"><g transform="translate(110 110) scale(.57)">${mark}</g></svg>`);

const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

(async () => {
  const b = await chromium.launch();
  const shot = async (html, w, h, file, transparent = true) => {
    const p = await b.newPage({ viewport: { width: w, height: h } }); await p.setContent(html);
    await p.screenshot({ path: file, omitBackground: transparent }); await p.close();
  };
  for (const [d, k] of Object.entries(DENS)) {
    const dir = path.join(res, `mipmap-${d}`);
    await shot(legacy(Math.round(48 * k)), Math.round(48 * k), Math.round(48 * k), path.join(dir, 'ic_launcher.png'));
    await shot(round(Math.round(48 * k)), Math.round(48 * k), Math.round(48 * k), path.join(dir, 'ic_launcher_round.png'));
    await shot(fg(Math.round(108 * k)), Math.round(108 * k), Math.round(108 * k), path.join(dir, 'ic_launcher_foreground.png'));
  }
  // Splash screens: keep each file's size, dark background, mark in the middle.
  for (const dir of fs.readdirSync(res).filter(n => n.startsWith('drawable'))) {
    const f = path.join(res, dir, 'splash.png'); if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f), w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), s = Math.round(Math.min(w, h) * 0.32);
    await shot(svg(w, h, `<rect width="${w}" height="${h}" fill="${BG}"/><svg x="${(w - s) / 2}" y="${(h - s) / 2}" width="${s}" height="${s}" viewBox="0 0 512 512">${mark}</svg>`), w, h, f, false);
  }
  await b.close();
  fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`);
  console.log('icons and splash screens written');
})();
