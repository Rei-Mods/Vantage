// Vantage - 3D sound: while you look around in 3D, the scene's ambient sounds are heard from the camera (louder as you
// walk toward them) and panned left / right by where they are around you
import {MOD} from "./foundry.js";

const panners = new WeakMap();   // Sound -> StereoPannerNode
let owner = null;                // the view the sounds currently follow

/** hear the scene's ambient sounds from this view's camera (call after each draw; cheap: at most ~8 times a second) */
export function followCamera(view, scene, who) {
  let on = true; try { on = game.settings.get(MOD, "sound3d") !== false; } catch (e) { /* not registered */ }
  const layer = canvas?.sounds;
  if (!on || !layer || !view?.world || canvas.scene?.id !== scene?.id) return release(who);
  const now = performance.now();
  if (owner === who && now - (who._sndT ?? 0) < 120) return;
  who._sndT = now; owner = who;
  const W = view.world, v = view.vectors();
  const ear = view.cam.mode === "orbit" ? view.cam.target : v.pos;
  const pos = {x: ear[0] + W.ox, y: ear[2] + W.oy, elevation: ear[1] / W.ppf};
  layer.getListenerPositions = () => [pos];   // Foundry's own volume falloff, walls and muffling then do the rest
  try { layer.refresh({fade: 120}); } catch (e) { /* audio not ready */ }
  // left / right
  const rx = v.r[0], rz = v.r[2], rl = Math.hypot(rx, rz) || 1;
  for (const s of layer.placeables ?? []) {
    const snd = s.sound; if (!snd?.context || !snd.playing) continue;
    let p = panners.get(snd);
    if (!p) { try { p = snd.context.createStereoPanner(); panners.set(snd, p); } catch (e) { continue; } }
    if (!(snd.effects ?? []).includes(p)) { try { snd.applyEffects([...(snd.effects ?? []).filter(e => !(e instanceof StereoPannerNode)), p]); } catch (e) { continue; } }
    const dx = s.document.x - pos.x, dz = s.document.y - pos.y, dl = Math.hypot(dx, dz);
    const pan = dl < 1 ? 0 : Math.max(-1, Math.min(1, (dx * rx + dz * rz) / (dl * rl))) * 0.85;
    try { p.pan.setTargetAtTime(pan, snd.context.currentTime, 0.08); } catch (e) { p.pan.value = pan; }
  }
}

/** back to Foundry's own listeners (the tokens on the map), centred */
export function release(who) {
  if (owner !== who || !canvas?.sounds) return;
  owner = null;
  delete canvas.sounds.getListenerPositions;
  for (const s of canvas.sounds.placeables ?? []) {
    const snd = s.sound, p = snd && panners.get(snd);
    if (p && snd.effects?.includes(p)) { try { snd.applyEffects(snd.effects.filter(e => e !== p)); } catch (e) { /* gone */ } }
  }
  try { canvas.sounds.refresh({fade: 250}); } catch (e) { /* audio not ready */ }
}
