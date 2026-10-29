// Vantage - the GM's 3D window, the players' viewer, and snapshot/live sharing
import {PovView, camAt} from "./view.js";
import {followCamera, release as releaseSound} from "./sound.js";
import {MOD, L, setting, sceneData, viewLevelFor, tokensOf, lightsOf, buildOptions, viewOptions, lookOf, sceneFlag, weatherOf, rectOf, templatesOf, visionMask} from "./foundry.js";
import {WEATHER} from "./renderer.js";
const LOOK_KEYS = ["wallSkin", "mood", "sunAz", "lightColor", "weather", "path"];

const {ApplicationV2} = foundry.applications.api;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const CHUNK = 240000;

// ================================================================== sockets
export function emit(msg) { game.socket.emit(`module.${MOD}`, msg); }

const incoming = new Map();
export function onSocket(msg) {
  if (!msg || (msg.to && !msg.to.includes(game.user.id))) return;
  if (msg.from === game.user.id) return;
  switch (msg.t) {
    case "snap-begin": incoming.set(msg.id, {title: msg.title, n: msg.n, parts: []}); break;
    case "snap-part": {
      const s = incoming.get(msg.id); if (!s) return;
      s.parts[msg.i] = msg.data;
      if (s.parts.filter(Boolean).length === s.n) { incoming.delete(msg.id); PovViewer.showImage(s.parts.join(""), s.title); }
      break;
    }
    case "live": PovViewer.onLive(msg); break;
    case "live-end": PovViewer.onLiveEnd(msg); break;
    case "cutscene": PovViewer.onCutscene(msg); break;
    case "want-snaps": if (game.user.isGM) PovWindow.phoneUsers.add(msg.from); break;
  }
}

export function sendSnapshot(dataUrl, title, to = null) {
  const id = foundry.utils.randomID(8);
  const n = Math.ceil(dataUrl.length / CHUNK);
  emit({t: "snap-begin", id, title, n, to, from: game.user.id});
  for (let i = 0; i < n; i++) emit({t: "snap-part", id, i, data: dataUrl.slice(i * CHUNK, (i + 1) * CHUNK), to, from: game.user.id});
}

// ================================================================== shared view setup
async function prepareView(view, scene, viewLevel, {playerView = false, maxBottom = null} = {}) {
  view.opts = {...viewOptions(scene), showHidden: !playerView};
  await view.load(sceneData(scene, viewLevel), {...buildOptions(scene), maxBottom});
  await view.setTokens(tokensOf(scene, {playerView}));
  view.setLights(lightsOf(scene));
  view.setTemplates(templatesOf(scene, {playerView}));
  if (playerView) applyVision(view, scene);
}
/** a player's 3D view shows only what their tokens see (and, dimmed, what they explored) */
function applyVision(view, scene) {
  let on = true; try { on = setting("playersVision") !== false; } catch (e) { /* not registered */ }
  view.setVision(on ? visionMask(scene, view.world) : null);
}
const COVER_COL = [[0.3, 1.0, 0.45], [1.0, 0.85, 0.2], [1.0, 0.45, 0.1], [1.0, 0.15, 0.15]];
const COVER_KEY = ["Cover.none", "Cover.half", "Cover.three", "Cover.full"];

function sizeCanvas(canvasEl, stage, scale) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(64, Math.round(stage.clientWidth * dpr * scale)), h = Math.max(64, Math.round(stage.clientHeight * dpr * scale));
  if (canvasEl.width !== w || canvasEl.height !== h) { canvasEl.width = w; canvasEl.height = h; return true; }
  return false;
}

// ================================================================== GM window
export class PovWindow extends ApplicationV2 {
  static instance = null;
  static phoneUsers = new Set();

  static async open({tokenDoc = null, mode = null, scene = canvas.scene} = {}) {
    if (!scene) return ui.notifications.warn(L("Notify.NoScene"));
    if (!game.user.isGM && !setting("playersCanOpen")) return ui.notifications.warn(L("Notify.GMOnly"));
    let app = this.instance;
    if (app && app.scene !== scene) { await app.close(); app = null; }
    if (!app) { app = new this(scene); this.instance = app; }
    app.pending = {tokenDoc, mode: mode ?? (tokenDoc ? "eye" : "orbit")};
    await app.render({force: true});
    if (app.view?.world && app.pending) app.applyPending();
    return app;
  }

  static DEFAULT_OPTIONS = {
    id: "vantage-window", classes: ["vantage"],
    window: {title: "VANTAGE.Title", icon: "fa-solid fa-vr-cardboard", resizable: true},
    position: {width: 1100, height: 680}
  };

  constructor(scene) {
    super({});
    this.scene = scene; this.keys = new Set(); this.live = false; this.hooks = [];
    this._busy = false; this._raf = null; this._idle = null; this._lastLive = 0; this.maxBottom = null;
    this._rebuildSoon = foundry.utils.debounce(() => this.rebuild(), 700);
    this._tokensSoon = foundry.utils.debounce(() => this.refreshTokens(), 300);
    this._phoneSnap = foundry.utils.debounce(() => this.sendPhoneSnapshot(), 700);
    this.visionSoon = foundry.utils.debounce(() => { if (this.view?.world && !game.user.isGM) { applyVision(this.view, this.scene); this.requestRender(); } }, 150);
  }

  get title() { return `${L("Title")} - ${this.scene?.name ?? ""}`; }

  async _renderHTML() {
    if (this._built) return null;
    const isGM = game.user.isGM;
    return `<div class="vtg-stage">
      <canvas class="vtg-canvas" tabindex="0" data-keyboard-focus="true"></canvas>
      <div class="vtg-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> ${L("Window.Building")}</div>
      <div class="vtg-bar">
        <select class="vtg-token" title="${L("Window.WhoseEyes")}"></select>
        <button type="button" data-a="eye" title="${L("Window.EyeTitle")}"><i class="fa-solid fa-eye"></i> ${L("Window.Eye")}</button>
        <button type="button" data-a="orbit" title="${L("Window.OverviewTitle")}"><i class="fa-solid fa-cube"></i> ${L("Window.Overview")}</button>
        <span class="vtg-sep"></span>
        ${isGM ? `<button type="button" data-a="snap" title="${L("Window.ShowPlayersTitle")}"><i class="fa-solid fa-camera"></i> ${L("Window.ShowPlayers")}</button>
        <button type="button" data-a="live" title="${L("Window.LiveTitle")}"><i class="fa-solid fa-tower-broadcast"></i> ${L("Window.Live")}</button>` : ""}
        ${isGM ? `<label class="vtg-time" data-tooltip="${L("Window.TimeTitle")}"><i class="fa-solid fa-sun"></i><input type="range" class="vtg-dark" min="0" max="1" step="0.01" value="0"><i class="fa-solid fa-moon"></i></label>
        <select class="vtg-weather" data-tooltip="${L("Window.WeatherTitle")}"></select>` : ""}
        <button type="button" data-a="film" title="${L("Window.FilmTitle")}"><i class="fa-solid fa-film"></i></button>
        <button type="button" data-a="rebuild" title="${L("Window.RebuildTitle")}"><i class="fa-solid fa-rotate"></i></button>
      </div>
      <div class="vtg-film" style="display:none">
        <div class="vtg-film-row"><b>${L("Film.Title")}</b><span class="vtg-film-n"></span></div>
        <div class="vtg-film-row">
          ${isGM ? `<button type="button" data-f="add" title="${L("Film.AddTitle")}"><i class="fa-solid fa-plus"></i> ${L("Film.Add")}</button>
          <button type="button" data-f="clear" title="${L("Film.ClearTitle")}"><i class="fa-solid fa-trash"></i></button>` : ""}
          <button type="button" data-f="play" title="${L("Film.PlayTitle")}"><i class="fa-solid fa-play"></i> ${L("Film.Play")}</button>
          <button type="button" data-f="rec" title="${L("Film.RecordTitle")}"><i class="fa-solid fa-circle"></i> ${L("Film.Record")}</button>
        </div>
        ${isGM ? `<div class="vtg-film-row"><label>${L("Film.Seconds")} <input type="number" class="vtg-film-dur" min="2" max="180" step="1" value="8"></label></div>` : ""}
      </div>
      <div class="vtg-cover" style="display:none"></div>
      <div class="vtg-help">${L("Window.Help")}</div>
    </div>`;
  }

  _replaceHTML(result, content) {
    if (result === null) return;
    content.innerHTML = result;
    this._built = true;
    this.stage = content.querySelector(".vtg-stage");
    this.canvasEl = content.querySelector(".vtg-canvas");
    this.bindUI(content);
  }

  async _onRender(context, options) {
    if (this.view) return;
    try {
      this.view = new PovView(this.canvasEl, {});
    } catch (e) {
      this.stage.querySelector(".vtg-loading").textContent = L("Window.CantStart", {error: e.message});
      console.error(MOD, e); return;
    }
    this.ro = new ResizeObserver(() => { if (this.view?.world) { sizeCanvas(this.canvasEl, this.stage, this.quality()); this.requestRender(); } });
    this.ro.observe(this.stage);
    this.registerHooks();
    const tok = this.pending?.tokenDoc;
    await this.build(viewLevelFor(this.scene, tok));
    this.applyPending();
  }

  quality(moving = false) {
    const q = Number(setting("quality")) || 0.75;
    let blur = true; try { blur = setting("blurMoving") !== false; } catch (e) { /* not registered */ }
    return moving && blur ? Math.min(q, 0.5) : q;
  }

  async build(viewLevel, maxBottom = null) {
    const ld = this.stage.querySelector(".vtg-loading");
    ld.style.display = "";
    try {
      this.viewLevel = viewLevel; this.maxBottom = maxBottom;
      await prepareView(this.view, this.scene, viewLevel, {playerView: !game.user.isGM, maxBottom});
      sizeCanvas(this.canvasEl, this.stage, this.quality());
      this.fillTokenSelect();
    } catch (e) { console.error(MOD, e); ui.notifications.error(L("Notify.Error", {error: e.message})); }
    ld.style.display = "none";
  }

  async rebuild() {
    if (!this.view) return;
    if (this._busy) return this._rebuildSoon();   // a change while building: build again right after
    this._busy = true;
    const cam = foundry.utils.deepClone(this.view.cam), self = this.view.selfId;
    this.view.clearCache();   // the scene changed: cached levels are stale
    await this.build(this.viewLevel, this.maxBottom);
    this.view.cam = cam; this.view.selfId = self;
    this._busy = false; this.refreshCover(); this.requestRender();
  }

  /** the "ceiling" setting this token needs: its elevation when a higher floor covers it, else null */
  ceilingFor(t) {
    if (!t || (this.scene.levels?.size ?? 0) < 2) return null;
    return this.view.underCeiling(t) ? (t.elevation ?? 0) : null;
  }
  levelOk(id) { return !!(id && this.scene.levels?.get?.(id)); }

  async refreshTokens() {
    if (!this.view?.world) return;
    if (this._busy) return this._tokensSoon();   // a rebuild is running: try again right after
    const list = tokensOf(this.scene, {playerView: !game.user.isGM});
    await this.view.setTokens(list);
    // follow the eye token if it moved
    if (this.view.cam.mode === "eye" && this.view.selfId) {
      const t = list.find(x => x.id === this.view.selfId);
      if (t) { const old = this._selfPos;
        const moved = !old || old.x !== t.x || old.y !== t.y || old.e !== t.elevation;
        const turned = !old || old.r !== t.rotation;
        if (moved || turned || (this.levelOk(t.level) && t.level !== this.viewLevel)) {
          // it changed level, or walked under / out from under a higher floor: build the matching world first
          this._busy = true;
          try {
            if (this.levelOk(t.level) && t.level !== this.viewLevel) await this.build(t.level, null);
            const want = this.ceilingFor(t);
            if (want !== this.maxBottom) await this.build(this.viewLevel, want);
          } finally { this._busy = false; }
          // follow the token: a new facing turns the camera; a plain move keeps where you were looking
          const yaw = this.view.cam.yaw, pitch = this.view.cam.pitch, fov = this.view.cam.fov, from = [...this.view.cam.pos];
          this.view.eyeFrom(t);
          if (old && moved) this.view.glideCam(from);   // walk there, don't teleport
          Object.assign(this.view.cam, turned ? {pitch, fov} : {yaw, pitch, fov});
          this._selfPos = {x: t.x, y: t.y, e: t.elevation, r: t.rotation};
        }
      }
    }
    this.fillTokenSelect();
    this.refreshCover();
    this.requestRender();
  }

  fillTokenSelect() {
    const sel = this.stage.querySelector(".vtg-token"); if (!sel) return;
    const toks = tokensOf(this.scene, {playerView: !game.user.isGM});
    const cur = this.view?.selfId ?? this.pending?.tokenDoc?.id ?? "";
    // same-name tokens get a number; on multi-level scenes every entry shows its level
    const multi = (this.scene.levels?.size ?? 0) > 1;
    const total = new Map(), seen = new Map();
    for (const t of toks) total.set(t.name, (total.get(t.name) ?? 0) + 1);
    const label = t => {
      let s = t.name;
      if (total.get(t.name) > 1) { const n = (seen.get(t.name) ?? 0) + 1; seen.set(t.name, n); s += ` #${n}`; }
      if (multi && t.level) { const lv = this.scene.levels.get(t.level)?.name; if (lv) s += ` · ${lv}`; }
      if (t.hidden) s += ` ${L("Window.Hidden")}`;
      return s;
    };
    const sorted = [...toks].sort((a, b) => a.name.localeCompare(b.name));
    const labels = new Map(sorted.map(t => [t.id, label(t)]));
    sel.innerHTML = `<option value="">${esc(L("Window.WhoseEyesOption"))}</option>` + toks.map(t =>
      `<option value="${t.id}" ${t.id === cur ? "selected" : ""}>${esc(labels.get(t.id))}</option>`).join("");
  }

  applyPending() {
    const p = this.pending; this.pending = null;
    if (!this.view?.world) return;
    const toks = tokensOf(this.scene, {playerView: !game.user.isGM});
    const doc = p?.tokenDoc ?? canvas.tokens?.controlled?.[0]?.document ?? null;
    const t = doc ? toks.find(x => x.id === doc.id) : null;
    if (t && doc.level && doc.level !== this.viewLevel && this.scene.levels?.get?.(doc.level)) { this.build(doc.level).then(() => { this.pending = p; this.applyPending(); }); return; }
    const mode = p?.mode ?? (t ? "eye" : "orbit");
    // eye view under a higher floor: rebuild without the levels over its head (else the camera is buried)
    if (t && mode === "eye") {
      const want = this.ceilingFor(t);
      if (want !== this.maxBottom) { this.build(this.viewLevel, want).then(() => { this.pending = p; this.applyPending(); }); return; }
    }
    if (t) {
      this.view.eyeFrom(t);   // looks where the token faces (its rotation, like Foundry's vision cone)
      this._selfPos = {x: t.x, y: t.y, e: t.elevation, r: t.rotation};
      if (mode === "orbit") { const yaw = this.view.cam.yaw; this.view.orbitAround(t.x, t.y, t.elevation, {yaw}); this.view.selfId = t.id; }
    } else {
      const W = this.view.world;
      this.view.orbitAround(W.W / 2, W.H / 2, null, {yaw: -90});   // null = the floor of the level being viewed
      this.view.cam.dist = Math.max(60, Math.min(220, W.W / W.ppf * 0.6));
    }
    this.view.cam.mode = mode;
    this.fillTokenSelect(); this.updateButtons(); this.refreshCover();
    this.requestRender();
  }

  // ---------------------------------------------------------------- cutscenes and clips
  syncFilm() {
    const st = this.stage; if (!st) return;
    const n = st.querySelector(".vtg-film-n"); if (n) n.textContent = ` ${L("Film.Points", {n: this.path?.keys.length ?? 0})}`;
    const d = st.querySelector(".vtg-film-dur"); if (d && document.activeElement !== d) d.value = String(this.path?.duration ?? 8);
    st.querySelector('[data-f="rec"]')?.classList.toggle("active", !!this.recorder);
    st.querySelector('[data-f="play"]')?.classList.toggle("active", !!this.playing);
    st.querySelector('[data-a="film"]')?.classList.toggle("active", !!this.recorder || !!this.playing);
  }
  savePath() {
    this.syncFilm();
    if (!game.user.isGM) return;
    clearTimeout(this._pathT);
    this._pathT = setTimeout(() => this.scene.update({[`flags.${MOD}.path`]: foundry.utils.deepClone(this.path)}).catch(e => console.error(MOD, e)), 400);
  }
  /** fly the camera along the saved points; players in Live play it too, in step */
  playPath({record = false} = {}) {
    const keys = this.path?.keys ?? [];
    if (keys.length < 2) return ui.notifications.info(L("Notify.NeedPoints"));
    if (this.playing) return;
    this.playing = {keys: foundry.utils.deepClone(keys), dur: this.path.duration || 8, t0: performance.now(), saved: {cam: foundry.utils.deepClone(this.view.cam), self: this.view.selfId}, record};
    if (this.live) emit({t: "cutscene", from: game.user.id, sceneId: this.scene.id, keys: this.playing.keys, duration: this.playing.dur});
    this.syncFilm(); this.requestRender();
  }
  endPlay() {
    const p = this.playing; if (!p) return;
    this.playing = null;
    this.view.cam = p.saved.cam; this.view.selfId = p.saved.self;
    if (p.record) setTimeout(() => this.stopRecord(), 200);
    if (this.live) this.broadcastLive(true);
    this.syncFilm(); this.requestRender();
  }
  /** record what the window shows to a video file (MP4 where the browser can, else WebM); with points, plays them */
  startRecord(withPath = false) {
    if (this.recorder || typeof MediaRecorder === "undefined") return;
    const types = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
    const mimeType = types.find(t => MediaRecorder.isTypeSupported?.(t)) ?? "";
    let rec;
    try { rec = new MediaRecorder(this.canvasEl.captureStream(30), {mimeType, videoBitsPerSecond: 12e6}); }
    catch (e) { console.error(MOD, e); return ui.notifications.error(L("Notify.Error", {error: e.message})); }
    const chunks = [];
    rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || "video/webm", blob = new Blob(chunks, {type});
      const name = `vantage-${this.scene.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${/mp4/.test(type) ? "mp4" : "webm"}`;
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      ui.notifications.info(L("Notify.Recorded", {name}));
    };
    rec.start(250); this.recorder = rec;
    if (withPath) this.playPath({record: true});
    this.syncFilm(); this.requestRender();
  }
  stopRecord() {
    const r = this.recorder; if (!r) return;
    this.recorder = null;
    try { r.stop(); } catch (e) { /* already stopped */ }
    this.syncFilm();
  }

  // ---------------------------------------------------------------- cover
  /** cover from the picked token to each of your targets: a line to each, coloured, and a note in the corner */
  refreshCover() {
    const v = this.view, box = this.stage?.querySelector(".vtg-cover"); if (!v?.world || !box) return;
    const me = v.selfId;
    const targets = [...(game.user.targets ?? [])].filter(t => t.document?.parent?.id === this.scene.id && t.id !== me).slice(0, 4);
    const out = me ? targets.map(t => ({t, c: v.cover(me, t.id)})).filter(x => x.c) : [];
    v.beams = out.map(({c}) => ({from: c.from, to: c.to, color: COVER_COL[c.level]}));
    box.style.display = out.length ? "" : "none";
    box.innerHTML = out.map(({t, c}) => `<div><span class="vtg-dot" style="background:rgb(${COVER_COL[c.level].map(x => Math.round(x * 255)).join(",")})"></span>${esc(t.name)}: ${esc(L(COVER_KEY[c.level]))}</div>`).join("");
    this.requestRender();
  }

  // ---------------------------------------------------------------- play in 3D
  pickAt(ev) {
    const r = this.canvasEl.getBoundingClientRect();
    return this.view?.world ? this.view.pick((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height) : null;
  }
  /** the token that moves on a double-click: the one you look through, the one picked here, or the one selected on the map */
  activeToken() {
    const id = this.view?.selfId ?? (canvas.scene?.id === this.scene.id ? canvas.tokens?.controlled?.[0]?.id : null);
    return id ? this.scene.tokens.get(id) ?? null : null;
  }
  /** under the mouse: a ring where a double-click would send the token, a lit door, a ring around a figure */
  hoverSoon(ev) {
    if (this._hoverRaf) { this._hoverEv = ev; return; }
    this._hoverEv = ev;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = null;
      const p = this.pickAt(this._hoverEv), W = this.view?.world; if (!W) return;
      let hv = null;
      if (p?.type === "token") hv = {x: p.x, z: p.z, y: p.y, r: (p.ring || 0.47 * W.gridPx) * 1.18, col: [1, 1, 1]};
      else if (p?.type === "door") hv = p.open ? {x: p.cx, z: p.cz, y: p.y, r: p.len * 0.5, col: [1, 0.8, 0.25]} : {x: p.cx, z: p.cz, y: p.y, r: p.len * 0.55, col: [1, 0.8, 0.25], door: true};
      else if (p?.type === "floor" && !p.side && this.activeToken()?.isOwner) hv = {x: p.x, z: p.y, y: p.h, r: 0.42 * W.gridPx, col: [0.25, 0.95, 1], dot: true};
      this.canvasEl.style.cursor = p?.type === "door" || p?.type === "token" ? "pointer" : "";
      const key = hv ? [hv.x, hv.z, hv.r].map(Math.round).join() : "";
      if (key !== this._hoverKey) { this._hoverKey = key; this.view.hover = hv; this.requestRender(); }
    });
  }
  async onClick(ev, button) {
    const p = this.pickAt(ev); if (!p) return;
    if (button === 2) { if (p.type === "token") this.toggleTarget(p.id, ev.shiftKey); return; }
    if (p.type === "door") return this.toggleDoor(p);
    if (p.type === "token") return this.selectToken(p.id);
  }
  async onDoubleClick(ev) {
    const p = this.pickAt(ev);
    if (p?.type === "floor" && !p.side) return this.moveTo(p);
  }
  /** pick a token here (the one a double-click moves); also selects it on the map */
  selectToken(id) {
    const doc = this.scene.tokens.get(id); if (!doc) return;
    if (canvas.scene?.id === this.scene.id && (doc.isOwner || game.user.isGM)) doc.object?.control({releaseOthers: true});
    if (this.view.cam.mode === "orbit") this.view.selfId = id;
    this.fillTokenSelect(); this.refreshCover(); this.requestRender();
  }
  toggleTarget(id, keep) {
    const t = this.scene.tokens.get(id)?.object;
    if (!t || canvas.scene?.id !== this.scene.id) return ui.notifications.warn(L("Notify.TargetScene"));
    t.setTarget(!t.isTargeted, {releaseOthers: !keep});
  }
  async toggleDoor(p) {
    const w = this.scene.walls.get(p.id); if (!w) return;
    if (game.paused && !game.user.isGM) return ui.notifications.warn(game.i18n.localize("GAME.PausedWarning"));
    const S = CONST.WALL_DOOR_STATES;
    if (w.ds === S.LOCKED) return ui.notifications.info(L("Notify.Locked"));
    try { await w.update({ds: w.ds === S.OPEN ? S.CLOSED : S.OPEN}); } catch (e) { console.error(MOD, e); ui.notifications.warn(L("Notify.Error", {error: e.message})); }
  }
  /** double-click on the floor: the token walks there (snapped to the grid like a drag; walls stop players) */
  async moveTo(p) {
    const doc = this.activeToken();
    if (!doc) return ui.notifications.info(L("Notify.PickToken"));
    if (!doc.isOwner) return ui.notifications.warn(L("Notify.NotYours"));
    if (game.paused && !game.user.isGM) return ui.notifications.warn(game.i18n.localize("GAME.PausedWarning"));
    const r = rectOf(this.scene), gs = r.gridPx;
    let x = p.x + r.ox - doc.width * gs / 2, y = p.y + r.oy - doc.height * gs / 2;
    try { const sn = doc.object?.getSnappedPosition?.({x, y}) ?? this.scene.grid.getSnappedPoint({x, y}, {mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_CORNER}); x = sn.x; y = sn.y; } catch (e) { /* free placement */ }
    const t = doc.object;
    if (!game.user.isGM && t?.checkCollision) {
      try { if (t.checkCollision(t.getCenterPoint({x, y}), {type: "move", mode: "any"})) return ui.notifications.warn(L("Notify.Blocked")); } catch (e) { /* no check */ }
    }
    try { if (typeof doc.move === "function") await doc.move({x, y}); else await doc.update({x, y}); }
    catch (e) { console.error(MOD, e); ui.notifications.warn(L("Notify.Error", {error: e.message})); }
  }

  /** the time slider and weather list show the scene as it is now */
  syncLookUI() {
    const st = this.stage; if (!st) return;
    const dark = st.querySelector(".vtg-dark");
    if (dark && document.activeElement !== dark) dark.value = String(lookOf(this.scene).dark ?? 0);
    const sel = st.querySelector(".vtg-weather"); if (!sel) return;
    const own = sceneFlag(this.scene, "weather") ?? "";
    const follow = weatherOf({weather: this.scene.weather, flags: {fxmaster: this.scene.flags?.fxmaster}});   // what Foundry shows
    sel.innerHTML = `<option value="">${esc(L("Weather.follow", {weather: L(`Weather.${follow}`)}))}</option>` +
      Object.keys(WEATHER).map(k => `<option value="${k}" ${k === own ? "selected" : ""}>${esc(L(`Weather.${k}`))}</option>`).join("");
  }

  updateButtons() {
    const st = this.stage;
    st.querySelector('[data-a="eye"]')?.classList.toggle("active", this.view.cam.mode === "eye");
    st.querySelector('[data-a="orbit"]')?.classList.toggle("active", this.view.cam.mode === "orbit");
    st.querySelector('[data-a="live"]')?.classList.toggle("active", this.live);
  }

  // ---------------------------------------------------------------- input
  bindUI(root) {
    const cv = this.canvasEl;
    let drag = null;
    cv.addEventListener("pointerdown", ev => { if (ev.button !== 0 && ev.button !== 2) return; cv.focus(); drag = {x: ev.clientX, y: ev.clientY, b: ev.button, x0: ev.clientX, y0: ev.clientY, t0: performance.now()}; cv.setPointerCapture(ev.pointerId); });
    cv.addEventListener("pointermove", ev => {
      if (!this.view?.world) return;
      if (!drag) return this.hoverSoon(ev);
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; drag.x = ev.clientX; drag.y = ev.clientY;
      const c = this.view.cam;
      if (drag.b === 2) { this.view.move(-dx * 0.08 * c.dist / 60, dy * 0.08 * c.dist / 60, 0); }
      else if (c.mode === "eye") { c.yaw += dx * 0.22; c.pitch = Math.max(-85, Math.min(85, c.pitch - dy * 0.22)); }
      else { c.yaw += dx * 0.3; c.orbitPitch = Math.max(-89, Math.min(-4, c.orbitPitch - dy * 0.25)); }
      this.requestRender(true);
    });
    const end = ev => {
      if (!drag) return;
      // a click (not a drag): play in 3D - left = pick a token or open a door, right = target
      const click = ev.type === "pointerup" && Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 5 && performance.now() - drag.t0 < 450;
      const b = drag.b; drag = null;
      try { cv.releasePointerCapture(ev.pointerId); } catch (e) {}
      if (click) this.onClick(ev, b);
      this.requestRender();
    };
    cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
    cv.addEventListener("pointerleave", () => { if (this.view?.hover) { this.view.hover = null; this.requestRender(); } });
    cv.addEventListener("dblclick", ev => this.onDoubleClick(ev));
    cv.addEventListener("contextmenu", ev => ev.preventDefault());
    cv.addEventListener("wheel", ev => {
      ev.preventDefault(); if (!this.view?.world) return;
      const c = this.view.cam, s = Math.sign(ev.deltaY);
      if (c.mode === "eye") c.fov = Math.max(30, Math.min(110, c.fov + s * 5));
      else c.dist = Math.max(8, Math.min(600, c.dist * (s > 0 ? 1.12 : 1 / 1.12)));
      this.requestRender(true);
    }, {passive: false});
    cv.addEventListener("keydown", ev => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.code)) {
        ev.preventDefault(); ev.stopPropagation(); this.keys.add(ev.code); this.requestRender(true);
      }
    });
    cv.addEventListener("keyup", ev => { this.keys.delete(ev.code); ev.stopPropagation(); });
    cv.addEventListener("blur", () => this.keys.clear());

    root.querySelector(".vtg-token")?.addEventListener("change", ev => {
      const doc = this.scene.tokens.get(ev.target.value);
      this.pending = {tokenDoc: doc ?? null, mode: this.view.cam.mode};
      this.applyPending();
    });
    // time of day: drag = preview in 3D (the Day cycle mood), let go = the scene's darkness (and Day cycle) for everyone
    const dark = root.querySelector(".vtg-dark");
    dark?.addEventListener("input", () => {
      if (!this.view) return;
      this.view.opts = {...this.view.opts, dark: Number(dark.value), mood: "daycycle"};
      this.requestRender();
    });
    dark?.addEventListener("change", async () => {
      const v = Number(dark.value), upd = {"environment.darknessLevel": v};
      if (lookOf(this.scene).mood !== "daycycle") { upd[`flags.${MOD}.mood`] = "daycycle"; ui.notifications.info(L("Notify.DayCycle")); }
      try { await this.scene.update(upd); } catch (e) { console.error(MOD, e); ui.notifications.error(L("Notify.Error", {error: e.message})); }
    });
    root.querySelector(".vtg-weather")?.addEventListener("change", async ev => {
      const v = ev.target.value;
      try { await this.scene.update({[`flags.${MOD}.weather`]: v || null}); }   // empty = follow Foundry's weather
      catch (e) { console.error(MOD, e); ui.notifications.error(L("Notify.Error", {error: e.message})); }
    });
    this.syncLookUI();
    // cutscenes: camera points saved with the scene, played smoothly (players in Live follow), recorded to a video
    root.querySelector(".vtg-film")?.addEventListener("click", ev => {
      const f = ev.target.closest("[data-f]")?.dataset.f; if (!f || !this.view?.world) return;
      if (f === "add") { this.path.keys.push(this.view.freeCam()); this.savePath(); }
      else if (f === "clear") { this.path.keys = []; this.savePath(); }
      else if (f === "play") this.playPath();
      else if (f === "rec") this.recorder ? this.stopRecord() : this.startRecord(this.path.keys.length >= 2);
      this.syncFilm();
    });
    root.querySelector(".vtg-film-dur")?.addEventListener("change", ev => { this.path.duration = Math.max(2, Math.min(180, Number(ev.target.value) || 8)); this.savePath(); });
    this.path = foundry.utils.deepClone(sceneFlag(this.scene, "path") ?? {keys: [], duration: 8});
    this.syncFilm();

    root.querySelector(".vtg-bar").addEventListener("click", ev => {
      const a = ev.target.closest("[data-a]")?.dataset.a; if (!a || !this.view?.world) return;
      const c = this.view.cam;
      if (a === "eye" && c.mode !== "eye") {
        const t = tokensOf(this.scene, {playerView: !game.user.isGM}).find(x => x.id === this.view.selfId);
        if (t) { this.pending = {tokenDoc: this.scene.tokens.get(t.id), mode: "eye"}; return this.applyPending(); }
        else { c.mode = "eye"; c.pos = [...c.target]; c.pos[1] += 3 * this.view.world.ppf; c.pitch = -6; }
      } else if (a === "orbit" && c.mode !== "orbit") {
        const self = this.view.selfId, doc = self ? this.scene.tokens.get(self) : null;
        this.view.orbitAround(c.pos[0], c.pos[2], doc ? (doc.elevation ?? 0) : null, {yaw: c.yaw});
        this.view.selfId = self;
      } else if (a === "snap") return this.shareSnapshot();
      else if (a === "live") return this.toggleLive();
      else if (a === "rebuild") return this.rebuild();
      else if (a === "film") { const p = this.stage.querySelector(".vtg-film"); p.style.display = p.style.display === "none" ? "" : "none"; return; }
      this.updateButtons(); this.requestRender();
    });
  }

  // ---------------------------------------------------------------- draw loop
  /** keep drawing on its own (video map art, animated lights, weather) - at most 30 frames a second, never while minimized */
  animating() {
    let on = true; try { on = setting("animate") !== false; } catch (e) { /* not registered */ }
    if (this.view) this.view.animate = on;
    const a = on && !this.minimized && !!this.view?.isAnimated();
    if (a !== this._playing) { this._playing = a; this.view?.play(a); }
    return a;
  }

  requestRender(moving = false) {
    if (!this.view?.world) return;
    if (moving) { this._moving = true; clearTimeout(this._idle); this._idle = setTimeout(() => { this._moving = false; this.requestRender(); }, 180); }
    if (this._raf) return;
    let last = performance.now();
    const tick = now => {
      this._raf = null;
      if (!this.view?.world) return;
      const anim = this.animating() || !!this.playing || !!this.recorder;
      if (this.playing) {
        const p = this.playing, u = Math.min(1, (now - p.t0) / 1000 / p.dur);
        this.view.setFreeCam(camAt(p.keys, u));
        if (u >= 1) { this.view.render(); return this.endPlay(); }
      }
      // animation alone: about 30 fps is plenty (saves the GPU); camera moves still draw every frame
      if (anim && !this.playing && !this.keys.size && !this._moving && !this.view.isMoving() && now - (this._lastFrame ?? 0) < 31) { this._raf = requestAnimationFrame(tick); return; }
      this._lastFrame = now;
      if (anim && now - (this._lastMedia ?? 0) > 38) { this.view.tickMedia(); this._lastMedia = now; }
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const k = this.keys;
      if (k.size) {
        const sp = (k.has("ShiftLeft") || k.has("ShiftRight") ? 60 : 20) * dt;
        const f = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
        const r = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
        const u = (k.has("KeyE") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0);
        if (this.view.cam.mode === "orbit") { this.view.move(r * sp, f * sp, 0); this.view.cam.yaw += u * 70 * dt; }
        else this.view.move(r * sp, f * sp, u * sp);
        this._moving = true; clearTimeout(this._idle); this._idle = setTimeout(() => { this._moving = false; this.requestRender(); }, 180);
      }
      sizeCanvas(this.canvasEl, this.stage, this.quality(this._moving));
      this.view.render();
      followCamera(this.view, this.scene, this);   // ambient sounds heard from the camera
      if (this.live && !this.playing) this.broadcastLive();
      if (k.size || anim || this.view.isMoving()) this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- sharing
  title2() {
    const t = this.view.selfId ? this.scene.tokens.get(this.view.selfId) : null;
    return this.view.cam.mode === "eye" && t ? L("Window.TokensView", {name: t.name}) : `${this.scene.name}`;
  }

  shareSnapshot(to = null) {
    if (!this.view?.world) return;
    const url = this.view.snapshot({width: Number(setting("snapshotWidth")) || 1600, forPlayers: true});
    sendSnapshot(url, this.title2(), to);
    if (!to) ui.notifications.info(L("Notify.Sent"));
  }

  sendPhoneSnapshot() {
    if (!this.live || !PovWindow.phoneUsers.size) return;
    const ids = [...PovWindow.phoneUsers].filter(id => game.users.get(id)?.active);
    if (ids.length) this.shareSnapshot(ids);
  }

  toggleLive() {
    this.live = !this.live;
    if (this.live) { PovWindow.phoneUsers.clear(); this.broadcastLive(true); ui.notifications.info(L("Notify.LiveOn")); }
    else emit({t: "live-end", from: game.user.id});
    this.updateButtons();
  }

  broadcastLive(force = false) {
    const now = performance.now();
    if (!force && now - this._lastLive < 90) { clearTimeout(this._liveT); this._liveT = setTimeout(() => this.broadcastLive(true), 100); return; }
    const c = this.view.cam;
    const key = JSON.stringify([c.mode, c.pos, c.yaw, c.pitch, c.fov, c.target, c.dist, c.orbitPitch, this.view.selfId]);
    if (!force && key === this._lastLiveKey) return;   // nothing moved (an animation frame): don't spam the players
    this._lastLive = now; this._lastLiveKey = key;
    emit({t: "live", from: game.user.id, sceneId: this.scene.id, viewLevel: this.viewLevel, maxBottom: this.maxBottom ?? null, title: this.title2(),
      cam: {mode: c.mode, pos: c.pos, yaw: c.yaw, pitch: c.pitch, fov: c.fov, target: c.target, targetElev: c.targetElev ?? null, dist: c.dist, orbitPitch: c.orbitPitch}, selfId: this.view.selfId});
    this._phoneSnap();
  }

  // ---------------------------------------------------------------- live scene updates
  registerHooks() {
    const on = (h, fn) => this.hooks.push([h, Hooks.on(h, fn)]);
    const mine = doc => { let d = doc.parent ?? doc.scene; while (d && d.documentName !== "Scene") d = d.parent; return d?.id === this.scene.id; };   // region behaviours sit under a region
    for (const h of ["createToken", "updateToken", "deleteToken"]) on(h, doc => { if (mine(doc)) this._tokensSoon(); });
    for (const h of ["createMeasuredTemplate", "updateMeasuredTemplate", "deleteMeasuredTemplate"])
      on(h, doc => { if (mine(doc) && this.view?.world) { this.view.setTemplates(templatesOf(this.scene, {playerView: !game.user.isGM})); this.requestRender(); } });
    on("targetToken", (user, token) => { if (user.id === game.user.id && token.document?.parent?.id === this.scene.id) this._tokensSoon(); });
    for (const h of ["createWall", "updateWall", "deleteWall", "createAmbientLight", "updateAmbientLight", "deleteAmbientLight", "createLevel", "updateLevel", "deleteLevel",
      "createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"])
      on(h, doc => { if (mine(doc)) this._rebuildSoon(); });
    // per-scene overrides (Scene Config > Vantage) changed
    on("updateScene", (doc, changes) => {
      if (doc.id !== this.scene.id) return;
      const own = foundry.utils.hasProperty(changes, `flags.${MOD}`);
      // darkness (time of day) and Foundry's / FXMaster's weather: a redraw
      const env = "environment" in changes || "darkness" in changes || "weather" in changes || foundry.utils.hasProperty(changes, "flags.fxmaster");
      if (!own && !env) return;
      // the look (skin, mood, sun, weather) only needs a redraw; anything else rebuilds the 3D scene
      const keys = own ? Object.keys(foundry.utils.flattenObject(changes.flags[MOD] ?? {})).map(k => k.replace(/^-=/, "").split(".")[0]) : [];
      if (this.view && keys.every(k => LOOK_KEYS.includes(k))) { this.view.opts = {...this.view.opts, ...viewOptions(doc)}; this.syncLookUI(); this.requestRender(); }
      else this._rebuildSoon();
    });
  }

  async close(options) {
    this.stopRecord(); this.playing = null; releaseSound(this);
    if (this.live) emit({t: "live-end", from: game.user.id});
    this.live = false;
    for (const [h, id] of this.hooks) Hooks.off(h, id);
    this.hooks = [];
    this.ro?.disconnect(); cancelAnimationFrame(this._raf);
    this.view?.play(false); this.view?.dispose(); this.view = null;
    if (PovWindow.instance === this) PovWindow.instance = null;
    return super.close(options);
  }
}

// ================================================================== players' viewer
export class PovViewer extends ApplicationV2 {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "vantage-viewer", classes: ["vantage", "vtg-viewer"],
    window: {title: "VANTAGE.Title", icon: "fa-solid fa-vr-cardboard", resizable: true},
    position: {width: Math.min(1100, window.innerWidth * 0.8), height: Math.min(660, window.innerHeight * 0.75)}
  };

  static get(create = true) { if (!this.instance && create) this.instance = new this(); return this.instance; }
  /** phones get a still picture after each camera move instead of a live 3D view (saves their battery) */
  static isPhone() {
    if (document.body.classList.contains("pm-phone")) return true;   // a phone-layout module marks the body
    return window.matchMedia?.("(pointer: coarse) and (max-width: 820px)").matches ?? false;
  }

  static async showImage(url, title) {
    const app = this.get();
    app.mode = "image"; app.img = url; app.titleText = title;
    await app.render({force: true});
    app.paint();
  }

  static async onLive(msg) {
    if (this.isPhone()) {
      if (!this._askedSnaps) { this._askedSnaps = true; emit({t: "want-snaps", from: game.user.id, to: [msg.from]}); }
      return;
    }
    const app = this.get();
    app.titleText = msg.title; app.lastLive = msg;
    if (app.mode !== "live" || !app.view || app.liveScene !== msg.sceneId || app.liveLevel !== msg.viewLevel || (app.liveBottom ?? null) !== (msg.maxBottom ?? null)) {
      if (app._starting) return;
      app._starting = true;
      app.mode = "live";
      await app.render({force: true});
      await app.startLive(msg);
      app._starting = false;
    }
    app.applyLive(app.lastLive);
  }

  /** the GM plays a cutscene: fly the same path here, in step */
  static onCutscene(msg) {
    const app = this.instance; if (!app?.view?.world || app.mode !== "live" || app.liveScene !== msg.sceneId) return;
    app.cut = {keys: msg.keys, dur: msg.duration || 8, t0: performance.now()};
    app.applyLive(app.lastLive);
  }

  static onLiveEnd() {
    this._askedSnaps = false;
    const app = this.instance; if (!app || app.mode !== "live") return;
    app.stopLive();
    app.close();
  }

  get title() { return this.titleText ? `${L("Title")} - ${this.titleText}` : L("Title"); }

  async _renderHTML() {
    if (this._built) return null;
    return `<div class="vtg-stage">
      <img class="vtg-img" alt="">
      <canvas class="vtg-canvas"></canvas>
      <div class="vtg-loading" style="display:none"><i class="fa-solid fa-circle-notch fa-spin"></i> ${L("Window.Loading")}</div>
    </div>`;
  }
  _replaceHTML(result, content) {
    if (result === null) return;
    content.innerHTML = result; this._built = true;
    this.stage = content.querySelector(".vtg-stage");
    this.imgEl = content.querySelector(".vtg-img"); this.canvasEl = content.querySelector(".vtg-canvas");
  }
  _onRender() { this.paint(); }

  paint() {
    if (!this.stage) return;
    const live = this.mode === "live";
    this.imgEl.style.display = live ? "none" : "";
    this.canvasEl.style.display = live ? "" : "none";
    if (!live && this.img) this.imgEl.src = this.img;
    const t = this.element?.querySelector(".window-title"); if (t) t.textContent = this.title;
  }

  async startLive(msg) {
    const scene = game.scenes.get(msg.sceneId);
    if (!scene || canvas.scene?.id !== msg.sceneId) return;
    this.stopLive();
    this.paint();
    const ld = this.stage.querySelector(".vtg-loading"); ld.style.display = "";
    try {
      this.view = new PovView(this.canvasEl, {});
      await prepareView(this.view, scene, msg.viewLevel, {playerView: true, maxBottom: msg.maxBottom ?? null});
      this.liveScene = msg.sceneId; this.liveLevel = msg.viewLevel; this.liveBottom = msg.maxBottom ?? null;
      this.ro = new ResizeObserver(() => this.applyLive(this.lastLive)); this.ro.observe(this.stage);
    } catch (e) { console.error(MOD, e); this.view = null; }
    ld.style.display = "none";
  }

  applyLive(msg) {
    if (!this.view?.world || !msg) return;
    if (!this.cut) { Object.assign(this.view.cam, foundry.utils.deepClone(msg.cam)); this.view.selfId = msg.selfId; }
    const sc = game.scenes.get(this.liveScene); if (sc) Object.assign(this.view.opts, lookOf(sc));   // the GM may change the mood mid-way
    if (this._raf || this._tmo) return;
    const frame = now => {
      this._raf = null;
      if (!this.view?.world) return;
      let on = true; try { on = setting("animate") !== false; } catch (e) { /* not registered */ }
      this.view.animate = on;
      const anim = on && !this.minimized && this.view.isAnimated();
      if (anim !== this._playing) { this._playing = anim; this.view.play(anim); }
      if (anim) this.view.tickMedia();
      let cutOn = false;
      if (this.cut) {   // a cutscene from the GM
        const u = Math.min(1, (now - this.cut.t0) / 1000 / this.cut.dur);
        this.view.setFreeCam(camAt(this.cut.keys, u)); cutOn = u < 1;
        if (!cutOn) { this.cut = null; if (this.lastLive) { Object.assign(this.view.cam, foundry.utils.deepClone(this.lastLive.cam)); this.view.selfId = this.lastLive.selfId; } }
      }
      sizeCanvas(this.canvasEl, this.stage, Math.min(0.75, Number(setting("quality")) || 0.75));
      this.view.render({forPlayers: true});
      followCamera(this.view, game.scenes.get(this.liveScene), this);
      const t = this.element?.querySelector(".window-title"); if (t) t.textContent = this.title;
      if (cutOn || this.view.isMoving()) this._raf = requestAnimationFrame(frame);   // a cutscene, or figures gliding to where they moved
      else if (anim) this._tmo = setTimeout(() => { this._tmo = null; this._raf = requestAnimationFrame(frame); }, 30);   // ~30 fps while something animates
    };
    this._raf = requestAnimationFrame(frame);
  }

  /** the player's sight changed (a token moved, a door opened, a light went out) */
  visionSoon() {
    clearTimeout(this._visT);
    this._visT = setTimeout(() => { const sc = game.scenes.get(this.liveScene); if (this.view?.world && sc) { applyVision(this.view, sc); this.applyLive(this.lastLive); } }, 150);
  }
  /** the GM changed this scene's look, time of day or weather (a redraw), or something it's built from (a rebuild) */
  relook(doc, changes = {}) {
    if (!this.view?.world || doc.id !== this.liveScene) return;
    const own = foundry.utils.hasProperty(changes, `flags.${MOD}`);
    const keys = own ? Object.keys(foundry.utils.flattenObject(changes.flags[MOD] ?? {})).map(k => k.replace(/^-=/, "").split(".")[0]) : [];
    if (!keys.every(k => LOOK_KEYS.includes(k)) || "background" in changes) return this.rebuildSoon();
    Object.assign(this.view.opts, viewOptions(doc), {showHidden: false});
    this.applyLive(this.lastLive);
  }
  /** walls, doors, lights, regions or levels changed: build the 3D scene again (debounced; once at a time) */
  rebuildSoon() {
    clearTimeout(this._rbT);
    this._rbT = setTimeout(async () => {
      if (this.mode !== "live" || !this.lastLive) return;
      if (this._starting) return this.rebuildSoon();
      this._starting = true;
      try { await this.startLive(this.lastLive); } finally { this._starting = false; }
      this.applyLive(this.lastLive);
    }, 700);
  }

  async refreshTokens() {
    const scene = game.scenes.get(this.liveScene);
    if (!this.view?.world || !scene) return;
    await this.view.setTokens(tokensOf(scene, {playerView: true}));
    this.applyLive(this.lastLive);
  }

  stopLive() { releaseSound(this); clearTimeout(this._tmo); cancelAnimationFrame(this._raf); this._tmo = this._raf = null; this.ro?.disconnect(); this.ro = null; this.view?.play(false); this.view?.dispose(); this.view = null; this.liveScene = null; }

  async close(options) { this.stopLive(); PovViewer.instance = null; return super.close(options); }
}
