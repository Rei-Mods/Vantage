// Vantage - reads the live Foundry scene into plain data for world.js / view.js
export const MOD = "vantage";
export const setting = k => game.settings.get(MOD, k);
/** localize a VANTAGE.* key; with data, format it */
export const L = (k, data) => data ? game.i18n.format(`VANTAGE.${k}`, data) : game.i18n.localize(`VANTAGE.${k}`);

const TARGET = [1.0, 0.42, 0.08];   // a token you target: an orange ring
const DISPO = {"-2": [0.75, 0.35, 1.0], "-1": [1.0, 0.18, 0.22], "0": [1.0, 0.85, 0.2], "1": [0.2, 0.9, 1.0]};

export function rectOf(scene) {
  const d = scene.dimensions;
  return {ox: d.sceneX, oy: d.sceneY, W: d.sceneWidth, H: d.sceneHeight, ppf: d.distancePixels, gridPx: d.size};
}

/** a per-scene override stored in the scene's flags (undefined = use the world setting) */
export function sceneFlag(scene, key) {
  const v = scene?.flags?.[MOD]?.[key];
  return v === undefined || v === null || v === "" ? undefined : v;
}

/** tallest point of height maps on this scene (ft): the scene's own value (Scene Config > Vantage) or the world setting */
export function heightMaxOf(scene) {
  const own = Number(sceneFlag(scene, "heightMax"));
  if (sceneFlag(scene, "heightMax") !== undefined && Number.isFinite(own)) return Math.max(0, own);
  try { return Number(setting("heightMapMax")) || 0; } catch (e) { return 0; }
}

/** height map files to look for next to a map image: "<map>_height.webp / .png / .jpg" (only when height maps are on) */
function heightSrcs(src, max) {
  if (!src || max <= 0 || isVideo(src)) return [];
  const m = src.match(/^(.*)\.[a-z0-9]+(\?.*)?$/i); if (!m) return [];
  return ["webp", "png", "jpg"].map(x => `${m[1]}_height.${x}`);
}

export function sceneData(scene, viewLevel) {
  const r = rectOf(scene);
  const hMax = heightMaxOf(scene);
  let levels = [];
  if (scene.levels?.size) {
    levels = scene.levels.contents.map(l => ({
      id: l.id, bottom: Number.isFinite(l.elevation?.bottom) ? l.elevation.bottom : 0,
      src: l.background?.src || null, color: l.background?.color?.css ?? null,
      visibility: [...(l.visibility?.levels ?? [])], heightSrcs: heightSrcs(l.background?.src, hMax)
    }));
  } else {
    levels = [{id: "base", bottom: 0, src: scene.background?.src ?? null, color: scene.backgroundColor?.css ?? "#111", visibility: [], heightSrcs: heightSrcs(scene.background?.src, hMax)}];
  }
  // sight NORMAL = a full wall; LIMITED / PROXIMITY / DISTANCE (windows, foliage, glass) = a low wall you can see over
  const NORMAL = CONST.WALL_SENSE_TYPES?.NORMAL ?? 20;
  const walls = scene.walls.contents.map(w => ({id: w.id, c: [...w.c], sight: w.sight, low: !!w.sight && w.sight !== NORMAL,
    door: w.door, ds: w.ds, levels: [...(w.levels ?? [])]}));
  return {...r, levels, walls, regions: regionsOf(scene), viewLevel: viewLevel ?? scene.levels?.contents?.[0]?.id ?? "base"};
}

/** stairs / ladders (regions with an active "Change Level" behaviour) and raised areas (regions with a Vantage height),
 *  as canvas-space polygons */
export function regionsOf(scene) {
  const out = [];
  for (const r of scene.regions?.contents ?? []) {
    const on = t => !!r.behaviors?.contents?.some(b => t.includes(b.type) && !b.disabled);
    const stairs = on(["changeLevel"]);
    const dry = on(["suppressWeather", "fxmaster.suppressSceneParticles"]);   // no rain or snow falls here
    const raise = Number(r.flags?.[MOD]?.raise);
    const raised = Number.isFinite(raise) && Math.abs(raise) >= 0.1;
    if (!stairs && !raised && !dry) continue;
    let polys = [];
    try { polys = (r.polygons ?? []).map(p => [...p.points]); } catch (e) { /* fall back to the shapes */ }
    if (!polys.length) polys = (r.shapes ?? []).filter(s => !s.hole).map(shapePoly).filter(p => p.length >= 6);
    const f = r.flags?.[MOD] ?? {};
    out.push({id: r.id, name: r.name, stairs: stairs && !raised, raise: raised ? raise : null, dry, levels: [...(r.levels ?? [])], polys,
      look: f.look || null, front: f.front ?? null, pic: f.pic || null});   // what a raised area looks like from the side
  }
  return out;
}
function shapePoly(s) {
  const rot = (s.rotation ?? 0) * Math.PI / 180, c = Math.cos(rot), n = Math.sin(rot);
  if (s.type === "polygon") return [...(s.points ?? [])];
  if (s.type === "rectangle") {
    const cx = s.x + s.width / 2, cy = s.y + s.height / 2, hw = s.width / 2, hh = s.height / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].flatMap(([x, y]) => [cx + x * c - y * n, cy + x * n + y * c]);
  }
  if (s.type === "ellipse" || s.type === "circle") {
    const rx = s.radiusX ?? s.radius ?? 0, ry = s.radiusY ?? s.radius ?? 0, pts = [];
    for (let i = 0; i < 24; i++) { const a = i / 24 * 2 * Math.PI, x = Math.cos(a) * rx, y = Math.sin(a) * ry; pts.push(s.x + x * c - y * n, s.y + x * n + y * c); }
    return pts;
  }
  return [];
}

export function viewLevelFor(scene, tokenDoc) {
  return tokenDoc?.level ?? (canvas.scene === scene ? canvas.level?.id : null) ?? scene.initialLevel?.id ?? scene.levels?.contents?.[0]?.id;
}

function isVideo(src) { return /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(src ?? ""); }
const isPlaceholder = src => !src || /mystery-man|icons\/svg/i.test(src);
/** The standee pictures to try, best first (the first one that loads is used).
 *  Override flag `vantage.standee` > (setting "portrait", the default) upright art: the actor portrait (or, while the token
 *  wears another form, the Tokenizer ".Avatar." twin of its CURRENT image so a Visage form shows), then the token image
 *  > (setting "token") the token image first. Top-down token art stood up on a card looks like it leans toward you,
 *  which is why the portrait is the default. Loot always uses its token image. Animated .webm = first frame. */
function standeeSrcs(doc, loot, mode) {
  const flag = d => d?.flags?.[MOD]?.standee || null;
  const own = flag(doc) ?? flag(doc.actor) ?? flag(protoOf(doc));
  if (own) return [own];
  const t = doc.texture?.src, a = doc.actor?.img;
  const ok = s => !!s && !isPlaceholder(s);
  const twin = ok(t) && /\.Token\./i.test(t) ? t.replace(/\.Token\./i, ".Avatar.") : null;
  // the token wears another form (e.g. a Visage transformation): its Tokenizer ".Avatar." twin shows that form;
  // otherwise the actor's own portrait comes first (it is usually the best upright art)
  const strip = s => String(s ?? "").split("?")[0];
  const transformed = !!twin && strip(t) !== strip(protoOf(doc)?.texture?.src);
  const list = loot || mode !== "portrait" ? [t, a] : transformed ? [twin, a, t] : [a, twin, t];
  const out = [...new Set(list.filter(ok))];
  return out.length ? out : [t || a].filter(Boolean);
}
const protoOf = doc => (doc.baseActor ?? doc.actor)?.prototypeToken ?? null;
/** This token's own 3D figure choice (Token Config > Appearance > Vantage), falling back to its actor's prototype token:
 *  "" = world setting, portrait | token (standing) | tilt (token art leaning back) | flat | none */
export function figureOf(doc) {
  return doc.flags?.[MOD]?.figure || protoOf(doc)?.flags?.[MOD]?.figure || "";
}
/** figure choices -> their VANTAGE.* label keys */
export const FIGURES = {"": "Figures.default", portrait: "Figures.portrait", token: "Figures.token", tilt: "Figures.tilt", flat: "Figures.flat", none: "Figures.none"};

/** Item Piles loot (bags, chests): drawn as a small object on the floor, not a person-sized standee. */
function isLoot(doc) {
  const pile = d => d?.flags?.["item-piles"]?.data?.enabled === true;
  return pile(doc) || pile(doc.actor);
}

/** Objects (creature type "Object ...", e.g. terminals) or anything flagged vantage.flat: drawn flat on the floor
 *  with the token's CURRENT image (so a "Destroyed" swap shows). */
function isObject(doc) {
  const f = doc.flags?.[MOD]?.flat ?? doc.actor?.flags?.[MOD]?.flat;
  if (f !== undefined) return !!f;
  const ty = doc.actor?.system?.details?.type;
  return /\bobject\b/i.test(`${ty?.value ?? ""} ${ty?.custom ?? ""} ${ty?.subtype ?? ""}`);
}

/** forViewer: the user whose eyes decide which tokens appear (GM sees all, hidden ones faded) */
export function tokensOf(scene, {playerView = false} = {}) {
  const r = rectOf(scene);
  const out = [];
  for (const doc of scene.tokens.contents) {
    if (doc.hidden && (playerView || !game.user.isGM)) continue;
    if (playerView && !game.user.isGM && doc.object && !doc.object.visible) continue;
    const loot = isLoot(doc);
    let mode = figureOf(doc);
    if (mode === "none") continue;
    if (!mode) { mode = isObject(doc) ? "flat" : "portrait"; try { if (mode !== "flat") mode = setting("standeeArt") || "portrait"; } catch (e) { /* not registered */ } }
    if (loot && mode !== "flat") mode = "token";
    const flat = mode === "flat", tilt = mode === "tilt" && !loot;
    const srcs = standeeSrcs(doc, loot, mode); if (!srcs.length) continue;
    const gs = r.gridPx;
    out.push({
      id: doc.id, name: doc.name, src: srcs[0], srcs,
      x: doc.x + doc.width * gs / 2 - r.ox, y: doc.y + doc.height * gs / 2 - r.oy,
      elevation: doc.elevation ?? 0, size: Math.max(doc.width, doc.height), rotation: doc.rotation ?? 0,
      ringColor: doc.object?.isTargeted ? TARGET : DISPO[String(doc.disposition)] ?? DISPO["0"], targeted: !!doc.object?.isTargeted,
      hidden: !!doc.hidden, level: doc.level ?? null, loot, flat, tilt
    });
  }
  return out;
}

export function lightsOf(scene) {
  const r = rectOf(scene);
  const C = foundry.utils.Color;
  // darkness sources (negative lights) don't glow
  return scene.lights.contents.filter(l => !l.hidden && !l.config?.negative).map(l => {
    const cfg = l.config ?? {};
    let rgb = [1, 1, 1];
    try { if (cfg.color !== null && cfg.color !== undefined) rgb = C.from(cfg.color).rgb; } catch (e) { /* default */ }
    const an = cfg.animation ?? {};
    return {x: l.x - r.ox, y: l.y - r.oy, elevation: l.elevation ?? 0, range: Math.max(cfg.dim ?? 0, cfg.bright ?? 0),
      alpha: cfg.alpha ?? 0.5, color: rgb, levels: [...(l.levels ?? [])],
      anim: an.type ? {type: an.type, speed: Number(an.speed ?? 5), intensity: Number(an.intensity ?? 5), reverse: !!an.reverse} : null};
  }).filter(l => l.range > 0);
}

/** the scene's spell templates (Foundry measured templates), in scene-rect px; hidden ones only for the GM */
export function templatesOf(scene, {playerView = false} = {}) {
  const r = rectOf(scene), C = foundry.utils.Color;
  return (scene.templates?.contents ?? []).filter(t => !(t.hidden && (playerView || !game.user.isGM))).map(t => {
    let color = [1, 0.5, 0.2];
    try { color = C.from(t.fillColor || t.author?.color || "#ff8040").rgb; } catch (e) { /* default */ }
    return {id: t.id, type: t.t, x: t.x - r.ox, y: t.y - r.oy, len: (t.distance ?? 0) * r.ppf, dir: (t.direction ?? 0) * Math.PI / 180,
      half: (t.angle || 53.13) * Math.PI / 360, width: (t.width || 5) * r.ppf, elevation: t.elevation ?? 0, color};
  });
}

/** the nearest hostile the token could look at (for the default facing) */
export function nearestFoe(scene, tok, list) {
  const mine = scene.tokens.get(tok.id);
  const foes = list.filter(t => t.id !== tok.id && !t.hidden && (mine?.disposition ?? 1) !== scene.tokens.get(t.id)?.disposition
    && scene.tokens.get(t.id)?.disposition === -1);
  let best = null, bd = Infinity;
  for (const f of foes) { const d = Math.hypot(f.x - tok.x, f.y - tok.y); if (d < bd) { bd = d; best = f; } }
  return bd < 150 * rectOf(scene).ppf ? best : null;
}

const boolOr = (v, dflt) => v === undefined ? dflt : v === true || v === "true";
export function buildOptions(scene = null) {
  return {wallHeight: setting("wallHeight"), doorHeight: setting("doorHeight"), rockHeight: setting("rockHeight"),
    raiseDark: boolOr(sceneFlag(scene, "raiseDark"), setting("raiseDark")), darkThreshold: setting("darkThreshold"), heightMapMax: heightMaxOf(scene)};
}
/** 0 = night, 1 = full daylight, from the scene's darkness level */
export function daylightOf(scene) {
  const d = scene?.environment?.darknessLevel ?? scene?.darkness ?? 0;
  return Math.max(0, Math.min(1, 1 - Number(d || 0)));
}
export function viewOptions(scene = null) {
  const trim = foundry.utils.Color.from(setting("trimColor") || "#3ce6ff").rgb.map(c => c * 1.05);
  const sh = setting("shadows");
  return {trim, fogFt: setting("fogDistance"), bloom: setting("bloom") ? 1 : 0, cutaway: true,
    shadowN: sh === "full" ? 4 : 0, ao: sh === "off" ? 0 : 1, tiltDeg: Number(setting("tiltDeg")) || 40,
    daylight: daylightOf(scene) * (sceneFlag(scene, "daylightHaze") === false ? 0 : 1), ...lookOf(scene)};
}
/** the scene's wall skin, lighting mood and sun direction (Scene Config > Vantage; empty = the world setting) */
export function lookOf(scene = null) {
  const get = k => { try { return setting(k); } catch (e) { return undefined; } };
  const az = Number(sceneFlag(scene, "sunAz"));
  return {skin: sceneFlag(scene, "wallSkin") ?? get("wallSkin") ?? "neon", mood: sceneFlag(scene, "mood") ?? get("mood") ?? "auto",
    sunAz: sceneFlag(scene, "sunAz") !== undefined && Number.isFinite(az) ? az : null,
    tint: hexRGB(sceneFlag(scene, "lightColor") ?? get("lightColor")),
    weather: weatherOf(scene), dark: Number(scene?.environment?.darknessLevel ?? scene?.darkness ?? 0) || 0};
}
// Foundry's own weather (and FXMaster's) -> a Vantage weather
const FOUNDRY_WEATHER = {rain: "rain", rainStorm: "storm", fog: "fog", snow: "snow", blizzard: "blizzard", leaves: "leaves",
  autumnleaves: "leaves", snowstorm: "blizzard", hail: "storm", embers: "embers", clouds: "fog", stars: "fireflies"};
/** the scene's weather: its Vantage choice (Scene Config > Vantage), else whatever Foundry (or FXMaster) shows on the map */
export function weatherOf(scene = null) {
  const own = sceneFlag(scene, "weather");
  if (own) return own;
  const id = String(scene?.weather ?? "").replace(/^fxmaster\./, "");
  if (FOUNDRY_WEATHER[id]) return FOUNDRY_WEATHER[id];
  for (const e of Object.values(scene?.flags?.fxmaster?.effects ?? {})) { const w = FOUNDRY_WEATHER[e?.type]; if (w) return w; }
  return "none";
}
/** "#rrggbb" -> [r, g, b] in 0..1 (null when empty or not a colour) */
export function hexRGB(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? "").trim()); if (!m) return null;
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
}
