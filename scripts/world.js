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
  // only the polygons' bounding box is drawn and read back (a whole-map canvas per region churns a lot of memory)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pts of polys) { if (pts.length < 6) continue; for (let i = 0; i < pts.length; i += 2) { const x = (pts[i] - data.ox) * hs, y = (pts[i + 1] - data.oy) * hs; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1); x1 = Math.min(hw, Math.ceil(x1) + 1); y1 = Math.min(hh, Math.ceil(y1) + 1);
  const bw = x1 - x0, bh = y1 - y0, out = [];
  if (!(bw > 0 && bh > 0)) return out;
  const [c, ctx] = canvas2d(bw, bh);
  ctx.setTransform(hs, 0, 0, hs, -data.ox * hs - x0, -data.oy * hs - y0);
  ctx.beginPath();
  for (const pts of polys) { if (pts.length < 6) continue; ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); }
  ctx.fillStyle = "#fff"; ctx.fill("evenodd");
  const d = ctx.getImageData(0, 0, bw, bh).data;
  for (let y = 0, j = 3; y < bh; y++) for (let x = 0; x < bw; x++, j += 4) if (d[j] > 127) out.push((y0 + y) * hw + x0 + x);
  return out;   // row by row: already in order
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
  const slabCeil = new Uint8Array(hw * hh);   // 1 = the slab is the ceiling of a room (the floor of a level above): wears the wall skin
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
      else { addSlab(k, elev - 0.5, elev); slabCeil[k] = 1; }   // a level over the viewer's head: a ceiling you can see from below
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
  const fullWall = new Uint8Array(hw * hh);   // pixels of full-height walls (they rise to meet a higher ceiling)
  const doorRecs = [];                        // every door, open or shut: the wall continues above it (a lintel)
  const brush = (x1, y1, x2, y2, fn) => {
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 0.5), r = Math.ceil(rad);
    for (let s = 0; s <= steps; s++) {
      const cx = x1 + (x2 - x1) * s / steps, cy = y1 + (y2 - y1) * s / steps;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rad * rad + 0.25) continue;
        const xi = Math.round(cx + dx), yi = Math.round(cy + dy);
        if (xi < 0 || yi < 0 || xi >= hw || yi >= hh) continue;
        fn(yi * hw + xi);
      }
    }
  };
  for (const wl of data.walls ?? []) {
    const secret = wl.door === 2;
    const isDoor = (wl.door ?? 0) > 0 && !secret;   // closed secret doors look like plain wall
    const open = (wl.door ?? 0) > 0 && wl.ds === 1;
    if (!(wl.door > 0) && !wl.sight) continue;  // see-through (platform edges, windows)
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
    if ((wl.door ?? 0) > 0 && (open || isDoor)) doorRecs.push({x1, y1, x2, y2, base});
    if (open) continue;   // an open door: just the gap (and the lintel over it, below)
    const top = base + (isDoor ? o.doorHeight : low ? Math.min(o.lowWallHeight, o.wallHeight) : o.wallHeight);
    const k = isDoor ? KIND.door : KIND.wall, full = !isDoor && !low;
    brush(x1, y1, x2, y2, idx => {
      if (kind[idx] === KIND.rock) return;
      if (top > heightFt[idx]) { heightFt[idx] = top; kind[idx] = k; }
      if (full && heightFt[idx] <= top + 0.01) fullWall[idx] = 1;
    });
  }

  // ---- raised areas that look like something: per pixel the look, which way the front faces, and the region
  const propData = new Uint8Array(hw * hh * 4), propInfo = [], propPics = [];
  const inR = propRegions.length ? new Uint8Array(hw * hh) : null;   // one mask, cleared after each region
  for (const [ri, pr] of propRegions.entries()) {
    if (ri >= 254) break;
    if (ri > 0) for (const k of propRegions[ri - 1].px) inR[k] = 0;
    for (const k of pr.px) inR[k] = 1;
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

  // ---- ceilings and roofs: rooms closed in by walls get a ceiling, seen from below (eye level, walking) and, in a token's
  // eye view, as a roof from above. "auto": a room is a place you can't reach from the edge of the map without crossing a
  // wall or door (gaps up to ~6 ft, like doorless arches, count as closed); "all": the whole map; "none": open sky. Regions
  // can force either way, or give an area its own ceiling height and roof shape (flat, slanted, peaked, pyramid).
  // Each ceiling is a plane: height (ft) = a + bx * x + bz * z (x, z in ft from the scene's top-left); at most 16 of them.
  const N = hw * hh;
  const ceilData = new Float32Array(N).fill(-1);   // ft at each point, -1 = open sky
  const ceilIdx = new Uint8Array(N);               // which plane (1..16), 0 = open sky
  const ceilPlanes = [];
  const planeOf = (a, bx = 0, bz = 0) => {
    a = Math.round(a * 100) / 100; bx = Math.round(bx * 1e4) / 1e4; bz = Math.round(bz * 1e4) / 1e4;
    let i = ceilPlanes.findIndex(P => Math.abs(P.a - a) < 0.01 && Math.abs(P.bx - bx) < 1e-4 && Math.abs(P.bz - bz) < 1e-4);
    if (i < 0) { if (ceilPlanes.length >= 16) return 0; ceilPlanes.push({a, bx, bz}); i = ceilPlanes.length - 1; }
    return i + 1;
  };
  const planeAt = (pi, k) => { const P = ceilPlanes[pi - 1], x = (k % hw + 0.5) / hs / ppf, z = (((k / hw) | 0) + 0.5) / hs / ppf; return P.a + P.bx * x + P.bz * z; };
  const ceilMode = o.ceiling ?? "auto";
  const roofed = new Uint8Array(N);   // 1 = gets a ceiling
  const rgSky = (data.regions ?? []).filter(rg => rg.polys?.length && (rg.sky === "open" || rg.sky === "roof" || (rg.dry && rg.sky !== "open")));
  const rgRoofs = (data.regions ?? []).filter(rg => rg.polys?.length && rg.sky !== "open" && ((Number.isFinite(rg.ceil) && rg.ceil > 0) || ["shed", "gable", "hip"].includes(rg.roof)));
  let wall = null;   // auto: 1 = a full wall or a door, 2 = a low wall (window, fence) - for telling rooms from fenced yards
  const forced = new Uint8Array(rgSky.length || rgRoofs.length ? N : 0);
  const regRoof = new Int16Array(rgRoofs.length ? N : 0);   // which region roof (1..) covers a point
  if (ceilMode !== "none" || rgSky.length || rgRoofs.length) {
    if (ceilMode === "all") roofed.fill(1);
    else if (ceilMode === "auto") {
      // what closes a room: walls you can't see through (and windows), doors open or shut; not invisible walls. Places
      // closed in mostly by low walls (fences, hedges, terrain walls) are told apart below and stay open to the sky
      wall = new Uint8Array(N);
      for (const wl of data.walls ?? []) {
        if (!((wl.door ?? 0) > 0 || wl.sight)) continue;
        const low = !((wl.door ?? 0) > 0) && !!wl.low;
        if (wl.levels?.length && !wl.levels.some(id => setIds.has(id))) continue;
        const x1 = (wl.c[0] - data.ox) * hs, y1 = (wl.c[1] - data.oy) * hs, x2 = (wl.c[2] - data.ox) * hs, y2 = (wl.c[3] - data.oy) * hs;
        const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 0.5) + 1;
        for (let s2 = 0; s2 <= n; s2++) {
          const cx = x1 + (x2 - x1) * s2 / n, cy = y1 + (y2 - y1) * s2 / n;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xi = Math.round(cx + dx), yi = Math.round(cy + dy);
            if (xi >= 0 && yi >= 0 && xi < hw && yi < hh) { const j = yi * hw + xi; wall[j] = low ? (wall[j] || 2) : 1; }
          }
        }
      }
      // distance to the nearest wall (chamfer 3-4, in thirds of a pixel)
      const dist = new Float32Array(N);
      for (let k = 0; k < N; k++) dist[k] = wall[k] ? 0 : 1e9;
      for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
        const k = y * hw + x; let v = dist[k]; if (!v) continue;
        if (x > 0) v = Math.min(v, dist[k - 1] + 3);
        if (y > 0) { v = Math.min(v, dist[k - hw] + 3); if (x > 0) v = Math.min(v, dist[k - hw - 1] + 4); if (x < hw - 1) v = Math.min(v, dist[k - hw + 1] + 4); }
        dist[k] = v;
      }
      for (let y = hh - 1; y >= 0; y--) for (let x = hw - 1; x >= 0; x--) {
        const k = y * hw + x; let v = dist[k]; if (!v) continue;
        if (x < hw - 1) v = Math.min(v, dist[k + 1] + 3);
        if (y < hh - 1) { v = Math.min(v, dist[k + hw] + 3); if (x < hw - 1) v = Math.min(v, dist[k + hw + 1] + 4); if (x > 0) v = Math.min(v, dist[k + hw - 1] + 4); }
        dist[k] = v;
      }
      const gap = 3 * Math.max(1.5, 3 * ppf * hs);   // 3 ft from any wall: openings up to ~6 ft wide don't let the outdoors in
      // the outdoors' core: reachable from the edge of the map while staying 3 ft clear of walls
      const lab = new Uint8Array(N), q = new Int32Array(N); let qh = 0, qt = 0;   // lab: 1 outdoors, 2 indoors
      const core = new Uint8Array(N);
      for (let k = 0; k < N; k++) core[k] = !wall[k] && dist[k] >= gap ? 1 : 0;
      const seedOut = k => { if (!lab[k] && core[k]) { lab[k] = 1; q[qt++] = k; } };
      for (let x = 0; x < hw; x++) { seedOut(x); seedOut((hh - 1) * hw + x); }
      for (let y = 0; y < hh; y++) { seedOut(y * hw); seedOut(y * hw + hw - 1); }
      while (qh < qt) {
        const k = q[qh++], x = k % hw;
        let j;
        if (x > 0 && !lab[j = k - 1] && core[j]) { lab[j] = 1; q[qt++] = j; }
        if (x < hw - 1 && !lab[j = k + 1] && core[j]) { lab[j] = 1; q[qt++] = j; }
        if (k >= hw && !lab[j = k - hw] && core[j]) { lab[j] = 1; q[qt++] = j; }
        if (k < N - hw && !lab[j = k + hw] && core[j]) { lab[j] = 1; q[qt++] = j; }
      }
      // rooms' cores: the rest of the open space; then both grow out to the walls together (an arch splits halfway)
      qh = 0; qt = 0;
      for (let k = 0; k < N; k++) {
        if (!lab[k] && core[k]) lab[k] = 2;
        if (lab[k]) q[qt++] = k;
      }
      while (qh < qt) {
        const k = q[qh++], x = k % hw, L = lab[k];
        let j;
        if (x > 0 && !lab[j = k - 1] && !wall[j]) { lab[j] = L; q[qt++] = j; }
        if (x < hw - 1 && !lab[j = k + 1] && !wall[j]) { lab[j] = L; q[qt++] = j; }
        if (k >= hw && !lab[j = k - hw] && !wall[j]) { lab[j] = L; q[qt++] = j; }
        if (k < N - hw && !lab[j = k + hw] && !wall[j]) { lab[j] = L; q[qt++] = j; }
      }
      // an interior map (by its name) whose outer walls aren't drawn: the map's edge is the building's wall, so the open
      // space reached from it is inside too (unless the walls already closed in most of the map)
      if (o.indoors === "in") {
        let inside = 0, open = 0;
        for (let k = 0; k < N; k++) if (!wall[k]) { if (lab[k] === 1) open++; else inside++; }
        if (inside < 0.3 * (inside + open)) for (let k = 0; k < N; k++) if (lab[k] === 1) lab[k] = 2;
      }
      for (let k = 0; k < N; k++) {
        if (!wall[k]) { if (lab[k] !== 1) roofed[k] = 1; continue; }   // indoors, or a closet too small to have a core
        // the inner half of a wall carries the ceiling up to its face
        const x = k % hw;
        for (let dy = -1; dy <= 1 && !roofed[k]; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, j = k + dy * hw + dx;
          if (xx < 0 || xx >= hw || j < 0 || j >= N) continue;
          if (!wall[j] && lab[j] !== 1) { roofed[k] = 1; break; }
        }
      }
    }
    // regions: "suppress weather" areas and "ceiling here" get one, "open sky here" never does
    for (const rg of rgSky) {
      const v = rg.sky === "open" ? 0 : 1;
      if (v === 1 && ceilMode === "none" && rg.sky !== "roof") continue;
      for (const k of rasterPolys(rg.polys, data, hs, hw, hh)) { roofed[k] = v; if (forced.length) forced[k] = v; }
    }

    // regions with their own ceiling height (and roof shape): always roofed, and planned below
    rgRoofs.forEach((rg, ri) => { for (const k of rasterPolys(rg.polys, data, hs, hw, hh)) { roofed[k] = 1; forced[k] = 1; regRoof[k] = ri + 1; } });

    // each roofed area (connected) gets one flat ceiling at wall height over its floor. The floor is the highest of: the
    // typical floor (height maps), the highest Level floor inside it, and a higher Level's floor right beside it with no
    // wall between - so a double-height hall or atrium under a gallery goes up to the top Level's roof as one ceiling
    const q = new Int32Array(N), mark = new Int32Array(N);
    const ok = new Uint8Array(N);   // 1 = still to place
    for (let k = 0; k < N; k++) ok[k] = roofed[k] && !(regRoof.length && regRoof[k]) && kind[k] !== KIND.rock && !(slabData[k * 2 + 1] > slabData[k * 2]) ? 1 : 0;
    let comp = 0;
    const isWallPx = k => kind[k] === KIND.wall || kind[k] === KIND.door || (wall && wall[k]);
    for (let k0 = 0; k0 < N; k0++) {
      if (!ok[k0]) continue;
      comp++;
      let qh = 0, qt = 0; q[qt++] = k0; ok[k0] = 0; mark[k0] = comp;
      while (qh < qt) {
        const k = q[qh++], x = k % hw;
        let j;
        if (x > 0 && ok[j = k - 1]) { ok[j] = 0; mark[j] = comp; q[qt++] = j; }
        if (x < hw - 1 && ok[j = k + 1]) { ok[j] = 0; mark[j] = comp; q[qt++] = j; }
        if (k >= hw && ok[j = k - hw]) { ok[j] = 0; mark[j] = comp; q[qt++] = j; }
        if (k < N - hw && ok[j = k + hw]) { ok[j] = 0; mark[j] = comp; q[qt++] = j; }
      }
      // closed in mostly by low walls (a fenced yard, a ring of hedges or terrain walls), not by real walls: no ceiling
      if (wall && o.indoors !== "in") {   // (on an interior map a cage of bars is still under the roof)
        let full = 0, low = 0, forcedAny = false;
        for (let i = 0; i < qt; i++) { const k = q[i], w = wall[k]; if (w === 1) full++; else if (w === 2) low++; if (forced.length && forced[k] === 1) forcedAny = true; }
        if (low > full && !forcedAny) continue;
      }
      const fl = [], step = Math.max(1, Math.floor(qt / 4096));
      let lvTop = -Infinity, ring = -Infinity;
      for (let i = 0; i < qt; i += step) { const k = q[i]; if (kind[k] !== KIND.wall && kind[k] !== KIND.door && kind[k] !== KIND.prop) fl.push(levelHeight[k]); }
      for (let i = 0; i < qt; i++) {
        const k = q[i], lb = coverSet[owner[k]]?.bottom; if (lb > lvTop) lvTop = lb;
        const x = k % hw;
        for (const j of [x > 0 ? k - 1 : -1, x < hw - 1 ? k + 1 : -1, k >= hw ? k - hw : -1, k < N - hw ? k + hw : -1]) {
          if (j < 0 || mark[j] === comp || isWallPx(j) || kind[j] === KIND.rock) continue;
          if (coverHeight[j] > ring) ring = coverHeight[j];
        }
      }
      fl.sort((a, b) => a - b);
      const base0 = Math.max(fl.length ? fl[fl.length >> 1] : (coverSet[owner[k0]]?.bottom ?? baseElev), lvTop);
      const floorFt = Math.max(base0, ring);
      const top = Math.round((floorFt + o.wallHeight) * 2) / 2;
      const pi = planeOf(top); if (!pi) continue;
      for (let i = 0; i < qt; i++) {
        const k = q[i];
        if (heightFt[k] >= top - 0.01 && kind[k] !== KIND.wall && kind[k] !== KIND.door) continue;   // something tall already reaches it
        ceilData[k] = top; ceilIdx[k] = pi;
      }
      // an atrium (open up to a higher Level beside it): the same roof goes on over that Level's floor in the room, so
      // looking up past a gallery's edge shows the roof, not the sky
      if (ring > base0 + 0.5) {
        let gh = 0, gt = 0;
        const grow = j => {   // (into the walls around it too, so they rise to meet it, but not past them)
          if (j < 0 || ceilIdx[j] || !roofed[j] || slabCeil[j] !== 1 || kind[j] === KIND.rock || mark[j] === comp) return;
          mark[j] = comp; ceilData[j] = top; ceilIdx[j] = pi; if (!isWallPx(j)) q[gt++] = j;
        };
        const seeds = []; for (let i = 0; i < qt; i++) seeds.push(q[i]);
        for (const k of seeds) { const x = k % hw; grow(x > 0 ? k - 1 : -1); grow(x < hw - 1 ? k + 1 : -1); grow(k >= hw ? k - hw : -1); grow(k < N - hw ? k + hw : -1); }
        while (gh < gt) { const k = q[gh++], x = k % hw; grow(x > 0 ? k - 1 : -1); grow(x < hw - 1 ? k + 1 : -1); grow(k >= hw ? k - hw : -1); grow(k < N - hw ? k + hw : -1); }
      }
    }

    // region roofs: a ceiling height over the region's floor; slanted (rises toward a side), peaked (a ridge down the middle,
    // along the longer side unless set) or pyramid (four faces up to a point)
    rgRoofs.forEach((rg, ri) => {
      const px = []; for (let k = 0; k < N; k++) if (regRoof[k] === ri + 1) px.push(k);
      if (!px.length) return;
      const fl = []; let lvTop = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const k of px) {
        if (kind[k] !== KIND.wall && kind[k] !== KIND.door && kind[k] !== KIND.prop) fl.push(levelHeight[k]);
        const lb = coverSet[owner[k]]?.bottom; if (lb > lvTop) lvTop = lb;
        const x = (k % hw + 0.5) / hs / ppf, z = (((k / hw) | 0) + 0.5) / hs / ppf;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      fl.sort((a, b) => a - b);
      const floorFt = Math.max(fl.length ? fl[fl.length >> 1] : baseElev, Number.isFinite(lvTop) ? lvTop : -Infinity);
      // the eaves at the ceiling height (empty: the walls'), the peak at Peak height (empty: half again as high)
      const ceil = Number.isFinite(rg.ceil) && rg.ceil > 0 ? rg.ceil : o.wallHeight, sloped = ["shed", "gable", "hip"].includes(rg.roof);
      const eaves = floorFt + ceil, peak = floorFt + (Number.isFinite(rg.ridge) && rg.ridge > ceil ? rg.ridge : sloped ? ceil * 1.5 : ceil);
      const rise = peak - eaves, W2 = Math.max(0.5, x1 - x0), H2 = Math.max(0.5, z1 - z0), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const dir = rg.roofDir === null || rg.roofDir === undefined || rg.roofDir === "" ? null : Number(rg.roofDir);
      let planes;   // [{a, bx, bz, pick(x, z)}]
      if (rg.roof === "shed" && rise > 0) {
        const d = dir ?? 0;   // the high side (compass): 0 = top of the map
        const pl = d === 90 ? planeOf(eaves - rise * x0 / W2, rise / W2, 0) : d === 270 ? planeOf(eaves + rise * x1 / W2, -rise / W2, 0)
          : d === 180 ? planeOf(eaves - rise * z0 / H2, 0, rise / H2) : planeOf(eaves + rise * z1 / H2, 0, -rise / H2);
        planes = () => pl;
      } else if (rg.roof === "gable" && rise > 0) {
        const alongZ = dir === null ? H2 >= W2 : (dir === 0 || dir === 180);   // the ridge runs top-bottom
        if (alongZ) { const s = rise / (W2 / 2), L = planeOf(peak - s * cx, s, 0), R = planeOf(peak + s * cx, -s, 0); planes = (x) => x < cx ? L : R; }
        else { const s = rise / (H2 / 2), T = planeOf(peak - s * cz, 0, s), B = planeOf(peak + s * cz, 0, -s); planes = (x, z) => z < cz ? T : B; }
      } else if (rg.roof === "hip" && rise > 0) {
        const sx = rise / (W2 / 2), sz = rise / (H2 / 2);
        const L = planeOf(peak - sx * cx, sx, 0), R = planeOf(peak + sx * cx, -sx, 0), T = planeOf(peak - sz * cz, 0, sz), B = planeOf(peak + sz * cz, 0, -sz);
        planes = (x, z) => { const ux = Math.abs(x - cx) / (W2 / 2), uz = Math.abs(z - cz) / (H2 / 2); return ux > uz ? (x < cx ? L : R) : (z < cz ? T : B); };
      } else { const pl = planeOf(eaves); planes = () => pl; }
      for (const k of px) {
        if (slabData[k * 2 + 1] > slabData[k * 2]) continue;   // a higher Level's floor over it comes first
        const x = (k % hw + 0.5) / hs / ppf, z = (((k / hw) | 0) + 0.5) / hs / ppf, pi = planes(x, z);
        if (!pi) continue;
        const h = planeAt(pi, k);
        if (heightFt[k] >= h - 0.01 && kind[k] !== KIND.wall && kind[k] !== KIND.door) continue;
        ceilData[k] = h; ceilIdx[k] = pi;
      }
    });

    // walls rise to meet a ceiling that's higher than they are (a tall hall, an atrium, the gable ends of a peaked roof), and
    // a higher Level's floor a little over their top; the highest one within the wall's thickness, so the whole wall rises
    const R = Math.ceil(rad) + 2;
    for (let k = 0; k < N; k++) {
      if (!fullWall[k] || kind[k] !== KIND.wall) continue;
      const h0 = heightFt[k];
      if (h0 < levelHeight[k] + o.wallHeight - 0.6) continue;   // not a full-height wall (a window, a fence)
      const x = k % hw, y = (k / hw) | 0; let m = -1;
      for (let yy = Math.max(0, y - R); yy <= Math.min(hh - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(hw - 1, x + R); xx++) {
        const j = yy * hw + xx;
        if (ceilIdx[j] && ceilData[j] > m) m = ceilData[j];
        if (slabCeil[j] === 1 && slabData[j * 2] > h0 && slabData[j * 2] - h0 < 6 && slabData[j * 2 + 1] > m) m = slabData[j * 2 + 1];
      }
      if (m > h0 + 0.25) heightFt[k] = m;
    }
  }
  const ceilHeights = ceilPlanes.map(P => P.a);   // (flat ones; for anything that only wants the levels)
  // what regions' roofs are covered with (0 = the scene's / what suits the walls, else ROOF_MATS index + 1)
  let roofMatPx = null;
  for (const rg of data.regions ?? []) {
    const m = (o.roofMats ?? []).indexOf(rg.roofMat); if (m < 0 || !rg.polys?.length) continue;
    roofMatPx ??= new Uint8Array(N);
    for (const k of rasterPolys(rg.polys, data, hs, hw, hh)) roofMatPx[k] = m + 1;
  }

  // ---- lintels: the wall carries on over every door (open or shut) up to the wall's top or the ceiling
  for (const dr of doorRecs) {
    const top0 = dr.base + o.doorHeight;
    const px = []; brush(dr.x1, dr.y1, dr.x2, dr.y2, k => px.push(k));
    // only in a wall: a door between full walls, or under a ceiling (not a gate in a fence)
    let inWall = false, roofedDoor = false;
    // the full wall at each end of the door: the lintel goes up as high as it does (walls risen to a tall ceiling too)
    const nearFull = (cx, cy) => { let m = -Infinity; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xi = Math.round(cx + dx), yi = Math.round(cy + dy); if (xi >= 0 && yi >= 0 && xi < hw && yi < hh && fullWall[yi * hw + xi] && heightFt[yi * hw + xi] > m) m = heightFt[yi * hw + xi]; } return m; };
    const L = Math.hypot(dr.x2 - dr.x1, dr.y2 - dr.y1) || 1, ex = (dr.x2 - dr.x1) / L * (rad + 2), ey = (dr.y2 - dr.y1) / L * (rad + 2);
    const endTop = Math.max(nearFull(dr.x1 - ex, dr.y1 - ey), nearFull(dr.x2 + ex, dr.y2 + ey));
    inWall = endTop > -Infinity;
    for (const k of px) if (ceilIdx[k]) { roofedDoor = true; break; }
    if (!inWall && !roofedDoor) continue;
    for (const k of px) {
      if (kind[k] === KIND.rock) continue;
      const top = Math.max(dr.base + o.wallHeight, ceilIdx[k] ? ceilData[k] : -Infinity, Math.min(endTop, dr.base + 200));
      if (top <= top0 + 0.25) continue;
      addSlab(k, top0, top); slabCeil[k] = 2;   // (under a higher Level's floor: joins it)
    }
  }

  // ---- where weather can't fall (ft): under a higher floor (also one hidden over the viewer's head), and in regions
  // with a "suppress weather" behaviour (whole column)
  const shelterFt = coverHeight.slice();
  if (hasSlabs) for (let k = 0; k < hw * hh; k++) if (slabData[k * 2 + 1] > slabData[k * 2]) shelterFt[k] = Math.max(shelterFt[k], slabData[k * 2 + 1]);
  if (ceilPlanes.length) for (let k = 0; k < hw * hh; k++) if (ceilData[k] > shelterFt[k]) shelterFt[k] = ceilData[k];
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
    standFt, standLo, standHi, heightMapLevels: world_hm, aoMap, shelterFt, propData, propInfo, propAtlas, slabData, slabCeil, ceilData, ceilIdx, ceilPlanes, ceilHeights, roofMatPx, hasSlabs, meanCol, maxBottom: Number.isFinite(o.maxBottom) ? o.maxBottom : null, maxH, minH, baseElev, viewLevel: view?.id,
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
