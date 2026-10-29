// Vantage - WebGL2 heightfield ray-march renderer (render on demand, bloom post-pass)

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const SCENE_FS = (MAX_LIGHTS, MAX_STANDEES) => `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uFloor, uHeight, uAtlas, uMax, uAOTex;
uniform int uMaxLod;
uniform vec2 uWorld, uHRes, uRes;
uniform float uPpf, uMaxH, uMinH, uTanX, uFogFt, uFogStart, uTime, uCutT, uCutH;
uniform vec3 uCamPos, uCamF, uCamR, uCamU, uTrim, uFogCol;
uniform vec4 uCap; uniform vec3 uCapRH;   // corridor: radius, cut height at the target, camera height
uniform int uNL, uNS, uShadowN;
uniform float uAO;
uniform int uSkin;                                   // wall skin (0 = neon panels, see WALL_SKINS)
uniform float uMood, uLightK, uSat, uSunShadow, uTrimK, uKeep;   // uKeep: how much of the map's bright (painted glowing) art stays lit   // uMood 0 = automatic (the map's own light), 1 = a lighting mood
uniform vec3 uSunDir, uSunCol, uAmb, uSkyTop, uSkyHor;
uniform vec4 uLPos[${MAX_LIGHTS}], uLCol[${MAX_LIGHTS}];
uniform vec4 uSPos[${MAX_STANDEES}], uSUV[${MAX_STANDEES}], uSInfo[${MAX_STANDEES}], uSTint[${MAX_STANDEES}], uSRing[${MAX_STANDEES}];

float hAt(vec2 xz){
  vec2 uv = xz / uWorld;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1e6;
  return texture(uHeight, uv).r * uPpf;
}
// cutaway limit at a point: near the camera (t < uCutT) -> uCutH; inside the camera->target corridor -> under the
// sight line from the camera down to the target's floor (0.6 of its height: a margin so the target's surroundings show)
float cutLim(vec2 xz, float t){
  float lim = t < uCutT ? uCutH : 1e9;
  if (uCapRH.x > 0.0) {
    vec2 a = uCap.xy, ab = uCap.zw - uCap.xy; float L2 = max(dot(ab, ab), 1e-6);
    float s = dot(xz - a, ab) / L2;
    if (s < 1.0 && distance(xz, a + ab * max(s, 0.0)) < uCapRH.x)
      lim = min(lim, uCapRH.y + max(uCapRH.z - uCapRH.y, 0.0) * (1.0 - max(s, 0.0)) * 0.6);
  }
  return lim;
}
float hCut(vec3 p, float t){ return min(hAt(p.xz), cutLim(p.xz, t)); }
int kindAt(vec2 xz){
  ivec2 ij = ivec2(clamp(xz / uWorld * uHRes, vec2(0.0), uHRes - 1.0));
  return int(texelFetch(uHeight, ij, 0).g + 0.5);
}
float hash(vec2 p);
// soft shadow toward a light: 1 = lit, 0 = blocked by walls, rock or raised areas (the overview cutaway lets light through)
float shadowTo(vec3 p, vec3 lp){
  vec3 dv = lp - p; float L = length(dv); vec3 d = dv / max(L, 1e-3);
  vec3 dd = vec3(abs(d.x) < 1e-6 ? 1e-6 : d.x, abs(d.y) < 1e-6 ? 1e-6 : d.y, abs(d.z) < 1e-6 ? 1e-6 : d.z);
  float texel = uWorld.x / uHRes.x, stp = max(1.6 * texel, 0.3 * uPpf);
  float t = (2.0 + hash(p.xz * 0.731 + lp.xz) * 1.5) * texel + hash(p.zx * 1.37) * stp, res = 1.0;   // jittered start: no banding
  for (int i = 0; i < 72; i++) {
    if (t >= L - 2.0 * texel) break;
    vec3 q = p + d * t;
    float skip = 0.0;
    for (int lv = uMaxLod; lv >= 2; lv -= 2) {
      float cs = texel * exp2(float(lv));
      ivec2 ij = ivec2(floor(q.xz / cs)); ivec2 sz = textureSize(uMax, lv);
      if (ij.x < 0 || ij.y < 0 || ij.x >= sz.x || ij.y >= sz.y) continue;
      float m = texelFetch(uMax, ij, lv).r * uPpf + 0.5;
      if (q.y > m) {
        vec2 lo = vec2(ij) * cs, hi = lo + cs;
        vec2 tt = (vec2(d.x > 0.0 ? hi.x : lo.x, d.z > 0.0 ? hi.y : lo.y) - q.xz) / vec2(dd.x, dd.z);
        float te = min(tt.x, tt.y); if (d.y < 0.0) te = min(te, (m - q.y) / d.y);
        skip = max(te, 0.0) + texel * 0.05; break;
      }
    }
    if (skip > 0.0) { t += skip; continue; }
    float dh = q.y - hCut(q, distance(q, uCamPos));
    if (dh < 0.0) return 0.0;
    res = min(res, 5.0 * dh / t);
    t += stp;
  }
  return clamp(res, 0.0, 1.0);
}
// corner shading: floors darken next to walls, crates and rock; wall faces darken toward their foot
float aoFloor(vec3 p, float t){ return texture(uAOTex, p.xz / uWorld).r; }   // baked on the CPU (world.js bakeAO)
float aoSide(vec3 p, vec2 n2, float texel){
  float g0 = hAt(p.xz + n2 * texel * 3.0);
  return 0.5 + 0.5 * smoothstep(0.0, 3.0 * uPpf, p.y - g0);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
// smoothstep that is also defined when edge0 > edge1 (a falling edge)
float sstep(float e0, float e1, float x){ float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float fbm(vec2 p){ return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.15 * vnoise(p * 4.1 + 3.3); }

// sun / moon shadow: march toward the sun over the max-height pyramid, on coarser cells as the steps grow
float sunShadow(vec3 p){
  if (uSunShadow < 0.5) return 1.0;
  vec3 d = uSunDir; if (d.y < 0.02) return 1.0;
  float texel = uWorld.x / uHRes.x, res = 1.0;
  float t = (2.5 + hash(p.xz * 0.531) * 2.0) * texel;
  for (int i = 0; i < 64; i++) {
    vec3 q = p + d * t;
    if (q.y > uMaxH + uPpf || q.x < 0.0 || q.z < 0.0 || q.x > uWorld.x || q.z > uWorld.y) break;
    float stp = max(1.5 * texel, 0.3 * uPpf) * (1.0 + 0.08 * float(i));
    int lv = int(clamp(floor(log2(stp / texel)) - 1.0, 0.0, float(uMaxLod)));
    float cs = texel * exp2(float(lv));
    ivec2 ij = min(ivec2(floor(q.xz / cs)), textureSize(uMax, lv) - 1);
    float h = min(texelFetch(uMax, ij, lv).r * uPpf, cutLim(q.xz, distance(q, uCamPos)));
    float dh = q.y + 0.25 * uPpf - h;
    if (dh < 0.0) return 0.0;
    res = min(res, 7.0 * dh / t);
    t += stp;
  }
  return clamp(res, 0.0, 1.0);
}

// ---- wall skins. u = ft along the face, y = ft up, dt = ft below the wall's top, foot = ft above the floor in front,
//      px = how many ft one pixel covers here (fine patterns fade out instead of shimmering)
float dtl(float size, float px){ return clamp(1.0 - 2.0 * px / size, 0.0, 1.0); }
// blocks w x h ft, every other row shifted by off: (column, row, distance to the nearest joint in ft)
vec3 blocks(float u, float y, float w, float h, float off){
  float row = floor(y / h), uu = u / w + off * mod(row, 2.0);
  vec2 f = vec2(fract(uu) * w, fract(y / h) * h);
  return vec3(floor(uu), row, min(min(f.x, w - f.x), min(f.y, h - f.y)));
}
vec3 woodCol(float u, float y, float px, float plank){
  float pl = floor(u / plank), f = fract(u / plank);
  vec3 c = vec3(0.36, 0.22, 0.12) * (0.72 + 0.45 * hash(vec2(pl, 3.7)));
  c *= 1.0 + 0.10 * sin((f * 9.0 + vnoise(vec2(pl * 5.3, y * 0.7)) * 5.0) * 6.2831) * dtl(plank * 0.15, px);
  return c * mix(1.0, 0.35, sstep(0.05, 0.02, min(f, 1.0 - f) * plank) * dtl(0.08, px));
}
vec3 hazard(float u, float foot){ return mod(u + foot, 1.0) < 0.5 ? vec3(0.78, 0.60, 0.10) : vec3(0.07); }
vec3 wallSkin(int sk, float u, float y, float dt, float foot, vec2 uv, vec2 xz, vec2 n2, bool door, float px){
  vec3 c;
  if (sk == 1) {            // concrete: poured panels, form-tie holes, rain streaks
    c = vec3(0.47, 0.47, 0.45) * (0.84 + 0.28 * fbm(vec2(u, y) * 0.55)) * (0.92 + 0.08 * vnoise(vec2(u * 3.0, y * 0.22)));
    c *= 1.0 - 0.28 * sstep(0.05, 0.02, blocks(u, y, 4.0, 2.0, 0.0).z) * dtl(0.1, px);
    c *= 1.0 - 0.55 * sstep(0.09, 0.05, length(vec2(mod(u, 2.0) - 1.0, mod(y, 2.0) - 1.0))) * dtl(0.15, px);
    if (door) c = vec3(0.24, 0.26, 0.29) * (0.9 + 0.2 * vnoise(vec2(u, y) * 2.0));
  } else if (sk == 2) {     // brick: running bond, warm reds, pale mortar
    vec3 b = blocks(u, y, 1.0, 0.4, 0.5);
    vec3 brick = mix(vec3(0.40, 0.14, 0.09), vec3(0.60, 0.28, 0.17), hash(b.xy + 0.37)) * (0.86 + 0.22 * vnoise(vec2(u, y) * 6.0));
    vec3 mortar = vec3(0.56, 0.53, 0.48);
    c = mix(mix(vec3(0.50, 0.25, 0.16), mortar, 0.18), mix(brick, mortar, sstep(0.045, 0.02, b.z)), dtl(0.12, px));
    if (door) c = woodCol(u, y, px, 0.55) * 0.85;
  } else if (sk == 3) {     // castle stone: big ashlar blocks, a darker plinth
    vec3 b = blocks(u, y, 2.2, 1.1, 0.5);
    c = mix(vec3(0.34, 0.33, 0.31), vec3(0.54, 0.52, 0.47), hash(b.xy + 1.3)) * (0.8 + 0.35 * fbm(vec2(u, y) * 1.4));
    c *= mix(0.9, mix(0.4, 1.0, smoothstep(0.03, 0.1, b.z)), dtl(0.25, px));
    if (foot < 1.2) c *= 0.85;
    if (door) { c = woodCol(u, y, px, 0.6) * 0.9; if (abs(mod(foot, 2.5) - 1.25) > 1.1) c = vec3(0.10, 0.10, 0.11); }   // iron bands
  } else if (sk == 4) {     // rough rock: strata and cracks (caves, mines)
    c = vec3(0.21, 0.20, 0.19) * (0.6 + 0.75 * fbm(vec2(u * 0.45 + y * 0.15, y * 0.8))) * (0.82 + 0.18 * sin(y * 2.2 + fbm(vec2(u * 0.35, y * 0.2)) * 5.0));
    c *= mix(1.0, 0.45, sstep(0.035, 0.01, abs(vnoise(vec2(u, y) * 1.3) - 0.5)) * dtl(0.2, px));
    if (door) c = woodCol(u, y, px, 0.7) * 0.7;
  } else if (sk == 5) {     // wooden planks with a top rail and a mid rail
    c = woodCol(u, y, px, 0.8);
    if (dt < 0.45 || abs(foot - 3.0) < 0.22) c = woodCol(y, u, px, 0.5) * 0.8;
    if (door) { c *= 0.85; if (abs(mod(foot, 3.0) - 1.5) > 1.32) c = vec3(0.11, 0.10, 0.10); }
  } else if (sk == 6) {     // timber & plaster (half-timbered)
    vec3 plaster = vec3(0.72, 0.68, 0.58) * (0.9 + 0.14 * fbm(vec2(u, y) * 1.8));
    vec3 beam = vec3(0.23, 0.14, 0.08) * (0.85 + 0.3 * vnoise(vec2(u * 4.0, y * 0.4)));
    float pu = mod(u, 5.0);
    bool bm = dt < 0.5 || foot < 0.5 || abs(foot - 4.6) < 0.24 || pu < 0.3 || pu > 4.7;
    if (!bm && foot > 0.5 && foot < 4.36 && mod(floor(u / 5.0), 3.0) < 1.0) bm = abs(pu - ((foot - 0.5) / 3.86 * 4.4 + 0.3)) < 0.26;   // a brace in every third panel
    c = bm ? beam : plaster;
    if (door) c = woodCol(u, y, px, 0.6);
  } else if (sk == 7) {     // riveted steel plates, rust, hazard stripes along the foot
    vec3 b = blocks(u, y, 4.0, 3.0, 0.5);
    c = vec3(0.33, 0.35, 0.38) * (0.85 + 0.22 * hash(b.xy + 2.1)) * (0.92 + 0.12 * vnoise(vec2(u, y) * 3.0));
    c = mix(c, vec3(0.36, 0.20, 0.10), smoothstep(0.62, 0.82, fbm(vec2(u, y) * 0.7)) * 0.55);
    float k = dtl(0.15, px);
    c *= mix(1.0, 0.4, sstep(0.04, 0.02, b.z) * k);
    c *= 1.0 + 0.35 * k * step(0.1, b.z) * step(b.z, 0.2) * step(fract((u + y) * 2.0), 0.14);
    if (foot < 0.7) c = hazard(u, foot);
    if (door) { c *= 0.75; if (abs(foot - 3.4) < 0.25) c = hazard(u, foot); }
  } else if (sk == 8) {     // corrugated scrap sheets, mixed paint and rust
    float f = fract(u / 3.0), hs = hash(vec2(floor(u / 3.0), floor(y / 6.0)));
    c = hs < 0.3 ? vec3(0.44, 0.24, 0.12) : hs < 0.55 ? vec3(0.22, 0.36, 0.34) : hs < 0.8 ? vec3(0.42, 0.42, 0.40) : vec3(0.46, 0.13, 0.10);
    c *= 1.0 - 0.22 * dtl(0.12, px) * (0.5 + 0.5 * sin(u * 6.2831 / 0.33));
    c = mix(c, vec3(0.38, 0.18, 0.08), smoothstep(0.55, 0.78, fbm(vec2(u, y) * 0.65)) * 0.75);
    if (f < 0.015 || f > 0.985 || abs(mod(y, 6.0) - 3.0) > 2.93) c *= 0.35;
    if (door) c *= 0.7;
  } else if (sk == 9) {     // white marble with veins, gold bands at the top and foot
    vec3 b = blocks(u, y, 3.0, 1.5, 0.5);
    c = vec3(0.86, 0.85, 0.81) * (0.93 + 0.08 * hash(b.xy + 4.4));
    c = mix(c, vec3(0.52, 0.52, 0.56), sstep(0.06, 0.0, abs(sin(u * 0.7 + y * 0.45 + fbm(vec2(u, y) * 0.8) * 5.0))) * 0.7 * dtl(0.08, px));
    c *= mix(1.0, 0.78, sstep(0.03, 0.01, b.z) * dtl(0.1, px));
    vec3 gold = vec3(0.95, 0.72, 0.30) * (0.85 + 0.3 * vnoise(vec2(u * 2.0, y)));
    if ((dt > 0.3 && dt < 0.75) || foot < 0.4) c = gold;
    if (door) { c = vec3(0.30, 0.19, 0.11) * (0.85 + 0.25 * vnoise(vec2(u * 6.0, y * 0.5))); if (abs(foot - 3.5) < 0.15) c = gold; }
  } else if (sk == 10) {    // hedge: leafy green, darker toward the roots
    vec2 q = vec2(u, y);
    c = vec3(0.09, 0.22, 0.07) + vec3(0.10, 0.17, 0.05) * fbm(q * 2.6) + vec3(0.16, 0.22, 0.07) * pow(vnoise(q * 7.0), 3.0) * dtl(0.12, px);
    c *= mix(0.55, 1.0, smoothstep(0.0, 3.0, foot)) * (dt < 0.4 ? 1.15 : 1.0);
    if (door) c = woodCol(u, y, px, 0.45) * 1.1;   // a garden gate
  } else if (sk == 11) {    // sandstone: warm layered blocks, weathered at the foot
    c = vec3(0.70, 0.55, 0.37) * (0.86 + 0.18 * fbm(vec2(u * 0.8, y * 3.0))) * (0.92 + 0.08 * sin(y * 4.0 + vnoise(vec2(u * 0.2, y)) * 3.0));
    c *= mix(1.0, 0.74, sstep(0.05, 0.015, blocks(u, y, 3.0, 1.5, 0.5).z) * dtl(0.12, px));
    c *= mix(0.82, 1.0, smoothstep(0.0, 2.0, foot));
    if (door) c = woodCol(u, y, px, 0.6) * 0.9;
  } else {                  // 12: match the map - the floor's own colours next to the wall, in plain panels
    c = textureLod(uFloor, (xz + n2 * 2.0 * uPpf) / uWorld, 4.5).rgb * 1.05;
    c *= mix(1.0, 0.7, sstep(0.05, 0.02, blocks(u, y, 4.0, 4.0, 0.0).z) * dtl(0.12, px));
    if (dt < 0.25) c *= 1.25;
    if (door) c *= 0.7;
  }
  return c;
}
// what raised areas (crates, counters, daises) are built of: sci-fi skins keep plain metal (0); natural ones use their
// material (timber -> wood, hedge -> stone planters); "match the map" stays the map's colours
int raisedSkin(int sk){ return (sk == 1 || sk == 7 || sk == 8) ? 0 : sk == 6 ? 5 : sk == 10 ? 3 : sk; }
// the tops of walls (seen from above) in the skin's colour
vec3 skinTop(int sk, vec2 xz, vec2 uv){
  vec2 q = xz / uPpf; float n = 0.85 + 0.3 * vnoise(q * 1.7);
  if (sk == 1) return vec3(0.46, 0.46, 0.44) * n;
  if (sk == 2) return vec3(0.50, 0.24, 0.16) * n;
  if (sk == 3) return vec3(0.48, 0.46, 0.42) * n;
  if (sk == 4) return vec3(0.20, 0.19, 0.18) * n;
  if (sk == 5) return vec3(0.40, 0.26, 0.14) * n;
  if (sk == 6) return vec3(0.26, 0.17, 0.09) * n;
  if (sk == 7) return vec3(0.36, 0.38, 0.41) * n;
  if (sk == 8) return vec3(0.40, 0.29, 0.20) * n;
  if (sk == 9) return vec3(0.88, 0.86, 0.82) * (0.95 + 0.05 * n);
  if (sk == 10) return vec3(0.14, 0.32, 0.10) * (0.7 + 0.6 * vnoise(q * 5.0));
  if (sk == 11) return vec3(0.72, 0.58, 0.40) * n;
  return textureLod(uFloor, uv, 4.5).rgb * 1.15;
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 o = uCamPos;
  vec3 d = normalize(uCamF + ndc.x * uTanX * uCamR + ndc.y * uTanX * (uRes.y / uRes.x) * uCamU);
  vec3 dd = vec3(abs(d.x) < 1e-6 ? 1e-6 : d.x, abs(d.y) < 1e-6 ? 1e-6 : d.y, abs(d.z) < 1e-6 ? 1e-6 : d.z);
  vec3 inv = 1.0 / dd;
  vec3 t0 = (vec3(0.0, uMinH - 400.0, 0.0) - o) * inv, t1 = (vec3(uWorld.x, uMaxH + 2.0, uWorld.y) - o) * inv;
  vec3 tmn = min(t0, t1), tmx = max(t0, t1);
  float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
  float texel = uWorld.x / uHRes.x;
  float t = max(tn, 0.5), tp = t; bool hit = false;
  if (tf > t) {
    for (int i = 0; i < 1200; i++) {
      vec3 p = o + d * t;
      // empty-space skipping: if we're above the tallest thing in a coarse cell, jump to where we leave it
      float skip = 0.0;
      for (int lv = uMaxLod; lv >= 2; lv -= 2) {
        float cs = texel * exp2(float(lv));
        ivec2 ij = ivec2(floor(p.xz / cs));
        ivec2 sz = textureSize(uMax, lv);
        if (ij.x < 0 || ij.y < 0 || ij.x >= sz.x || ij.y >= sz.y) continue;
        float m = texelFetch(uMax, ij, lv).r * uPpf + 1.0;
        if (p.y > m) {
          vec2 lo = vec2(ij) * cs, hi = lo + cs;
          vec2 bound = vec2(d.x > 0.0 ? hi.x : lo.x, d.z > 0.0 ? hi.y : lo.y);
          vec2 tt = (bound - p.xz) / vec2(dd.x, dd.z);
          float te = min(tt.x, tt.y);
          if (d.y < 0.0) te = min(te, (m - p.y) / d.y);
          skip = max(te, 0.0) + texel * 0.05;
          break;
        }
      }
      if (skip > 0.0) { tp = t; t += skip; if (t > tf) { vec3 q = o + d * tf; if (q.y < hCut(q, tf)) { t = tf; hit = true; } break; } continue; }
      if (p.y < hCut(p, t)) { hit = true; break; }
      tp = t; t += max(texel * 0.55, t * 0.0013);
      if (t > tf) { vec3 q = o + d * tf; if (q.y < hCut(q, tf)) { t = tf; hit = true; } break; }
    }
  }
  vec3 col; float tHit = 1e12;
  if (hit) {
    float a = tp, b = t;
    for (int k = 0; k < 9; k++) { float m = 0.5 * (a + b); vec3 q = o + d * m; if (q.y < hCut(q, m)) b = m; else a = m; }
    t = b; tHit = t;
    vec3 p = o + d * t;
    float hb = hAt(p.xz);
    int kd = kindAt(p.xz);   // re-read from inside the column on side hits (below)
    vec2 uv = p.xz / uWorld;
    float e = texel * 1.25;
    vec2 g = vec2(hAt(p.xz + vec2(e, 0.0)) - hAt(p.xz - vec2(e, 0.0)), hAt(p.xz + vec2(0.0, e)) - hAt(p.xz - vec2(0.0, e)));
    float slope = length(g) / (2.0 * e);
    float lim = cutLim(p.xz, t);
    bool cut = hb > lim + 0.5 * uPpf && p.y > lim - 0.5 * uPpf;
    bool side = slope > (kd == 6 ? 5.0 : 1.2) && !cut;   // height-map slopes stay map art (shaded by their slope) unless almost a cliff
    // a wall face: take the top height of the column we hit for the trim/shading reference
    if (side) { vec2 inward = normalize(g); hb = max(hb, hAt(p.xz + inward * texel * 1.5)); kd = kindAt(p.xz + inward * texel * 1.0); }
    vec2 n2 = length(g) > 1e-4 ? normalize(-g) : -normalize(d.xz + 1e-5);
    vec3 N = side ? vec3(n2.x, 0.0, n2.y) : vec3(0.0, 1.0, 0.0);
    float glow = 0.0; vec3 glowCol = uTrim;   // self-lit bits (glow trims, token rings): a dark mood doesn't dim them
    float pxFt = t * 2.0 * uTanX / uRes.x / uPpf / (side ? max(abs(dot(d, N)), 0.25) : max(abs(d.y), 0.25));
    if (!side) {
      col = texture(uFloor, uv).rgb;
      if (cut) {
        // a cut-away top: the map art, dimmed, with a thin glowing rim where the cut ends (a section view, not a black hole)
        col = col * 0.42 + uTrim * 0.03;
        float ce = texel * 1.5; bool rim = false;
        for (int q = 0; q < 4; q++) {
          vec2 off = q == 0 ? vec2(ce, 0.0) : q == 1 ? vec2(-ce, 0.0) : q == 2 ? vec2(0.0, ce) : vec2(0.0, -ce);
          if (hAt(p.xz + off) <= cutLim(p.xz + off, t) + 0.5 * uPpf) rim = true;
        }
        if (rim) glow = 0.55;
      }
      else if (kd == 1) col = vec3(0.13, 0.15, 0.19) * (0.75 + 0.5 * vnoise(p.xz / (6.0 * uPpf)));
      else if (kd == 6) {   // gentle height-map slopes: shade by the slope so bumps read as 3D
        vec3 tn = normalize(vec3(-g.x / (2.0 * e), 1.0, -g.y / (2.0 * e)));
        col *= 0.55 + 0.55 * clamp(dot(tn, normalize(vec3(0.35, 0.8, -0.45))), 0.0, 1.0);
      }
      else if ((kd == 2 || kd == 3) && uSkin != 0) col = mix(skinTop(uSkin, p.xz, uv), col, 0.2);   // wall tops wear the skin
      // token bases: soft contact shadow + coloured ring
      for (int s = 0; s < ${MAX_STANDEES}; s++) {
        if (s >= uNS) break;
        if (abs(p.y - uSPos[s].y) > 0.5 * uPpf) continue;
        float r = uSInfo[s].y, dist = distance(p.xz, uSPos[s].xz);
        if (uSInfo[s].z > 0.5) {
          // flat object (top-down art lying on the floor like on the 2D map), turned with the token
          vec2 dv = p.xz - uSPos[s].xz; float cr = cos(uSInfo[s].w), sr = sin(uSInfo[s].w);
          vec2 q = vec2(dv.x * cr + dv.y * sr, -dv.x * sr + dv.y * cr) / vec2(uSInfo[s].x, uSPos[s].w) + 0.5;
          if (q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0) {
            vec4 tx = texture(uAtlas, mix(uSUV[s].xy, uSUV[s].zw, q));
            col = mix(col, tx.rgb * uSTint[s].rgb, tx.a * uSTint[s].a);
          }
        } else if (dist < r) col *= 0.45 + 0.55 * pow(dist / r, 2.0);
        if (uSRing[s].a > 0.5 && abs(dist - r) < max(r * 0.07, 1.5 * texel)) { glow = 1.0; glowCol = uSRing[s].rgb * 1.6; }
      }
    } else {
      vec3 base = mix(vec3(0.20, 0.22, 0.25), textureLod(uFloor, uv, 3.0).rgb, 0.35);
      float rel = clamp(1.0 - (hb - p.y) / (30.0 * uPpf), 0.0, 1.0);
      float dt = (hb - p.y) / uPpf;
      float foot = (p.y - hAt(p.xz + n2 * texel * 3.0)) / uPpf;   // ft above the floor in front of this face
      float fu = dot(p.xz, vec2(-n2.y, n2.x)) / uPpf;               // ft along the face
      col = base * (0.45 + 0.55 * rel);
      if (kd == 1) {
        float strata = 0.8 + 0.2 * sin(p.y / (1.5 * uPpf) + (p.x + p.z) / (11.0 * uPpf)) + 0.08 * sin(p.y / (3.5 * uPpf) - (p.x - p.z) / (5.6 * uPpf));
        col = vec3(0.15, 0.17, 0.21) * (0.7 + 0.6 * vnoise(p.xz / (6.0 * uPpf))) * strata * (0.55 + 0.45 * rel);
      } else if (kd == 5 && raisedSkin(uSkin) == 0) {
        // raised area (crate, console, dais): plain dark metal, a soft lighter lip at the top, no glow trim
        // the top's own colour tints the metal a little, darker toward the foot; panel seams every 2 ft and down the sides
        col = mix(vec3(0.15, 0.17, 0.20), textureLod(uFloor, uv, 6.5).rgb, 0.3) * (0.62 + 0.38 * rel);
        if (dt < 0.12) col = mix(col, textureLod(uFloor, uv, 1.0).rgb, 0.6) * 1.35;
        if (abs(mod(p.y / uPpf, 2.0) - 1.0) > 0.95) col *= 0.72;
        if (abs(mod(fu, 3.0) - 1.5) > 1.44) col *= 0.8;
      } else if (kd == 5) {
        // raised areas in a skinned scene are built of the same material, with the top's art showing at the lip
        col = wallSkin(raisedSkin(uSkin), fu, p.y / uPpf, dt, foot, uv, p.xz, n2, false, pxFt) * (0.62 + 0.38 * rel);
        if (dt < 0.12) col = mix(col, textureLod(uFloor, uv, 1.0).rgb, 0.6) * 1.2;
      } else if (kd == 6) {
        // height-map terrain: the map art carries down the slope
        col = texture(uFloor, uv).rgb * (0.6 + 0.4 * rel);
      } else if (kd == 4) {
        // stair risers: plain metal with a thin glowing nosing on every step
        col = base * (0.75 + 0.25 * rel);
        if (dt < 0.14) { glow = 1.0; glowCol = uTrim * 0.85; }
      } else if (uSkin == 0) {
        // neon panels: dark metal, panel seams, a glowing trim strip under the top, doors tinted teal
        bool seam = abs(mod(p.y / uPpf, 4.0) - 2.0) > 1.85 || abs(mod(fu, 5.0) - 2.5) > 2.42;
        if (seam) col *= 0.45;
        if (kd == 3) col = mix(col, vec3(0.12, 0.45, 0.55), 0.6);
        if (dt > 0.6 && dt < 1.1) glow = 1.0;
      } else {
        col = wallSkin(uSkin, fu, p.y / uPpf, dt, foot, uv, p.xz, n2, kd == 3, pxFt) * (0.55 + 0.45 * rel);
      }
    }
    // light: "automatic" keeps the map's own light (walls shaded by a fixed key); a mood tints it, adds a sun (or moon)
    // with shadows, and scales the scene's lights
    float keyT = clamp(dot(N.xz, normalize(vec3(0.35, 0.8, -0.45)).xz), 0.0, 1.0);
    vec3 alb;
    if (uMood < 0.5) {
      col = mix(col, glowCol, glow);
      if (side) col *= 0.5 + 0.5 * keyT;
      alb = col;
    } else {
      alb = col;
      float ss = (dot(uSunCol, uSunCol) > 0.0 && !cut) ? sunShadow(p + (side ? N * texel * 2.0 : vec3(0.0, 0.25 * uPpf, 0.0))) : 1.0;
      vec3 lit = side ? uAmb * (0.62 + 0.38 * keyT) + uSunCol * max(dot(N, uSunDir), 0.0) * ss
                      : uAmb + uSunCol * max(uSunDir.y, 0.0) * ss;
      col = alb * lit;
      // at night, what the map paints as glowing (signs, screens, lamps, neon strips) keeps glowing
      if (!side) col += alb * sstep(0.42, 0.85, dot(alb, vec3(0.299, 0.587, 0.114))) * uKeep;
    }
    // scene lights
    vec3 acc = vec3(0.0);
    for (int l = 0; l < ${MAX_LIGHTS}; l++) {
      if (l >= uNL) break;
      vec3 L = uLPos[l].xyz - p; float dl = length(L) + 1e-3;
      float fall = pow(clamp(1.0 - dl / uLPos[l].w, 0.0, 1.0), 2.0) * uLCol[l].w;
      if (fall <= 0.0) continue;
      float ndl = side ? clamp(dot(N, L / dl), 0.0, 1.0) : 0.18;
      float sh = 1.0;
      if (l < uShadowN && !cut && ndl > 0.0) sh = shadowTo(p + (side ? N * texel * 2.0 : vec3(0.0, 0.2 * uPpf, 0.0)), uLPos[l].xyz);
      acc += fall * ndl * mix(0.12, 1.0, sh) * uLCol[l].rgb;
    }
    col += (acc * (side ? 1.0 : 0.6) * max(alb, vec3(0.08)) * 2.2 + acc * 0.12) * uLightK;
    if (uMood > 0.5) col = mix(col, glowCol * uTrimK, glow);
    if (uAO > 0.0 && !cut) col *= mix(1.0, side ? aoSide(p, n2, texel) : aoFloor(p, t), uAO * 0.85);
    float fog = 1.0 - exp(-max(t - uFogStart * uPpf, 0.0) / (uFogFt * uPpf));
    col = mix(col, uFogCol, fog);
  } else if (uMood > 0.5) {
    // a mood's sky: horizon to zenith, the sun's disc and glow; below the horizon it fades into the haze
    col = mix(uSkyHor, uSkyTop, smoothstep(0.0, 0.6, d.y));
    if (d.y < 0.0) col = mix(uSkyHor, uFogCol, smoothstep(0.0, 0.3, -d.y));
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunCol * (smoothstep(0.99955, 0.99975, sd) * 4.0 + pow(sd, 16.0) * 0.25);
  } else {
    float jh = exp(-abs(d.y) * 4.0);
    col = mix(vec3(0.01, 0.02, 0.03), uFogCol * 0.55, clamp(uFogCol.b * 1.6 - 0.15, 0.0, 1.0)) + uFogCol * 0.9 * jh;
  }
  // standees, sorted far -> near on the CPU
  for (int s = 0; s < ${MAX_STANDEES}; s++) {
    if (s >= uNS) break;
    if (uSInfo[s].z > 0.5) continue;   // flat objects are drawn on the floor
    vec3 C = uSPos[s].xyz;
    vec3 n = vec3(o.x - C.x, 0.0, o.z - C.z); float ln = length(n); if (ln < 1.0) continue; n /= ln;
    // the card faces you; a tilted one (top-down token art) leans back by uSInfo.w, centred over the token
    float ta = uSInfo[s].w;
    vec3 up = vec3(0.0, cos(ta), 0.0) - n * sin(ta), nn = vec3(0.0, sin(ta), 0.0) + n * cos(ta);
    vec3 B = C + n * (0.5 * uSPos[s].w * sin(ta));
    float den = dot(d, nn); if (abs(den) < 1e-5) continue;
    float ts = dot(B - o, nn) / den;
    if (ts <= 0.0 || ts >= tHit) continue;
    vec3 P = o + d * ts;
    vec3 br = normalize(cross(-n, vec3(0.0, 1.0, 0.0)));
    float u = dot(P - B, br) / uSInfo[s].x + 0.5;
    float v = 1.0 - dot(P - B, up) / uSPos[s].w;
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) continue;
    vec4 tx = texture(uAtlas, mix(uSUV[s].xy, uSUV[s].zw, vec2(u, v)));
    float al = tx.a * clamp((1.0 - v) / 0.05, 0.0, 1.0) * uSTint[s].a;
    if (al < 0.01) continue;
    vec3 sc = tx.rgb * uSTint[s].rgb;
    if (uMood > 0.5) {
      // figures take the mood's light (and stand in the sun or in shadow); scene lights still pick them out
      float ss = dot(uSunCol, uSunCol) > 0.0 ? sunShadow(vec3(C.x, C.y + uPpf, C.z)) : 1.0;
      sc = tx.rgb * (max(uAmb * 1.25 + uSunCol * max(uSunDir.y, 0.25) * ss, vec3(0.36)) + max(uSTint[s].rgb - 0.85, 0.0) * 2.0 * uLightK);
    }
    sc = mix(sc, uFogCol, 1.0 - exp(-max(ts - uFogStart * uPpf, 0.0) / (uFogFt * uPpf)));
    col = mix(col, sc, al);
  }
  if (uMood > 0.5) col = max(mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat), 0.0);
  outColor = vec4(col, 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc;
void main(){ vec3 c = texture(uSrc, vUv).rgb; float l = max(max(c.r, c.g), c.b) * 0.7 + dot(c, vec3(0.3, 0.55, 0.15)) * 0.3;
  o = vec4(c * clamp((l - 0.62) / 0.4, 0.0, 1.0), 1.0); }`;
const BLUR_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uDir;
void main(){ vec3 s = texture(uSrc, vUv).rgb * 0.2270270270;
  s += (texture(uSrc, vUv + uDir * 1.3846153846).rgb + texture(uSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  s += (texture(uSrc, vUv + uDir * 3.2307692308).rgb + texture(uSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  o = vec4(s, 1.0); }`;
const COMP_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc, uB1, uB2; uniform float uBloom;
void main(){ vec3 c = texture(uSrc, vUv).rgb + (texture(uB1, vUv).rgb * 0.6 + texture(uB2, vUv).rgb * 0.5) * uBloom;
  c = c / (1.0 + 0.18 * c);
  vec2 q = vUv - 0.5; c *= 1.0 - 0.38 * ((q.x * 1.4) * (q.x * 1.4) + (q.y * 1.6) * (q.y * 1.6));
  c = pow(clamp(c * 1.12, 0.0, 1.0), vec3(1.0 / 1.05)); o = vec4(c, 1.0); }`;

function compile(gl, vs, fs) {
  const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Vantage shader: " + gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos"); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Vantage link: " + gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, info.name); }
  return {p, u};
}

/** haze colour: deep teal by default, pulled toward the map's own average colour (more of it in daylight) */
export function fogColour(day = 0, mean = null) {
  const n = [0.03, 0.09, 0.11];
  if (!mean) return n;
  const k = 0.35 + 0.5 * Math.max(0, Math.min(1, day)), lift = 0.75 + 0.45 * Math.max(0, Math.min(1, day));
  return n.map((v, i) => v + (Math.min(0.75, mean[i] * lift) - v) * k);
}

/** wall skins, in shader order (Settings > Wall skin, Scene Config > Vantage) */
export const WALL_SKINS = ["neon", "concrete", "brick", "stone", "rock", "wood", "timber", "steel", "scrap", "marble", "hedge", "sandstone", "map"];

/**
 * lighting moods ("auto" = the map's own light, as painted). amb: how much of the map's light is left (tint);
 * sun: sun or moon colour (0 = none), el / az: its height and compass direction in degrees (0 = from the top of the map,
 * 90 = from the right); sky: [zenith, horizon]; fog: haze colour, fogK: haze distance x; lightK: scene lights x;
 * sat: saturation; bloom: glow x; trimK: glowing trims x; keep: how much of the map's bright art stays lit (night glow)
 */
export const MOODS = {
  auto: null,
  noon:     {keep: 0, amb: [0.68, 0.69, 0.72], sun: [0.58, 0.54, 0.46], el: 58, az: 160, sky: [[0.22, 0.44, 0.82], [0.66, 0.78, 0.92]], fog: [0.62, 0.70, 0.80], fogK: 1.6, lightK: 0.55, sat: 1.05, bloom: 0.7},
  golden:   {keep: 0.1, amb: [0.52, 0.46, 0.50], sun: [1.45, 0.92, 0.48], el: 13, az: 250, sky: [[0.26, 0.34, 0.58], [1.00, 0.62, 0.32]], fog: [0.72, 0.50, 0.34], fogK: 1.2, lightK: 0.8, sat: 1.1, bloom: 1.2},
  overcast: {keep: 0, amb: [0.84, 0.86, 0.90], sun: [0, 0, 0], el: 60, az: 0, sky: [[0.52, 0.55, 0.60], [0.70, 0.72, 0.75]], fog: [0.58, 0.61, 0.66], fogK: 0.8, lightK: 0.7, sat: 0.72, bloom: 0.6},
  dusk:     {keep: 0.35, amb: [0.40, 0.36, 0.52], sun: [0.95, 0.42, 0.52], el: 5, az: 275, sky: [[0.08, 0.10, 0.28], [0.90, 0.42, 0.40]], fog: [0.30, 0.22, 0.36], fogK: 1.0, lightK: 1.2, sat: 1.05, bloom: 1.3},
  moon:     {keep: 0.55, amb: [0.24, 0.30, 0.45], sun: [0.22, 0.28, 0.42], el: 48, az: 40, sky: [[0.01, 0.02, 0.06], [0.06, 0.09, 0.17]], fog: [0.05, 0.08, 0.15], fogK: 0.9, lightK: 2.0, sat: 0.62, bloom: 1.2},
  neon:     {keep: 1.0, amb: [0.30, 0.22, 0.40], sun: [0, 0, 0], el: 60, az: 0, sky: [[0.03, 0.01, 0.06], [0.18, 0.04, 0.22]], fog: [0.14, 0.03, 0.18], fogK: 0.8, lightK: 3.0, sat: 1.2, bloom: 1.7, trimK: 1.4},
  torch:    {keep: 0.6, amb: [0.30, 0.22, 0.15], sun: [0, 0, 0], el: 60, az: 0, sky: [[0.0, 0.0, 0.0], [0.04, 0.025, 0.015]], fog: [0.05, 0.03, 0.015], fogK: 0.45, lightK: 3.0, sat: 0.95, bloom: 1.3},
  toxic:    {keep: 0.3, amb: [0.40, 0.52, 0.28], sun: [0.40, 0.55, 0.16], el: 38, az: 120, sky: [[0.12, 0.20, 0.06], [0.42, 0.55, 0.18]], fog: [0.26, 0.36, 0.12], fogK: 0.55, lightK: 1.1, sat: 0.9, bloom: 1.1},
  blood:    {keep: 0.45, amb: [0.42, 0.15, 0.13], sun: [0.75, 0.14, 0.08], el: 30, az: 300, sky: [[0.06, 0.0, 0.0], [0.42, 0.06, 0.04]], fog: [0.22, 0.03, 0.03], fogK: 0.7, lightK: 1.3, sat: 1.0, bloom: 1.3}
};
/** direction toward the sun for a mood (az: compass degrees, overrides the mood's own) */
export function sunDirection(mood, az = null) {
  const M = MOODS[mood]; if (!M) return [0, 1, 0];
  const a = (Number.isFinite(az) ? az : M.az) * Math.PI / 180, e = M.el * Math.PI / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

export class PovRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance"});
    if (!gl) throw new Error("Vantage needs WebGL2.");
    if (gl.isContextLost()) throw new Error("Vantage: the graphics context was lost - close and reopen the window.");
    this.gl = gl;
    this.floatRT = !!gl.getExtension("EXT_color_buffer_float");
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // fit the uniform arrays to this GPU (WebGL2 guarantees only 224 vec4s)
    const budget = Math.max(120, gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 48);
    this.NL = Math.min(48, Math.floor(budget * 0.25 / 2));
    this.NS = Math.min(48, Math.floor((budget - this.NL * 2) / 5));
    this.scene = compile(gl, VS, SCENE_FS(this.NL, this.NS));
    this.bright = compile(gl, VS, BRIGHT_FS);
    this.blur = compile(gl, VS, BLUR_FS);
    this.comp = compile(gl, VS, COMP_FS);
    this.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.rts = {}; this.tex = {};
  }

  _texture(img, {mip = false, filter = "linear"} = {}) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** world: {W, H, ppf, floorCanvas, hw, hh, heightData(Float32Array RG), maxH, minH} */
  setWorld(world) {
    const gl = this.gl;
    for (const k of ["floor", "height"]) if (this.tex[k]) gl.deleteTexture(this.tex[k]);
    this.world = world;
    this.tex.floor = this._texture(world.floorCanvas, {mip: true});
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, world.hw, world.hh, 0, gl.RG, gl.FLOAT, world.heightData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.height = t;
    // max-height pyramid for empty-space skipping (level 0 = 3x3-dilated heights so linear filtering stays inside)
    if (this.tex.max) gl.deleteTexture(this.tex.max);
    const mt = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, mt);
    let w = world.hw, h = world.hh;
    let cur = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = -1e6;
      for (let dy = -1; dy <= 1; dy++) { const yy = Math.min(h - 1, Math.max(0, y + dy)); for (let dx = -1; dx <= 1; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); const v = world.heightData[(yy * w + xx) * 2]; if (v > m) m = v; } }
      cur[y * w + x] = m;
    }
    let lod = 0; const maxLod = Math.min(6, Math.floor(Math.log2(Math.min(w, h))));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, cur);
    while (lod < maxLod) {
      const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), nx = new Float32Array(nw * nh);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        let m = -1e6;
        const x1 = x === nw - 1 ? w - 1 : 2 * x + 1, y1 = y === nh - 1 ? h - 1 : 2 * y + 1;
        for (let yy = 2 * y; yy <= y1; yy++) for (let xx = 2 * x; xx <= x1; xx++) { const v = cur[yy * w + xx]; if (v > m) m = v; }
        nx[y * nw + x] = m;
      }
      lod++; w = nw; h = nh; cur = nx;
      gl.texImage2D(gl.TEXTURE_2D, lod, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, cur);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, lod);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.tex.max = mt; this.maxLod = lod - (lod % 2);
    // baked corner shading
    if (this.tex.ao) gl.deleteTexture(this.tex.ao);
    const at = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, at);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, world.hw, world.hh, 0, gl.RED, gl.UNSIGNED_BYTE, world.aoMap ?? new Uint8Array(world.hw * world.hh).fill(255));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.ao = at;
  }

  setAtlas(atlasCanvas) {
    const gl = this.gl;
    if (this.tex.atlas) gl.deleteTexture(this.tex.atlas);
    this.tex.atlas = this._texture(atlasCanvas, {mip: true});
  }

  _rt(name, w, h) {
    const gl = this.gl; let rt = this.rts[name];
    if (rt && rt.w === w && rt.h === h) return rt;
    if (rt) { gl.deleteFramebuffer(rt.fb); gl.deleteTexture(rt.tex); }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.floatRT) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    rt = {fb, tex, w, h}; this.rts[name] = rt; return rt;
  }

  _pass(prog, target, w, h, bind) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h); gl.useProgram(prog.p); bind(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _bindTex(unit, tex, loc) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); }

  /**
   * cam: {pos:[x,y,z], f, r, u, fov(deg horizontal)}
   * lights: [{x,y,z,radius,r,g,b,intensity}]  standees: [{x,y,z,h,w,ring,uv:[u0,v0,u1,v1],tint:[r,g,b,a],ringColor:[r,g,b]}]
   */
  render(cam, lights, standees, opts = {}) {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height, W = this.world, MAX_LIGHTS = this.NL, MAX_STANDEES = this.NS;
    if (!W || !w || !h) return;
    const M = MOODS[opts.mood] ?? null;
    const sceneRT = this._rt("scene", w, h);
    const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
    const b1 = this._rt("b1", bw, bh), b1t = this._rt("b1t", bw, bh);
    const b2 = this._rt("b2", Math.max(1, w >> 3), Math.max(1, h >> 3)), b2t = this._rt("b2t", Math.max(1, w >> 3), Math.max(1, h >> 3));
    const L = new Float32Array(MAX_LIGHTS * 4), LC = new Float32Array(MAX_LIGHTS * 4);
    lights.slice(0, MAX_LIGHTS).forEach((l, i) => { LC.set([l.r, l.g, l.b, l.intensity], i * 4); L.set([l.x, l.y, l.z, l.radius], i * 4); });
    const SP = new Float32Array(MAX_STANDEES * 4), SU = new Float32Array(MAX_STANDEES * 4), SI = new Float32Array(MAX_STANDEES * 4), ST = new Float32Array(MAX_STANDEES * 4), SR = new Float32Array(MAX_STANDEES * 4);
    const ns = Math.min(standees.length, MAX_STANDEES);
    for (let i = 0; i < ns; i++) {
      const s = standees[i];
      SP.set([s.x, s.y, s.z, s.h], i * 4); SU.set(s.uv, i * 4);
      SI.set([s.w, s.ring, s.flat ? 1 : 0, (s.flat ? (s.rot ?? 0) : (s.tilt ?? 0)) * Math.PI / 180], i * 4); ST.set(s.tint, i * 4);
      SR.set(s.ringColor ? [...s.ringColor, 1] : [0, 0, 0, 0], i * 4);
    }
    this._pass(this.scene, sceneRT, w, h, u => {
      this._bindTex(0, this.tex.floor, u.uFloor); this._bindTex(1, this.tex.height, u.uHeight); this._bindTex(2, this.tex.atlas, u.uAtlas); this._bindTex(3, this.tex.max, u.uMax); this._bindTex(4, this.tex.ao, u.uAOTex); gl.uniform1i(u.uMaxLod, this.maxLod);
      gl.uniform2f(u.uWorld, W.W, W.H); gl.uniform2f(u.uHRes, W.hw, W.hh); gl.uniform2f(u.uRes, w, h);
      gl.uniform1f(u.uPpf, W.ppf); gl.uniform1f(u.uMaxH, W.maxH * W.ppf); gl.uniform1f(u.uMinH, W.minH * W.ppf);
      gl.uniform1f(u.uTanX, Math.tan((cam.fov * Math.PI / 180) / 2)); gl.uniform1f(u.uFogFt, (opts.fogFt ?? 250) * (M?.fogK ?? 1)); gl.uniform1f(u.uFogStart, opts.fogStart ?? 0);
      gl.uniform3fv(u.uCamPos, cam.pos); gl.uniform3fv(u.uCamF, cam.f); gl.uniform3fv(u.uCamR, cam.r); gl.uniform3fv(u.uCamU, cam.u);
      gl.uniform3fv(u.uTrim, opts.trim ?? [0.2, 1.0, 1.1]);
      // the mood: its haze leans a little toward the map's own average colour, so it belongs to the map
      const fog = opts.fogCol ?? (M ? M.fog.map((v, i) => v * 0.85 + Math.min(0.6, W.meanCol?.[i] ?? v) * 0.15 * (0.4 + M.amb[i])) : fogColour(opts.daylight ?? 0, W.meanCol));
      gl.uniform3fv(u.uFogCol, fog);
      gl.uniform1i(u.uSkin ?? null, Math.max(0, WALL_SKINS.indexOf(opts.skin ?? "neon")));
      gl.uniform1f(u.uMood ?? null, M ? 1 : 0); gl.uniform1f(u.uSunShadow ?? null, (opts.shadowN ?? 4) > 0 ? 1 : 0);
      gl.uniform1f(u.uKeep ?? null, M?.keep ?? 0); gl.uniform1f(u.uLightK ?? null, M?.lightK ?? 1); gl.uniform1f(u.uSat ?? null, M?.sat ?? 1); gl.uniform1f(u.uTrimK ?? null, M?.trimK ?? 1);
      gl.uniform3fv(u.uSunDir ?? null, sunDirection(opts.mood, opts.sunAz)); gl.uniform3fv(u.uSunCol ?? null, M?.sun ?? [0, 0, 0]);
      gl.uniform3fv(u.uAmb ?? null, M?.amb ?? [1, 1, 1]); gl.uniform3fv(u.uSkyTop ?? null, M?.sky[0] ?? [0, 0, 0]); gl.uniform3fv(u.uSkyHor ?? null, M?.sky[1] ?? [0, 0, 0]);
      gl.uniform1f(u.uCutT, opts.cutT ?? 0); gl.uniform1f(u.uCutH, opts.cutH ?? 1e9);
      const cap = opts.cap; gl.uniform4fv(u.uCap, cap ?? [0, 0, 0, 0]); gl.uniform3f(u.uCapRH, cap ? opts.capR : 0, cap ? opts.capH : 1e9, cap ? (opts.capTop ?? opts.capH) : 1e9);
      gl.uniform1i(u.uNL, Math.min(lights.length, MAX_LIGHTS)); gl.uniform1i(u.uNS, ns);
      gl.uniform1i(u.uShadowN, Math.max(0, Math.min(opts.shadowN ?? 4, lights.length))); gl.uniform1f(u.uAO, opts.ao ?? 1);
      if (u.uLPos) gl.uniform4fv(u.uLPos, L); if (u.uLCol) gl.uniform4fv(u.uLCol, LC);
      if (u.uSPos) gl.uniform4fv(u.uSPos, SP); if (u.uSUV) gl.uniform4fv(u.uSUV, SU);
      if (u.uSInfo) gl.uniform4fv(u.uSInfo, SI); if (u.uSTint) gl.uniform4fv(u.uSTint, ST); if (u.uSRing) gl.uniform4fv(u.uSRing, SR);
    });
    const bloom = (opts.bloom ?? 1) * (M?.bloom ?? 1);
    if (bloom > 0) {
      this._pass(this.bright, b1, bw, bh, u => this._bindTex(0, sceneRT.tex, u.uSrc));
      for (let k = 0; k < 2; k++) {
        this._pass(this.blur, b1t, bw, bh, u => { this._bindTex(0, b1.tex, u.uSrc); gl.uniform2f(u.uDir, 1.6 / bw, 0); });
        this._pass(this.blur, b1, bw, bh, u => { this._bindTex(0, b1t.tex, u.uSrc); gl.uniform2f(u.uDir, 0, 1.6 / bh); });
      }
      this._pass(this.bright, b2, b2.w, b2.h, u => this._bindTex(0, b1.tex, u.uSrc));
      for (let k = 0; k < 3; k++) {
        this._pass(this.blur, b2t, b2.w, b2.h, u => { this._bindTex(0, b2.tex, u.uSrc); gl.uniform2f(u.uDir, 2.2 / b2.w, 0); });
        this._pass(this.blur, b2, b2.w, b2.h, u => { this._bindTex(0, b2t.tex, u.uSrc); gl.uniform2f(u.uDir, 0, 2.2 / b2.h); });
      }
    }
    this._pass(this.comp, null, w, h, u => {
      this._bindTex(0, sceneRT.tex, u.uSrc); this._bindTex(1, b1.tex, u.uB1); this._bindTex(2, b2.tex, u.uB2);
      gl.uniform1f(u.uBloom, bloom > 0 ? bloom : 0);
    });
  }

  dispose() {
    const gl = this.gl;
    try {
      for (const t of Object.values(this.tex)) gl.deleteTexture(t);
      for (const rt of Object.values(this.rts)) { gl.deleteFramebuffer(rt.fb); gl.deleteTexture(rt.tex); }
      for (const pr of [this.scene, this.bright, this.blur, this.comp]) if (pr?.p) gl.deleteProgram(pr.p);
    } catch (e) { /* ignore */ }
    // Free the GPU context once the canvas is gone. Not right away: losing a context in the same moment another one is
    // created (or this canvas is reused, e.g. the players' Live viewer) leaves the new one dead.
    const cv = this.canvas;
    setTimeout(() => { if (!cv.isConnected) { try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (e) { /* ignore */ } } }, 1500);
  }
}
