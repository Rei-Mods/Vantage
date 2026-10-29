// Vantage - turns a scene (levels, walls, map art) into a heightfield + floor texture.
// Pure functions over plain data so it can be tested outside Foundry; foundry.js feeds it.

export const KIND = {floor: 0, rock: 1, wall: 2, door: 3, stairs: 4, prop: 5, terrain: 6};
/** what a raised area can look like from the side (Region Config > Vantage > Looks like), in shader order (0 = plain) */
export const PROP_LOOKS = ["plain", "stretch", "arcade", "vending", "server", "bookshelf", "crate", "container", "console", "bar", "counter",
  "fridge", "lockers", "plinth", "barrels", "machine", "dresser", "display", "sandbags", "hay", "kiosk",
  "altar", "table", "bed", "hearth", "chest", "sofa", "atm", "jukebox", "reactor", "tires", "dumpster", "car", "shelving", "piano",
  "stall", "planter", "boulder", "ice", "crystals", "cage"];
/** how far back "leaning" figures lean (high-angle / top-down token art), degrees from upright (setting tiltDeg) */
export const TILT_DEG = 40;

/** pixel indices (heightfield grid) inside canvas-space polygons [[x0,y0,x1,y1,...], ...] (even-odd, so holes cut out) */
function rasterPolys(polys, data, hs, hw, hh) {
  const [c, ctx] = canvas2d(hw, hh);
  ctx.setTransform(hs, 0, 0, hs, -data.ox * hs, -data.oy * hs);
  ctx.beginPath();
  for (const pts of polys) { if (pts.length < 6) continue; ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); }
  ctx.fillStyle = "#fff"; ctx.fill("evenodd");
  const d = ctx.getImageData(0, 0, hw, hh).data, out = [];
  for (let k = 0, j = 3; k < hw * hh; k++, j += 4) if (d[j] > 127) out.push(k);
  return out;
}

const imgCache = new Map();
export function loadImageLike(src) {
  if (!src) return Promise.resolve(null);
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((resolve) => {
    if (/\.(webm|mp4|m4v|ogv)(\?|$)/i.test(src)) {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (e) { resolve(v); } };
      v.onseeked = () => resolve(v);
      v.onerror = () => resolve(null);
      v.src = src;
      setTimeout(() => resolve(v.readyState >= 2 ? v : null), 6000);
    } else {
      const im = new Image();
      if (/^https?:/i.test(src) && !src.startsWith(location.origin)) im.crossOrigin = "anonymous";
      im.onload = () => resolve(im); im.onerror = () => resolve(null);
      im.src = src;
    }
  });
  imgCache.set(src, p);
  return p;
}
export const isVideo = m => typeof HTMLVideoElement !== "undefined" && m instanceof HTMLVideoElement;
/** animated (video) map art: start or stop playing it */
export function playFloor(world, on) {
  for (const l of world?.floorLayers ?? []) if (isVideo(l.media)) {
    const v = l.media; v.loop = true; v.muted = true;
    if (on) { if (v.paused) v.play().catch(() => {}); } else if (!v.paused) v.pause();
  }
}
/** the floor as it looks right now: the video's current frame, or the levels re-composited (null = nothing to redraw) */
export function floorFrame(world) {
  const L = world?.floorLayers ?? [];
  if (!world?.hasVideo) return null;
  if (L.some(l => isVideo(l.media) && l.media.readyState < 2)) return null;   // no frame yet: keep the last one
  if (L.length === 1) {   // a single video goes straight to the GPU, unless it is bigger than this GPU's textures
    const [vw, vh] = mediaSize(L[0].media), mx = world.maxTex ?? 4096;
    if (vw <= mx && vh <= mx) return L[0].media;
  }
  const fc = world.floorCanvas;
  if (!world._frame) { world._frame = document.createElement("canvas"); world._frame.width = fc.width; world._frame.height = fc.height; }
  const c = world._frame, ctx = c.getContext("2d");
  ctx.fillStyle = "#0b0f14"; ctx.fillRect(0, 0, c.width, c.height);
  for (const l of L) { if (l.media) ctx.drawImage(l.media, 0, 0, c.width, c.height); else if (l.color) { ctx.fillStyle = l.color; ctx.fillRect(0, 0, c.width, c.height); } }
  return c;
}
export function mediaSize(m) { return m ? [m.naturalWidth || m.videoWidth || m.width, m.naturalHeight || m.videoHeight || m.height] : [0, 0]; }

function canvas2d(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return [c, c.getContext("2d", {willReadFrequently: true})]; }

function hashNoise(seed = 3) {
  const h = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return s - Math.floor(s); };
  return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; };
}

/**
 * data: {
 *   W, H            scene rect size (px), ppf: px per ft (distancePixels), ox, oy: scene rect origin on the canvas
 *   levels: [{id, bottom, src, color, visibility:[ids]}]   (bottom in ft)
 *   viewLevel: id
 *   walls: [{c:[x1,y1,x2,y2] canvas px, sight, door, ds, levels:[ids]}]
 * }
 * opts: {wallHeight, doorHeight, lowWallHeight, rockHeight, raiseDark, darkThreshold, maxTex, floorMax, heightMax,
 *        maxBottom}  maxBottom (ft): leave out levels whose bottom is above it ("ceiling" build for a token
 *        standing under a higher floor - a heightfield can't draw ceilings, so they'd bury the camera)
 */
export async function buildWorld(data, opts = {}) {
  const o = Object.assign({wallHeight: 12, doorHeight: 10, lowWallHeight: 4, rockHeight: 35, maxBottom: null, raiseDark: true, darkThreshold: 26, floorMax: 4096, heightMax: 2048, heightMapMax: 0}, opts);
  const {W, H, ppf} = data;
  const maxTex = Math.min(o.maxTex ?? 8192, 8192);
  const fs = Math.min(1, Math.min(o.floorMax, maxTex) / Math.max(W, H));
  const hs = Math.min(1, Math.min(o.heightMax, maxTex) / Math.max(W, H));
  const fw = Math.max(1, Math.round(W * fs)), fh = Math.max(1, Math.round(H * fs));
  const hw = Math.max(1, Math.round(W * hs)), hh = Math.max(1, Math.round(H * hs));

  // ---- which levels are drawn together: the viewed one + the ones it can see
  const all = [...(data.levels ?? [])].sort((a, b) => (a.bottom ?? 0) - (b.bottom ?? 0));
  let view = all.find(l => l.id === data.viewLevel) ?? all[0];
  let set = all;
  if (view) {
    const ids = new Set([view.id, ...(view.visibility ?? [])]);
    set = all.filter(l => ids.has(l.id));
  }
  // levels that sit over the viewer's head are dropped from the geometry (but still measured as "cover")
  const coverSet = set;
  if (Number.isFinite(o.maxBottom)) set = set.filter(l => l.id === view?.id || (l.bottom ?? 0) <= o.maxBottom + 0.01);
  const baseElev = set.length ? (set[0].bottom ?? 0) : 0;

  const world_hm = [];   // levels that got a height map
  const [floor, fctx] = canvas2d(fw, fh);
  fctx.fillStyle = "#0b0f14"; fctx.fillRect(0, 0, fw, fh);
  const heightFt = new Float32Array(hw * hh).fill(baseElev);
  const coverHeight = new Float32Array(hw * hh).fill(baseElev);   // floor height with ALL visible levels (for ceiling checks)
  const kind = new Uint8Array(hw * hh);
  const owner = new Int16Array(hw * hh);   // which level (index in coverSet) is the top floor at each pixel
  // where a token should stand (stairs treads, tops of raised areas): height, and the elevation range it applies to
  const standFt = new Float32Array(hw * hh).fill(NaN), standLo = new Float32Array(hw * hh), standHi = new Float32Array(hw * hh);
  const [lc, lctx] = canvas2d(hw, hh);
  const floorLayers = [];   // what the floor is painted from, in order (video art is redrawn while it plays)
  // overhangs: a floating slab (bottom, top ft) over the ground - bridge decks, roofs, balconies, the ceiling of a higher level
  const slabData = new Float32Array(hw * hh * 2).fill(-1);
  let hasSlabs = false;
  const addSlab = (k, lo, hi) => { const a = slabData[k * 2], b = slabData[k * 2 + 1]; if (b > a) { slabData[k * 2] = Math.min(a, lo); slabData[k * 2 + 1] = Math.max(b, hi); } else { slabData[k * 2] = lo; slabData[k * 2 + 1] = hi; } hasSlabs = true; };

  for (let i = 0; i < coverSet.length; i++) {
    const lv = coverSet[i];
    const used = set.includes(lv);
    const media = await loadImageLike(lv.src);
    const draw = (ctx, w, h) => {
      if (media) ctx.drawImage(media, 0, 0, w, h);
      else if (i === 0 && lv.color) { ctx.fillStyle = lv.color; ctx.fillRect(0, 0, w, h); }
    };
    if (used) { draw(fctx, fw, fh); floorLayers.push({media, color: i === 0 ? lv.color : null}); }
    if (i === 0 || !media) continue;
    // raise everything this level paints (alpha > 0.5) to its bottom elevation
    lctx.clearRect(0, 0, hw, hh); draw(lctx, hw, hh);
    const px = lctx.getImageData(0, 0, hw, hh).data;
    const elev = lv.bottom ?? 0;
    for (let k = 0, j = 3; k < hw * hh; k++, j += 4) if (px[j] > 127) {
      coverHeight[k] = elev;
      if (used) { heightFt[k] = elev; owner[k] = i; }
      else addSlab(k, elev - 0.5, elev);   // a level over the viewer's head: a ceiling you can see from below
    }
  }

  // ---- height maps (experimental): "<map>_height.webp/png/jpg" next to a level's art; white = tallest (heightMapMax ft)
  if (o.heightMapMax > 0) {
    for (let i = 0; i < coverSet.length; i++) {
      const lv = coverSet[i];
      if (!set.includes(lv) || !lv.heightSrcs?.length) continue;
      let hm = null;
      for (const s of lv.heightSrcs) { hm = await loadImageLike(s); if (hm) break; }
      if (!hm) continue;
      lctx.clearRect(0, 0, hw, hh);
      lctx.filter = `blur(${Math.max(0.7, 0.12 * ppf * hs)}px)`;   // soften the steps of 8-bit grey
      lctx.drawImage(hm, 0, 0, hw, hh); lctx.filter = "none";
      let px; try { px = lctx.getImageData(0, 0, hw, hh).data; } catch (e) { continue; }
      for (let k = 0, j = 0; k < hw * hh; k++, j += 4) {
        if (owner[k] !== i) continue;
        const g = (0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) / 255 * (px[j + 3] / 255);
        const v = Math.max(0, (g - 0.04) / 0.96);   // near-black = plain floor
        if (v <= 0) continue;
        const base = heightFt[k];
        heightFt[k] += v * o.heightMapMax;
        if (v * o.heightMapMax > 0.25) {
          kind[k] = KIND.terrain;
          // tokens standing here stand on the slope (stairs / raised areas below still win)
          standFt[k] = heightFt[k]; standLo[k] = base; standHi[k] = heightFt[k];
        }
      }
      world_hm.push(lv.id);
    }
  }
  const levelHeight = heightFt.slice();

  // ---- dark areas -> solid rock (pillars, cave walls, out-of-bounds black)
  if (o.raiseDark) {
    const [mc, mctx] = canvas2d(hw, hh);
    mctx.drawImage(floor, 0, 0, hw, hh);
    const src = mctx.getImageData(0, 0, hw, hh), sp = src.data;
    const thr = o.darkThreshold;
    const blurPx = Math.max(1, 6 * hs);
    // blur the colour first (like the preview's 6 px blur), then threshold
    const [bc, bctx] = canvas2d(hw, hh);
    bctx.filter = `blur(${blurPx}px)`; bctx.drawImage(mc, 0, 0);
    const bp = bctx.getImageData(0, 0, hw, hh).data;
    const mask = mctx.createImageData(hw, hh), mp = mask.data;
    for (let k = 0, j = 0; k < hw * hh; k++, j += 4) {
      const l = 0.299 * bp[j] + 0.587 * bp[j + 1] + 0.114 * bp[j + 2];
      const v = l < thr ? 255 : 0; mp[j] = mp[j + 1] = mp[j + 2] = v; mp[j + 3] = 255;
    }
    mctx.putImageData(mask, 0, 0);
    // opening: drop anything thinner than ~1 ft (blur + high threshold, then blur + low threshold)
    const open = Math.max(1, 0.55 * ppf * hs);
    const step = (filterPx, cut) => {
      bctx.filter = "none"; bctx.clearRect(0, 0, hw, hh); bctx.filter = `blur(${filterPx}px)`; bctx.drawImage(mc, 0, 0); bctx.filter = "none";
      const q = bctx.getImageData(0, 0, hw, hh); const d = q.data;
      for (let j = 0; j < d.length; j += 4) { const v = d[j] > cut ? 255 : 0; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
      mctx.putImageData(q, 0, 0);
    };
    step(open, 200); step(open, 55);
    // rounded tops: a wider blur of the final mask gives a 0..1 "depth inside the rock"
    const rp = mctx.getImageData(0, 0, hw, hh).data;
    bctx.clearRect(0, 0, hw, hh); bctx.filter = `blur(${Math.max(1, 3.2 * ppf * hs)}px)`; bctx.drawImage(mc, 0, 0); bctx.filter = "none";
    const dp = bctx.getImageData(0, 0, hw, hh).data;
    const noise = hashNoise(3), ns = 1 / Math.max(1, 64 * hs);
    for (let y = 0, k = 0; y < hh; y++) for (let x = 0; x < hw; x++, k++) {
      if (rp[k * 4] < 128) continue;
      const depth = Math.min(1, Math.max(0, (dp[k * 4] / 255 - 0.5) / 0.5));
      const prof = Math.max(0.12, Math.pow(depth, 0.45));
      heightFt[k] = levelHeight[k] + o.rockHeight * prof * (0.75 + 0.4 * noise(x * ns, y * ns));
      kind[k] = KIND.rock;
    }
  }

  // ---- stairs: Levels "change level" regions joining two built levels become stepped ramps
  const lvById = new Map(set.map(l => [l.id, l]));
  for (const rg of data.regions ?? []) {
    if (!rg.stairs || !rg.polys?.length) continue;
    const ends = (rg.levels ?? []).map(id => lvById.get(id)).filter(Boolean).map(l => l.bottom ?? 0);
    if (ends.length < 2) continue;
    const lo = Math.min(...ends), hi = Math.max(...ends);
    if (hi - lo < 1) continue;
    const px = rasterPolys(rg.polys, data, hs, hw, hh);
    if (px.length < 8) continue;
    // the stairs run along the region's long axis
    let mx = 0, my = 0; for (const k of px) { mx += k % hw; my += (k / hw) | 0; } mx /= px.length; my /= px.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const k of px) { const dx = k % hw - mx, dy = ((k / hw) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = Math.cos(th), ay = Math.sin(th);
    let smin = Infinity, smax = -Infinity;
    const sv = new Float32Array(px.length);
    px.forEach((k, i) => { const s = (k % hw - mx) * ax + (((k / hw) | 0) - my) * ay; sv[i] = s; if (s < smin) smin = s; if (s > smax) smax = s; });
    const runFt = (smax - smin) / hs / ppf;
    if (runFt < (hi - lo) * 0.35) continue;   // steeper than ~70 degrees: a ladder, leave it flat
    // which end is the top: the end whose floor just outside is closer to the upper level
    const out = 1.5 * ppf * hs;
    const floorBeyond = s => { const x = Math.round(mx + ax * s), y = Math.round(my + ay * s);
      return levelHeight[Math.min(hh - 1, Math.max(0, y)) * hw + Math.min(hw - 1, Math.max(0, x))]; };
    const upAtMax = Math.abs(floorBeyond(smax + out) - hi) <= Math.abs(floorBeyond(smin - out) - hi);
    const steps = Math.max(2, Math.round(runFt / 1.0));   // about 1 ft treads
    px.forEach((k, i) => {
      let t = (sv[i] - smin) / Math.max(1e-6, smax - smin); if (!upAtMax) t = 1 - t;
      const tread = Math.min(steps - 1, Math.floor(t * steps));
      const h = lo + (hi - lo) * (tread + 1) / steps;
      heightFt[k] = h; levelHeight[k] = h; kind[k] = KIND.stairs;
      standFt[k] = h; standLo[k] = lo; standHi[k] = hi;
    });
  }

  // ---- raised areas: regions with a Vantage height become blocks (crates, consoles, daises) or pits (negative)
  const propRegions = [];   // the ones that look like something (arcade cabinets, shelves...) or wear a front picture
  for (const rg of data.regions ?? []) {
    const hr = Number(rg.raise);
    if (!rg.polys?.length || !Number.isFinite(hr) || Math.abs(hr) < 0.1) continue;
    const under = Number(rg.under);
    const floating = hr > 0 && rg.under !== null && rg.under !== undefined && rg.under !== "" && Number.isFinite(under) && under > 0 && under < hr;
    const own = (rg.levels ?? []).filter(id => lvById.has(id));
    if (rg.levels?.length && !own.length) continue;   // it belongs to a level that isn't built in this view
    const px = rasterPolys(rg.polys, data, hs, hw, hh);
    if (!px.length) continue;
    let base;
    if (own.length) base = Math.min(...own.map(id => lvById.get(id).bottom ?? 0));
    else {
      // the floor it stands on: the median floor height under it (ignoring rock)
      const fl = px.filter(k => kind[k] !== KIND.rock).map(k => levelHeight[k]).sort((a, b) => a - b);
      base = fl.length ? fl[fl.length >> 1] : baseElev;
    }
    const top = base + hr;
    if (floating) {   // a slab from its underside up to its height: room to walk under it
      for (const k of px) { addSlab(k, base + under, top); standFt[k] = top; standLo[k] = top - 1.5; standHi[k] = top + 1; }
      continue;
    }
    const used = [];
    for (const k of px) {
      if (kind[k] === KIND.rock && heightFt[k] > top) continue;
      heightFt[k] = top; levelHeight[k] = top;
      kind[k] = hr > 0 ? KIND.prop : KIND.floor;
      standFt[k] = top; standLo[k] = Math.min(base, top); standHi[k] = Math.max(base, top);
      used.push(k);
    }
    const look = Math.max(0, PROP_LOOKS.indexOf(rg.look ?? "plain"));
    if (hr > 0 && used.length && (look > 0 || rg.pic)) propRegions.push({px: used, look, front: rg.front, pic: rg.pic ?? null, base, top});
  }

  // ---- walls: extrude sight-blocking walls and closed doors
  const setIds = new Set(set.map(l => l.id));
  const byId = new Map(all.map(l => [l.id, l]));
  const sampleLevel = (x, y) => { const xi = Math.min(hw - 1, Math.max(0, Math.round(x))), yi = Math.min(hh - 1, Math.max(0, Math.round(y))); return levelHeight[yi * hw + xi]; };
  const rad = Math.max(1, 0.25 * ppf * hs);
  for (const wl of data.walls ?? []) {
    const secret = wl.door === 2;
    const isDoor = (wl.door ?? 0) > 0 && !secret;   // closed secret doors look like plain wall
    if ((wl.door ?? 0) > 0 && wl.ds === 1) continue;  // any open door
    if (!isDoor && !secret && !wl.sight) continue;  // see-through (platform edges, windows)
    const low = !isDoor && !secret && wl.low;          // limited / proximity sight (windows, foliage): a low wall
    let base = null;
    if (wl.levels?.length) {
      const own = wl.levels.filter(id => setIds.has(id)).map(id => byId.get(id)?.bottom ?? 0);
      if (!own.length) continue;
      base = Math.min(...own);
    }
    const x1 = (wl.c[0] - data.ox) * hs, y1 = (wl.c[1] - data.oy) * hs, x2 = (wl.c[2] - data.ox) * hs, y2 = (wl.c[3] - data.oy) * hs;
    const len = Math.hypot(x2 - x1, y2 - y1); if (len < 0.01) continue;
    if (base === null) {
      // the wall sits on whatever floor is right beside it (highest of a few samples)
      const nx = -(y2 - y1) / len * (rad + 2), ny = (x2 - x1) / len * (rad + 2);
      base = -Infinity;
      for (const f of [0.1, 0.5, 0.9]) {
        const mx = x1 + (x2 - x1) * f, my = y1 + (y2 - y1) * f;
        base = Math.max(base, sampleLevel(mx, my), sampleLevel(mx + nx, my + ny), sampleLevel(mx - nx, my - ny));
      }
    }
    const top = base + (isDoor ? o.doorHeight : low ? Math.min(o.lowWallHeight, o.wallHeight) : o.wallHeight);
    const k = isDoor ? KIND.door : KIND.wall;
    const steps = Math.ceil(len / 0.5);
    const r = Math.ceil(rad);
    for (let s = 0; s <= steps; s++) {
      const cx = x1 + (x2 - x1) * s / steps, cy = y1 + (y2 - y1) * s / steps;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rad * rad + 0.25) continue;
        const xi = Math.round(cx + dx), yi = Math.round(cy + dy);
        if (xi < 0 || yi < 0 || xi >= hw || yi >= hh) continue;
        const idx = yi * hw + xi;
        if (kind[idx] === KIND.rock) continue;
        if (top > heightFt[idx]) { heightFt[idx] = top; kind[idx] = k; }
      }
    }
  }

  // ---- raised areas that look like something: per pixel the look, which way the front faces, and the region
  const propData = new Uint8Array(hw * hh * 4), propInfo = [], propPics = [];
  for (const [ri, pr] of propRegions.entries()) {
    if (ri >= 254) break;
    const inR = new Uint8Array(hw * hh); for (const k of pr.px) inR[k] = 1;
    // front: as chosen (compass degrees, 0 = top of the map), else the side with the most open floor in front of it
    let az = Number(pr.front);
    if (!(pr.front !== null && pr.front !== undefined && pr.front !== "" && Number.isFinite(az))) {
      const off = Math.max(2, Math.round(2.5 * ppf * hs)), dirs = [[0, -1, 0], [1, 0, 90], [0, 1, 180], [-1, 0, 270]];
      let best = -1; az = 180;
      for (const [dx, dy, a] of dirs) {
        let n = 0;
        for (const k of pr.px) {
          const x = k % hw, y = (k / hw) | 0, ex = x + dx, ey = y + dy;
          if (ex < 0 || ey < 0 || ex >= hw || ey >= hh || inR[ey * hw + ex]) continue;   // not an edge facing this way
          const fx = x + dx * off, fy = y + dy * off;
          if (fx < 0 || fy < 0 || fx >= hw || fy >= hh) continue;
          const f = fy * hw + fx;
          if (!inR[f] && (kind[f] === KIND.floor || kind[f] === KIND.terrain) && heightFt[f] <= pr.base + 0.5) n++;
        }
        if (n > best) { best = n; az = a; }
      }
    }
    const ar = az * Math.PI / 180, R = [-Math.cos(ar), -Math.sin(ar)];   // the viewer's right, facing the front
    let lo = Infinity, hi = -Infinity, flo = Infinity, fhi = -Infinity;
    const F = [Math.sin(ar), -Math.cos(ar)];   // toward the front
    for (const k of pr.px) {
      const x = (k % hw + 0.5) / hs, y = (((k / hw) | 0) + 0.5) / hs, u = x * R[0] + y * R[1], f = x * F[0] + y * F[1];
      if (u < lo) lo = u; if (u > hi) hi = u; if (f < flo) flo = f; if (f > fhi) fhi = f;
    }
    const g = Math.round(((az % 360) + 360) % 360 / 360 * 256) & 255;
    for (const k of pr.px) { propData[k * 4] = pr.look; propData[k * 4 + 1] = g; propData[k * 4 + 2] = ri + 1; }
    let pic = -1;
    if (pr.pic) { const img = await loadImageLike(pr.pic); if (img) { pic = propPics.length; propPics.push(img); } }
    propInfo.push({lo, w: Math.max(1, hi - lo), flo, fd: Math.max(1, fhi - flo), pic, seed: (ri * 0.618) % 1, az});
  }
  // regions with their own wall skin: the walls (and raised areas) inside wear it (alpha = skin + 1)
  for (const rg of data.regions ?? []) {
    const si = rg.skin ? (o.skins ?? []).indexOf(rg.skin) : -1;
    if (si < 0 || !rg.polys?.length) continue;
    for (const k of rasterPolys(rg.polys, data, hs, hw, hh)) propData[k * 4 + 3] = si + 1;
  }
  // front pictures in one atlas (portrait cells)
  let propAtlas = null;
  if (propPics.length) {
    const cw = 256, ch = 512, cols = Math.min(4, propPics.length), rows = Math.ceil(propPics.length / cols);
    const [ac, actx] = canvas2d(cw * cols, ch * rows);
    propPics.forEach((img, i) => {
      const [iw, ih] = mediaSize(img), x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      try { actx.drawImage(img, x, y, cw, ch); } catch (e) { /* not drawable */ }
      for (const pi of propInfo) if (pi.pic === i) pi.uv = [x / ac.width, y / ac.height, (x + cw) / ac.width, (y + ch) / ac.height, iw / ih];
    });
    propAtlas = ac;
  }

  // ---- where weather can't fall (ft): under a higher floor (also one hidden over the viewer's head), and in regions
  // with a "suppress weather" behaviour (whole column)
  const shelterFt = coverHeight.slice();
  if (hasSlabs) for (let k = 0; k < hw * hh; k++) if (slabData[k * 2 + 1] > slabData[k * 2]) shelterFt[k] = Math.max(shelterFt[k], slabData[k * 2 + 1]);
  for (const rg of data.regions ?? []) {
    if (!rg.dry || !rg.polys?.length) continue;
    for (const k of rasterPolys(rg.polys, data, hs, hw, hh)) shelterFt[k] = 1e4;
  }

  // ---- the map's average colour (tints the haze so it matches the scene: deep purple in a club, pale teal by a river)
  let meanCol = [0.03, 0.09, 0.11];
  try {
    const [mc, mx] = canvas2d(16, 16); mx.drawImage(floor, 0, 0, 16, 16);
    const md = mx.getImageData(0, 0, 16, 16).data; let r = 0, g = 0, b = 0;
    for (let j = 0; j < md.length; j += 4) { r += md[j]; g += md[j + 1]; b += md[j + 2]; }
    const n = md.length / 4 * 255; meanCol = [r / n, g / n, b / n];
  } catch (e) { /* tainted canvas: keep the default */ }

  // ---- corner shading, baked once: floors darken where walls, crates or rock rise around them (smooth, no banding)
  const aoMap = bakeAO(heightFt, hw, hh, ppf * hs);

  let maxH = -Infinity, minH = Infinity;
  const heightData = new Float32Array(hw * hh * 2);
  for (let k = 0; k < hw * hh; k++) {
    const v = heightFt[k]; heightData[k * 2] = v; heightData[k * 2 + 1] = kind[k];
    if (v > maxH) maxH = v; if (v < minH) minH = v;
    if (hasSlabs && slabData[k * 2 + 1] > slabData[k * 2] && slabData[k * 2 + 1] > maxH) maxH = slabData[k * 2 + 1];
  }
  return {W, H, ppf, gridPx: data.gridPx ?? ppf * 5, ox: data.ox, oy: data.oy, hs, hw, hh, floorCanvas: floor, heightData, heightFt, levelHeight, coverHeight,
    standFt, standLo, standHi, heightMapLevels: world_hm, aoMap, shelterFt, propData, propInfo, propAtlas, slabData, hasSlabs, meanCol, maxBottom: Number.isFinite(o.maxBottom) ? o.maxBottom : null, maxH, minH, baseElev, viewLevel: view?.id,
    viewElev: view?.bottom ?? baseElev,   // the floor of the level being viewed (ft): what an overview looks at
    floorLayers, hasVideo: floorLayers.some(l => isVideo(l.media)), maxTex: opts.maxTex,
    levelIds: new Set(set.map(l => l.id))};
}

/** box blur (two passes = a soft tent) of a float grid, radius r texels */
function blurGrid(src, w, h, r) {
  r = Math.max(1, Math.round(r));
  const tmp = new Float32Array(w * h), out = new Float32Array(src);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {   // horizontal
      const row = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += out[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += out[row + Math.min(w - 1, x + r + 1)] - out[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {   // vertical
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return out;
}
function bakeAO(hf, w, h, texPerFt) {
  const ao = new Uint8Array(w * h).fill(255);
  const radii = [[1.2, 0.5], [3, 0.33], [7, 0.17]];
  const occ = new Float32Array(w * h);
  for (const [rFt, wgt] of radii) {
    const b = blurGrid(hf, w, h, rFt * texPerFt * 0.6);
    for (let k = 0; k < w * h; k++) { const d = b[k] - hf[k]; if (d > 0) occ[k] += wgt * Math.min(1, d / (rFt * 0.45)); }
  }
  for (let k = 0; k < w * h; k++) ao[k] = Math.round(255 * Math.max(0.35, 1 - 0.85 * occ[k]));
  return ao;
}

/** height (ft) of the world under a scene-rect position (px) */
export function heightAt(world, x, y) {
  const xi = Math.min(world.hw - 1, Math.max(0, Math.round(x * world.hs))), yi = Math.min(world.hh - 1, Math.max(0, Math.round(y * world.hs)));
  return world.heightFt[yi * world.hw + xi];
}
/** floor height (ft) under a point if every visible level were built - higher than the token = it stands under a ceiling */
export function coverAt(world, x, y) {
  const a = world.coverHeight ?? world.levelHeight;
  const xi = Math.min(world.hw - 1, Math.max(0, Math.round(x * world.hs))), yi = Math.min(world.hh - 1, Math.max(0, Math.round(y * world.hs)));
  return a[yi * world.hw + xi];
}
/** where a token at this spot and elevation stands: a stair tread or the top of a raised area (ft), else null */
export function standAt(world, x, y, elev = 0) {
  if (!world.standFt) return null;
  const xi = Math.min(world.hw - 1, Math.max(0, Math.round(x * world.hs))), yi = Math.min(world.hh - 1, Math.max(0, Math.round(y * world.hs)));
  const k = yi * world.hw + xi, s = world.standFt[k];
  if (Number.isNaN(s)) return null;
  if (elev < world.standLo[k] - 1 || elev > world.standHi[k] + 1) return null;   // flying over it, or on another level
  return s;
}
export function floorAt(world, x, y) {
  const xi = Math.min(world.hw - 1, Math.max(0, Math.round(x * world.hs))), yi = Math.min(world.hh - 1, Math.max(0, Math.round(y * world.hs)));
  return world.levelHeight[yi * world.hw + xi];
}

// ------------------------------------------------------------------ standees
const CELL = 512;
/** tokens: [{id, src, x, y (scene-rect px centre), elevation(ft), size (grid units), disposition, hidden, alpha}] */
export async function buildStandees(world, tokens, {tiltDeg = TILT_DEG} = {}) {
  // each token may list several pictures (best first): use the first one that loads
  for (const t of tokens) {
    if (!t.srcs?.length) continue;
    for (const s of t.srcs) { if (await loadImageLike(s)) { t.src = s; break; } }
  }
  const uniq = [...new Set(tokens.map(t => t.src).filter(Boolean))].slice(0, 64);
  const cols = 8, rows = Math.max(1, Math.ceil(uniq.length / cols));
  const [atlas, actx] = canvas2d(cols * CELL, rows * CELL);
  const uvs = new Map();
  for (let i = 0; i < uniq.length; i++) {
    const m = await loadImageLike(uniq[i]); if (!m) continue;
    const [iw, ih] = mediaSize(m); if (!iw || !ih) continue;
    // crop to the visible pixels so feet touch the floor
    const k = Math.min(1, 1024 / Math.max(iw, ih));   // keep the aspect (tall portraits used to get squashed)
    const [tc, tctx] = canvas2d(Math.max(1, Math.round(iw * k)), Math.max(1, Math.round(ih * k)));
    tctx.drawImage(m, 0, 0, tc.width, tc.height);
    let bx0 = 0, by0 = 0, bx1 = tc.width, by1 = tc.height;
    try {
      const d = tctx.getImageData(0, 0, tc.width, tc.height).data;
      let x0 = tc.width, y0 = tc.height, x1 = -1, y1 = -1;
      for (let y = 0; y < tc.height; y += 2) for (let x = 0; x < tc.width; x += 2) if (d[(y * tc.width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 > x0 && y1 > y0) { bx0 = x0; by0 = y0; bx1 = Math.min(tc.width, x1 + 2); by1 = Math.min(tc.height, y1 + 2); }
    } catch (e) { /* tainted: use the whole image */ }
    const cw = bx1 - bx0, ch = by1 - by0;
    const sc = Math.min(CELL / cw, CELL / ch);
    const dw = cw * sc, dh = ch * sc;
    const cx = (i % cols) * CELL, cy = Math.floor(i / cols) * CELL;
    const ox = cx + (CELL - dw) / 2, oy = cy + (CELL - dh);   // bottom-aligned in its cell
    actx.drawImage(tc, bx0, by0, cw, ch, ox, oy, dw, dh);
    uvs.set(uniq[i], {uv: [ox / atlas.width, oy / atlas.height, (ox + dw) / atlas.width, (oy + dh) / atlas.height], aspect: dw / dh});
  }
  const list = [];
  for (const t of tokens) {
    const a = uvs.get(t.src); if (!a) continue;
    const size = t.size || 1;
    // loot: about knee-high, at most as wide as its square
    if (t.flat) {
      // an object with top-down art: lies flat on the floor, filling its squares like on the map
      const side = size * world.gridPx * 0.96;
      const w = a.aspect >= 1 ? side : side * a.aspect, d = a.aspect >= 1 ? side / a.aspect : side;
      list.push({id: t.id, x: t.x, z: t.y, y: (standAt(world, t.x, t.y, t.elevation ?? 0) ?? t.elevation ?? 0) * world.ppf, h: d, w, uv: a.uv, flat: true, rot: t.rotation ?? 0,
        ring: 0.47 * size * world.gridPx, ringColor: t.ringColor, hidden: t.hidden, baseAlpha: t.alpha ?? 1});
      continue;
    }
    const elev = standAt(world, t.x, t.y, t.elevation ?? 0) ?? t.elevation ?? 0;
    if (t.tilt) {
      // high-angle token art (drawn from above): a figure-sized card leaning back by about the art's camera angle,
      // so the figure stands instead of tipping toward you
      let h = (size < 1 ? 6.2 * size * 0.9 + 0.6 : 6.2 * Math.pow(size, 0.85)) * world.ppf;
      const maxW = size * world.gridPx * 1.15; if (h * a.aspect > maxW) h = maxW / a.aspect;   // wide art: no wider than its squares
      list.push({id: t.id, x: t.x, z: t.y, y: elev * world.ppf, h, w: h * a.aspect, uv: a.uv, tilt: tiltDeg,
        ring: 0.47 * size * world.gridPx, ringColor: t.ringColor, hidden: t.hidden, baseAlpha: t.alpha ?? 1});
      continue;
    }
    let hFt = t.loot ? 1.6 * Math.min(size, 1) : size < 1 ? 6.2 * size * 0.9 + 0.6 : 6.2 * Math.pow(size, 0.85);
    if (t.loot && hFt * a.aspect > 4.5 * Math.min(size, 1)) hFt = 4.5 * Math.min(size, 1) / a.aspect;
    const h = hFt * world.ppf;
    list.push({id: t.id, x: t.x, z: t.y, y: elev * world.ppf, h, w: h * a.aspect, uv: a.uv,
      ring: (t.loot ? 0.3 : 0.47) * size * world.gridPx, ringColor: t.loot ? null : t.ringColor, hidden: t.hidden, baseAlpha: t.alpha ?? 1});
  }
  return {atlas, list};
}
