// Vantage - which dark parts of a map become rock ("Raise dark areas as rock").
// Pure functions over plain arrays (no DOM, no Foundry) so they can be tested on their own; world.js calls them.
//
// Only real "nothing here" areas should rise: out-of-bounds black, cave rock, pillars. A dark floor (a night map, a neon
// club, dark sci-fi plating) must stay floor. Three things tell them apart:
//   1. flat: empty space is plain black with almost no texture; floors have grid lines, tiles, dirt, panel seams
//   2. where it is: rock touches the map's edge or sits behind walls; floor is where tokens stand and can walk to
//   3. how much: if rock that walls and tokens can't vouch for would cover much of the map, it is a dark map, not rock
//      (skipped unless the scene forces it on). Rock behind walls, out of every token's reach, always rises.

/** standard deviation of `lum` in a (2r+1)^2 box around each pixel (summed-area tables, so any radius costs the same) */
export function localStd(lum, w, h, r) {
  const W1 = w + 1, s1 = new Float64Array(W1 * (h + 1)), s2 = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let a = 0, b = 0;
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x]; a += v; b += v * v;
      s1[(y + 1) * W1 + x + 1] = s1[y * W1 + x + 1] + a;
      s2[(y + 1) * W1 + x + 1] = s2[y * W1 + x + 1] + b;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const A = s1[y1 * W1 + x1] - s1[y0 * W1 + x1] - s1[y1 * W1 + x0] + s1[y0 * W1 + x0];
      const B = s2[y1 * W1 + x1] - s2[y0 * W1 + x1] - s2[y1 * W1 + x0] + s2[y0 * W1 + x0];
      const m = A / n;
      out[y * w + x] = Math.sqrt(Math.max(0, B / n - m * m));
    }
  }
  return out;
}

/** step 1: dark AND flat. lum = the map's brightness (0-255), blurred = the same after a small blur. Returns 0/255 per pixel. */
export function flatDarkMask(lum, blurred, w, h, {thr = 26, pxPerFt = 1, flatStd = 5} = {}) {
  const r = Math.max(1, Math.round(1.0 * pxPerFt));   // texture is judged over about 2 ft
  const sd = localStd(lum, w, h, r);
  const m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) if (blurred[k] < thr && sd[k] < flatStd) m[k] = 255;
  return m;
}

/**
 * step 2 + 3: keep the dark patches that are rock, drop the ones that are floor.
 * mask: 0/255 (flat dark, after the opening), blurred: blurred brightness (to grow the kept rock back to the dark edge
 * the texture test trimmed), walls: Uint8 (1 = a sight-blocking wall) or null, tokens: pixel indices of token centres.
 * force: the scene says On, so a big dark area still rises.
 * Returns {mask, frac (part of the map that rises), skipped (true = unconfirmed rock would have covered more than maxFrac
 * of the map, so that part was left flat), unconfirmed (that part of the map), kept, dropped}.
 */
export function keepRock(mask, blurred, w, h, {thr = 26, pxPerFt = 1, walls = null, tokens = [], force = false, maxFrac = 0.35} = {}) {
  const N = w * h;
  // where tokens can walk: flood from each token, stopped by walls (doors are walked through)
  let reach = null;
  const starts = tokens.filter(k => k >= 0 && k < N && !(walls && walls[k]));
  if (walls && starts.length) {
    reach = new Uint8Array(N); const q = new Int32Array(N); let qh = 0, qt = 0, n = 0;
    for (const k of starts) if (!reach[k]) { reach[k] = 1; q[qt++] = k; n++; }
    while (qh < qt) {
      const k = q[qh++], x = k % w;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w];
      for (const j of nb) if (j >= 0 && j < N && !reach[j] && !walls[j]) { reach[j] = 1; q[qt++] = j; n++; }
    }
    // walls that don't close (no walls, or a gap) let the flood fill the whole map: then it tells us nothing
    let free = 0; for (let k = 0; k < N; k++) if (!walls[k]) free++;
    if (n > 0.9 * free) reach = null;
  }
  const tokenAt = new Set(tokens);
  // connected dark patches
  const lab = new Int32Array(N).fill(-1), out = new Uint8Array(N), q = new Int32Array(N);
  let kept = 0, dropped = 0;
  for (let s = 0; s < N; s++) {
    if (mask[s] < 128 || lab[s] >= 0) continue;
    let qh = 0, qt = 0; q[qt++] = s; lab[s] = s;
    let edge = false, token = false, reached = 0;
    while (qh < qt) {
      const k = q[qh++], x = k % w, y = (k / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (tokenAt.has(k)) token = true;
      if (reach?.[k]) reached++;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const j of nb) if (j >= 0 && mask[j] >= 128 && lab[j] < 0) { lab[j] = s; q[qt++] = j; }
    }
    const area = qt;
    // confirmed (255): walls keep every token out of it; unconfirmed (128): only the edge rule says so
    let keep, tag = 128;
    if (token) keep = false;                                   // a token stands on it: floor
    else if (reach) { keep = reached <= 0.5 * area; tag = 255; }   // behind walls: rock; where tokens can walk: floor
    else keep = edge;   // no walls + tokens to go by: only out at the map's edge (a lone dark blob mid-map is more likely a table than a pillar)
    if (keep) { for (let i = 0; i < qt; i++) out[q[i]] = tag; kept++; } else dropped++;
  }
  // grow the kept rock back out to where the dark actually ends (the texture test trims about 1 ft off every edge)
  const grow = Math.max(1, Math.round(1.5 * pxPerFt));
  let front = [];
  for (let k = 0; k < N; k++) if (out[k]) front.push(k);
  for (let g = 0; g < grow && front.length; g++) {
    const next = [];
    for (const k of front) {
      const x = k % w, y = (k / w) | 0;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const j of nb) if (j >= 0 && !out[j] && blurred[j] < thr && !tokenAt.has(j)) { out[j] = out[k]; next.push(j); }
    }
    front = next;
  }
  let un = 0; for (let k = 0; k < N; k++) if (out[k] === 128) un++;
  const unconfirmed = un / N, skipped = !force && unconfirmed > maxFrac;
  let px = 0;
  for (let k = 0; k < N; k++) { if (out[k] === 128 && skipped) out[k] = 0; if (out[k]) { out[k] = 255; px++; } }
  return {mask: out, frac: px / N, skipped, unconfirmed, kept, dropped};
}
