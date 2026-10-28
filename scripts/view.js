// Vantage - camera + scene state around one renderer (used by the GM window and the players' live view)
import {PovRenderer} from "./renderer.js";
import {buildWorld, buildStandees, floorAt, heightAt, coverAt, standAt} from "./world.js";

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
    this.standees = list;
  }

  setLights(lights) {
    const W = this.world;
    const vis = l => !l.levels?.length || !W.levelIds?.size || l.levels.some(id => W.levelIds.has(id));
    this.lights = lights.filter(vis).map(l => {
      // a light on a raised area / stairs / height-map slope sits on top of it, not buried inside
      const fl = standAt(W, l.x, l.y, l.elevation ?? 0) ?? floorAt(W, l.x, l.y);
      return {x: l.x, y: (Math.max(l.elevation ?? 0, fl) + 4) * W.ppf, z: l.y, radius: Math.max(1, l.range) * W.ppf * 1.8,
        r: l.color[0], g: l.color[1], b: l.color[2], intensity: 0.9 * (l.alpha ?? 0.5) + 0.3};
    });
  }

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
  orbitAround(x, y, elevationFt, {yaw} = {}) {
    const W = this.world;
    this.cam.mode = "orbit";
    this.cam.target = [x, (elevationFt + 3) * W.ppf, y];
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
    } else {
      const p = c.pitch * D2R, y = c.yaw * D2R;
      f = norm([Math.cos(y) * Math.cos(p), Math.sin(p), Math.sin(y) * Math.cos(p)]);
      pos = c.pos;
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
  }

  // ---------------------------------------------------------------- draw
  render({forPlayers = false} = {}) {
    if (!this.world) return;
    const v = this.vectors();
    const showHidden = !forPlayers && this.opts.showHidden !== false;
    // nearest lights first (to what you're looking at: the eye, or the overview's target)
    const ref = this.cam.mode === "orbit" ? this.cam.target : v.pos;
    const lights = [...this.lights].sort((a, b) => Math.hypot(a.x - ref[0], a.z - ref[2]) - Math.hypot(b.x - ref[0], b.z - ref[2]));
    const gp = this.world.gridPx || this.world.ppf * 5;
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const st = this.standees
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
      // 1) everything close to the camera is lowered to 9 ft over the target
      // 2) a corridor from the camera to the target is cut down to just above the target's floor (Sims-style cutaway),
      //    so rock, upper floors and walls between you and the target never hide it
      const r = Math.max(12, Math.min(30, this.cam.dist * 0.2)) * W.ppf;
      cut = {cutT: this.cam.dist * W.ppf * 0.8, cutH: tg[1] + 9 * W.ppf,
        cap: [v.pos[0], v.pos[2], tg[0], tg[2]], capR: r, capH: tg[1] - 2.5 * W.ppf};   // target is 3 ft over its floor
    }
    // haze starts behind what an overview looks at, so a far-away overview isn't murky
    const fogStart = this.cam.mode === "orbit" ? this.cam.dist * 0.8 : 0;
    this.r.render(v, lights, st, {fogStart, ...this.opts, ...cut});
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
