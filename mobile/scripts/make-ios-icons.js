// Renders the iOS app icon (1024 square, opaque, no rounded corners: iOS adds them) and splash screens.
// Run from mobile/: node scripts/make-ios-icons.js   (needs playwright)
const { chromium } = require('playwright');
const path = require('path');
const xc = path.join(__dirname, '..', 'ios', 'App', 'App', 'Assets.xcassets');
const BG = '#191E33';
const mark = `<g transform="rotate(-6 256 256)"><rect x="96" y="132" width="250" height="58" rx="6" fill="#F2C200"/><rect x="150" y="226" width="270" height="58" rx="6" fill="#E8508A"/><rect x="96" y="320" width="250" height="58" rx="6" fill="#19A7BC"/></g><circle cx="392" cy="138" r="34" fill="#F3F4FA"/>`;
const page = (w, h, body) => `<html><body style="margin:0"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${body}</svg></body></html>`;
(async () => {
  const b = await chromium.launch();
  const shot = async (html, w, h, file) => { const p = await b.newPage({ viewport: { width: w, height: h } }); await p.setContent(html); await p.screenshot({ path: file }); await p.close(); };
  await shot(page(1024, 1024, `<rect width="1024" height="1024" fill="${BG}"/><svg x="112" y="112" width="800" height="800" viewBox="0 0 512 512">${mark}</svg>`), 1024, 1024, path.join(xc, 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
  const S = 2732, s = 900;
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'])
    await shot(page(S, S, `<rect width="${S}" height="${S}" fill="${BG}"/><svg x="${(S - s) / 2}" y="${(S - s) / 2}" width="${s}" height="${s}" viewBox="0 0 512 512">${mark}</svg>`), S, S, path.join(xc, 'Splash.imageset', f));
  await b.close();
  console.log('iOS icon and splash screens written');
})();
