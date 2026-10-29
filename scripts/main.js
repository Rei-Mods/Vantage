// Vantage - see the battlemap in 3D from a token's eyes (or an overview), and show it to the players
import {MOD, FIGURES, figureOf, L, viewOptions, templatesOf} from "./foundry.js";
import {WALL_SKINS, MOODS, WEATHER} from "./renderer.js";
import {PROP_LOOKS} from "./world.js";
import {PovWindow, PovViewer, onSocket, sendSnapshot} from "./app.js";

const S = k => `VANTAGE.Settings.${k}`;

Hooks.once("init", () => {
  const reg = (key, data, scope = "world") => game.settings.register(MOD, key, {name: `${S(key)}.Name`, hint: `${S(key)}.Hint`, scope, config: true, ...data});
  const choices = (key, list) => Object.fromEntries(Object.entries(list).map(([v, k]) => [v, `${S(key)}.Choices.${k}`]));
  reg("wallHeight", {type: Number, default: 12, range: {min: 4, max: 40, step: 1}});
  reg("doorHeight", {type: Number, default: 10, range: {min: 4, max: 30, step: 1}});
  reg("raiseDark", {type: Boolean, default: true});
  reg("rockHeight", {type: Number, default: 35, range: {min: 0, max: 120, step: 1}});
  reg("darkThreshold", {type: Number, default: 26, range: {min: 5, max: 80, step: 1}});
  reg("trimColor", {type: String, default: "#3ce6ff"});
  // the look: what walls are made of, and the light (both can be set per scene in Scene Config > Vantage)
  const relook = () => { const w = PovWindow.instance; if (w?.view) { w.view.opts = {...w.view.opts, ...viewOptions(w.scene)}; w.requestRender(); } };
  reg("wallSkin", {type: String, default: "neon", choices: Object.fromEntries(WALL_SKINS.map(k => [k, `VANTAGE.Skins.${k}`])), onChange: relook});
  reg("mood", {type: String, default: "auto", choices: Object.fromEntries(Object.keys(MOODS).map(k => [k, `VANTAGE.Moods.${k}`])), onChange: relook});
  reg("lightColor", {type: String, default: "", onChange: relook});
  reg("fogDistance", {type: Number, default: 250, range: {min: 40, max: 1000, step: 10}});
  reg("bloom", {type: Boolean, default: true});
  reg("snapshotWidth", {type: Number, default: 1600, range: {min: 800, max: 2560, step: 160}});
  reg("standeeArt", {type: String, default: "portrait", choices: choices("standeeArt", {portrait: "portrait", token: "token", tilt: "tilt"}),
    onChange: () => PovWindow.instance?.refreshTokens()});
  reg("tiltDeg", {type: Number, default: 40, range: {min: 10, max: 75, step: 5},
    onChange: () => { const w = PovWindow.instance; if (w?.view) { w.view.opts.tiltDeg = game.settings.get(MOD, "tiltDeg"); w.refreshTokens(); } }});
  reg("heightMapMax", {type: Number, default: 10, range: {min: 0, max: 40, step: 1}, onChange: () => PovWindow.instance?.rebuild()});
  reg("playersCanOpen", {type: Boolean, default: false});
  reg("playersVision", {type: Boolean, default: true});
  reg("shadows", {type: String, default: "full", choices: choices("shadows", {full: "full", corners: "corners", off: "off"}),
    onChange: () => { const w = PovWindow.instance; if (w?.view) { w.view.opts = {...w.view.opts, ...shadowOpts()}; w.requestRender(); } }}, "client");
  reg("quality", {type: String, default: "0.75", choices: choices("quality", {"1": "full", "0.75": "balanced", "0.5": "fast"}),
    onChange: () => PovWindow.instance?.requestRender()}, "client");
  reg("blurMoving", {type: Boolean, default: true, onChange: () => PovWindow.instance?.requestRender()}, "client");
  reg("animate", {type: Boolean, default: true, onChange: () => PovWindow.instance?.requestRender()}, "client");
});

function shadowOpts() { const sh = game.settings.get(MOD, "shadows"); return {shadowN: sh === "full" ? 4 : 0, ao: sh === "off" ? 0 : 1}; }

const viewerTokens = foundry.utils.debounce(() => PovViewer.instance?.refreshTokens(), 300);
for (const h of ["createToken", "updateToken", "deleteToken"]) Hooks.on(h, () => { if (PovViewer.instance?.mode === "live") viewerTokens(); });
// a figure choice set on an actor's prototype token applies to its tokens already on the map
Hooks.on("updateScene", doc => PovViewer.instance?.relook?.(doc));
// players: their 3D view follows their sight
Hooks.on("sightRefresh", () => { if (game.user.isGM) return; PovViewer.instance?.visionSoon?.(); PovWindow.instance?.visionSoon?.(); });
for (const h of ["createMeasuredTemplate", "updateMeasuredTemplate", "deleteMeasuredTemplate"]) Hooks.on(h, doc => {
  const v = PovViewer.instance; if (v?.view?.world && v.liveScene === doc.parent?.id) { v.view.setTemplates(templatesOf(doc.parent, {playerView: true})); v.applyLive(v.lastLive); }
});
Hooks.on("updateActor", (actor, changes) => { if (foundry.utils.hasProperty(changes, `prototypeToken.flags.${MOD}`)) PovWindow.instance?.refreshTokens(); });

// ------------------------------------------------------------------ config fields
const escA = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const rootOf = html => html instanceof HTMLElement ? html : html?.[0];

// Region Config > Placement: a height turns the region into a block (crate, console, dais) or a pit
Hooks.on("renderRegionConfig", (app, html) => {
  if (!game.user.isGM) return;
  const root = rootOf(html) ?? app.element; if (!root) return;
  const part = root.querySelector('[data-application-part="placement"]') ?? root.querySelector('.tab[data-tab="placement"]');
  if (!part || part.querySelector(".vtg-raise")) return;
  const f = app.document?.flags?.[MOD] ?? {}, v = f.raise;
  const look = f.look || "plain", front = f.front === null || f.front === undefined || f.front === "" ? "" : String(f.front);
  const fronts = [["", "Region.FrontAuto"], ["0", "Region.FrontTop"], ["90", "Region.FrontRight"], ["180", "Region.FrontBottom"], ["270", "Region.FrontLeft"]];
  const fs = document.createElement("fieldset");
  fs.className = "vtg-raise";
  fs.innerHTML = `<legend><i class="fa-solid fa-vr-cardboard"></i> ${L("Region.Legend")}</legend>
    <div class="form-group"><label>${L("Region.Height")}</label>
      <div class="form-fields"><input type="number" name="flags.${MOD}.raise" step="0.5" min="-40" max="60" value="${Number.isFinite(v) ? v : ""}" placeholder="${escA(L("Region.Placeholder"))}"></div>
      <p class="hint">${L("Region.Hint")}</p>
    </div>
    <div class="form-group"><label>${L("Region.Look")}</label>
      <div class="form-fields"><select name="flags.${MOD}.look">${PROP_LOOKS.map(k => `<option value="${k}" ${k === look ? "selected" : ""}>${escA(L(`Looks.${k}`))}</option>`).join("")}</select></div>
      <p class="hint">${L("Region.LookHint")}</p>
    </div>
    <div class="form-group"><label>${L("Region.Front")}</label>
      <div class="form-fields"><select name="flags.${MOD}.front" data-dtype="String">${fronts.map(([k, l]) => `<option value="${k}" ${k === front ? "selected" : ""}>${escA(L(l))}</option>`).join("")}</select></div>
    </div>
    <div class="form-group"><label>${L("Region.Pic")}</label>
      <div class="form-fields"><file-picker name="flags.${MOD}.pic" type="image" value="${escA(f.pic ?? "")}"></file-picker></div>
      <p class="hint">${L("Region.PicHint")}</p>
    </div>`;
  (part.querySelector(".scrollable") ?? part).append(fs);
});

// Scene Config > Basics: per-scene height map strength and dark-rock switch (empty = world setting)
Hooks.on("renderSceneConfig", (app, html) => {
  if (!game.user.isGM) return;
  const root = rootOf(html) ?? app.element; if (!root) return;
  const part = root.querySelector('[data-application-part="basics"]') ?? root.querySelector('.tab[data-tab="basics"]') ?? root.querySelector("form");
  if (!part || part.querySelector(".vtg-scene")) return;
  const f = app.document?.flags?.[MOD] ?? {};
  const hm = Number.isFinite(Number(f.heightMax)) && f.heightMax !== "" && f.heightMax != null ? f.heightMax : "";
  const rd = f.raiseDark === true ? "true" : f.raiseDark === false ? "false" : "";
  const opt = (v, label, cur) => `<option value="${v}" ${v === (cur ?? "") ? "selected" : ""}>${escA(label)}</option>`;
  const skinSel = [opt("", L("Scene.UseWorld"), f.wallSkin), ...WALL_SKINS.map(k => opt(k, L(`Skins.${k}`), f.wallSkin))].join("");
  const moodSel = [opt("", L("Scene.UseWorld"), f.mood), ...Object.keys(MOODS).map(k => opt(k, L(`Moods.${k}`), f.mood))].join("");
  const az = Number.isFinite(Number(f.sunAz)) && f.sunAz !== "" && f.sunAz != null ? f.sunAz : "";
  const lc = /^#[0-9a-f]{6}$/i.test(f.lightColor ?? "") ? f.lightColor : "";
  const wxSel = [opt("", L("Scene.WeatherFollow"), f.weather), ...Object.keys(WEATHER).map(k => opt(k, L(`Weather.${k}`), f.weather))].join("");
  const fs = document.createElement("fieldset");
  fs.className = "vtg-scene";
  fs.innerHTML = `<legend><i class="fa-solid fa-vr-cardboard"></i> ${L("Scene.Legend")}</legend>
    <div class="form-group"><label>${L("Scene.HeightMax")}</label>
      <div class="form-fields"><input type="number" name="flags.${MOD}.heightMax" step="1" min="0" max="60" value="${hm}" placeholder="${escA(L("Scene.UseWorld"))}"></div>
      <p class="hint">${L("Scene.HeightMaxHint")}</p>
    </div>
    <div class="form-group"><label>${L("Scene.RaiseDark")}</label>
      <div class="form-fields"><select name="flags.${MOD}.raiseDark" data-dtype="JSON">
        <option value="" ${rd === "" ? "selected" : ""}>${L("Scene.UseWorld")}</option>
        <option value="true" ${rd === "true" ? "selected" : ""}>${L("Scene.On")}</option>
        <option value="false" ${rd === "false" ? "selected" : ""}>${L("Scene.Off")}</option></select></div>
      <p class="hint">${L("Scene.RaiseDarkHint")}</p>
    </div>
    <div class="form-group"><label>${L("Scene.WallSkin")}</label>
      <div class="form-fields"><select name="flags.${MOD}.wallSkin">${skinSel}</select></div>
      <p class="hint">${L("Scene.WallSkinHint")}</p>
    </div>
    <div class="form-group"><label>${L("Scene.Mood")}</label>
      <div class="form-fields"><select name="flags.${MOD}.mood">${moodSel}</select></div>
      <p class="hint">${L("Scene.MoodHint")}</p>
    </div>
    <div class="form-group"><label>${L("Scene.LightColor")}</label>
      <div class="form-fields"><color-picker name="flags.${MOD}.lightColor" value="${lc}" placeholder="${escA(L("Scene.LightColorNone"))}"></color-picker></div>
      <p class="hint">${L("Scene.LightColorHint")}</p>
    </div>
    <div class="form-group"><label>${L("Scene.Weather")}</label>
      <div class="form-fields"><select name="flags.${MOD}.weather">${wxSel}</select></div>
      <p class="hint">${L("Scene.WeatherHint")}</p>
    </div>
    <div class="form-group"><label>${L("Scene.SunAz")}</label>
      <div class="form-fields"><input type="number" name="flags.${MOD}.sunAz" step="5" min="0" max="360" value="${az}" placeholder="${escA(L("Scene.SunAzAuto"))}"></div>
      <p class="hint">${L("Scene.SunAzHint")}</p>
    </div>`;
  (part.querySelector(".scrollable") ?? part).append(fs);
});

// Token Config / Prototype Token > Appearance: which picture this token's 3D figure uses, and how it stands
Hooks.on("renderTokenApplication", (app, html) => {
  const root = rootOf(html) ?? app.element; if (!root) return;
  const part = root.querySelector('[data-application-part="appearance"]') ?? root.querySelector('.tab[data-tab="appearance"]');
  if (!part || part.querySelector(".vtg-figure")) return;
  const tok = app.token ?? app.document; if (!tok) return;
  const own = tok.flags?.[MOD] ?? {};
  const cur = own.figure ?? "", pic = own.standee ?? "";
  const inherited = !app.isPrototype && !own.figure ? figureOf(tok) : "";
  const label = k => k === "" && inherited ? game.i18n.format("VANTAGE.Figures.defaultFrom", {figure: L(FIGURES[inherited])}) : L(FIGURES[k]);
  const fs = document.createElement("fieldset");
  fs.className = "vtg-figure";
  fs.innerHTML = `<legend><i class="fa-solid fa-vr-cardboard"></i> ${L("Token.Legend")}</legend>
    <div class="form-group"><label>${L("Token.Figure")}</label>
      <div class="form-fields"><select name="flags.${MOD}.figure">${Object.keys(FIGURES).map(k =>
        `<option value="${k}" ${k === cur ? "selected" : ""}>${escA(label(k))}</option>`).join("")}</select></div>
      <p class="hint">${L("Token.FigureHint")}</p>
    </div>
    <div class="form-group"><label>${L("Token.Picture")}</label>
      <div class="form-fields"><file-picker name="flags.${MOD}.standee" type="image" value="${escA(pic)}"></file-picker></div>
      <p class="hint">${L("Token.PictureHint")}</p>
    </div>`;
  (part.querySelector(".scrollable") ?? part).append(fs);
});

Hooks.once("ready", () => {
  game.socket.on(`module.${MOD}`, onSocket);
  game.modules.get(MOD).api = {
    /** open the 3D view from a token's eyes ("eye") or as an overview around it ("orbit"); token = Token, TokenDocument, id or name */
    open: (token, mode) => {
      const doc = typeof token === "string" ? canvas.scene?.tokens.get(token) ?? canvas.scene?.tokens.getName(token) : (token?.document ?? token ?? null);
      return PovWindow.open({tokenDoc: doc, mode});
    },
    /** open an overview of the whole scene */
    overview: () => PovWindow.open({mode: "orbit"}),
    /** send the current picture to every player */
    showPlayers: () => PovWindow.instance?.shareSnapshot(),
    /** the open 3D window (or null) */
    window: () => PovWindow.instance,
    /** show any image (data URL or path) to every player in the viewer window */
    sendImage: (url, title) => sendSnapshot(url, title)
  };
  Hooks.callAll("vantageReady", game.modules.get(MOD).api);
});

const canOpen = () => game.user?.isGM || game.settings.get(MOD, "playersCanOpen");

Hooks.on("getSceneControlButtons", controls => {
  if (!canOpen()) return;
  const tool = {name: "vantage", title: "VANTAGE.ToolTitle", icon: "fa-solid fa-vr-cardboard", button: true, order: 95, visible: true,
    onChange: () => { const t = canvas.tokens?.controlled?.[0]; PovWindow.open({tokenDoc: t?.document ?? null, mode: t ? "eye" : "orbit"}); }};
  if (Array.isArray(controls)) { const t = controls.find(c => c.name === "token" || c.name === "tokens"); t?.tools.push(tool); }
  else { const t = controls.tokens ?? controls.token; if (t) t.tools[tool.name] = tool; }
});

Hooks.on("renderTokenHUD", (hud, html) => {
  if (!canOpen()) return;
  const doc = hud.object?.document; if (!doc) return;
  if (!game.user.isGM && !doc.isOwner) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector(".col.left") ?? root?.querySelector(".left");
  if (!col || col.querySelector(".vtg-hud")) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "control-icon vtg-hud"; b.dataset.tooltip = L("HudTooltip");
  b.innerHTML = `<i class="fa-solid fa-vr-cardboard"></i>`;
  b.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); PovWindow.open({tokenDoc: doc, mode: "eye"}); });
  col.append(b);
});
