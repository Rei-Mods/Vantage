// Vantage - the GM's 3D window, the players' viewer, and snapshot/live sharing
import {PovView} from "./view.js";
import {MOD, L, setting, sceneData, viewLevelFor, tokensOf, lightsOf, buildOptions, viewOptions} from "./foundry.js";

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
}

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
        <button type="button" data-a="rebuild" title="${L("Window.RebuildTitle")}"><i class="fa-solid fa-rotate"></i></button>
      </div>
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
    if (!this.view || this._busy) return;
    this._busy = true;
    const cam = foundry.utils.deepClone(this.view.cam), self = this.view.selfId;
    this.view.clearCache();   // the scene changed: cached levels are stale
    await this.build(this.viewLevel, this.maxBottom);
    this.view.cam = cam; this.view.selfId = self;
    this._busy = false; this.requestRender();
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
          const yaw = this.view.cam.yaw, pitch = this.view.cam.pitch, fov = this.view.cam.fov;
          this.view.eyeFrom(t);
          Object.assign(this.view.cam, turned ? {pitch, fov} : {yaw, pitch, fov});
          this._selfPos = {x: t.x, y: t.y, e: t.elevation, r: t.rotation};
        }
      }
    }
    this.fillTokenSelect();
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
      this.view.orbitAround(W.W / 2, W.H / 2, W.baseElev, {yaw: -90}); this.view.cam.dist = Math.max(60, Math.min(220, W.W / W.ppf * 0.6));
    }
    this.view.cam.mode = mode;
    this.fillTokenSelect(); this.updateButtons();
    this.requestRender();
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
    cv.addEventListener("pointerdown", ev => { if (ev.button !== 0 && ev.button !== 2) return; cv.focus(); drag = {x: ev.clientX, y: ev.clientY, b: ev.button}; cv.setPointerCapture(ev.pointerId); });
    cv.addEventListener("pointermove", ev => {
      if (!drag || !this.view?.world) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; drag.x = ev.clientX; drag.y = ev.clientY;
      const c = this.view.cam;
      if (drag.b === 2) { this.view.move(-dx * 0.08 * c.dist / 60, dy * 0.08 * c.dist / 60, 0); }
      else if (c.mode === "eye") { c.yaw += dx * 0.22; c.pitch = Math.max(-85, Math.min(85, c.pitch - dy * 0.22)); }
      else { c.yaw += dx * 0.3; c.orbitPitch = Math.max(-89, Math.min(-4, c.orbitPitch - dy * 0.25)); }
      this.requestRender(true);
    });
    const end = ev => { if (drag) { drag = null; try { cv.releasePointerCapture(ev.pointerId); } catch (e) {} this.requestRender(); } };
    cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
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
    root.querySelector(".vtg-bar").addEventListener("click", ev => {
      const a = ev.target.closest("[data-a]")?.dataset.a; if (!a || !this.view?.world) return;
      const c = this.view.cam;
      if (a === "eye" && c.mode !== "eye") {
        const t = tokensOf(this.scene, {playerView: !game.user.isGM}).find(x => x.id === this.view.selfId);
        if (t) { this.pending = {tokenDoc: this.scene.tokens.get(t.id), mode: "eye"}; return this.applyPending(); }
        else { c.mode = "eye"; c.pos = [...c.target]; c.pos[1] += 3 * this.view.world.ppf; c.pitch = -6; }
      } else if (a === "orbit" && c.mode !== "orbit") {
        const self = this.view.selfId;
        this.view.orbitAround(c.pos[0], c.pos[2], c.pos[1] / this.view.world.ppf - 5.5, {yaw: c.yaw});
        this.view.selfId = self;
      } else if (a === "snap") return this.shareSnapshot();
      else if (a === "live") return this.toggleLive();
      else if (a === "rebuild") return this.rebuild();
      this.updateButtons(); this.requestRender();
    });
  }

  // ---------------------------------------------------------------- draw loop
  requestRender(moving = false) {
    if (!this.view?.world) return;
    if (moving) { this._moving = true; clearTimeout(this._idle); this._idle = setTimeout(() => { this._moving = false; this.requestRender(); }, 180); }
    if (this._raf) return;
    let last = performance.now();
    const tick = now => {
      this._raf = null;
      if (!this.view?.world) return;
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
      if (this.live) this.broadcastLive();
      if (k.size) this._raf = requestAnimationFrame(tick);
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
    this._lastLive = now;
    const c = this.view.cam;
    emit({t: "live", from: game.user.id, sceneId: this.scene.id, viewLevel: this.viewLevel, maxBottom: this.maxBottom ?? null, title: this.title2(),
      cam: {mode: c.mode, pos: c.pos, yaw: c.yaw, pitch: c.pitch, fov: c.fov, target: c.target, dist: c.dist, orbitPitch: c.orbitPitch}, selfId: this.view.selfId});
    this._phoneSnap();
  }

  // ---------------------------------------------------------------- live scene updates
  registerHooks() {
    const on = (h, fn) => this.hooks.push([h, Hooks.on(h, fn)]);
    const mine = doc => { let d = doc.parent ?? doc.scene; while (d && d.documentName !== "Scene") d = d.parent; return d?.id === this.scene.id; };   // region behaviours sit under a region
    for (const h of ["createToken", "updateToken", "deleteToken"]) on(h, doc => { if (mine(doc)) this._tokensSoon(); });
    for (const h of ["createWall", "updateWall", "deleteWall", "createAmbientLight", "updateAmbientLight", "deleteAmbientLight", "createLevel", "updateLevel", "deleteLevel",
      "createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"])
      on(h, doc => { if (mine(doc)) this._rebuildSoon(); });
    // per-scene overrides (Scene Config > Vantage) changed
    on("updateScene", (doc, changes) => { if (doc.id === this.scene.id && foundry.utils.hasProperty(changes, `flags.${MOD}`)) this._rebuildSoon(); });
  }

  async close(options) {
    if (this.live) emit({t: "live-end", from: game.user.id});
    this.live = false;
    for (const [h, id] of this.hooks) Hooks.off(h, id);
    this.hooks = [];
    this.ro?.disconnect(); cancelAnimationFrame(this._raf);
    this.view?.dispose(); this.view = null;
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
    Object.assign(this.view.cam, foundry.utils.deepClone(msg.cam));
    this.view.selfId = msg.selfId;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      sizeCanvas(this.canvasEl, this.stage, Math.min(0.75, Number(setting("quality")) || 0.75));
      this.view.render({forPlayers: true});
      const t = this.element?.querySelector(".window-title"); if (t) t.textContent = this.title;
    });
  }

  async refreshTokens() {
    const scene = game.scenes.get(this.liveScene);
    if (!this.view?.world || !scene) return;
    await this.view.setTokens(tokensOf(scene, {playerView: true}));
    this.applyLive(this.lastLive);
  }

  stopLive() { this.ro?.disconnect(); this.ro = null; this.view?.dispose(); this.view = null; this.liveScene = null; }

  async close(options) { this.stopLive(); PovViewer.instance = null; return super.close(options); }
}
