/* StageCore: the stage maths and drawing shared by the desktop app (app/stagecore.js) and the phone
   player (mobile/www/stagecore.js). The two copies must stay identical: edit app/stagecore.js, then
   run `npm run sync-core`. Everything here is pure: it reads a project and never changes it.

   Project fields this reads (all optional, so older .dance files still work):
     project.stage = {w, d, spike, labels, floor, bg}   stage size in feet, spike-mark spacing and numbering, floor look
     formation.paths[dancerId]  = [x, y]   control point of a curved path INTO this formation (feet)
     formation.timing[dancerId] = [a, b]   this dancer moves from count a to count b of the travel (0 = travel start)
     formation.face[dancerId]   = degrees  which way the dancer faces: 0 front, 90 stage left, 180 back, 270 stage right
     formation.ease             = 'smooth' | 'steady'
     formation.note             = text shown with the formation */
(function (root) {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DEF = { w: 36, d: 24, spike: 4, labels: 'pairs', floor: 'dark', bg: null };
  const STAGE_PRESETS = [
    { id: 'studio', label: 'Studio (30 × 20 ft)', w: 30, d: 20 },
    { id: 'standard', label: 'Standard stage (36 × 24 ft)', w: 36, d: 24 },
    { id: 'large', label: 'Large stage (40 × 30 ft)', w: 40, d: 30 },
    { id: 'gym', label: 'Gym floor (60 × 40 ft)', w: 60, d: 40 }
  ];
  const FLOORS = {
    dark: { label: 'Dark (default)', fill: 'var(--floor)', line: 'var(--floor-line)', ink: 'var(--floor-ink)', muted: 'var(--floor-muted)', solid: '#262B3B', solidLine: '#3A4157', solidInk: '#E9EBF4' },
    black: { label: 'Black marley', fill: '#141519', line: '#30333D', ink: '#EDEEF3', muted: '#9097AA', solid: '#141519', solidLine: '#30333D', solidInk: '#EDEEF3' },
    grey: { label: 'Grey marley', fill: '#5B606C', line: '#757B88', ink: '#FFFFFF', muted: '#D5D8E0', solid: '#5B606C', solidLine: '#757B88', solidInk: '#FFFFFF' },
    wood: { label: 'Wood', fill: '#8A5E36', line: '#A0734A', ink: '#FFF7EC', muted: '#F0DCC2', solid: '#8A5E36', solidLine: '#A0734A', solidInk: '#FFF7EC', planks: true },
    white: { label: 'White', fill: '#E7E4DC', line: '#C9C5BA', ink: '#1C1F28', muted: '#5F6371', solid: '#E7E4DC', solidLine: '#C9C5BA', solidInk: '#1C1F28' },
    photo: { label: 'My own picture', fill: '#262B3B', line: 'rgba(255,255,255,.35)', ink: '#FFFFFF', muted: '#E3E6EE', solid: '#262B3B', solidLine: 'rgba(255,255,255,.35)', solidInk: '#FFFFFF' }
  };
  const LABELS = { pairs: 'Numbers by 2s (2, 4, 6, 8)', ones: 'Numbers by 1s (1, 2, 3, 4)', feet: 'Feet from centre' };

  function stageOf(p) {
    const s = Object.assign({}, DEF, (p && p.stage) || {});
    s.w = clamp(Math.round(+s.w || 36), 12, 80); s.d = clamp(Math.round(+s.d || 24), 8, 60);
    s.spike = [2, 3, 4, 5, 6].includes(+s.spike) ? +s.spike : 4;
    if (!LABELS[s.labels]) s.labels = 'pairs';
    if (!FLOORS[s.floor] || (s.floor === 'photo' && !s.bg)) s.floor = 'dark';
    return s;
  }
  // Geometry of the 400 × 310 stage drawing: the floor is centred and as big as fits 360 × 240.
  function geom(st, view) {
    const k = Math.min(360 / st.w, 240 / st.d), half = st.d * k / 2, top = 155 - half, bottom = 155 + half;
    return {
      k, view, top, bottom, left: 200 - st.w * k / 2, right: 200 + st.w * k / 2,
      toS: (x, y) => view === 'dan' ? [200 - x * k, top + y * k] : [200 + x * k, bottom - y * k],
      fromS: (X, Y) => view === 'dan' ? [(200 - X) / k, (Y - top) / k] : [(X - 200) / k, (bottom - Y) / k]
    };
  }
  function markLabel(st, n) {
    if (n === 0) return 'C';
    return st.labels === 'ones' ? String(n) : st.labels === 'feet' ? String(n * st.spike) : String(n * 2);
  }
  function marks(st) { const o = []; const m = Math.floor((st.w / 2 - 0.5) / st.spike); for (let n = -m; n <= m; n++) o.push({ x: n * st.spike, n: Math.abs(n) }); return o; }
  function spotText(st, x, y) {
    const depth = y < st.d / 3 ? 'Downstage' : y < st.d * 2 / 3 ? 'Centre' : 'Upstage', side = x > 0 ? 'stage left' : 'stage right', ax = Math.abs(x);
    const near = Math.round(ax / st.spike), unit = st.labels === 'feet' ? ' ft' : '';
    let spot;
    if (Math.abs(ax - near * st.spike) <= st.spike / 4) spot = near === 0 ? 'on centre' : `on ${markLabel(st, near)}${unit} ${side}`;
    else { const lo = Math.floor(ax / st.spike); spot = lo === 0 ? `between centre and ${markLabel(st, 1)}${unit} ${side}` : `between ${markLabel(st, lo)} and ${markLabel(st, lo + 1)}${unit} ${side}`; }
    return `${depth}, ${spot}`;
  }
  const FACES = ['facing front', 'facing the front-left corner', 'facing stage left', 'facing the back-left corner', 'with your back to the audience', 'facing the back-right corner', 'facing stage right', 'facing the front-right corner'];
  const normDeg = a => ((Math.round(a) % 360) + 360) % 360;
  const faceText = deg => FACES[Math.round(normDeg(deg) / 45) % 8];
  // Stage left is the audience's right; as numbers, stage left is +x and upstage is +y.
  const faceVec = deg => { const r = deg * Math.PI / 180; return [Math.sin(r), -Math.cos(r)]; };

  /* ---------- motion ---------- */
  const EASE = { smooth: k => 0.5 - 0.5 * Math.cos(Math.PI * clamp(k, 0, 1)), steady: k => clamp(k, 0, 1) };
  const easeOf = f => EASE[f && f.ease] || EASE.smooth;
  function travelStart(p, i) { const F = p.formations; return i === 0 ? F[0].at : Math.max(F[i - 1].at, F[i].at - F[i].travel); }
  // When one dancer moves into formation i, in beats: [start, end] (staggered timing narrows the window).
  function moveWindow(p, i, id) {
    const f = p.formations[i], ts = travelStart(p, i), len = f.at - ts, t = f.timing && f.timing[id];
    if (!t || len <= 0) return [ts, f.at];
    let a = clamp(Math.round(+t[0] || 0), 0, len), z = clamp(t[1] == null ? len : Math.round(+t[1]), 0, len);
    if (z <= a) { if (a >= len) a = len - 1; z = a + 1; }
    return [ts + a, ts + z];
  }
  const qpt = (a, z, c, k) => { if (!c) return [a[0] + (z[0] - a[0]) * k, a[1] + (z[1] - a[1]) * k]; const u = 1 - k; return [u * u * a[0] + 2 * u * k * c[0] + k * k * z[0], u * u * a[1] + 2 * u * k * c[1] + k * k * z[1]]; };
  const angleLerp = (a, b, k) => { const d = ((b - a) % 360 + 540) % 360 - 180; return a + d * k; };
  const faceIn = (f, id) => (f && f.face && f.face[id]) || 0;
  function usesFacing(p) { return (p.formations || []).some(f => f.face && Object.values(f.face).some(v => normDeg(v) !== 0)); }
  // Where everyone is at beat b. pos/face per dancer; mv[id] is true while that dancer is actually moving.
  function stateAt(p, b) {
    const F = p.formations; if (!F || !F.length) return { pos: {}, face: {}, mv: {}, idx: -1, moving: false, b };
    let i = 0; while (i + 1 < F.length && F[i + 1].at <= b) i++;
    const c = F[i], n = F[i + 1], face = {};
    p.dancers.forEach(d => { face[d.id] = faceIn(c, d.id); });
    if (!n || b < c.at) return { pos: c.pos, face, mv: {}, idx: i, moving: false, b };
    const ts = travelStart(p, i + 1); if (b <= ts) return { pos: c.pos, face, mv: {}, idx: i, moving: false, b };
    const pos = {}, mv = {}, ef = easeOf(n);
    p.dancers.forEach(d => {
      const a = c.pos[d.id] || n.pos[d.id], z = n.pos[d.id] || a; if (!a) return;
      const [ws, we] = moveWindow(p, i + 1, d.id), k = we > ws ? clamp((b - ws) / (we - ws), 0, 1) : (b >= we ? 1 : 0), e = ef(k);
      pos[d.id] = qpt(a, z, n.paths && n.paths[d.id], e); face[d.id] = angleLerp(faceIn(c, d.id), faceIn(n, d.id), e);
      if (k > 0 && k < 1) mv[d.id] = true;
    });
    return { pos, face, mv, idx: i, next: i + 1, moving: true, ts, b };
  }
  // A dancer's path into formation i as points (feet), for drawing and spacing checks.
  function pathPoints(p, i, id, steps) {
    const F = p.formations; if (i <= 0 || !F[i]) return [];
    const a = F[i - 1].pos[id], z = F[i].pos[id]; if (!a || !z) return [];
    const c = F[i].paths && F[i].paths[id], o = []; steps = steps || 16;
    for (let s = 0; s <= steps; s++) o.push(qpt(a, z, c, s / steps));
    return o;
  }
  const midOf = (a, z, c) => qpt(a, z, c, 0.5);
  // Dragging the middle of a curve to m means the control point is 2m − (a+z)/2.
  const ctrlFromMid = (a, z, m) => [2 * m[0] - (a[0] + z[0]) / 2, 2 * m[1] - (a[1] + z[1]) / 2];
  function staggerTimings(p, i, order, moveLen) {
    const f = p.formations[i], len = f.at - travelStart(p, i); if (len <= 0) return null;
    const ids = p.dancers.map(d => d.id).filter(id => f.pos[id]); if (order === 'together' || ids.length < 2) return null;
    moveLen = clamp(Math.round(moveLen || Math.max(1, len / 2)), 1, len);
    const prev = p.formations[i - 1], at = id => (prev && prev.pos[id]) || f.pos[id];
    let groups;
    if (order === 'one') groups = p.dancers.filter(d => f.pos[d.id]).map(d => [d.id]);
    else {
      const key = { front: id => at(id)[1], back: id => -at(id)[1], right: id => at(id)[0], left: id => -at(id)[0] }[order] || (id => at(id)[1]);
      const sorted = ids.slice().sort((a, b) => key(a) - key(b)); groups = [];
      sorted.forEach(id => { const g = groups[groups.length - 1]; if (g && Math.abs(key(g[0]) - key(id)) <= 1.5) g.push(id); else groups.push([id]); });
    }
    const t = {}, n = groups.length, step = n > 1 ? (len - moveLen) / (n - 1) : 0;
    groups.forEach((g, gi) => { const a = Math.round(gi * step); g.forEach(id => { t[id] = [a, Math.min(len, a + moveLen)]; }); });
    return t;
  }

  /* ---------- props ---------- */
  const isOn = s => !!(s && s.on);
  function propMoved(a, z) { const A = isOn(a), Z = isOn(z); if (!A && !Z) return false; if (A !== Z) return true; return Math.hypot(a.x - z.x, a.y - z.y) > 0.4 || (a.rot || 0) !== (z.rot || 0); }
  const wingOf = (st, s) => ({ x: s.x < 0 ? -(st.w / 2 + 1.5) : st.w / 2 + 1.5, y: s.y, rot: s.rot || 0 });
  function propsAt(p, S) {
    const F = p.formations, out = {}; if (S.idx < 0) return out;
    const st = stageOf(p), c = F[S.idx], n = S.moving ? F[S.next] : null, k = n ? easeOf(n)((S.b - S.ts) / (n.at - S.ts)) : 0;
    (p.props || []).forEach(pr => {
      const a = (c.props || {})[pr.id];
      if (!n) { if (isOn(a)) out[pr.id] = { x: a.x, y: a.y, rot: a.rot || 0 }; return; }
      const z = (n.props || {})[pr.id]; if (!isOn(a) && !isOn(z)) return;
      if (!propMoved(a, z)) { out[pr.id] = { x: a.x, y: a.y, rot: a.rot || 0 }; return; }
      const fr = isOn(a) ? a : wingOf(st, z), to = isOn(z) ? z : wingOf(st, a);
      out[pr.id] = { x: fr.x + (to.x - fr.x) * k, y: fr.y + (to.y - fr.y) * k, rot: (fr.rot || 0) + ((to.rot || 0) - (fr.rot || 0)) * k, moving: true, mover: z ? z.mover : '' };
    });
    return out;
  }

  /* ---------- 2D stage drawing (SVG strings) ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function palette(st) { return FLOORS[st.floor] || FLOORS.dark; }
  // The floor, grid, spike marks and labels. opts: {view, big, markerId}
  function svgStatic(p, opts) {
    const st = stageOf(p), view = opts.view || 'aud', g = geom(st, view), P = palette(st), fs = opts.big ? 1.15 : 1;
    const [x0, y0] = g.toS(-st.w / 2, st.d), [x1, y1] = g.toS(st.w / 2, 0), fx = Math.min(x0, x1), fy = Math.min(y0, y1), fw = Math.abs(x1 - x0), fh = Math.abs(y1 - y0);
    const clip = `stclip-${opts.markerId || 'x'}`;
    let h = `<defs><clipPath id="${clip}"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="3"/></clipPath></defs><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="3" fill="${P.fill}"/>`;
    if (st.floor === 'photo' && st.bg) h += `<g clip-path="url(#${clip})"><image href="${esc(st.bg)}" x="${fx}" y="${fy}" width="${fw}" height="${fh}" preserveAspectRatio="xMidYMid slice" ${view === 'dan' ? `transform="rotate(180 ${fx + fw / 2} ${fy + fh / 2})"` : ''}/><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="rgba(10,12,22,.38)"/></g>`;
    if (P.planks) for (let x = -st.w / 2 + 2; x < st.w / 2; x += 2) { const [a, b] = g.toS(x, 0), [c, d] = g.toS(x, st.d); h += `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="#7A512D" stroke-width=".5" opacity=".6"/>`; }
    const third = [st.d / 3, st.d * 2 / 3];
    for (let y = 4; y < st.d; y += 4) { const [a, b] = g.toS(-st.w / 2, y), [c, d] = g.toS(st.w / 2, y); h += `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${P.line}" stroke-width=".6"/>`; }
    third.forEach(y => { const [a, b] = g.toS(-st.w / 2, y), [c, d] = g.toS(st.w / 2, y); h += `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${P.line}" stroke-width="1" stroke-dasharray="4 3"/>`; });
    const M = marks(st);
    for (let x = -Math.floor(st.w / 2 / (st.spike / 2)) * (st.spike / 2); x <= st.w / 2; x += st.spike / 2) {
      if (Math.abs(x) > st.w / 2 - 0.01) continue; const major = Math.abs(x / st.spike - Math.round(x / st.spike)) < 0.01;
      const [a, b] = g.toS(x, 0), [c, d] = g.toS(x, st.d); h += `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${x === 0 ? P.muted : P.line}" stroke-width="${x === 0 ? .9 : major ? .8 : .35}" ${x === 0 ? 'opacity=".55"' : ''}/>`;
    }
    const fr = view === 'aud' ? 1 : -1;
    M.forEach(m => { const [a, b] = g.toS(m.x, 0); h += `<rect x="${a - 3.5}" y="${b - 1.6}" width="7" height="3.2" fill="var(--tape-1, #F2C200)" transform="rotate(-6 ${a} ${b})"/><text x="${a}" y="${b + fr * 12 * fs + 3}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${(M.length > 15 ? 7 : 8.5) * fs}" fill="var(--floor-ink, #E9EBF4)">${markLabel(st, m.n)}</text>`; });
    [['DS', st.d / 6], ['CS', st.d / 2], ['US', st.d * 5 / 6]].forEach(([t, y]) => { const [a, b] = g.toS(-st.w / 2 + 1.1 * 10 / g.k, y); h += `<text x="${a}" y="${b + 3}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${6.5 * fs}" fill="${P.muted}">${t}</text>`; });
    const lab = (x, y, t, r) => `<text x="${x}" y="${y}" text-anchor="middle" font-family="Archivo, sans-serif" font-weight="700" font-size="${8 * fs}" letter-spacing="1.6" fill="var(--floor-muted, #8F97B3)" ${r ? `transform="rotate(${r} ${x} ${y})"` : ''}>${t}</text>`;
    const sx = Math.min(390, g.right + 10), sxl = Math.max(10, g.left - 10);
    h += view === 'aud' ? lab(200, g.top - 9, 'UPSTAGE') + lab(200, g.bottom + 29 * fs, 'AUDIENCE') + lab(sx, 155, 'STAGE LEFT', 90) + lab(sxl, 155, 'STAGE RIGHT', -90)
      : lab(200, g.top - 25 * fs + 2, 'AUDIENCE') + lab(200, g.bottom + 17, 'UPSTAGE') + lab(sx, 155, 'STAGE RIGHT', 90) + lab(sxl, 155, 'STAGE LEFT', -90);
    if (opts.markerId) h += `<defs><marker id="arr-${opts.markerId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--floor-ink, #E9EBF4)"/></marker></defs>`;
    return h;
  }
  // SVG path through a dancer's travel into formation i, in drawing coordinates.
  function svgPath(p, g, i, id) { const pts = pathPoints(p, i, id, 20).map(q => g.toS(q[0], q[1])); return pts.length ? 'M' + pts.map(q => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' L') : ''; }
  // A small pointer on the edge of a dancer's dot showing which way they face.
  function svgFacing(g, x, y, deg, r) {
    const v = faceVec(deg), o = g.toS(0, 0), q = g.toS(v[0], v[1]); let dx = q[0] - o[0], dy = q[1] - o[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const tx = x + dx * (r + 5), ty = y + dy * (r + 5), bx = x + dx * (r - 1), by = y + dy * (r - 1), px = -dy * 4, py = dx * 4;
    return `<path d="M${tx.toFixed(1)} ${ty.toFixed(1)}L${(bx + px).toFixed(1)} ${(by + py).toFixed(1)}L${(bx - px).toFixed(1)} ${(by - py).toFixed(1)}Z" fill="#FFFFFF" stroke="rgba(0,0,0,.45)" stroke-width=".7"/>`;
  }

  /* ---------- 3D audience view (canvas 2D, no libraries) ----------
     o: {yaw, pitch (degrees), highlight, names, dpr, colors:{bg1,bg2,ink,muted}} */
  const PROP_H = { chair: 1.5, stool: 2.2, box: 1.5, bench: 1.5, table: 2.5, ladder: 5, hoop: 0.25, other: 2 };
  const imgCache = new Map();
  function imageFor(src) {
    if (!src || typeof Image === 'undefined') return null;
    let im = imgCache.get(src); if (!im) { im = new Image(); im.src = src; imgCache.set(src, im); if (imgCache.size > 6) imgCache.delete(imgCache.keys().next().value); }
    return im.complete && im.naturalWidth ? im : null;
  }
  function preloadImage(src) {
    return new Promise(res => {
      if (!src || typeof Image === 'undefined') return res(null);
      let im = imgCache.get(src); if (!im) { im = new Image(); im.src = src; imgCache.set(src, im); }
      if (im.complete && im.naturalWidth) return res(im);
      im.addEventListener('load', () => res(im), { once: true }); im.addEventListener('error', () => res(null), { once: true });
    });
  }
  function shade(hex, f) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex; const n = parseInt(m[1], 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  }
  function camera(st, yaw, pitch) {
    const T = [0, 1.6, st.d * 0.45], R = Math.max(st.w * 0.8, st.d * 1.1) + 6, y = yaw * Math.PI / 180, pt = pitch * Math.PI / 180;
    const C = [T[0] + R * Math.sin(y) * Math.cos(pt), T[1] + R * Math.sin(pt), T[2] - R * Math.cos(y) * Math.cos(pt)];
    const f = norm([T[0] - C[0], T[1] - C[1], T[2] - C[2]]), r = norm(cross([0, 1, 0], f)), u = cross(f, r);
    return { C, f, r, u };
  }
  const norm = v => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Stage feet → world: x across, h up, y (depth) away from the audience.
  function render3D(c, box, p, S, PP, o) {
    o = o || {}; const st = stageOf(p), P = palette(st), dpr = o.dpr || 1;
    const yaw = clamp(o.yaw == null ? 0 : o.yaw, -75, 75), pitch = clamp(o.pitch == null ? 24 : o.pitch, 4, 75), cam = camera(st, yaw, pitch);
    const raw = (x, h, y) => { const v = [x - cam.C[0], h - cam.C[1], y - cam.C[2]], z = Math.max(0.5, dot(v, cam.f)); return [dot(v, cam.r) / z, -dot(v, cam.u) / z, z]; };
    // Fit the stage (with headroom for dancers and the back wall) into the box.
    const fitPts = [[-st.w / 2, 0, 0], [st.w / 2, 0, 0], [-st.w / 2, 0, st.d], [st.w / 2, 0, st.d], [-st.w / 2, 6.5, 0], [st.w / 2, 6.5, 0], [-st.w / 2, 7.5, st.d], [st.w / 2, 7.5, st.d], [0, -1.4, 0]].map(q => raw(q[0], q[1], q[2]));
    const minX = Math.min(...fitPts.map(q => q[0])), maxX = Math.max(...fitPts.map(q => q[0])), minY = Math.min(...fitPts.map(q => q[1])), maxY = Math.max(...fitPts.map(q => q[1]));
    const sc = Math.min(box.w * 0.94 / (maxX - minX), box.h * 0.9 / (maxY - minY)), ox = box.x + box.w / 2 - (minX + maxX) / 2 * sc, oy = box.y + box.h / 2 - (minY + maxY) / 2 * sc;
    const pr = (x, h, y) => { const q = raw(x, h, y); return [ox + q[0] * sc, oy + q[1] * sc, q[2]]; };
    const ftPx = (x, y) => { const a = pr(x, 0, y), b = pr(x, 5, y); return Math.abs(a[1] - b[1]) / 5; };
    c.save(); c.beginPath(); c.rect(box.x, box.y, box.w, box.h); c.clip();
    const bg = c.createLinearGradient(0, box.y, 0, box.y + box.h); bg.addColorStop(0, (o.colors && o.colors.bg1) || '#0B0E18'); bg.addColorStop(1, (o.colors && o.colors.bg2) || '#1A1F31');
    c.fillStyle = bg; c.fillRect(box.x, box.y, box.w, box.h);
    const poly = (pts, fill, stroke, lw) => { c.beginPath(); pts.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath(); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw || 1; c.stroke(); } };
    // back wall (cyc) and the stage lip
    const W2 = st.w / 2 + 3, cycTop = 11;
    const cyc = [pr(-W2, 0, st.d + 1), pr(W2, 0, st.d + 1), pr(W2, cycTop, st.d + 1), pr(-W2, cycTop, st.d + 1)];
    const cg = c.createLinearGradient(0, cyc[2][1], 0, cyc[0][1]); cg.addColorStop(0, '#1B2140'); cg.addColorStop(1, '#3A3F72'); poly(cyc, cg);
    poly([pr(-st.w / 2, 0, 0), pr(st.w / 2, 0, 0), pr(st.w / 2, -1.4, 0), pr(-st.w / 2, -1.4, 0)], '#090B12');
    // floor
    const fl = [pr(-st.w / 2, 0, 0), pr(st.w / 2, 0, 0), pr(st.w / 2, 0, st.d), pr(-st.w / 2, 0, st.d)];
    poly(fl, P.solid);
    const img = st.floor === 'photo' ? imageFor(st.bg) : null;
    if (img) {   // texture the floor with small affine-mapped triangles
      const NX = 8, NY = 6, iw = img.naturalWidth, ih = img.naturalHeight;
      const tri = (s0, s1, s2, d0, d1, d2) => {
        c.save(); c.beginPath(); c.moveTo(d0[0], d0[1]); c.lineTo(d1[0], d1[1]); c.lineTo(d2[0], d2[1]); c.closePath(); c.clip();
        const den = s0[0] * (s1[1] - s2[1]) + s1[0] * (s2[1] - s0[1]) + s2[0] * (s0[1] - s1[1]); if (Math.abs(den) < 1e-9) { c.restore(); return; }
        const a = (d0[0] * (s1[1] - s2[1]) + d1[0] * (s2[1] - s0[1]) + d2[0] * (s0[1] - s1[1])) / den, b = (d0[1] * (s1[1] - s2[1]) + d1[1] * (s2[1] - s0[1]) + d2[1] * (s0[1] - s1[1])) / den;
        const cc = (d0[0] * (s2[0] - s1[0]) + d1[0] * (s0[0] - s2[0]) + d2[0] * (s1[0] - s0[0])) / den, d = (d0[1] * (s2[0] - s1[0]) + d1[1] * (s0[0] - s2[0]) + d2[1] * (s1[0] - s0[0])) / den;
        const e = (d0[0] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[0] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[0] * (s0[0] * s1[1] - s1[0] * s0[1])) / den;
        const f = (d0[1] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[1] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[1] * (s0[0] * s1[1] - s1[0] * s0[1])) / den;
        c.transform(a, b, cc, d, e, f); c.drawImage(img, 0, 0); c.restore();
      };
      for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
        const sx0 = iw * i / NX, sx1 = iw * (i + 1) / NX, sy0 = ih * j / NY, sy1 = ih * (j + 1) / NY;   // image top = upstage
        const X0 = -st.w / 2 + st.w * i / NX, X1 = -st.w / 2 + st.w * (i + 1) / NX, Y0 = st.d - st.d * j / NY, Y1 = st.d - st.d * (j + 1) / NY;
        const p00 = pr(X0, 0, Y0), p10 = pr(X1, 0, Y0), p01 = pr(X0, 0, Y1), p11 = pr(X1, 0, Y1);
        tri([sx0, sy0], [sx1, sy0], [sx0, sy1], p00, p10, p01); tri([sx1, sy0], [sx1, sy1], [sx0, sy1], p10, p11, p01);
      }
      poly(fl, 'rgba(10,12,22,.3)');
    }
    c.lineWidth = Math.max(0.6, dpr * 0.7); c.strokeStyle = P.solidLine;
    const line = (a, b) => { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); };
    if (P.planks) { c.save(); c.strokeStyle = 'rgba(70,40,20,.35)'; for (let x = -st.w / 2 + 2; x < st.w / 2; x += 2) line(pr(x, 0, 0), pr(x, 0, st.d)); c.restore(); }
    for (let y = 4; y < st.d; y += 4) line(pr(-st.w / 2, 0, y), pr(st.w / 2, 0, y));
    marks(st).forEach(m => line(pr(m.x, 0, 0), pr(m.x, 0, st.d)));
    // spike marks on the front edge
    const fpx = ftPx(0, 0), fsz = clamp(fpx * 0.75, 8 * dpr, 15 * dpr);
    c.font = `600 ${fsz}px "JetBrains Mono", monospace`; c.textAlign = 'center'; c.textBaseline = 'top';
    marks(st).forEach(m => { const a = pr(m.x - 0.35, 0.01, 0.1), b = pr(m.x + 0.35, 0.01, 0.1), q = pr(m.x, 0, 0); c.strokeStyle = '#F2C200'; c.lineWidth = Math.max(2, fpx * 0.18); line(a, b); c.fillStyle = '#C9CDE0'; c.fillText(markLabel(st, m.n), q[0], q[1] + fpx * 0.5); });
    c.textBaseline = 'alphabetic';
    // shadows, then props and dancers from back to front
    const items = [], hl = o.highlight, facing = usesFacing(p);
    (p.props || []).forEach(prp => {
      const s = PP[prp.id]; if (!s) return;
      const r = (s.rot || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), w = prp.w / 2, d = prp.d / 2;
      const loc = prp.round ? Array.from({ length: 16 }, (_, i) => { const t = i / 16 * Math.PI * 2; return [Math.cos(t) * w, Math.sin(t) * d]; }) : [[-w, -d], [w, -d], [w, d], [-w, d]];
      const foot = loc.map(([lx, ly]) => [s.x + lx * cs - ly * sn, s.y - (lx * sn + ly * cs)]);
      items.push({ z: pr(s.x, 0, s.y)[2], draw: () => drawPrism(foot, PROP_H[prp.kind] || 2, prp.kind === 'chair' ? { s, cs, sn, w, d } : null, s.moving) });
    });
    p.dancers.forEach(d => { const q = S.pos[d.id]; if (!q) return; items.push({ z: pr(q[0], 0, q[1])[2], d, q }); });
    items.forEach(it => { if (!it.d) return; const a = pr(it.q[0], 0, it.q[1]), px = ftPx(it.q[0], it.q[1]); c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.ellipse(a[0], a[1], px * 1.0, px * 0.35, 0, 0, Math.PI * 2); c.fill(); });
    items.sort((a, b) => b.z - a.z);
    items.forEach(it => { if (it.draw) { c.globalAlpha = hl ? 0.55 : 1; it.draw(); c.globalAlpha = 1; } else drawDancer(it.d, it.q); });
    c.restore();

    function drawPrism(foot, h, chair, moving) {
      const base = foot.map(q => pr(q[0], 0, q[1])), top = foot.map(q => pr(q[0], h, q[1])), n = foot.length;
      const sides = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, mx = (foot[i][0] + foot[j][0]) / 2, my = (foot[i][1] + foot[j][1]) / 2;
        const ex = foot[j][0] - foot[i][0], ey = foot[j][1] - foot[i][1], nx = ey, ny = -ex;   // outward normal (stage coords)
        const cx = foot.reduce((s, q) => s + q[0], 0) / n, cy = foot.reduce((s, q) => s + q[1], 0) / n, out = (mx - cx) * nx + (my - cy) * ny >= 0 ? 1 : -1;
        const toCam = [cam.C[0] - mx, cam.C[2] - my]; if ((nx * toCam[0] + ny * toCam[1]) * out <= 0) continue;
        sides.push({ z: pr(mx, h / 2, my)[2], pts: [base[i], base[j], top[j], top[i]], lit: Math.abs(nx * out) > Math.abs(ny * out) ? 0 : 1 });
      }
      sides.sort((a, b) => b.z - a.z).forEach(sd => poly(sd.pts, sd.lit ? '#A57A45' : '#8B6436', '#5E4122', 0.6 * dpr));
      poly(top, '#C99A5B', moving ? '#F1DFBE' : '#6E4C28', (moving ? 1.4 : 0.6) * dpr);
      if (chair) {   // a backrest along the chair's upstage edge
        const { s, cs, sn, w, d } = chair, bk = [[-w, d], [w, d]].map(([lx, ly]) => [s.x + lx * cs - ly * sn, s.y - (lx * sn + ly * cs)]);
        poly([pr(bk[0][0], h, bk[0][1]), pr(bk[1][0], h, bk[1][1]), pr(bk[1][0], h + 1.6, bk[1][1]), pr(bk[0][0], h + 1.6, bk[0][1])], '#B4864D', '#5E4122', 0.6 * dpr);
      }
    }
    function drawDancer(d, q) {
      const dim = hl && hl !== d.id, a = pr(q[0], 0, q[1]), px = ftPx(q[0], q[1]), Hh = 5.3 * px, bw = 1.25 * px;
      c.globalAlpha = dim ? 0.3 : 1;
      if (hl === d.id) { c.strokeStyle = '#FFFFFF'; c.lineWidth = 2 * dpr; c.beginPath(); c.ellipse(a[0], a[1], px * 1.45, px * 0.5, 0, 0, Math.PI * 2); c.stroke(); }
      const deg = (S.face && S.face[d.id]) || 0, v = faceVec(deg), dir3 = [v[0], 0, v[1]], side = dot(dir3, cam.r), toward = -dot(dir3, cam.f);
      if (facing) {   // a short arrow on the floor in front of the dancer
        const tip = pr(q[0] + v[0] * 1.6, 0.02, q[1] + v[1] * 1.6), l = pr(q[0] + v[0] * 0.9 - v[1] * 0.35, 0.02, q[1] + v[1] * 0.9 + v[0] * 0.35), r2 = pr(q[0] + v[0] * 0.9 + v[1] * 0.35, 0.02, q[1] + v[1] * 0.9 - v[0] * 0.35);
        poly([tip, l, r2], 'rgba(255,255,255,.85)');
      }
      const x = a[0], y = a[1], legTop = y - Hh * 0.47, sh = y - Hh * 0.8, headR = Hh * 0.085, headY = y - Hh * 0.9;
      c.fillStyle = shade(d.color, -0.35);
      c.beginPath(); c.roundRect ? c.roundRect(x - bw * 0.42, legTop, bw * 0.36, Hh * 0.47, bw * 0.15) : c.rect(x - bw * 0.42, legTop, bw * 0.36, Hh * 0.47); c.fill();
      c.beginPath(); c.roundRect ? c.roundRect(x + bw * 0.06, legTop, bw * 0.36, Hh * 0.47, bw * 0.15) : c.rect(x + bw * 0.06, legTop, bw * 0.36, Hh * 0.47); c.fill();
      c.fillStyle = d.color; c.beginPath(); c.moveTo(x - bw * 0.5, sh); c.lineTo(x + bw * 0.5, sh); c.lineTo(x + bw * 0.36, legTop + Hh * 0.03); c.lineTo(x - bw * 0.36, legTop + Hh * 0.03); c.closePath(); c.fill();
      c.strokeStyle = shade(d.color, -0.3); c.lineWidth = bw * 0.16; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x - bw * 0.5, sh + Hh * 0.02); c.lineTo(x - bw * 0.62, sh + Hh * 0.3); c.moveTo(x + bw * 0.5, sh + Hh * 0.02); c.lineTo(x + bw * 0.62, sh + Hh * 0.3); c.stroke();
      c.fillStyle = shade(d.color, 0.55); c.beginPath(); c.arc(x, headY, headR, 0, Math.PI * 2); c.fill();
      // hair on the side facing away from the audience seat, a nose dot on the side they face
      if (toward < 0.6) { c.fillStyle = shade(d.color, -0.55); c.beginPath(); c.arc(x - side * headR * 0.35, headY - headR * 0.1, headR * (0.75 + 0.3 * Math.max(0, -toward)), 0, Math.PI * 2); c.fill(); }
      if (toward > -0.3) { c.fillStyle = shade(d.color, -0.5); c.beginPath(); c.arc(x + side * headR * 0.7, headY + headR * 0.05, Math.max(1, headR * 0.16), 0, Math.PI * 2); c.fill(); }
      if (o.names !== false) {
        const t = d.name, fz = clamp(px * 0.62, 9 * dpr, 14 * dpr); c.font = `600 ${fz}px Inter, sans-serif`; c.textAlign = 'center';
        const tw = c.measureText(t).width, ty = headY - headR - fz * 0.55;
        c.fillStyle = 'rgba(8,10,20,.62)'; c.fillRect(x - tw / 2 - 3 * dpr, ty - fz * 0.95, tw + 6 * dpr, fz * 1.25); c.fillStyle = '#FFFFFF'; c.fillText(t, x, ty);
      }
      c.globalAlpha = 1;
    }
  }

  const api = { DEF, STAGE_PRESETS, FLOORS, LABELS, clamp, stageOf, geom, marks, markLabel, spotText, faceText, faceVec, normDeg, usesFacing,
    travelStart, moveWindow, stateAt, pathPoints, midOf, ctrlFromMid, staggerTimings, isOn, propMoved, wingOf, propsAt,
    palette, svgStatic, svgPath, svgFacing, render3D, imageFor, preloadImage, shade, EASE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StageCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
