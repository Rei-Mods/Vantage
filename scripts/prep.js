// Vantage - one-click map prep: a height map from the map's water, raised areas from tiles, looks from names
import {MOD, L, rectOf, sceneFlag} from "./foundry.js";
import {loadImageLike} from "./world.js";

/** names (of tiles, their images, or regions) -> a look, and how tall that thing usually is (ft) */
const WORDS = [
  [/arcade|cabinet/i, "arcade", 6], [/vending/i, "vending", 7], [/server/i, "server", 7], [/book ?shel|bookcase/i, "bookshelf", 7],
  [/crate|\bbox(es)?\b/i, "crate", 3.5], [/container/i, "container", 8.5], [/console|terminal|computer/i, "console", 4],
  [/\bbar\b|bar ?counter/i, "bar", 3.8], [/counter/i, "counter", 3.5], [/fridge|refrigerat/i, "fridge", 6.5], [/locker/i, "lockers", 6.5],
  [/pillar|plinth|pedestal|statue/i, "plinth", 4], [/barrel|keg/i, "barrels", 3.5], [/machine|generator|engine/i, "machine", 6],
  [/dresser|wardrobe|cupboard|drawer/i, "dresser", 5], [/display|showcase|vitrine/i, "display", 4], [/sandbag/i, "sandbags", 3],
  [/\bhay\b|haybale/i, "hay", 3.5], [/kiosk|booth/i, "kiosk", 8], [/altar|shrine/i, "altar", 3.5], [/table|desk/i, "table", 3],
  [/\bbed\b|bedroll|cot\b/i, "bed", 2.5], [/hearth|fireplace|furnace|oven|forge/i, "hearth", 6], [/chest|coffer|trunk/i, "chest", 2.5],
  [/sofa|couch/i, "sofa", 3], [/\batm\b/i, "atm", 6], [/jukebox/i, "jukebox", 5.5], [/reactor/i, "reactor", 12], [/tyre|tire/i, "tires", 3],
  [/dumpster|skip|trash|garbage/i, "dumpster", 5], [/\bcar\b|truck|\bvan\b|vehicle|taxi|sedan/i, "car", 5], [/shelf|shelving|rack/i, "shelving", 8],
  [/piano/i, "piano", 4], [/stall|market/i, "stall", 7], [/planter|flower ?pot|plant ?pot/i, "planter", 2.5], [/boulder|\brocks?\b|stone/i, "boulder", 4],
  [/\bice\b/i, "ice", 5], [/crystal/i, "crystals", 5], [/cage|jail|prison/i, "cage", 8], [/tent/i, "stretch", 7]
];
/** tiles that are effects, not things (no block for them) */
const SKIP = /aura|portal|vortex|\bfx\b|effect|glow|spell|smoke|fog|cloud|light|shadow|trap|blood|decal|rug|carpet|puddle|water|grass|road|path/i;
export function guessLook(...names) {
  const s = names.filter(Boolean).join(" ").replace(/[_\-.]+/g, " ");
  for (const [re, look, h] of WORDS) if (re.test(s)) return {look, height: h};
  return null;
}

/** what "Prep this map" would do: {water: {frac, canvas} | null, tiles: [...], looks: [...]} */
export async function analyze(scene) {
  const r = rectOf(scene), out = {water: null, tiles: [], looks: []};
  // ---- water -> a height map: the ground rises with the distance from the water (riverbanks, shores, canyons)
  const src = scene.levels?.contents?.[0]?.background?.src || scene.background?.src;
  const img = await loadImageLike(src);
  if (img) {
    const maxSide = 900, k = Math.min(1, maxSide / Math.max(r.W, r.H)), w = Math.max(8, Math.round(r.W * k)), h = Math.max(8, Math.round(r.H * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d", {willReadFrequently: true});
    try {
      x.drawImage(img, 0, 0, w, h);
      const px = x.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        // water: cyan to sky blue, fairly saturated, neither black nor glaring (purple neon and blue night tints are not water)
        const R = px[j] / 255, G = px[j + 1] / 255, B = px[j + 2] / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), c = mx - mn;
        let hue = 0;
        if (c > 1e-3) hue = mx === R ? 60 * (((G - B) / c) % 6) : mx === G ? 60 * ((B - R) / c + 2) : 60 * ((R - G) / c + 4);
        if (hue < 0) hue += 360;
        m[i] = hue >= 165 && hue <= 212 && c / mx >= 0.25 && mx >= 0.2 && mx <= 0.92 ? 1 : 0;
      }
      const clean = keepBlobs(smooth(m, w, h, 2), w, h, Math.max(8, 4 * (r.gridPx * k) ** 2));   // at least 4 squares of it
      let n = 0; for (const v of clean) n += v;
      const frac = n / (w * h);
      if (frac > 0.02 && frac < 0.6) {
        const pxPerFt = r.ppf * k, bank = 15 * pxPerFt, dist = distance(clean, w, h);
        const hc = document.createElement("canvas"); hc.width = w; hc.height = h;
        const hx = hc.getContext("2d"), id = hx.createImageData(w, h);
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
          const v = Math.round(255 * Math.pow(Math.min(1, dist[i] / bank), 0.8));
          id.data[j] = id.data[j + 1] = id.data[j + 2] = v; id.data[j + 3] = 255;
        }
        hx.putImageData(id, 0, 0);
        // a preview for the dialog: the map, dimmed, with what was taken for water in cyan
        const pv = document.createElement("canvas"); pv.width = 360; pv.height = Math.round(360 * h / w);
        const pc = pv.getContext("2d"); pc.drawImage(c, 0, 0, pv.width, pv.height); pc.fillStyle = "rgba(0,0,0,0.55)"; pc.fillRect(0, 0, pv.width, pv.height);
        const mc = document.createElement("canvas"); mc.width = w; mc.height = h; const mx2 = mc.getContext("2d"), mi = mx2.createImageData(w, h);
        for (let i = 0, j = 0; i < w * h; i++, j += 4) if (clean[i]) { mi.data[j] = 40; mi.data[j + 1] = 230; mi.data[j + 2] = 255; mi.data[j + 3] = 200; }
        mx2.putImageData(mi, 0, 0); pc.drawImage(mc, 0, 0, pv.width, pv.height);
        out.water = {frac, canvas: hc, preview: pv.toDataURL("image/jpeg", 0.8)};
      }
    } catch (e) { console.warn(MOD, "prep: the map can't be read (another server?)", e); }
  }
  // ---- tiles -> raised areas (with a look from their names); bridges and roofs float
  const fg = scene.foregroundElevation ?? scene.environment?.foregroundElevation ?? 20;
  for (const t of scene.tiles?.contents ?? []) {
    if (t.hidden) continue;
    const name = decodeURIComponent((t.texture?.src ?? "").split("/").pop() ?? "");
    if (SKIP.test(name) || /\.(webm|mp4)$/i.test(name)) continue;
    const area = t.width * t.height, cell = r.gridPx * r.gridPx;
    if (area < 0.3 * cell || area > 0.4 * r.W * r.H) continue;
    const g = guessLook(name, t.name);
    const overhead = (t.elevation ?? 0) >= fg;
    const bridge = /bridge|walkway|catwalk|balcony|gantry/i.test(name);
    let raise, under = null, look = g?.look ?? null;
    if (bridge) { raise = overhead ? 10 : 10; under = raise - 1.5; look = null; }
    else if (overhead || /roof|canopy|awning|tree/i.test(name)) { raise = 12; under = 11; look = null; }
    else raise = g?.height ?? 3;
    out.tiles.push({tile: t, name, look, raise, under, kind: bridge ? "bridge" : under !== null ? "roof" : "block"});
  }
  // ---- raised regions without a look: guess it from their names
  for (const rg of scene.regions?.contents ?? []) {
    const f = rg.flags?.[MOD] ?? {};
    if (!(Number(f.raise) > 0) || f.look) continue;
    const g = guessLook(rg.name); if (g) out.looks.push({region: rg, look: g.look});
  }
  return out;
}

/** do it: upload the height map, create the regions (named "... (auto)", flagged so they can be removed), set looks */
export async function apply(scene, res, {water = true, tiles = true, looks = true} = {}) {
  const done = {water: false, tiles: 0, looks: 0};
  if (water && res.water) {
    const FP = foundry.applications.apps.FilePicker.implementation, dir = "vantage-height-maps";
    try { await FP.createDirectory("data", dir, {notify: false}); } catch (e) { /* exists */ }
    const blob = await new Promise(ok => res.water.canvas.toBlob(ok, "image/png"));
    const file = new File([blob], `${scene.id}-${Date.now().toString(36)}.png`, {type: "image/png"});
    const up = await FP.upload("data", dir, file, {}, {notify: false});
    const path = up?.path;
    if (path) {
      const upd = {[`flags.${MOD}.heightSrc`]: path};
      if (sceneFlag(scene, "heightMax") === undefined) upd[`flags.${MOD}.heightMax`] = 8;
      await scene.update(upd); done.water = true;
    }
  }
  if (tiles && res.tiles.length) {
    const docs = res.tiles.map(({tile: t, name, look, raise, under, kind}) => ({
      name: `Vantage: ${look ?? kind} (auto)`, color: kind === "block" ? "#3ce6ff" : "#ffb347",
      shapes: [{type: "rectangle", x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation ?? 0}],
      flags: {[MOD]: {raise, ...(under !== null ? {under} : {}), ...(look ? {look} : {}), auto: true, from: name}}
    }));
    const made = await scene.createEmbeddedDocuments("Region", docs);
    done.tiles = made.length;
  }
  if (looks && res.looks.length) {
    await scene.updateEmbeddedDocuments("Region", res.looks.map(({region, look}) => ({_id: region.id, [`flags.${MOD}.look`]: look})));
    done.looks = res.looks.length;
  }
  return done;
}

/** undo: remove the regions prep made and its height map */
export async function undo(scene) {
  const ids = scene.regions.filter(r => r.flags?.[MOD]?.auto).map(r => r.id);
  if (ids.length) await scene.deleteEmbeddedDocuments("Region", ids);
  if (sceneFlag(scene, "heightSrc")) await scene.update({[`flags.${MOD}.heightSrc`]: null});
  return ids.length;
}

/** Scene Config button: analyse, show what it found, apply what the GM ticks */
export async function prepDialog(scene) {
  ui.notifications.info(L("Prep.Working"));
  const res = await analyze(scene);
  const autos = scene.regions.filter(r => r.flags?.[MOD]?.auto).length + (sceneFlag(scene, "heightSrc") ? 1 : 0);
  const count = res.tiles.reduce((m, t) => (m[t.look ?? t.kind] = (m[t.look ?? t.kind] ?? 0) + 1, m), {});
  const list = Object.entries(count).map(([k, n]) => `${n} × ${L(`Looks.${k}`).startsWith("VANTAGE.") ? k : L(`Looks.${k}`)}`).join(", ");
  const row = (name, on, label, hint) => `<div class="form-group"><label class="checkbox"><input type="checkbox" name="${name}" ${on ? "checked" : "disabled"}> ${label}</label><p class="hint">${hint}</p></div>`;
  const content = `<p>${L("Prep.Intro")}</p>
    ${row("water", !!res.water, L("Prep.Water"), res.water ? L("Prep.WaterFound", {pct: Math.round(res.water.frac * 100)}) : L("Prep.WaterNone"))}
    ${res.water?.preview ? `<img src="${res.water.preview}" style="display:block;max-width:100%;margin:0 0 8px;border:1px solid #3ce6ff55;border-radius:4px" alt="">` : ""}
    ${row("tiles", res.tiles.length > 0, L("Prep.Tiles"), res.tiles.length ? L("Prep.TilesFound", {n: res.tiles.length, list}) : L("Prep.TilesNone"))}
    ${row("looks", res.looks.length > 0, L("Prep.Looks"), res.looks.length ? L("Prep.LooksFound", {n: res.looks.length}) : L("Prep.LooksNone"))}
    ${autos ? `<p class="hint">${L("Prep.UndoHint", {n: autos})}</p>` : ""}`;
  const {DialogV2} = foundry.applications.api;
  const choice = await DialogV2.wait({
    window: {title: L("Prep.Title"), icon: "fa-solid fa-wand-magic-sparkles"}, content, rejectClose: false,
    buttons: [
      {action: "apply", label: L("Prep.Apply"), icon: "fa-solid fa-check", default: true,
        callback: (ev, btn) => { const f = btn.form; return {water: !!f.elements.water?.checked, tiles: !!f.elements.tiles?.checked, looks: !!f.elements.looks?.checked}; }},
      ...(autos ? [{action: "undo", label: L("Prep.Undo"), icon: "fa-solid fa-rotate-left", callback: () => "undo"}] : []),
      {action: "cancel", label: L("Prep.Cancel"), icon: "fa-solid fa-xmark"}
    ]
  });
  if (choice === "undo") { const n = await undo(scene); return ui.notifications.info(L("Prep.Undone", {n})); }
  if (!choice || choice === "cancel") return;
  const done = await apply(scene, res, choice);
  ui.notifications.info(L("Prep.Done", {water: done.water ? L("Prep.Yes") : L("Prep.No"), tiles: done.tiles, looks: done.looks}));
}

// ---------------------------------------------------------------- small image helpers
function smooth(m, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += m[yy * w + xx]; n++; } }
    out[y * w + x] = s * 2 > n ? 1 : 0;
  }
  return out;
}
function keepBlobs(m, w, h, minArea) {
  const lab = new Int32Array(w * h).fill(-1), out = new Uint8Array(w * h), stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || lab[i] >= 0) continue;
    const blob = []; stack.push(i); lab[i] = i;
    while (stack.length) {
      const p = stack.pop(); blob.push(p); const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && m[q] && lab[q] < 0) { lab[q] = i; stack.push(q); }
    }
    if (blob.length >= minArea) for (const p of blob) out[p] = 1;
  }
  return out;
}
/** distance (px) to the nearest water pixel (two-pass chamfer) */
function distance(m, w, h) {
  const d = new Float32Array(w * h), INF = 1e9, D = Math.SQRT2;
  for (let i = 0; i < w * h; i++) d[i] = m[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1); if (y > 0) v = Math.min(v, d[i - w] + 1);
    if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + D); if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + D);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1); if (y < h - 1) v = Math.min(v, d[i + w] + 1);
    if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + D); if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + D);
    d[i] = v;
  }
  return d;
}
