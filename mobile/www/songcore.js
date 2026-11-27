/* SongCore: listening to the music and matching up projects, shared by the desktop app (app/songcore.js) and the
   phone player (mobile/www/songcore.js). Keep the two copies identical: edit app/songcore.js, then `npm run sync-core`. */
(function (root) {
  'use strict';
  function computePeaks(buf){
    const d = buf.getChannelData(0), N = 1600, step = d.length/N, out = []; let max = 0;
    for (let i=0;i<N;i++){ let m=0; for (let j=Math.floor(i*step); j<Math.floor((i+1)*step); j+=2){ const x = Math.abs(d[j]); if (x>m) m=x; } out.push(m); if (m>max) max=m; }
    return out.map(v => max ? Math.round(v/max*1000)/1000 : 0);
  }
  function detectTempo(buf){
    const sr = buf.sampleRate, d = buf.getChannelData(0), hop = Math.max(1, Math.round(sr/200)), fps = sr/hop;
    const n = Math.min(Math.floor(d.length/hop), Math.floor(fps*120)), env = new Float32Array(n); let emax = 0;
    for (let f=0; f<n; f++){ let s=0; const a=f*hop; for (let j=0;j<hop;j++){ const x=d[a+j]||0; s+=x*x; } env[f]=Math.sqrt(s/hop); if (env[f]>emax) emax=env[f]; }
    if (!emax) return null;
    const on = new Float32Array(n); for (let f=1; f<n; f++) on[f] = Math.max(0, Math.log(1+100*env[f]/emax) - Math.log(1+100*env[f-1]/emax));
    const minLag = Math.floor(fps*60/200), maxLag = Math.ceil(fps*60/55); let best=-1, bestLag=minLag;
    for (let lag=minLag; lag<=maxLag; lag++){ let s=0; for (let i=0;i<n-lag;i++) s+=on[i]*on[i+lag]; s/=(n-lag); const bpm=60*fps/lag, w=Math.exp(-0.5*Math.pow(Math.log2(bpm/120)/0.9,2)); if (s*w>best){best=s*w; bestLag=lag;} }
    let bpm = 60*fps/bestLag; while (bpm<75) bpm*=2; while (bpm>165) bpm/=2;
    let bs=-1, bB=bpm, bP=0;
    for (let c=bpm*0.97; c<=bpm*1.03; c+=bpm*0.0015){ const p=fps*60/c; for (let ph=0; ph<p; ph++){ let s=0,k=0; for (let x=ph;x<n;x+=p){ s+=on[Math.round(x)]||0; k++; } s/=k; if (s>bs){bs=s; bB=c; bP=ph;} } }
    if (Math.abs(bB-Math.round(bB))<0.3) bB = Math.round(bB);
    const p = fps*60/bB; let st=0; for (let f=0; f<n; f++){ if (env[f]>0.08*emax){ st=f; break; } }
    const k = Math.max(0, Math.ceil((st-bP)/p - 0.3));
    return {bpm:Math.round(bB*10)/10, offset:Math.round((bP+k*p)/fps*1000)/1000};
  }
  /* Listens to the song beat by beat: finds which beat is "1" of the 8-count, then looks for places where the
     music changes (loudness, bass, brightness) at 8-count boundaries and names the parts: Intro, Verse, Chorus… */
  function analyzeSong(buf, bpm, offset, P, keepOffset){
    const sr = buf.sampleRate, d = buf.getChannelData(0), bl = 60/bpm, spb = Math.round(bl*sr), nb = Math.floor((d.length/sr - offset)/bl);
    if (nb < P*3) return null;
    const rms = new Float32Array(nb), low = new Float32Array(nb), hi = new Float32Array(nb), hit = new Float32Array(nb);
    let lp = 0; const a = Math.exp(-2*Math.PI*160/sr);
    for (let b = 0; b < nb; b++){
      const s0 = Math.round((offset + b*bl)*sr); let e = 0, el = 0, eh = 0, head = 0, prev = d[s0-1] || 0;
      for (let i = 0; i < spb; i += 2){ const x = d[s0+i] || 0; lp = a*lp + (1-a)*x; e += x*x; el += lp*lp; const df = x - prev; eh += df*df; prev = x; if (i < spb/8) head += x*x; }
      rms[b] = Math.sqrt(e/(spb/2)); low[b] = el/(e || 1); hi[b] = eh/(e || 1); hit[b] = head/(spb/16);
    }
    const mx = Math.max(...rms) || 1, feat = b => [Math.log(1e-4 + rms[b]/mx), low[b], Math.log(1e-4 + hi[b])];
    const win = (from, n) => { const o = [0,0,0]; let c = 0; for (let b = Math.max(0, from); b < Math.min(nb, from + n); b++){ const f = feat(b); o[0]+=f[0]; o[1]+=f[1]; o[2]+=f[2]; c++; } return c ? o.map(v => v/c) : null; };
    // which beat is 1: strong hits and changes in the music should land on phrase starts
    const hm = Math.max(...hit) || 1, sd = [0.6, 0.15, 0.5];
    const change = b => { const A = win(b-4, 4), B = win(b, 4); return A && B ? Math.hypot((A[0]-B[0])/sd[0], (A[1]-B[1])/sd[1], (A[2]-B[2])/sd[2]) : 0; };
    let shift = 0;
    if (!keepOffset){
      const score = k => { let s = 0, c = 0; for (let b = k; b < nb; b += P){ s += hit[b]/hm + 0.6*change(b); c++; } return c ? s/c : 0; };
      const sc = Array.from({length:P}, (_, k) => score(k)), best = sc.indexOf(Math.max(...sc));
      if (best > 0 && sc[best] > sc[0]*1.25) shift = best;
    }
    // step back whole 8-counts while there's already music playing before count 1
    while (shift >= P) shift -= P;
    if (shift > 0){ let pk = 0; for (let i = 0; i < d.length; i += 4) pk = Math.max(pk, Math.abs(d[i])); let i0 = 0; while (i0 < d.length && Math.abs(d[i0]) < 0.05*pk) i0++;
      const back = shift - P; if (offset + back*bl >= i0/sr - 0.1) shift = back; }
    const off = Math.max(0, offset + shift*bl), np = Math.floor((nb - Math.max(0, shift))/P);
    if (np < 3) return {offset:off, shift, sections:null};
    // one feature vector per 8-count, normalised across the song
    const V = []; for (let p = 0; p < np; p++) V.push(win(shift + p*P, P));   // shift can be negative: win() clips
    // normalise each feature by its median spread, so one very different part (a quiet intro) doesn't hide the rest
    const med = arr => { const o = arr.slice().sort((x, y) => x - y); return o[Math.floor(o.length/2)]; };
    const mid = [0,1,2].map(i => med(V.map(v => v[i]))), spread = [0,1,2].map(i => (med(V.map(v => Math.abs(v[i] - mid[i]))) || 0) * 1.4826 || Math.max(1e-3, Math.abs(mid[i])*0.05));
    const Z = V.map(v => v.map((x, i) => Math.max(-6, Math.min(6, (x - mid[i])/spread[i])))), dist = (u, v) => Math.hypot(u[0]-v[0], u[1]-v[1], u[2]-v[2]);
    const avg = (a, b) => { const o = [0,0,0]; let c = 0; for (let p = Math.max(0, a); p < Math.min(np, b); p++){ o[0]+=Z[p][0]; o[1]+=Z[p][1]; o[2]+=Z[p][2]; c++; } return c ? o.map(v => v/c) : null; };
    // change at each 8-count boundary: the 8-counts either side, and the pairs either side
    const nov = []; for (let p = 1; p < np; p++){ const A = avg(p-2, p), B = avg(p, p+2); nov.push({p, v: 0.5*dist(Z[p-1], Z[p]) + 0.5*(A && B ? dist(A, B) : 0)}); }
    const nmed = med(nov.map(x => x.v)), thr = Math.max(1.5, nmed * 0.8), cuts = [];
    nov.filter((x, i) => x.v > thr && x.v >= (nov[i-1] ? nov[i-1].v : 0) && x.v >= (nov[i+1] ? nov[i+1].v : 0)).sort((x, y) => y.v - x.v)
      .forEach(x => { if (cuts.length < 9 && cuts.every(c => Math.abs(c - x.p) >= 2)) cuts.push(x.p); });
    cuts.sort((x, y) => x - y);
    const bounds = [0, ...cuts, np], parts = [];
    for (let i = 0; i < bounds.length-1; i++){ const v = avg(bounds[i], bounds[i+1]); parts.push({start:bounds[i], len:bounds[i+1]-bounds[i], v, loud:v[0]}); }
    // group parts that sound alike
    const groups = []; parts.forEach(pt => { let g = groups.find(G => dist(G.v, pt.v) < 0.9); if (!g){ g = {v:pt.v, parts:[], loud:0}; groups.push(g); } g.parts.push(pt); pt.g = g; });
    groups.forEach(g => { g.loud = g.parts.reduce((s, x) => s + x.loud, 0)/g.parts.length; });
    const loudSorted = parts.map(x => x.loud).sort((x, y) => x - y), quiet = loudSorted[Math.floor(loudSorted.length/3)];
    const rep = groups.filter(g => g.parts.length > 1), chorus = (rep.length ? rep : groups).slice().sort((x, y) => y.loud - x.loud)[0];
    const order = ['Verse', 'Bridge', 'Break', 'Part D', 'Part E', 'Part F']; let oi = 0;
    groups.forEach(g => { g.name = g === chorus ? 'Chorus' : null; });
    parts.forEach((pt, i) => {
      if (i === 0 && parts.length > 2 && pt.loud <= quiet && pt.len <= 4 && pt.g !== chorus){ pt.name = 'Intro'; return; }
      if (i === parts.length-1 && parts.length > 2 && pt.loud <= quiet && pt.len <= 3 && pt.g !== chorus){ pt.name = 'Ending'; return; }
      if (!pt.g.name) pt.g.name = order[Math.min(oi++, order.length-1)];
      pt.name = pt.g.name;
    });
    const seen = {}, total = {}; parts.forEach(pt => { total[pt.name] = (total[pt.name]||0) + 1; });
    parts.forEach((pt, i) => { seen[pt.name] = (seen[pt.name]||0) + 1;
      if (total[pt.name] > 1 && seen[pt.name] > 1) pt.name = pt.name === 'Chorus' && i === parts.length-1 ? 'Final chorus' : `${pt.name} ${seen[pt.name]}`; });
    return {offset:off, shift, sections:parts.map(pt => ({name:pt.name, start:pt.start + 1}))};
  }

  /* Sync by file. Every project keeps a permanent uid. A .dance file carries the project's uid, when it was last
     changed (updated) and which version it started from (base). Opening a file with a uid you already have:
       same      you already have exactly this version
       update    yours is exactly the version the file started from: update yours in place
       older     the file is exactly the version yours started from (yours is newer)
       conflict  both were changed since they last matched: ask (replace yours, or keep both) */
  function importPlan(local, incoming) {
    const lu = +local.updated || 0, iu = +incoming.updated || 0, ib = +incoming.base || 0, lb = +local.base || 0;
    // Versions are compared for equality only, so phones and PCs with different clocks still match up.
    if (lu && lu === iu) return 'same';
    if (!lu || lu === ib) return 'update';
    if (iu && iu === lb) return 'older';
    return 'conflict';
  }

  const api = { computePeaks, detectTempo, analyzeSong, importPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SongCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
