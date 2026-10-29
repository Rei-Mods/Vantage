// Vantage - camera + scene state around one renderer (used by the GM window and the players' live view)
import {PovRenderer} from "./renderer.js";
import {buildWorld, buildStandees, floorAt, heightAt, coverAt, standAt, playFloor, floorFrame, KIND} from "./world.js";

const hash1 = x => { const s = Math.sin(x * 127.1 + 1.7) * 43758.5453; return s - Math.floor(s); };
const noise1 = x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; };
const hsv = (h, s, v) => { const f = n => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)]; };
/** a scene light at time t (s), following its Foundry animation: torches flicker, pulses breathe, sirens sweep, chroma cycles */
export function animLight(l, t, k = 0) {
  const a = l.anim; if (!a) return l;
  const sp = Math.max(0.1, a.speed) / 5, amp = Math.min(1, Math.max(0, a.intensity) / 10), ph = k * 1.731;
  let f = 1, col = null;
  switch (a.type) {
    case "torch": case "flame": case "fairy": case "starlight": case "smokepatch":
      f = 1 - amp * 0.6 * (noise1(t * 7 * sp + ph) * 0.7 + noise1(t * 19 * sp + ph * 3) * 0.3); break;
    case "chroma": case "rainbowswirl": case "radialrainbow": col = hsv((t * 0.12 * sp + k * 0.137) % 1, 0.85, 1); break;
    case "siren": case "revolving": f = 1 - amp * 0.85 * (1 - Math.pow(0.5 + 0.5 * Math.cos(t * 5 * sp + ph), 6)); break;
    case "fog": case "ghost": f = 1 - amp * 0.4 * (0.5 + 0.5 * Math.sin(t * 0.9 * sp + ph)); break;
    default: f = 1 - amp * 0.55 * (0.5 + 0.5 * Math.sin(t * 2.4 * sp + ph));   // pulse, wave, energy, emanation, dome...
  }
  const c = col ? [l.r, l.g, l.b].map((v, i) => v + (col[i] * Math.max(l.r, l.g, l.b, 0.6) - v) * Math.max(amp, 0.5)) : [l.r, l.g, l.b];
  return {...l, r: c[0], g: c[1], b: c[2], intensity: l.intensity * f};
}

/** lightning at time t (s): now and then a strike - a bright flash, a flicker, a fading afterglow (0 = none) */
export function flashAt(t) {
  let f = 0;
  const slot = 7.5, k0 = Math.floor(t / slot);
  for (const k of [k0, k0 - 1]) {
    if (hash1(k * 3.17 + 0.5) < 0.3) continue;   // some slots stay quiet
    const dt = t - (k * slot + hash1(k * 7.31 + 2.2) * 5.5);
    if (dt < 0 || dt > 1.4) continue;
    f = Math.max(f, Math.exp(-dt * 16) + (dt > 0.13 ? 0.7 * Math.exp(-(dt - 0.13) * 22) : 0) + (dt > 0.42 ? 0.35 * Math.exp(-(dt - 0.42) * 7) : 0));
  }
  return Math.min(1.2, f);
}

const D2R = Math.PI / 180;
const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class PovView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.r = new PovRenderer(canvas);
    this.opts = opts;               // {fogFt, trim, bloom, showHidden}
    this.cam = {mode: "eye", pos: [0, 0, 0], yaw: 0, pitch: -6, fov: 80, target: [0, 0, 0], dist: 70, orbitPitch: -40};
    this.lights = []; this.standees = []; this.selfId = null;
    this.cache = new Map();         // built worlds by "level|maxBottom" (big: keep only the last 2)
  }

  static key(sceneData, buildOpts) { return `${sceneData.viewLevel}|${buildOpts?.maxBottom ?? ""}`; }

  /** sceneData: see world.buildWorld; extra: {tokens, lights} */
  async load(sceneData, buildOpts) {
    const key = PovView.key(sceneData, buildOpts);
    let world = this.cache.get(key);
    if (world) this.cache.delete(key);
    else world = await buildWorld(sceneData, {...buildOpts, maxTex: this.r.maxTex});
    this.cache.set(key, world);
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    this.world = world;
    this.r.setWorld(this.world);
    this.sceneData = sceneData;
  }
  clearCache() { this.cache.clear(); }

  /** true when a higher level's floor covers this token (it stands under a ceiling) */
  underCeiling(tok) {
    const W = this.world; if (!W) return false;
    return coverAt(W, tok.x, tok.y) > (tok.elevation ?? 0) + 1;
  }

  async setTokens(tokens) {
    const ids = this.world.levelIds;
    tokens = tokens.filter(t => !t.level || !ids?.size || ids.has(t.level));
    const {atlas, list} = await buildStandees(this.world, tokens, {tiltDeg: this.opts.tiltDeg});
    this.r.setAtlas(atlas);
    // figures that moved glide to their new spot (about a third of a second), like tokens on the map
    const old = new Map(this.standees.map(s => [s.id, this.shown(s)])), now = this.clock();
    for (const s of list) {
      const o = old.get(s.id);
      if (o && Math.hypot(o.x - s.x, o.z - s.z) > 1 && Math.hypot(o.x - s.x, o.z - s.z) < 40 * this.world.gridPx) s.glide = {from: [o.x, o.y, o.z], t0: now, dur: 0.35};
    }
    this.standees = list;
  }
  /** seconds: the view's own clock when set (recorded clips), else real time */
  clock() { return this.time ?? performance.now() / 1000; }
  /** where a figure is drawn right now (part way along a glide) */
  shown(s) {
    const g = s.glide; if (!g) return s;
    const k = Math.max(0, Math.min(1, (this.clock() - g.t0) / g.dur)), e = k * k * (3 - 2 * k);
    if (k >= 1) { delete s.glide; return s; }
    return {...s, x: g.from[0] + (s.x - g.from[0]) * e, y: g.from[1] + (s.y - g.from[1]) * e, z: g.from[2] + (s.z - g.from[2]) * e};
  }
  /** the camera glides to a new eye position (the token you look through moved) */
  glideCam(from) { if (from) this._camGlide = {from: [...from], t0: this.clock(), dur: 0.35}; }
  /** a glide is under way: keep drawing */
  isMoving() { return !!this._camGlide || this.standees.some(s => s.glide); }

  setLights(lights) {
    const W = this.world;
    const vis = l => !l.levels?.length || !W.levelIds?.size || l.levels.some(id => W.levelIds.has(id));
    this.lights = lights.filter(vis).map(l => {
      // a light on a raised area / stairs / height-map slope sits on top of it, not buried inside
      const fl = standAt(W, l.x, l.y, l.elevation ?? 0) ?? floorAt(W, l.x, l.y);
      return {x: l.x, y: (Math.max(l.elevation ?? 0, fl) + 4) * W.ppf, z: l.y, radius: Math.max(1, l.range) * W.ppf * 1.8,
        r: l.color[0], g: l.color[1], b: l.color[2], intensity: 0.9 * (l.alpha ?? 0.5) + 0.3, anim: l.anim ?? null};
    });
  }

  /** anything that changes by itself (video map art, animated lights, weather): the window keeps drawing while true */
  isAnimated() {
    const W = this.world; if (!W) return false;
    return !!(W.hasVideo || this.lights.some(l => l.anim) || (this.opts.weather && this.opts.weather !== "none"));
  }
  /** start/stop video map art */
  play(on) { playFloor(this.world, on); }
  /** copy the current video frame into the floor texture */
  tickMedia() { const f = floorFrame(this.world); if (f) this.r.updateFloor(f); }

  // ---------------------------------------------------------------- camera
  eyeFrom(tok, {faceToward} = {}) {
    const W = this.world;
    const size = tok.size || 1;
    const eyeFt = size < 1 ? 3 : 5.5 * Math.pow(size, 0.8);
    this.cam.mode = "eye";
    // stand on whatever is built under the token (never bury the camera inside rock or a higher floor)
    // (on stairs or a raised area: the tread / top it stands on)
    const ground = standAt(W, tok.x, tok.y, tok.elevation ?? 0) ?? Math.max(tok.elevation ?? 0, heightAt(W, tok.x, tok.y));
    this.cam.pos = [tok.x, (ground + eyeFt) * W.ppf, tok.y];
    this.selfId = tok.id;
    if (faceToward) this.cam.yaw = Math.atan2(faceToward.y - tok.y, faceToward.x - tok.x) / D2R;
    else { const r = (tok.rotation ?? 0) * D2R; this.cam.yaw = Math.atan2(Math.cos(r), -Math.sin(r)) / D2R; }
    this.cam.pitch = -4;
  }
  /** the floor an overview looks at (ft): at elevation `elev` (a token's, or null = the level being viewed), whatever
   *  stands there (stairs, raised areas, height-map slopes) - so the cutaway is measured from the floor you see */
  groundAt(x, y, elev = null) {
    const W = this.world;
    const e = Number.isFinite(elev) ? elev : (W.viewElev ?? W.baseElev ?? 0);
    return standAt(W, x, y, e) ?? e;
  }
  /** overview around a point; elevationFt = a token's elevation, or null for the level being viewed */
  orbitAround(x, y, elevationFt = null, {yaw} = {}) {
    const W = this.world;
    this.cam.mode = "orbit";
    this.cam.targetElev = Number.isFinite(elevationFt) ? elevationFt : null;
    this.cam.target = [x, (this.groundAt(x, y, this.cam.targetElev) + 3) * W.ppf, y];
    if (yaw !== undefined) this.cam.yaw = yaw;
    this.selfId = null;
  }

  vectors() {
    const c = this.cam, W = this.world;
    let f, pos;
    if (c.mode === "orbit") {
      const p = c.orbitPitch * D2R, y = c.yaw * D2R;
      f = norm([Math.cos(y) * Math.cos(p), Math.sin(p), Math.sin(y) * Math.cos(p)]);
      const dist = c.dist * W.ppf;
      pos = [c.target[0] - f[0] * dist, c.target[1] - f[1] * dist, c.target[2] - f[2] * dist];
      this._camGlide = null;
    } else {
      const p = c.pitch * D2R, y = c.yaw * D2R;
      f = norm([Math.cos(y) * Math.cos(p), Math.sin(p), Math.sin(y) * Math.cos(p)]);
      pos = c.pos;
      const g = this._camGlide;
      if (g) {
        const k = Math.max(0, Math.min(1, (this.clock() - g.t0) / g.dur)), e = k * k * (3 - 2 * k);
        if (k >= 1) this._camGlide = null; else pos = pos.map((v, i) => g.from[i] + (v - g.from[i]) * e);
      }
    }
    const r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
    return {pos, f, r, u, fov: c.fov};
  }

  /** move in the camera's ground plane (ft); dz = forward, dx = right, dy = up */
  move(dxFt, dzFt, dyFt) {
    const W = this.world, y = this.cam.yaw * D2R;
    const fw = [Math.cos(y), Math.sin(y)], rt = [-Math.sin(y), Math.cos(y)];
    const t = this.cam.mode === "orbit" ? this.cam.target : this.cam.pos;
    t[0] += (fw[0] * dzFt + rt[0] * dxFt) * W.ppf;
    t[2] += (fw[1] * dzFt + rt[1] * dxFt) * W.ppf;
    t[1] += dyFt * W.ppf;
    // an overview glides up and down with the floor under it (stairs, raised areas, hills)
    if (this.cam.mode === "orbit") t[1] += ((this.groundAt(t[0], t[2], this.cam.targetElev) + 3) * W.ppf - t[1]) * 0.25;
  }

  // ---------------------------------------------------------------- draw
  render({forPlayers = false} = {}) {
    if (!this.world) return;
    const v = this.vectors();
    const showHidden = !forPlayers && this.opts.showHidden !== false;
    // nearest lights first (to what you're looking at: the eye, or the overview's target)
    const ref = this.cam.mode === "orbit" ? this.cam.target : v.pos;
    const t = this.time ?? this.clock();
    // animated lights follow the clock unless animation is off (then they hold still, as in Foundry with animation off)
    const live = this.animate !== false;
    const lights = this.lights.map((l, k) => live ? animLight(l, t, k) : l).sort((a, b) => Math.hypot(a.x - ref[0], a.z - ref[2]) - Math.hypot(b.x - ref[0], b.z - ref[2]));
    const gp = this.world.gridPx || this.world.ppf * 5;
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const st = this.standees.map(s => this.shown(s))
      .filter(s => s.id !== (this.cam.mode === "eye" ? this.selfId : null))
      .filter(s => showHidden || !s.hidden)
      .map(s => {
        let rim = [0, 0, 0];
        for (const l of lights.slice(0, 24)) {
          const d = Math.hypot(l.x - s.x, l.z - s.z);
          if (d < l.radius) { const k = (1 - d / l.radius) ** 2 * l.intensity; rim = rim.map((c, i) => c + [l.r, l.g, l.b][i] * k); }
        }
        const tint = rim.map(c => 0.85 + 0.25 * Math.min(1.5, c));
        const dist = Math.hypot(s.x - v.pos[0], s.z - v.pos[2]);
        // in eye view, figures right next to you fade so they don't fill the screen
        const near = this.cam.mode === "eye" ? 0.1 + 0.9 * smooth(1.2 * gp, 2.6 * gp, dist) : 1;
        return {...s, tint: [...tint, (s.hidden ? 0.5 : 1) * s.baseAlpha * near], dist};
      })
      .sort((a, b) => b.dist - a.dist)
      .slice(-this.r.NS);
    let cut = {cutT: 0, cutH: 1e9, cap: null};
    if (this.cam.mode === "orbit" && this.opts.cutaway !== false) {
      const W = this.world, tg = this.cam.target;
      // measured from the floor under the target (not the lowest level of the scene: on a scene with levels below,
      // that cut the whole floor you look at away into a dark slab)
      const gy = this.groundAt(tg[0], tg[2], this.cam.targetElev) * W.ppf;
      // 1) close to the camera, whatever reaches up near it is lowered (to 9 ft over that floor, or 6 ft under the camera)
      // 2) in a corridor from the camera to the target, whatever rises into the sight line is cut (Sims-style cutaway),
      //    so rock, upper floors and walls in between never hide the target - lower near the target, none on the floor itself
      const r = Math.max(12, Math.min(30, this.cam.dist * 0.2)) * W.ppf;
      cut = {cutT: this.cam.dist * W.ppf * 0.8, cutH: Math.max(gy + 9 * W.ppf, v.pos[1] - 6 * W.ppf),
        cap: [v.pos[0], v.pos[2], tg[0], tg[2]], capR: r, capH: gy + 0.5 * W.ppf, capTop: v.pos[1]};
    }
    // haze starts behind what an overview looks at, so a far-away overview isn't murky
    const fogStart = this.cam.mode === "orbit" ? this.cam.dist * 0.8 : 0;
    this._cut = cut; this._showHidden = showHidden;
    this.r.render(v, lights, st, {fogStart, ...this.opts, time: live ? t : 0, flash: live ? flashAt(t) : 0, hover: forPlayers ? null : this.hover ?? null, ...cut});
  }

  // ---------------------------------------------------------------- picking (play in 3D)
  /** the ray through a point of the canvas (nx, ny: 0..1 from the top left) */
  rayAt(nx, ny) {
    const v = this.vectors(), c = this.canvas, tanX = Math.tan(v.fov * D2R / 2), asp = c.height / c.width;
    const x = nx * 2 - 1, y = 1 - ny * 2;
    return {o: v.pos, d: norm([0, 1, 2].map(i => v.f[i] + x * tanX * v.r[i] + y * tanX * asp * v.u[i]))};
  }
  /** the overview's cutaway at a point (as the shader cuts it), so a click lands on what you see */
  cutLim(x, z, t) {
    const c = this._cut; if (!c) return Infinity;
    let lim = t < c.cutT ? c.cutH : Infinity;
    if (c.cap && c.capR > 0) {
      const [ax, az, bx, bz] = c.cap, abx = bx - ax, abz = bz - az, L2 = Math.max(abx * abx + abz * abz, 1e-6);
      const sv = ((x - ax) * abx + (z - az) * abz) / L2;
      if (sv < 1) { const ss = Math.max(sv, 0); if (Math.hypot(x - (ax + abx * ss), z - (az + abz * ss)) < c.capR) lim = Math.min(lim, c.capH + Math.max(c.capTop - c.capH, 0) * (1 - ss) * 0.6); }
    }
    return lim;
  }
  /** march the ray over the heights: the first thing it hits {t, x, y, z (px), kind, side} or null */
  marchHeights(o, d) {
    const W = this.world, hs = W.hs, hd = W.heightData, ppf = W.ppf, tex = 1 / hs;
    const lo = [0, (W.minH - 2) * ppf, 0], hi = [W.W, (W.maxH + 2) * ppf, W.H];
    let tn = 0.5, tf = Infinity;
    for (let i = 0; i < 3; i++) {
      const dd = Math.abs(d[i]) < 1e-9 ? 1e-9 : d[i], a = (lo[i] - o[i]) / dd, b = (hi[i] - o[i]) / dd;
      tn = Math.max(tn, Math.min(a, b)); tf = Math.min(tf, Math.max(a, b));
    }
    if (!(tf > tn)) return null;
    const hAt = (x, z, t) => {
      const xi = Math.floor(x * hs), zi = Math.floor(z * hs);
      if (xi < 0 || zi < 0 || xi >= W.hw || zi >= W.hh) return [-Infinity, 0];
      const k = zi * W.hw + xi; return [Math.min(hd[k * 2] * ppf, this.cutLim(x, z, t)), hd[k * 2 + 1]];
    };
    let tp = tn;
    for (let t = tn, i = 0; t <= tf && i < 40000; i++) {
      const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
      if (y < hAt(x, z, t)[0]) {
        let a = tp, b = t;
        for (let k = 0; k < 12; k++) { const m = (a + b) / 2; if (o[1] + d[1] * m < hAt(o[0] + d[0] * m, o[2] + d[2] * m, m)[0]) b = m; else a = m; }
        const px = o[0] + d[0] * b, py = o[1] + d[1] * b, pz = o[2] + d[2] * b, [h, kind] = hAt(px, pz, b);
        return {t: b, x: px, y: Math.min(py, h), z: pz, kind, side: py < h - 0.6 * ppf};
      }
      tp = t; t += Math.max(tex * 0.5, t * 0.0013);
    }
    return null;
  }
  /** a door near a spot (scene-rect px) within r px: {id, open, locked, secret, cx, cz, len} */
  doorNear(x, z, r) {
    const D = this.sceneData; if (!D) return null;
    const ids = this.world.levelIds;
    let best = null, bd = r;
    for (const w of D.walls ?? []) {
      if (!(w.door > 0) || !w.id) continue;
      if (w.door === 2 && !this._showHidden) continue;   // secret doors: the GM only
      if (w.levels?.length && ids?.size && !w.levels.some(id => ids.has(id))) continue;
      const ax = w.c[0] - D.ox, az = w.c[1] - D.oy, bx = w.c[2] - D.ox, bz = w.c[3] - D.oy;
      const abx = bx - ax, abz = bz - az, L2 = abx * abx + abz * abz || 1;
      const s = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / L2));
      const dist = Math.hypot(x - (ax + abx * s), z - (az + abz * s));
      if (dist < bd) { bd = dist; best = {id: w.id, open: w.ds === 1, locked: w.ds === 2, secret: w.door === 2, cx: (ax + bx) / 2, cz: (az + bz) / 2, len: Math.sqrt(L2)}; }
    }
    return best;
  }
  /** what is under a point of the canvas: {type: "token", id} | {type: "door", ...door} | {type: "floor", x, y (scene px), elev (ft)} */
  pick(nx, ny) {
    const W = this.world; if (!W) return null;
    const {o, d} = this.rayAt(nx, ny);
    const hit = this.marchHeights(o, d);
    let best = null, bt = hit ? hit.t : Infinity;
    for (const s0 of this.standees) {
      const s = this.shown(s0);
      if (this.cam.mode === "eye" && s.id === this.selfId) continue;
      if (s.hidden && !this._showHidden) continue;
      if (s.flat) {   // lying on the floor: where the ray meets its plane
        if (Math.abs(d[1]) < 1e-6) continue;
        const ts = (s.y + 0.1 * W.ppf - o[1]) / d[1];
        if (ts <= 0 || ts >= bt) continue;
        if (Math.hypot(o[0] + d[0] * ts - s.x, o[2] + d[2] * ts - s.z) < Math.max(s.w, s.h) * 0.5) { best = s; bt = ts; }
        continue;
      }
      // a standing card facing the camera (leaning back by its tilt), as the shader draws it
      let n = [o[0] - s.x, 0, o[2] - s.z]; const ln = Math.hypot(n[0], n[2]); if (ln < 1) continue; n = n.map(v => v / ln);
      const ta = (s.tilt ?? 0) * D2R, up = [-n[0] * Math.sin(ta), Math.cos(ta), -n[2] * Math.sin(ta)], nn = [n[0] * Math.cos(ta), Math.sin(ta), n[2] * Math.cos(ta)];
      const B = [s.x + n[0] * 0.5 * s.h * Math.sin(ta), s.y, s.z + n[2] * 0.5 * s.h * Math.sin(ta)];
      const den = d[0] * nn[0] + d[1] * nn[1] + d[2] * nn[2]; if (Math.abs(den) < 1e-5) continue;
      const ts = ((B[0] - o[0]) * nn[0] + (B[1] - o[1]) * nn[1] + (B[2] - o[2]) * nn[2]) / den;
      if (ts <= 0 || ts >= bt) continue;
      const P = [o[0] + d[0] * ts - B[0], o[1] + d[1] * ts - B[1], o[2] + d[2] * ts - B[2]];
      const br = norm(cross([-n[0], 0, -n[2]], [0, 1, 0]));
      const u = (P[0] * br[0] + P[2] * br[2]) / s.w + 0.5, v = 1 - (P[0] * up[0] + P[1] * up[1] + P[2] * up[2]) / s.h;
      if (u > 0.12 && u < 0.88 && v > 0.04 && v < 1) { best = s; bt = ts; }
    }
    if (best) return {type: "token", id: best.id, x: best.x, z: best.z, y: best.y, ring: best.ring};
    if (!hit) return null;
    const gp = W.gridPx;
    // a closed door you clicked on, or right on the line of an open one
    // (a door in the middle of a wall line may be built as wall: a click on the face right at it counts too)
    const onFace = hit.kind === KIND.door || (hit.side && (hit.kind === KIND.wall || hit.kind === KIND.door));
    const door = this.doorNear(hit.x, hit.z, onFace ? 0.4 * gp : 0.2 * gp);
    if (door && (onFace ? !door.open : door.open)) return {type: "door", ...door, y: hit.y};
    return {type: "floor", x: hit.x, y: hit.z, elev: hit.y / W.ppf, h: hit.y, side: hit.side, kind: hit.kind};
  }

  snapshot({width = 1600, quality = 0.82, forPlayers = true} = {}) {
    const c = this.canvas, ow = c.width, oh = c.height;
    const aspect = (ow && oh) ? ow / oh : 16 / 9;
    c.width = width; c.height = Math.round(width / aspect);
    this.render({forPlayers});
    const url = c.toDataURL("image/jpeg", quality);
    c.width = ow; c.height = oh;
    this.render();
    return url;
  }

  dispose() { this.r.dispose(); this.world = null; }
}
