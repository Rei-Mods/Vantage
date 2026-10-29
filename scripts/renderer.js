// Vantage - WebGL2 heightfield ray-march renderer (render on demand, bloom post-pass)

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// which wall skins (SK_n) and raised-area looks (LK_n) the shader has: only the ones a scene uses (null = all), because
// each one adds to the time the GPU driver needs to compile the shader
const skinDefs = (skins, looks) => {
  const on = (set, i) => !set || set.includes(i) ? 1 : 0, out = [];
  for (let i = 1; i < 64; i++) out.push(`#define SK_${i} ${on(skins, i)}`);
  for (let i = 1; i < 64; i++) out.push(`#define LK_${i} ${on(looks, i)}`);
  out.push(`#define HAS_SKINS ${!skins || skins.length ? 1 : 0}`);   // (none: neon panels only, the pattern is never drawn)
  return out.join("\n");
};
const SCENE_FS = (MAX_LIGHTS, MAX_STANDEES, skins = null, looks = null) => `#version 300 es
precision highp float;
precision highp sampler2D;
${skinDefs(skins, looks)}
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
// weather: uWx = kind (0 none / mist only, 1 rain, 2 snow, 3 ash, 4 embers, 5 leaves, 6 fireflies, 7 sand); uWxVel (px/s);
// uWxP = density, streak (s), size (px), opacity; uWxQ = cell (px), wobble (px), max height over the floor (px, 0 = any), self-lit
uniform int uWx; uniform vec3 uWxVel, uWxCol, uWxMistCol; uniform vec4 uWxP, uWxQ; uniform float uWxFlash, uWxMist, uWxGround, uWxTop;
uniform sampler2D uShelter;
uniform sampler2D uSlab; uniform float uSlabOn;   // overhangs (bridges, roofs, ceilings): a floating slab per point, bottom..top (ft)
uniform sampler2D uCeil; uniform vec4 uCeilP[16]; uniform int uCeilN, uRoofMat; uniform float uCeilSun, uRoofTop;
// rooms' ceilings and roofs: per point R = which plane (1..16, 0 = open sky), G = the slab here is a room's ceiling (1) or the
// wall over a door (0.5), B = a region's roof covering (+1, 0 = the scene's: uRoofMat, -1 = suit the walls); plane i: height (px) = x + y * px + z * pz. uCeilSun: the camera is under a ceiling (ceilings keep
// the sun out); uRoofTop: roofs show from above too (a token's eye view)
uniform vec4 uHover, uHoverCol;
uniform sampler2D uPropData, uPropInfo, uPropPic;
uniform sampler2D uVis; uniform float uVisOn;      // a player's sight: R = in sight now, G = explored before
uniform sampler2D uTpl; uniform int uTplN;          // spell templates: per template (x, z, length, type) (direction, half angle / width, base height) (colour)
uniform vec4 uBeamA[4], uBeamB[4], uBeamC[4]; uniform int uBeamN;   // cover lines: from, to, colour   // raised areas that look like something: per pixel look / front / region; per region box + picture   // what the mouse points at: x, z, radius, height (px); colour, 1 = ring on the floor / 2 = a door   // ft: weather only falls above this (higher floors over the view, "suppress weather" regions)
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
// a floating slab over a point (bridge deck, roof, balcony, the ceiling of a higher level): (bottom, top) px, top < bottom = none
vec2 slabAt(vec2 xz){
  if (uSlabOn < 0.5) return vec2(0.0, -1.0);
  ivec2 ij = ivec2(clamp(xz / uWorld * uHRes, vec2(0.0), uHRes - 1.0));
  return texelFetch(uSlab, ij, 0).rg * uPpf;
}
bool inSlab(vec3 p, float t){ vec2 s = slabAt(p.xz); return s.y > s.x && p.y > s.x && p.y < min(s.y, cutLim(p.xz, t)); }
bool solidAt(vec3 p, float t){ return p.y < hCut(p, t) || inSlab(p, t); }
// a room's ceiling (flat or sloped), seen from below; and, in a token's eye view, its roof from above. How far along the
// ray the first one is (1e12 = none) and which plane it is
float ceilHit(vec3 o, vec3 d, bool cam, out int which){
  float best = 1e12; which = -1;
  for (int i = 0; i < 16; i++) {
    if (i >= uCeilN) break;
    vec4 P = uCeilP[i];
    float num = P.x + P.y * o.x + P.z * o.z - o.y, den = d.y - P.y * d.x - P.z * d.z;   // num > 0: the origin is under it
    if (num > 0.05 * uPpf) { if (den < 1e-5) continue; }
    else if (cam && uRoofTop > 0.5 && num < -0.05 * uPpf) { if (den > -1e-5) continue; }
    else continue;
    float tc = num / den;
    if (tc <= 0.0 || tc >= best) continue;
    vec2 xz = o.xz + d.xz * tc;
    if (xz.x < 0.0 || xz.y < 0.0 || xz.x >= uWorld.x || xz.y >= uWorld.y) continue;
    if (int(texelFetch(uCeil, ivec2(xz / uWorld * uHRes), 0).r * 255.0 + 0.5) != i + 1) continue;
    if (cam && cutLim(xz, tc) < o.y + d.y * tc) continue;
    best = tc; which = i;
  }
  return best;
}
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
    if (dh < 0.0 || inSlab(q, distance(q, uCamPos))) return 0.0;
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

// ---------------------------------------------------------------- weather
vec3 h33(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float shelterAt(vec2 xz){ vec2 uv = xz / uWorld; if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1e9; return texture(uShelter, uv).r * uPpf; }
vec3 wxPos, wxEm; float wxSum, wxOcc;
// particles along the ray from ta to tb, one at most per cell of size cs (px), walked cell by cell (3D DDA), in the frame
// that moves with them (so the grid stays still and nothing has to be simulated); occluded by whatever the ray hit
vec4 wxOctave(vec3 o, vec3 d, vec3 dd, float ta, float tb, float cs, float seed, float sizeK, float aK, vec4 acc){
  if (tb <= ta || acc.a > 0.97) return acc;
  vec3 vel = uWxVel; float sp = length(vel);
  vec3 sdir = sp > 1e-3 ? vel / sp : vec3(0.0, 1.0, 0.0);
  float hl = 0.5 * sp * uWxP.y;   // half a streak (motion blur), px
  vec3 om = o - vel * uTime;
  vec3 P0 = om + d * ta;
  vec3 cell = floor(P0 / cs), stp = sign(dd), tDel = abs(cs / dd);
  vec3 tMax = ta + ((cell + max(stp, 0.0)) * cs - P0) / dd;
  float pxK = 2.0 * uTanX / uRes.x;
  for (int i = 0; i < 26; i++) {
    vec3 h = h33(cell + seed);
    if (h.x < uWxP.x) {
      vec3 c = (cell + 0.5 + (h33(cell.zxy * 1.37 + seed + 11.0) - 0.5) * 0.5) * cs;
      if (uWxQ.y > 0.0) c += uWxQ.y * vec3(sin(uTime * (0.7 + h.y) + h.z * 6.28), 0.6 * sin(uTime * (0.9 + h.z) + h.y * 6.28), cos(uTime * (0.8 + 0.5 * h.y) + h.x * 6.28));
      vec3 w0 = om - c; float b = dot(d, sdir), dw = dot(d, w0), e = dot(sdir, w0);
      float u = hl > 0.0 ? clamp(e + b * (b * e - dw) / max(1.0 - b * b, 1e-4), -hl, hl) : 0.0;
      float s = b * u - dw;
      float r = uWxP.z * sizeK * (0.6 + 0.8 * h.y), re = max(r, s * pxK * 0.75);
      float dist = length(w0 + d * s - sdir * u);
      bool glowy = uWxQ.w > 0.5;   // self-lit ones get a soft halo too
      if (s > 0.0 && s < wxOcc && dist < (glowy ? re * 3.0 : re)) {
        vec3 cw = c + vel * uTime;   // where it is now
        float fl = hAt(cw.xz);
        if (cw.y < uWxTop && cw.y > max(fl, shelterAt(cw.xz)) && (uWxQ.z <= 0.0 || cw.y < fl + uWxQ.z)) {
          float a = ((1.0 - smoothstep(re * 0.2, re, dist)) + (glowy ? 0.35 * exp(-dist * dist / (2.0 * re * re)) : 0.0)) * (r / re) * uWxP.w * aK;
          a *= exp(-max(s - uFogStart * uPpf, 0.0) / (uFogFt * uPpf));
          vec3 pc = uWxCol;
          if (uWx == 2 || uWx == 3) pc *= 0.85 + 0.3 * h.z;
          else if (uWx == 5) { pc = mix(mix(vec3(0.72, 0.30, 0.07), vec3(0.50, 0.12, 0.05), h.z), vec3(0.85, 0.62, 0.14), step(0.68, h.y)); a *= 0.5 + 0.5 * abs(sin(uTime * 3.0 + h.x * 40.0)); }
          if (glowy) {   // self-lit: embers flicker, fireflies blink
            float k = uWx == 6 ? smoothstep(0.25, 0.9, 0.5 + 0.5 * sin(uTime * (0.9 + h.y) + h.z * 40.0)) : 0.55 + 0.45 * sin(uTime * 9.0 + h.y * 50.0);
            wxEm += (1.0 - acc.a) * a * k * pc * (0.6 + 0.8 * h.z);
            acc.a += (1.0 - acc.a) * a * 0.25;
          } else {
            acc.rgb += (1.0 - acc.a) * a * pc; acc.a += (1.0 - acc.a) * a;
            wxPos += cw * a; wxSum += a;
          }
        }
      }
    }
    float tn = min(min(tMax.x, tMax.y), tMax.z);
    if (tn > tb || acc.a > 0.97) break;
    if (tMax.x <= tMax.y && tMax.x <= tMax.z) { cell.x += stp.x; tMax.x += tDel.x; }
    else if (tMax.y <= tMax.z) { cell.y += stp.y; tMax.y += tDel.y; }
    else { cell.z += stp.z; tMax.z += tDel.z; }
  }
  return acc;
}
// ground mist: how much of the ray runs through the drifting layer a few feet over the floor
float mistAmt(vec3 o, vec3 d, float tOcc){
  float top = (uWxGround + 7.0) * uPpf, ta = 0.0, tb = min(tOcc, 1e7);
  if (abs(d.y) > 1e-5) { float tm = (top - o.y) / d.y; if (o.y > top) { if (d.y >= 0.0) return 0.0; ta = tm; } else if (d.y > 0.0) tb = min(tb, tm); }
  else if (o.y > top) return 0.0;
  float L = min(max(tb - ta, 0.0), 400.0 * uPpf); if (L <= 0.0) return 0.0;
  vec3 m = o + d * (ta + min(L, 60.0 * uPpf) * 0.5);
  float n = fbm(m.xz / (22.0 * uPpf) + vec2(uTime * 0.021, uTime * 0.013));
  return 1.0 - exp(-L / (55.0 * uPpf) * uWxMist * (0.35 + 1.3 * n));
}

// sun / moon shadow: march toward the sun over the max-height pyramid, on coarser cells as the steps grow
float sunShadow(vec3 p){
  int cw; if (uCeilSun > 0.5 && ceilHit(p, uSunDir, false, cw) < 1e11) return 0.0;   // indoors, seen from inside: the ceiling keeps the sun out (overviews stay a doll's house)
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
vec3 gEmit;   // the self-lit part of the last wall skin / raised-area face drawn (screens, LEDs, neon): added after the light
vec3 hue3(float h){ return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
// hexagonal cells s ft across: (ft to the cell's edge, a hash of the cell); gHex = the point from the cell's middle
vec2 gHex;
vec2 hexCell(vec2 p, float s){
  p /= s;
  vec2 r = vec2(1.0, 1.7320508), h = r * 0.5;
  vec2 a = mod(p, r) - h, b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b, ag = abs(g);
  gHex = g;
  return vec2((0.5 - max(dot(ag, vec2(0.5, 0.8660254)), ag.x)) * s, hash(floor((p - g) * 2.0 + 0.5)));
}
// a seven-segment digit n in a box (f: 0..1 across and up): 1 on a lit segment
float seg7(vec2 f, int n){
  f = (f - vec2(0.15, 0.08)) / vec2(0.7, 0.84);
  if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0) return 0.0;
  int m = n == 0 ? 0x3F : n == 1 ? 0x06 : n == 2 ? 0x5B : n == 3 ? 0x4F : n == 4 ? 0x66 : n == 5 ? 0x6D : n == 6 ? 0x7D : n == 7 ? 0x07 : n == 8 ? 0x7F : 0x6F;
  float t = 0.16; bool up = f.y > 0.5, vl = f.x < t, vr = f.x > 1.0 - t;
  bool on = ((m & 1) != 0 && f.y > 1.0 - t) || ((m & 2) != 0 && vr && up) || ((m & 4) != 0 && vr && !up) || ((m & 8) != 0 && f.y < t)
         || ((m & 16) != 0 && vl && !up) || ((m & 32) != 0 && vl && up) || ((m & 64) != 0 && abs(f.y - 0.5) < t * 0.5);
  return on ? 1.0 : 0.0;
}
vec3 hazard(float u, float foot){ return mod(u + foot, 1.0) < 0.5 ? vec3(0.78, 0.60, 0.10) : vec3(0.07); }
vec3 wallSkin(int sk, float u, float y, float dt, float foot, vec2 uv, vec2 xz, vec2 n2, bool door, float px){
  vec3 c; gEmit = vec3(0.0);
  if (sk < 0) { c = vec3(0.0);   // (each skin below is compiled in only when a scene needs it: SK_n)
#if SK_1
  } else if (sk == 1) {            // concrete: poured panels, form-tie holes, rain streaks
    c = vec3(0.47, 0.47, 0.45) * (0.84 + 0.28 * fbm(vec2(u, y) * 0.55)) * (0.92 + 0.08 * vnoise(vec2(u * 3.0, y * 0.22)));
    c *= 1.0 - 0.28 * sstep(0.05, 0.02, blocks(u, y, 4.0, 2.0, 0.0).z) * dtl(0.1, px);
    c *= 1.0 - 0.55 * sstep(0.09, 0.05, length(vec2(mod(u, 2.0) - 1.0, mod(y, 2.0) - 1.0))) * dtl(0.15, px);
    if (door) c = vec3(0.24, 0.26, 0.29) * (0.9 + 0.2 * vnoise(vec2(u, y) * 2.0));
#endif
#if SK_2
  } else if (sk == 2) {     // brick: running bond, warm reds, pale mortar
    vec3 b = blocks(u, y, 1.0, 0.4, 0.5);
    vec3 brick = mix(vec3(0.40, 0.14, 0.09), vec3(0.60, 0.28, 0.17), hash(b.xy + 0.37)) * (0.86 + 0.22 * vnoise(vec2(u, y) * 6.0));
    vec3 mortar = vec3(0.56, 0.53, 0.48);
    c = mix(mix(vec3(0.50, 0.25, 0.16), mortar, 0.18), mix(brick, mortar, sstep(0.045, 0.02, b.z)), dtl(0.12, px));
    if (door) c = woodCol(u, y, px, 0.55) * 0.85;
#endif
#if SK_3
  } else if (sk == 3) {     // castle stone: big ashlar blocks, a darker plinth
    vec3 b = blocks(u, y, 2.2, 1.1, 0.5);
    c = mix(vec3(0.34, 0.33, 0.31), vec3(0.54, 0.52, 0.47), hash(b.xy + 1.3)) * (0.8 + 0.35 * fbm(vec2(u, y) * 1.4));
    c *= mix(0.9, mix(0.4, 1.0, smoothstep(0.03, 0.1, b.z)), dtl(0.25, px));
    if (foot < 1.2) c *= 0.85;
    if (door) { c = woodCol(u, y, px, 0.6) * 0.9; if (abs(mod(foot, 2.5) - 1.25) > 1.1) c = vec3(0.10, 0.10, 0.11); }   // iron bands
#endif
#if SK_4
  } else if (sk == 4) {     // rough rock: strata and cracks (caves, mines)
    c = vec3(0.21, 0.20, 0.19) * (0.6 + 0.75 * fbm(vec2(u * 0.45 + y * 0.15, y * 0.8))) * (0.82 + 0.18 * sin(y * 2.2 + fbm(vec2(u * 0.35, y * 0.2)) * 5.0));
    c *= mix(1.0, 0.45, sstep(0.035, 0.01, abs(vnoise(vec2(u, y) * 1.3) - 0.5)) * dtl(0.2, px));
    if (door) c = woodCol(u, y, px, 0.7) * 0.7;
#endif
#if SK_5
  } else if (sk == 5) {     // wooden planks with a top rail and a mid rail
    c = woodCol(u, y, px, 0.8);
    if (dt < 0.45 || abs(foot - 3.0) < 0.22) c = woodCol(y, u, px, 0.5) * 0.8;
    if (door) { c *= 0.85; if (abs(mod(foot, 3.0) - 1.5) > 1.32) c = vec3(0.11, 0.10, 0.10); }
#endif
#if SK_6
  } else if (sk == 6) {     // timber & plaster (half-timbered)
    vec3 plaster = vec3(0.72, 0.68, 0.58) * (0.9 + 0.14 * fbm(vec2(u, y) * 1.8));
    vec3 beam = vec3(0.23, 0.14, 0.08) * (0.85 + 0.3 * vnoise(vec2(u * 4.0, y * 0.4)));
    float pu = mod(u, 5.0);
    bool bm = dt < 0.5 || foot < 0.5 || abs(foot - 4.6) < 0.24 || pu < 0.3 || pu > 4.7;
    if (!bm && foot > 0.5 && foot < 4.36 && mod(floor(u / 5.0), 3.0) < 1.0) bm = abs(pu - ((foot - 0.5) / 3.86 * 4.4 + 0.3)) < 0.26;   // a brace in every third panel
    c = bm ? beam : plaster;
    if (door) c = woodCol(u, y, px, 0.6);
#endif
#if SK_7
  } else if (sk == 7) {     // riveted steel plates, rust, hazard stripes along the foot
    vec3 b = blocks(u, y, 4.0, 3.0, 0.5);
    c = vec3(0.33, 0.35, 0.38) * (0.85 + 0.22 * hash(b.xy + 2.1)) * (0.92 + 0.12 * vnoise(vec2(u, y) * 3.0));
    c = mix(c, vec3(0.36, 0.20, 0.10), smoothstep(0.62, 0.82, fbm(vec2(u, y) * 0.7)) * 0.55);
    float k = dtl(0.15, px);
    c *= mix(1.0, 0.4, sstep(0.04, 0.02, b.z) * k);
    c *= 1.0 + 0.35 * k * step(0.1, b.z) * step(b.z, 0.2) * step(fract((u + y) * 2.0), 0.14);
    if (foot < 0.7) c = hazard(u, foot);
    if (door) { c *= 0.75; if (abs(foot - 3.4) < 0.25) c = hazard(u, foot); }
#endif
#if SK_8
  } else if (sk == 8) {     // corrugated scrap sheets, mixed paint and rust
    float f = fract(u / 3.0), hs = hash(vec2(floor(u / 3.0), floor(y / 6.0)));
    c = hs < 0.3 ? vec3(0.44, 0.24, 0.12) : hs < 0.55 ? vec3(0.22, 0.36, 0.34) : hs < 0.8 ? vec3(0.42, 0.42, 0.40) : vec3(0.46, 0.13, 0.10);
    c *= 1.0 - 0.22 * dtl(0.12, px) * (0.5 + 0.5 * sin(u * 6.2831 / 0.33));
    c = mix(c, vec3(0.38, 0.18, 0.08), smoothstep(0.55, 0.78, fbm(vec2(u, y) * 0.65)) * 0.75);
    if (f < 0.015 || f > 0.985 || abs(mod(y, 6.0) - 3.0) > 2.93) c *= 0.35;
    if (door) c *= 0.7;
#endif
#if SK_9
  } else if (sk == 9) {     // white marble with veins, gold bands at the top and foot
    vec3 b = blocks(u, y, 3.0, 1.5, 0.5);
    c = vec3(0.86, 0.85, 0.81) * (0.93 + 0.08 * hash(b.xy + 4.4));
    c = mix(c, vec3(0.52, 0.52, 0.56), sstep(0.06, 0.0, abs(sin(u * 0.7 + y * 0.45 + fbm(vec2(u, y) * 0.8) * 5.0))) * 0.7 * dtl(0.08, px));
    c *= mix(1.0, 0.78, sstep(0.03, 0.01, b.z) * dtl(0.1, px));
    vec3 gold = vec3(0.95, 0.72, 0.30) * (0.85 + 0.3 * vnoise(vec2(u * 2.0, y)));
    if ((dt > 0.3 && dt < 0.75) || foot < 0.4) c = gold;
    if (door) { c = vec3(0.30, 0.19, 0.11) * (0.85 + 0.25 * vnoise(vec2(u * 6.0, y * 0.5))); if (abs(foot - 3.5) < 0.15) c = gold; }
#endif
#if SK_10
  } else if (sk == 10) {    // hedge: leafy green, darker toward the roots
    vec2 q = vec2(u, y);
    c = vec3(0.09, 0.22, 0.07) + vec3(0.10, 0.17, 0.05) * fbm(q * 2.6) + vec3(0.16, 0.22, 0.07) * pow(vnoise(q * 7.0), 3.0) * dtl(0.12, px);
    c *= mix(0.55, 1.0, smoothstep(0.0, 3.0, foot)) * (dt < 0.4 ? 1.15 : 1.0);
    if (door) c = woodCol(u, y, px, 0.45) * 1.1;   // a garden gate
#endif
#if SK_11
  } else if (sk == 11) {    // sandstone: warm layered blocks, weathered at the foot
    c = vec3(0.70, 0.55, 0.37) * (0.86 + 0.18 * fbm(vec2(u * 0.8, y * 3.0))) * (0.92 + 0.08 * sin(y * 4.0 + vnoise(vec2(u * 0.2, y)) * 3.0));
    c *= mix(1.0, 0.74, sstep(0.05, 0.015, blocks(u, y, 3.0, 1.5, 0.5).z) * dtl(0.12, px));
    c *= mix(0.82, 1.0, smoothstep(0.0, 2.0, foot));
    if (door) c = woodCol(u, y, px, 0.6) * 0.9;
#endif
#if SK_13
  } else if (sk == 13) {    // glass curtain wall: tinted panes in slim mullions, the sky in them, a few lit from inside
    vec3 b = blocks(u, y, 5.0, 4.0, 0.0);
    c = mix(vec3(0.06, 0.10, 0.14), vec3(0.24, 0.34, 0.42), clamp(foot / 24.0 + 0.35 * vnoise(vec2(u * 0.05, y * 0.02)) + 0.06 * hash(b.xy + 2.0), 0.0, 1.0));   // the sky, across the whole face
    c += vec3(0.10, 0.12, 0.14) * sstep(0.12, 0.0, abs(fract((u * 0.6 + y) * 0.05) - 0.5)) * dtl(0.5, px);   // a streak of reflection
    if (hash(b.xy + 9.1) > 0.9) gEmit = vec3(1.0, 0.82, 0.55) * 0.14;   // a few lit from inside
    float mul = sstep(0.12, 0.06, b.z) * dtl(0.15, px);
    c = mix(c, vec3(0.52, 0.55, 0.58), mul); gEmit *= 1.0 - mul;
    if (door) { c = vec3(0.08, 0.12, 0.15); gEmit = vec3(0.0); if (abs(mod(u, 3.0) - 1.5) > 1.38 || abs(foot - 3.4) < 0.08) c = vec3(0.62, 0.64, 0.66); }
#endif
#if SK_14
  } else if (sk == 14) {    // tiles: white subway tile over a dark green dado, grey grout
    bool lo = foot < 3.5;
    vec3 b = blocks(u, y, lo ? 0.5 : 0.6, lo ? 0.5 : 0.3, lo ? 0.0 : 0.5);
    vec3 t = (lo ? vec3(0.10, 0.30, 0.24) : vec3(0.86, 0.87, 0.84)) * (0.93 + 0.1 * hash(b.xy + 5.5));
    c = mix(mix(t, vec3(0.5), 0.15), mix(t, vec3(0.48, 0.48, 0.46), sstep(0.03, 0.012, b.z)), dtl(0.06, px));
    if (abs(foot - 3.55) < 0.08) c = vec3(0.07, 0.20, 0.16);   // the cap row
    if (door) c = vec3(0.32, 0.36, 0.38) * (0.9 + 0.1 * vnoise(vec2(u, y) * 3.0));
#endif
#if SK_15
  } else if (sk == 15) {    // graffiti: concrete under layers of pieces and tags, the paint a little fluorescent
    c = vec3(0.40, 0.40, 0.39) * (0.82 + 0.28 * fbm(vec2(u, y) * 0.6));
    vec2 q = vec2(u, foot) * 0.35;
    float n = fbm(q + vec2(0.0, 3.0)), k = fbm(q * 1.7 + 11.0), low = sstep(9.0, 6.0, foot);
    float paint = sstep(0.52, 0.58, n) * low;
    vec3 pc = hue3(floor(fbm(q * 0.3 + 5.0) * 6.0) / 6.0 + 0.05);
    c = mix(c, pc * 0.8, paint);
    c = mix(c, vec3(0.03), sstep(0.025, 0.0, abs(n - 0.52)) * low * dtl(0.15, px));                   // outlines
    c = mix(c, vec3(0.02), sstep(0.02, 0.0, abs(k - 0.55)) * sstep(6.5, 5.0, foot) * dtl(0.12, px));  // tags
    gEmit = pc * paint * 0.08;
    if (door) { c = vec3(0.30, 0.31, 0.33) * (0.85 + 0.2 * vnoise(vec2(u, y) * 2.0)); gEmit = vec3(0.0); if (abs(mod(y, 0.5) - 0.25) > 0.22) c *= 0.75; }   // a roller shutter
#endif
#if SK_16
  } else if (sk == 16) {    // cinder blocks: painted grey, deep joints, a scuffed foot
    vec3 b = blocks(u, y, 1.33, 0.67, 0.5);
    c = vec3(0.55, 0.56, 0.55) * (0.88 + 0.12 * hash(b.xy + 3.3)) * (0.9 + 0.14 * vnoise(vec2(u, y) * 9.0));
    c *= mix(1.0, 0.55, sstep(0.04, 0.015, b.z) * dtl(0.08, px));
    c *= mix(0.75, 1.0, smoothstep(0.0, 1.2, foot));
    if (door) { c = vec3(0.42, 0.20, 0.14) * (0.9 + 0.15 * vnoise(vec2(u, y) * 2.0)); if (abs(foot - 3.3) < 0.1) c = vec3(0.7); }
#endif
#if SK_17
  } else if (sk == 17) {    // wallpaper: a damask pattern over wood panelling, a chair rail and a moulding at the top
    vec2 q = vec2(u / 1.2, y / 1.6), f = fract(q) - 0.5;
    float m = length(vec2(f.x * 1.6, f.y)) - 0.28 - 0.08 * sin(atan(f.y, f.x) * 4.0);
    c = mix(vec3(0.13, 0.27, 0.27), vec3(0.55, 0.47, 0.26), sstep(0.04, 0.0, abs(m) - 0.03) * dtl(0.15, px) * 0.85) * (0.9 + 0.1 * vnoise(vec2(u, y) * 2.0));
    if (foot < 3.0) { c = woodCol(u, y, px, 1.5) * 0.95; if (abs(mod(u, 3.0) - 1.5) > 1.3 || abs(foot - 1.5) > 1.2) c *= 0.7; }   // wainscot panels
    if (abs(foot - 3.05) < 0.1 || dt < 0.35) c = vec3(0.82, 0.79, 0.72) * (dt < 0.35 && dt > 0.25 ? 0.7 : 1.0);
    if (door) { c = woodCol(u, y, px, 0.5) * 0.9; if (abs(mod(u, 1.5) - 0.75) > 0.6 || abs(mod(foot, 3.4) - 1.7) > 1.5) c *= 0.65; }
#endif
#if SK_18
  } else if (sk == 18) {    // starship panels: pale insets in a darker frame, small status lights, a dark kick strip
    vec3 b = blocks(u, foot, 3.0, 2.5, 0.0);
    float k = dtl(0.1, px);
    c = vec3(0.70, 0.73, 0.76) * (0.94 + 0.06 * hash(b.xy + 1.7));
    c *= mix(1.0, 0.55, sstep(0.14, 0.10, b.z) * k);
    c *= mix(1.0, 0.86, sstep(0.14, 0.18, b.z) * sstep(0.30, 0.26, b.z) * k);
    if (foot < 0.6) c = vec3(0.12, 0.13, 0.15);
    vec2 f = vec2(fract(u / 3.0) * 3.0, fract(foot / 2.5) * 2.5);
    if (length(f - vec2(2.6, 2.2)) < 0.07 && hash(b.xy) > 0.5) { c = vec3(0.1); gEmit = hash(b.xy + 2.0) > 0.7 ? vec3(1.0, 0.45, 0.1) : vec3(0.2, 0.7, 1.0); }
    if (dt > 0.3 && dt < 0.45) gEmit = vec3(0.6, 0.85, 1.0) * 0.35;   // a light strip under the ceiling
    if (door) { c = vec3(0.45, 0.48, 0.52); gEmit = vec3(0.0); if (abs(fract(u / 4.0) - 0.5) < 0.012) c *= 0.3; if (foot < 0.6) c = hazard(u, foot); }
#endif
#if SK_19
  } else if (sk == 19) {    // plywood: boarded-up sheets, nail lines, spray-painted marks
    vec3 b = blocks(u, foot, 4.0, 8.0, 0.0);
    float hs = hash(b.xy + 6.2);
    c = vec3(0.62, 0.48, 0.30) * (0.8 + 0.25 * hs) * (0.88 + 0.16 * fbm(vec2(u * 0.4, y * 2.5) + hs * 9.0));
    c *= mix(1.0, 0.4, sstep(0.05, 0.02, b.z) * dtl(0.1, px));
    vec2 f = vec2(fract(u / 4.0) * 4.0, fract(foot / 8.0) * 8.0);
    if (hs > 0.6 && f.y > 0.5 && min(abs(f.x * 2.0 - f.y), abs((4.0 - f.x) * 2.0 - f.y)) < 0.35) c = mix(c, hs > 0.85 ? vec3(0.6, 0.06, 0.05) : vec3(0.05), 0.85);   // a big X
    if (door) c *= 0.75;
#endif
#if SK_20
  } else if (sk == 20) {    // neon alley: soot-dark brick with neon tubes along it
    vec3 b = blocks(u, y, 1.0, 0.4, 0.5);
    c = mix(vec3(0.16, 0.08, 0.08), vec3(0.26, 0.14, 0.12), hash(b.xy + 0.9)) * (0.8 + 0.3 * vnoise(vec2(u, y) * 5.0));
    c = mix(c, vec3(0.07), sstep(0.045, 0.02, b.z) * dtl(0.12, px));
    float hs = hash(vec2(floor(u / 12.0), 4.4)), tu = fract(u / 12.0) * 12.0, th = 7.0 + 2.0 * hs;
    vec3 nc = hs < 0.33 ? vec3(1.0, 0.15, 0.6) : hs < 0.66 ? vec3(0.1, 0.9, 1.0) : vec3(0.7, 0.3, 1.0);
    float dd = min(abs(foot - th) + (tu > 10.5 ? 99.0 : 0.0), abs(tu - 1.0 - hs * 8.0) + (foot < th - 3.0 || foot > th ? 99.0 : 0.0));
    if (dd < 0.07) { c = nc * 0.5; gEmit = nc * 1.2; } else gEmit = nc * 0.25 * sstep(0.7, 0.07, dd);   // the tube and its glow on the brick
    if (door) { c = vec3(0.10, 0.10, 0.12) * (0.9 + 0.2 * vnoise(vec2(u, y) * 3.0)); gEmit = vec3(0.0); if (abs(mod(y, 0.5) - 0.25) > 0.22) c *= 0.6; }
#endif
#if SK_21
  } else if (sk == 21) {    // padded and tufted: dark leather in diamonds, buttons at the corners (lounges, clubs, cells)
    vec2 q = vec2(u + foot, foot - u) / 1.1, f = fract(q) - 0.5;
    float r = max(abs(f.x), abs(f.y));
    c = vec3(0.17, 0.07, 0.14) * (0.65 + 0.5 * (1.0 - r * 1.6)) * (0.92 + 0.1 * vnoise(vec2(u, y) * 4.0));
    if (length(abs(f) - 0.5) < 0.09) c = mix(c, vec3(0.05), dtl(0.1, px));
    if (foot < 0.4) c = vec3(0.55, 0.56, 0.58);   // a chrome skirting
    if (door) c *= 0.8;
#endif
#if SK_22
  } else if (sk == 22) {    // LED video wall: a still, colourful picture in a fine grid of pixels, black bezels between screens
    vec3 b = blocks(u, foot, 6.0, 3.5, 0.0);
    vec2 q = vec2(u, foot);
    vec3 img = hue3(fbm(q * 0.05 + 3.0) * 1.2 + q.x * 0.01) * (0.35 + 0.65 * smoothstep(0.3, 0.7, fbm(q * 0.12 + 1.0)));
    float grid = mix(1.0, 0.45 + 0.55 * step(0.25, fract(u * 8.0)) * step(0.25, fract(foot * 8.0)), dtl(0.125, px));
    c = vec3(0.02); gEmit = img * grid * 0.9;
    if (b.z < 0.05 || foot < 0.5 || dt < 0.3) { c = vec3(0.03); gEmit = vec3(0.0); }
    if (door) { c = vec3(0.06, 0.06, 0.07); gEmit = vec3(0.0); if (abs(fract(u / 4.0) - 0.5) < 0.04) c = vec3(0.2); }
#endif
#if SK_23
  } else if (sk == 23) {    // clinic: wipe-clean pale walls, a coloured stripe, a handrail
    c = (foot < 3.0 ? vec3(0.55, 0.70, 0.72) : vec3(0.80, 0.84, 0.82)) * (0.95 + 0.05 * vnoise(vec2(u, y) * 2.0));
    if (abs(foot - 3.0) < 0.18) c = vec3(0.12, 0.45, 0.55);
    if (abs(foot - 3.35) < 0.08) c = vec3(0.85, 0.86, 0.88) * (abs(foot - 3.35) < 0.03 ? 1.1 : 0.75);
    if (foot < 0.35) c = vec3(0.25, 0.28, 0.30);
    if (door) { c = vec3(0.62, 0.70, 0.76); float fx = fract(u / 4.0) * 4.0; if (fx > 2.6 && fx < 3.2 && foot > 4.2 && foot < 6.0) c = vec3(0.10, 0.15, 0.18); if (foot < 1.0) c = vec3(0.7); }
#endif
#if SK_24
  } else if (sk == 24) {    // shipping containers: ribbed steel in 8 ft boxes, each its own colour, scraped and rusty
    float hs = hash(vec2(floor(u / 8.0), floor(foot / 8.5)) + 2.6), f = fract(u / 0.9);
    c = hs < 0.25 ? vec3(0.50, 0.12, 0.08) : hs < 0.5 ? vec3(0.10, 0.25, 0.45) : hs < 0.7 ? vec3(0.12, 0.35, 0.20) : hs < 0.85 ? vec3(0.65, 0.35, 0.08) : vec3(0.55, 0.55, 0.52);
    c *= mix(1.0, 0.75 + 0.35 * smoothstep(0.2, 0.3, f) * (1.0 - smoothstep(0.7, 0.8, f)), dtl(0.3, px));
    c = mix(c, vec3(0.35, 0.17, 0.07), smoothstep(0.65, 0.85, fbm(vec2(u, y) * 0.8)) * 0.6);
    float cu = fract(u / 8.0) * 8.0, cf = fract(foot / 8.5) * 8.5;
    if (cu < 0.25 || cu > 7.75 || cf < 0.3) c *= 0.5;   // the corner posts and rails
    if (hs > 0.5 && cu > 1.0 && cu < 3.5 && cf > 6.0 && cf < 7.0) c = vec3(0.85) * step(0.45, hash(floor(vec2(u * 4.0, foot * 3.0))));   // stencilled numbers
    if (door) { c *= 0.9; if (abs(mod(u, 2.0) - 1.0) < 0.06) c = vec3(0.55); }   // locking bars
#endif
#if SK_25
  } else if (sk == 25) {    // chrome: polished panels mirroring the room - bright above a horizon at eye height, dark below
    vec3 b = blocks(u, foot, 4.0, 4.0, 0.0);
    float hz = foot - 5.0 - 0.8 * (hash(b.xy + 8.0) - 0.5) - 0.3 * vnoise(vec2(u * 0.3, 1.0));
    vec3 hi = mix(vec3(0.80, 0.84, 0.90), uTrim, 0.12) * (0.75 + 0.25 * clamp(1.0 - hz / 6.0, 0.0, 1.0));
    c = mix(vec3(0.10, 0.10, 0.12) + vec3(0.12) * clamp(-hz / 5.0, 0.0, 1.0), hi, smoothstep(-0.15, 0.15, hz));
    c += vec3(0.35) * sstep(0.25, 0.0, abs(fract(u / 4.0 + foot * 0.03) - 0.3)) * dtl(0.3, px);   // a streak of light
    c *= mix(1.0, 0.3, sstep(0.05, 0.02, b.z) * dtl(0.1, px));
    if (door) { c *= 0.8; if (abs(fract(u / 4.0) - 0.5) < 0.012) c = vec3(0.05); }
#endif
#if SK_26
  } else if (sk == 26) {    // carbon fibre: a fine twill weave in dark panels, a red line along them
    vec2 q = vec2(u, y) * 6.0;
    float o = mod(floor(q.x) + floor(q.y), 2.0);
    float sh = o < 1.0 ? sin(fract(q.x) * 3.1416) : sin(fract(q.y) * 3.1416) * 0.6;
    c = vec3(0.05, 0.055, 0.06) + vec3(0.07) * mix(0.4, sh, dtl(0.17, px));
    c *= mix(1.0, 0.4, sstep(0.04, 0.02, blocks(u, foot, 5.0, 4.0, 0.0).z) * dtl(0.1, px));
    if (door) c *= 1.25;
    if (abs(foot - 3.6) < 0.05) c = vec3(0.7, 0.05, 0.05);
#endif
#if SK_27
  } else if (sk == 27) {    // holo wall: dark glass with a projected grid, scan lines and floating panels
    c = vec3(0.02, 0.03, 0.05);
    vec2 q = vec2(u, foot), dg = (0.5 - abs(fract(q / 2.0) - 0.5)) * 2.0;
    vec3 cy = mix(vec3(0.1, 0.9, 1.0), uTrim, 0.35);
    gEmit = cy * (sstep(0.05, 0.0, min(dg.x, dg.y)) * dtl(0.1, px) * 0.6 + 0.06 + 0.04 * step(0.5, fract(foot * 6.0)) * dtl(0.17, px));
    float hs = hash(floor(vec2(u / 6.0, foot / 3.0)) + 3.1);
    vec2 f = vec2(fract(u / 6.0) * 6.0, fract(foot / 3.0) * 3.0);
    if (hs > 0.6 && foot > 3.0 && f.x > 1.0 && f.x < 5.0 && f.y > 0.6 && f.y < 2.4) {   // a floating panel with lines of text
      float row = floor(f.y * 6.0), txt = step(fract(f.y * 6.0), 0.5) * step(f.x - 1.2, 0.4 + 3.2 * hash(vec2(row, hs))) * step(0.3, hash(floor(vec2(u * 8.0, row)))) * step(1.2, f.x);
      gEmit += cy * (0.12 + 0.5 * txt * dtl(0.08, px));
    }
    if (door) gEmit = cy * 0.25 * (0.6 + 0.4 * step(0.5, fract(foot * 3.0)));
#endif
#if SK_28
  } else if (sk == 28) {    // pipes: a dark plant wall with pipes and conduits along it, flanges every few feet
    c = vec3(0.16, 0.17, 0.17) * (0.85 + 0.25 * fbm(vec2(u, y) * 0.5));
    for (int i = 0; i < 4; i++) {
      float ph = i == 0 ? 1.2 : i == 1 ? 2.6 : i == 2 ? 5.5 : 7.2, pr = i == 0 ? 0.35 : i == 1 ? 0.2 : i == 2 ? 0.45 : 0.15;
      float dd = abs(foot - ph) / pr;
      if (dd < 1.0) {
        c = (i == 0 ? vec3(0.45, 0.30, 0.15) : i == 1 ? vec3(0.55, 0.45, 0.10) : i == 2 ? vec3(0.40, 0.42, 0.44) : vec3(0.15, 0.30, 0.45)) * (0.35 + 0.75 * sqrt(1.0 - dd * dd));
        if (abs(mod(u + float(i) * 1.7, 6.0) - 3.0) > 2.85) c *= 1.25;
      }
    }
    if (door) { c = vec3(0.25, 0.27, 0.27); if (abs(foot - 3.5) < 0.35 && abs(mod(u, 4.0) - 2.0) < 0.35) c = vec3(0.6, 0.15, 0.1); if (foot < 0.5) c = hazard(u, foot); }
#endif
#if SK_29
  } else if (sk == 29) {    // rusted plate: welded sheets eaten through with rust, streaks running down
    vec3 b = blocks(u, y, 6.0, 4.0, 0.33);
    float n = fbm(vec2(u, y) * 0.45 + b.xy);
    c = mix(vec3(0.30, 0.30, 0.29), vec3(0.42, 0.20, 0.08), smoothstep(0.35, 0.65, n));
    c = mix(c, vec3(0.20, 0.08, 0.03), smoothstep(0.68, 0.8, n));
    c *= (0.85 + 0.25 * vnoise(vec2(u * 4.0, y * 0.25))) * mix(1.0, 0.45, sstep(0.05, 0.02, b.z) * dtl(0.1, px));
    if (door) { c *= 0.8; if (abs(mod(foot, 2.0) - 1.0) > 0.9) c *= 0.6; }
#endif
#if SK_30
  } else if (sk == 30) {    // biotech: grown, ribbed walls with glowing veins (alien hives, bio labs)
    vec2 q = vec2(u, y);
    float rib = 0.5 + 0.5 * sin(u * 2.2 + 1.5 * sin(y * 0.6 + u * 0.3));
    c = mix(vec3(0.10, 0.05, 0.10), vec3(0.28, 0.20, 0.24), rib) * (0.75 + 0.4 * fbm(q * 0.9));
    float vein = sstep(0.03, 0.0, abs(fbm(q * 0.4 + 2.0) - 0.5)) * dtl(0.12, px);
    gEmit = vec3(0.25, 1.0, 0.55) * vein * 0.7;
    c = mix(c, vec3(0.1, 0.3, 0.15), vein) + vec3(0.08) * pow(rib, 8.0) * dtl(0.2, px);   // and a wet sheen
    if (door) { c = vec3(0.18, 0.10, 0.16) * (0.7 + 0.4 * vnoise(q * 3.0)); gEmit = vec3(0.25, 1.0, 0.55) * 0.5 * sstep(0.2, 0.0, abs(fract(u / 4.0) - 0.5) * 4.0); }
#endif
#if SK_31
  } else if (sk == 31) {    // hex plating: hexagonal armour plates, faintly lit seams, a few glowing cells
    vec2 hx = hexCell(vec2(u, y), 1.6);
    float sm = sstep(0.06, 0.02, hx.x) * dtl(0.1, px);
    c = vec3(0.22, 0.24, 0.27) * (0.85 + 0.25 * hx.y) * (1.0 - 0.6 * sm) * (1.0 + 0.12 * sstep(0.1, 0.16, hx.x) * sstep(0.26, 0.2, hx.x));
    gEmit = uTrim * 0.12 * sm + (hx.y > 0.9 ? mix(vec3(1.0, 0.6, 0.15), uTrim, 0.3) * 0.3 * sstep(0.08, 0.2, hx.x) : vec3(0.0));
    if (door) { c = vec3(0.15, 0.16, 0.18); gEmit = uTrim * 0.25 * sm; }
#endif
#if SK_32
  } else if (sk == 32) {    // arcane: dark dressed stone with carved runes and circles that glow
    vec3 b = blocks(u, y, 2.0, 1.0, 0.5);
    c = mix(vec3(0.13, 0.12, 0.15), vec3(0.22, 0.20, 0.25), hash(b.xy + 7.7)) * (0.8 + 0.3 * fbm(vec2(u, y) * 1.5));
    c *= mix(1.0, 0.5, sstep(0.04, 0.015, b.z) * dtl(0.1, px));
    vec3 ac = mix(vec3(0.55, 0.3, 1.0), uTrim, 0.25);
    vec2 rc = vec2(mod(u, 10.0) - 5.0, foot - 4.5);
    float rl = length(rc), an = atan(rc.y, rc.x) * 3.0;
    float gl = sstep(0.06, 0.02, abs(rl - 1.6)) + sstep(0.05, 0.02, abs(rl - 1.25))
             + step(0.5, hash(vec2(floor(an), 1.0))) * sstep(0.05, 0.01, abs(rl - 1.42)) * step(abs(fract(an) - 0.5), 0.3)
             + (abs(foot - 7.2) < 0.3 ? step(0.55, hash(floor(vec2(u * 3.0, foot * 4.0 + 0.5)))) * step(0.08, fract(u * 3.0)) : 0.0);   // a band of runes
    gl = clamp(gl, 0.0, 1.0) * dtl(0.1, px);
    c = mix(c, ac * 0.3, gl); gEmit = ac * gl * 1.3;
    if (door) { c = woodCol(u, y, px, 0.6) * 0.5; gEmit = ac * 0.6 * sstep(0.05, 0.02, abs(abs(mod(u, 4.0) - 2.0) - 1.6)) * dtl(0.1, px); }
#endif
#if SK_33
  } else if (sk == 33) {    // shoji: paper screens in a dark wooden lattice, a little light through the paper
    vec2 g = vec2(abs(fract(u) - 0.5), abs(fract(foot / 1.25) - 0.5));
    vec3 paper = vec3(0.86, 0.82, 0.70) * (0.92 + 0.08 * fbm(vec2(u, y) * 3.0));
    float bar = sstep(0.05, 0.03, min(0.5 - g.x, (0.5 - g.y) * 1.25)) * dtl(0.1, px);
    c = mix(paper, vec3(0.20, 0.12, 0.07), bar); gEmit = paper * (1.0 - bar) * 0.12;
    if (mod(u, 3.0) < 0.15 || foot < 0.7 || dt < 0.5 || abs(foot - 6.5) < 0.12) { c = woodCol(u, y, px, 0.5) * 0.6; gEmit = vec3(0.0); }   // the frame
#endif
#if SK_34
  } else if (sk == 34) {    // ruins: old, uneven blocks, moss in the cracks, a few gone
    vec3 b = blocks(u + 0.4 * vnoise(vec2(y * 0.8, u * 0.1)), y, 1.8, 0.9, 0.37);
    float hs = hash(b.xy + 2.2);
    c = mix(vec3(0.36, 0.35, 0.31), vec3(0.50, 0.48, 0.42), hs) * (0.72 + 0.42 * fbm(vec2(u, y) * 1.1));
    c *= mix(1.0, 0.4, sstep(0.07, 0.02, b.z) * dtl(0.15, px));
    float moss = smoothstep(0.55, 0.75, fbm(vec2(u, y) * 0.5 + 4.0)) * (1.0 - smoothstep(0.0, 6.0, foot) * 0.6);
    c = mix(c, vec3(0.16, 0.25, 0.08) * (0.7 + 0.5 * vnoise(vec2(u, y) * 6.0)), clamp(moss * (1.0 + 0.5 * sstep(0.08, 0.0, b.z)), 0.0, 1.0));
    if (hs > 0.93) c *= 0.35;
    if (door) c = woodCol(u, y, px, 0.7) * 0.55;
#endif
#if SK_35
  } else if (sk == 35) {    // dwarven: great dressed granite, a carved band of chevrons, brass inlay
    vec3 b = blocks(u, y, 3.0, 1.5, 0.5);
    c = mix(vec3(0.24, 0.23, 0.24), vec3(0.36, 0.34, 0.33), hash(b.xy + 5.0)) * (0.85 + 0.2 * fbm(vec2(u, y) * 2.0));
    c *= mix(1.0, 0.45, sstep(0.035, 0.012, b.z) * dtl(0.1, px));
    vec3 brass = vec3(0.78, 0.55, 0.22) * (0.85 + 0.3 * vnoise(vec2(u * 3.0, y)));
    float band = abs(foot - 6.0);
    if (band < 0.6) { c = vec3(0.20, 0.19, 0.19) * (0.9 + 0.1 * vnoise(vec2(u, y) * 4.0)); if (band > 0.5 || abs(fract(u / 1.2 + band / 1.2) - 0.5) < 0.08) c = brass; }
    if (foot < 0.8) c *= 0.75;
    if (dt < 0.25) c = brass * 0.85;
    if (door) { c = vec3(0.22, 0.21, 0.21) * (0.85 + 0.2 * vnoise(vec2(u, y) * 2.0)); float fx = abs(fract(u / 4.0) - 0.5) * 4.0; if (abs(fx - 1.5) < 0.12 || abs(foot - 3.5) < 0.12 || abs(fx - foot * 0.25) < 0.08) c = brass; }
#endif
#if SK_36
  } else if (sk == 36) {    // elven: living wood grown into flowing ribs, pale bark, leaves and a few glowing blossoms
    float w = u + 0.35 * sin(y * 0.45 + u * 0.2) + 0.15 * sin(y * 1.3), rib = fract(w / 1.1);
    c = mix(vec3(0.45, 0.40, 0.32), vec3(0.70, 0.64, 0.52), smoothstep(0.0, 0.5, rib) * (1.0 - smoothstep(0.5, 1.0, rib))) * (0.85 + 0.2 * vnoise(vec2(w * 3.0, y * 0.4)));
    c *= (0.8 + 0.3 * vnoise(vec2(w * 6.0, y * 0.35))) * mix(1.0, 0.45, sstep(0.08, 0.02, min(rib, 1.0 - rib) * 1.1) * dtl(0.1, px));   // bark, and the gaps between the stems
    float lf = smoothstep(0.6, 0.72, fbm(vec2(u, y) * 0.7 + 9.0));
    c = mix(c, vec3(0.20, 0.40, 0.14) * (0.7 + 0.6 * vnoise(vec2(u, y) * 5.0)), lf);
    vec2 bq = vec2(u, y) * 1.5;
    if (lf > 0.4 && hash(floor(bq)) > 0.85 && length(fract(bq) - 0.5) < 0.16) { c = vec3(0.85, 0.9, 1.0); gEmit = vec3(0.55, 0.8, 1.0) * 0.5 * dtl(0.1, px); }   // a blossom
    if (door) { c = woodCol(u, y, px, 0.5) * 1.1; gEmit = vec3(0.0); float ax = abs(fract(u / 4.0) - 0.5) * 2.0; if (abs(foot - 7.0 + 2.0 * ax * ax) < 0.15) c = vec3(0.85, 0.75, 0.4); }   // a leaf-arch inlay
#endif
#if SK_37
  } else if (sk == 37) {    // crystal: a cave wall grown over with faceted crystals that glow from within
    vec2 hx = hexCell(vec2(u * 0.8 + 0.3 * y, y * 0.5), 1.3);
    vec3 cc = hx.y < 0.65 ? vec3(0.55, 0.3, 0.9) : hx.y < 0.85 ? vec3(0.2, 0.75, 0.85) : vec3(0.9, 0.35, 0.65);
    float fa = hash(vec2(floor(atan(gHex.y, gHex.x) / 1.0472 + 3.0), hx.y * 31.0));   // which facet of the crystal: its own shade
    float k = smoothstep(0.0, 0.4, hx.x);
    if (hx.y < 0.4) c = vec3(0.12, 0.11, 0.13) * (0.7 + 0.5 * fbm(vec2(u, y)));
    else { c = mix(cc * (0.18 + 0.5 * fa) * (0.6 + 0.4 * k), vec3(0.04), sstep(0.05, 0.0, hx.x) * dtl(0.1, px)); gEmit = cc * (0.08 + 0.22 * k) * (0.6 + 0.6 * fa); }
    if (door) { c = woodCol(u, y, px, 0.7) * 0.5; gEmit = vec3(0.0); }
#endif
#if SK_38
  } else if (sk == 38) {    // cryo: frosted white panels, blue light in the seams, frost creeping up from the floor
    vec3 b = blocks(u, foot, 2.5, 4.0, 0.0);
    c = vec3(0.80, 0.86, 0.90) * (0.93 + 0.07 * hash(b.xy + 4.2)) * (0.9 + 0.12 * fbm(vec2(u, y) * 1.5));
    float sm = sstep(0.12, 0.06, b.z) * mix(0.35, 1.0, dtl(0.12, px));
    c = mix(c, vec3(0.35, 0.55, 0.7), sm); gEmit = vec3(0.3, 0.7, 1.0) * 0.6 * sm;
    c = mix(c, vec3(0.95, 0.98, 1.0), sstep(2.0, 0.0, foot) * smoothstep(0.4, 0.7, fbm(vec2(u, y) * 2.0)) * 0.8);
    if (door) { c = vec3(0.6, 0.66, 0.7); gEmit = vec3(0.0); if (abs(fract(u / 4.0) - 0.5) < 0.012 || abs(foot - 3.5) < 0.05) { c = vec3(0.2, 0.5, 0.7); gEmit = vec3(0.3, 0.7, 1.0) * 0.5; } }
#endif
#if SK_39
  } else if (sk == 39) {    // server racks: black cabinets full of units, rows of status LEDs
    float ru = fract(u / 2.0) * 2.0, unit = floor(foot / 0.15), k = dtl(0.06, px);
    c = vec3(0.04, 0.045, 0.05);
    if (ru > 0.15 && ru < 1.85 && foot > 0.5 && foot < 7.0) {
      c = vec3(0.09, 0.095, 0.10) * (0.8 + 0.3 * hash(vec2(floor(u / 2.0), unit)));
      if (fract(foot / 0.15) < 0.12) c *= 0.4;
      float led = hash(vec2(floor(u * 6.0), unit) + 1.3);
      gEmit = vec3(0.03, 0.08, 0.05) * (1.0 - k);   // far away: the LEDs blur to a faint glow
      if (led > 0.75 && fract(u * 6.0) < 0.35 && abs(fract(foot / 0.15) - 0.55) < 0.2) gEmit += (led > 0.96 ? vec3(1.0, 0.6, 0.1) : led > 0.88 ? vec3(0.2, 0.6, 1.0) : vec3(0.2, 1.0, 0.4)) * 0.9 * k;
    }
    if (door) { c = vec3(0.07, 0.08, 0.09); gEmit = vec3(0.0); if (fract(u * 4.0) < 0.1 && foot > 1.0 && foot < 6.0) c *= 0.4; }   // a mesh door
#endif
#if SK_40
  } else if (sk == 40) {    // force field: an energy wall between emitter rails, hexes and interference bands
    vec2 hx = hexCell(vec2(u, y), 0.9);
    float band = 0.5 + 0.5 * sin(y * 3.0 + u * 0.7 + 3.0 * vnoise(vec2(u, y) * 0.3));
    vec3 fc = mix(vec3(0.2, 0.8, 1.0), uTrim, 0.4);
    c = fc * 0.15; gEmit = fc * (0.18 + 0.25 * band * band + 0.5 * sstep(0.05, 0.0, hx.x) * dtl(0.08, px));
    if (foot < 0.6 || dt < 0.4) { c = vec3(0.12, 0.13, 0.15); gEmit = abs(foot - 0.55) < 0.05 || abs(dt - 0.35) < 0.05 ? fc : vec3(0.0); }   // the emitter rails
    if (door) { c = fc * 0.1; gEmit *= 0.6; }
#endif
#if SK_41
  } else if (sk == 41) {    // hangar bulkhead: heavy grey plates, hazard bands, big stencilled bay numbers
    vec3 b = blocks(u, foot, 6.0, 3.0, 0.0);
    c = vec3(0.38, 0.40, 0.42) * (0.85 + 0.2 * hash(b.xy + 8.8)) * (0.9 + 0.12 * fbm(vec2(u, y)));
    c *= mix(1.0, 0.45, sstep(0.06, 0.03, b.z) * dtl(0.12, px));
    if (abs(mod(u, 12.0) - 6.0) > 5.6) c = vec3(0.22, 0.23, 0.25);
    float cu = fract(u / 24.0) * 24.0;
    if (cu > 8.0 && cu < 16.0 && foot > 3.0 && foot < 7.5) {
      float g = (cu - 8.0) / 4.0, dg = floor(g);
      if (seg7(vec2(fract(g), (foot - 3.0) / 4.5), int(hash(vec2(floor(u / 24.0), dg)) * 9.99)) > 0.5) c = vec3(0.85, 0.72, 0.18) * (0.85 + 0.2 * vnoise(vec2(u, y) * 3.0));
    }
    if (foot < 1.2 || abs(foot - 9.0) < 0.4) c = hazard(u * 0.5, foot * 0.5);
    if (door) { c = vec3(0.32, 0.34, 0.36) * (abs(fract(foot / 1.2) - 0.5) > 0.45 ? 0.5 : 1.0); if (foot < 1.2) c = hazard(u * 0.5, foot * 0.5); }   // a slatted shutter
#endif
#if SK_42
  } else if (sk == 42) {    // art deco: black lacquer in gold-framed panels, fans and stepped lines (noir lobbies, speakeasies)
    vec3 gold = vec3(0.85, 0.66, 0.30) * (0.85 + 0.25 * vnoise(vec2(u * 2.0, y * 2.0)));
    float pu = fract(u / 4.0) * 4.0 - 2.0, k = dtl(0.14, px), g = 0.0;
    c = vec3(0.05, 0.045, 0.045) * (0.9 + 0.2 * vnoise(vec2(u, y) * 3.0));
    if (abs(pu) > 1.86 || foot < 0.7 || dt < 0.35) g = 1.0;
    vec2 fv = vec2(pu, foot - 1.0); float fr = length(fv), fa = atan(fv.x, max(fv.y, 1e-3));
    if (fv.y > 0.0 && fr < 3.1 && (abs(fract(fa / 0.2618) - 0.5) > 0.4 || abs(fr - 2.4) < 0.08 || abs(fr - 3.0) < 0.1 || fr < 0.5)) g = 1.0;   // a sunburst fan
    if (foot > 5.0 && abs(abs(pu) - (0.3 + floor((foot - 5.0) / 0.5) * 0.3)) < 0.08) g = 1.0;   // stepped lines above it
    c = mix(c, gold, g * k + (1.0 - k) * 0.3);
    if (door) { c = vec3(0.05); if (abs(pu) > 1.8 || abs(fract(foot / 1.5) - 0.5) > 0.44) c = gold; }
#endif
#if SK_43
  } else if (sk == 43) {    // reactor: dark plating, glowing coolant tubes, warning chevrons
    c = vec3(0.14, 0.15, 0.16) * (0.85 + 0.2 * fbm(vec2(u, y) * 0.7));
    c *= mix(1.0, 0.55, sstep(0.05, 0.02, blocks(u, foot, 3.0, 3.0, 0.0).z) * dtl(0.1, px));
    float tu = fract(u / 5.0) * 5.0 - 2.5, tr = 0.45;
    vec3 cc = hash(vec2(floor(u / 5.0), 2.2)) > 0.5 ? vec3(0.2, 0.75, 1.0) : vec3(1.0, 0.45, 0.1);
    bool col = foot > 1.0 && dt > 1.0;
    if (col && abs(tu) < tr) {
      float s = sqrt(1.0 - (tu / tr) * (tu / tr));
      c = cc * 0.15; gEmit = cc * (0.4 + 0.6 * s) * (0.85 + 0.15 * sin(foot * 6.0 + u));
      if (abs(fract(foot / 2.0) - 0.5) > 0.46) { c = vec3(0.3); gEmit = vec3(0.0); }   // clamps
    } else if (col && abs(tu) < tr + 0.15) c = vec3(0.35, 0.36, 0.38);
    else if (col) gEmit = cc * 0.12 * sstep(1.4, tr, abs(tu));   // the tube's glow on the plating
    if (foot < 0.8) c = hazard(u * 0.7, foot * 0.7);
    if (door) { c = vec3(0.2, 0.21, 0.22); gEmit = vec3(0.0); if (abs(foot - 3.5) < 0.4) c = hazard(u, foot); }
#endif
#if SK_44
  } else if (sk == 44) {    // viewports: tall windows onto space - stars and a nebula - in a panelled hull
    float wu = fract(u / 6.0) * 6.0;
    if (wu > 0.8 && wu < 5.2 && foot > 2.5 && dt > 1.0) {
      vec2 q = vec2(u, y) * 0.15 + n2 * 3.0;
      vec3 neb = mix(vec3(0.25, 0.05, 0.35), vec3(0.05, 0.25, 0.4), fbm(q * 0.7)) * smoothstep(0.35, 0.8, fbm(q * 0.5 + 4.0));
      vec2 sc = floor(vec2(u, y) * 3.0);
      float star = hash(sc + 7.0) > 0.97 ? sstep(0.25, 0.0, length(fract(vec2(u, y) * 3.0) - 0.5 - (hash(sc) - 0.5) * 0.4)) : 0.0, k = dtl(0.2, px);
      c = vec3(0.005); gEmit = neb * 0.8 + vec3(0.9, 0.95, 1.0) * star * k + vec3(0.02) * (1.0 - k);
      if (abs(wu - 3.0) < 0.06) { c = vec3(0.3); gEmit = vec3(0.0); }
    } else {
      c = vec3(0.62, 0.65, 0.68) * (0.92 + 0.08 * vnoise(vec2(u, y) * 2.0));
      c *= mix(1.0, 0.55, sstep(0.05, 0.02, blocks(u, foot, 3.0, 2.5, 0.0).z) * dtl(0.1, px));
      if (wu > 0.6 && wu < 5.4 && foot > 2.3 && dt > 0.8) c = vec3(0.18, 0.19, 0.21);   // the window's frame
      if (foot < 0.6) c = vec3(0.12, 0.13, 0.15);
    }
    if (door) { c = vec3(0.45, 0.48, 0.52); gEmit = vec3(0.0); if (abs(fract(u / 4.0) - 0.5) < 0.012) c *= 0.3; }
#endif
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
int raisedSkin(int sk){
  if (sk == 1 || sk == 7 || sk == 8 || sk == 13 || sk == 15 || sk == 18 || sk == 20 || (sk >= 22 && sk <= 23) || (sk >= 26 && sk <= 28) || sk == 31 || (sk >= 38 && sk != 42)) return 0;
  return sk == 6 || sk == 17 || sk == 33 ? 5 : sk == 10 || sk == 32 ? 3 : sk == 37 ? 4 : sk;
}
// the tops of walls (seen from above) in the skin's colour
const vec3 SKIN_TOP[32] = vec3[32](vec3(0.45, 0.48, 0.50), vec3(0.80, 0.80, 0.78), vec3(0.40, 0.40, 0.39), vec3(0.52, 0.53, 0.52),
  vec3(0.75, 0.72, 0.66), vec3(0.60, 0.63, 0.66), vec3(0.58, 0.45, 0.28), vec3(0.18, 0.10, 0.09), vec3(0.12, 0.06, 0.10),
  vec3(0.05, 0.05, 0.05), vec3(0.78, 0.80, 0.80), vec3(0.45, 0.20, 0.12), vec3(0.70, 0.72, 0.76), vec3(0.08, 0.08, 0.08),
  vec3(0.04, 0.06, 0.08), vec3(0.20, 0.21, 0.21), vec3(0.38, 0.20, 0.10), vec3(0.20, 0.12, 0.17), vec3(0.24, 0.26, 0.29),
  vec3(0.17, 0.16, 0.19), vec3(0.25, 0.15, 0.08), vec3(0.42, 0.41, 0.36), vec3(0.30, 0.29, 0.29), vec3(0.55, 0.50, 0.40),
  vec3(0.20, 0.15, 0.25), vec3(0.78, 0.84, 0.88), vec3(0.06, 0.06, 0.07), vec3(0.14, 0.15, 0.17), vec3(0.36, 0.38, 0.40),
  vec3(0.08, 0.07, 0.06), vec3(0.16, 0.17, 0.18), vec3(0.55, 0.58, 0.62));
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
  if (sk >= 13) return SKIN_TOP[min(sk - 13, 31)] * n;
  return textureLod(uFloor, uv, 4.5).rgb * 1.15;
}
// the wall-skin pattern to draw at this pixel (-1 = none) and where on it: wallSkin is big, so it is drawn from one
// place only (each call would be compiled in full), after the surface has said what it wants
int wsSk; float wsU, wsY, wsDt, wsFt, wsMul; vec2 wsN; bool wsDoor;
// ceilings (seen from below) in the wall skin's material; xz in px; may light a strip (glow, glowCol). Ceilings made of
// the wall's own pattern ask for it (wsSk...) and are finished by ceilPost
vec3 ceilSkin(int sk, vec2 xz, vec2 uv, float px, inout float glow, inout vec3 glowCol){
  vec2 q = xz / uPpf; vec3 c = vec3(0.0); gEmit = vec3(0.0);
  wsSk = -1; wsU = q.x; wsY = q.y; wsDt = 9.0; wsFt = 9.0; wsN = vec2(0.0); wsDoor = false; wsMul = 1.0;
  if (sk == 0) {            // neon: dark metal panels (like the walls), recessed seams, glowing light strips
    vec2 cell = floor(q / 5.0), f = abs(fract(q / 5.0) - 0.5) * 5.0;
    c = mix(vec3(0.12, 0.13, 0.155), textureLod(uFloor, uv, 6.0).rgb, 0.22) * (0.82 + 0.22 * hash(cell + 7.3)) * (0.92 + 0.1 * vnoise(q * 0.8));
    c *= mix(1.0, 0.55, sstep(2.38, 2.45, max(f.x, f.y)) * dtl(0.1, px));
    float sx = abs(mod(q.x + 7.5, 15.0) - 7.5), sy = abs(fract(q.y / 10.0) - 0.5) * 10.0;
    if (sx < 0.2 && sy < 4.2) { glow = 1.0; glowCol = uTrim; }                // a light strip in every third row
    else if (sx < 0.45 && sy < 4.35) c *= 0.5;                                   // its housing
  } else if (sk == 12) {    // match the map: its own colours, dimmed, in big plain panels
    c = textureLod(uFloor, uv, 5.0).rgb * 0.55 + vec3(0.02);
    c *= mix(1.0, 0.7, sstep(0.06, 0.02, blocks(q.x, q.y, 6.0, 6.0, 0.0).z) * dtl(0.12, px));
  } else if (sk == 13 || sk == 14 || sk == 16 || sk == 23) {   // offices, clinics, washrooms: ceiling tiles with light panels
    vec3 b = blocks(q.x, q.y, 2.0, 4.0, 0.0); vec2 cell = floor(q / vec2(2.0, 4.0));
    c = vec3(0.78, 0.78, 0.76) * (0.95 + 0.05 * hash(cell)) * (0.92 + 0.1 * vnoise(q * 6.0));
    c *= mix(1.0, 0.6, sstep(0.05, 0.02, b.z) * dtl(0.08, px));
    if (mod(cell.x, 3.0) < 1.0 && mod(cell.y, 2.0) < 1.0 && b.z > 0.12) { glow = 1.0; glowCol = vec3(1.0, 0.98, 0.92) * 0.8; }
  } else if (sk == 17) {    // plaster in big moulded panels
    c = vec3(0.80, 0.78, 0.72) * (0.94 + 0.08 * fbm(q * 0.8));
    c *= mix(1.0, 0.8, sstep(0.25, 0.1, blocks(q.x, q.y, 8.0, 8.0, 0.0).z) * dtl(0.1, px));
  } else if (sk == 15 || sk == 20) {   // bare concrete (dark in a neon alley)
    wsSk = 1; wsMul = sk == 20 ? 0.4 : 1.0;
  } else if (sk == 22 || sk == 39) {    // a black box (or a server room): matte black with a truss / cable-tray grid
    c = vec3(0.035, 0.035, 0.04) * (0.9 + 0.2 * vnoise(q));
    if (abs(mod(q.x, 8.0) - 4.0) > 3.85 || abs(mod(q.y, 8.0) - 4.0) > 3.85) c = vec3(0.12);
  } else if (sk == 5 || sk == 19) {     // boards across joists
    c = woodCol(q.x, q.y, px, 0.8) * 0.85;
    if (abs(mod(q.y, 4.0) - 2.0) > 1.68) c = woodCol(q.y, q.x, px, 0.6) * 0.55;
  } else if (sk == 6) {     // plaster between dark timber beams
    c = vec3(0.70, 0.66, 0.56) * (0.88 + 0.14 * fbm(q * 1.6));
    if (abs(mod(q.x, 4.0) - 2.0) > 1.7 || abs(mod(q.y, 16.0) - 8.0) > 7.45) c = vec3(0.22, 0.13, 0.07) * (0.85 + 0.3 * vnoise(vec2(q.x * 0.4, q.y * 4.0)));
  } else if (sk == 7 || sk == 40 || sk == 41) wsSk = 7;   // steel deck plates on girders (ceilPost)
  else if (sk == 9) wsSk = 9;                                // marble coffers with gold edges (ceilPost)
  else if (sk == 44) { wsSk = 18; wsFt = 40.0 + q.y; }      // viewports: starship panels
  else { wsSk = sk; wsFt = sk == 28 || sk == 43 ? mod(q.y, 9.0) : 40.0 + q.y; }   // the wall's own pattern (pipes, reactor: ducts every 9 ft)
  return c;
}
// what goes over a ceiling drawn in the wall's pattern: girders, coffers
vec3 ceilPost(int sk, vec2 q, vec3 c){
  if (sk == 7 || sk == 40 || sk == 41) { if (abs(mod(q.x, 8.0) - 4.0) > 3.6) c = vec3(0.20, 0.21, 0.23) * (0.9 + 0.2 * vnoise(q * 3.0)); }
  else if (sk == 9) {
    vec2 f = abs(fract(q / 6.0) - 0.5) * 6.0; float e = 3.0 - max(f.x, f.y);
    if (e < 0.12) c = vec3(0.95, 0.72, 0.30) * (0.85 + 0.3 * vnoise(q * 2.0)); else if (e < 0.5) c *= 0.8;
  }
  return c;
}

// what a sloped roof is covered with: 0 standing-seam metal, 1 clay tiles, 2 slate, 3 wood shingles, 4 thatch, 5 corrugated sheet
int roofMat(int sk){
  if (sk == 2 || sk == 9 || sk == 11) return 1;
  if (sk == 3 || sk == 4 || sk == 32 || sk == 34 || sk == 35 || sk == 37) return 2;
  if (sk == 5 || sk == 6 || sk == 17 || sk == 33 || sk == 36) return 3;
  if (sk == 10) return 4;
  if (sk == 8 || sk == 15 || sk == 19 || sk == 24 || sk == 29) return 5;
  return 0;
}
// roofs seen from above (a token's eye view): sloped ones in a covering that suits the walls, flat ones in the wall tops'
// colour with seams and a few vents; sl = the slope (height per px across x and z)
vec3 roofSkin(int sk, vec2 xz, vec2 uv, float px, vec2 sl, int mo){   // mo: a covering picked in Scene / Region Config (-1 = suit the walls)
  vec2 q = xz / uPpf; vec3 c;
  bool flt = dot(sl, sl) < 1e-4;
  if (sk == 0 && mo < 0) {   // neon panels: dark sci-fi plating, seams, a vent here and there (not the map's art)
    vec3 b = blocks(q.x, q.y, 5.0, 5.0, 0.0); float vr = length(fract(q / 5.0) * 5.0 - 2.5);
    c = vec3(0.15, 0.16, 0.18) * (0.85 + 0.2 * hash(b.xy + 1.9)) * (0.92 + 0.1 * vnoise(q * 0.8));
    c *= mix(1.0, 0.5, sstep(0.06, 0.02, b.z) * dtl(0.1, px));
    if (hash(b.xy + 5.3) > 0.88 && vr < 0.8) c = vec3(0.08) * (vr < 0.55 ? 0.6 : 1.0);
    return c;
  }
  if (flt && mo < 0) {
    c = skinTop(sk, xz, uv) * 0.8 * (0.9 + 0.15 * fbm(q * 0.6));
    vec3 b = blocks(q.x, q.y, 6.0, 6.0, 0.0); float vr = length(fract(q / 6.0) * 6.0 - 3.0);
    c *= mix(1.0, 0.75, sstep(0.06, 0.02, b.z) * dtl(0.1, px));
    if (hash(b.xy + 3.7) > 0.9 && vr < 0.9) c = vec3(0.22, 0.23, 0.24) * (vr < 0.6 ? 0.5 : 1.0);   // a vent
    return c;
  }
  vec2 dn = flt ? vec2(0.0, 1.0) : -normalize(sl), ac = vec2(-dn.y, dn.x);
  float u = dot(q, ac), v = dot(q, dn) * sqrt(1.0 + dot(sl, sl));   // ft across and down the roof
  int m = mo >= 0 ? mo : roofMat(sk);
  if (m == 1) {          // clay barrel tiles
    float row = floor(v), cu = u / 0.75 + 0.5 * mod(row, 2.0);
    c = mix(vec3(0.55, 0.22, 0.12), vec3(0.70, 0.34, 0.18), hash(vec2(floor(cu), row)));
    c *= mix(1.0, 0.65 + 0.45 * sin(fract(cu) * 3.1416), dtl(0.2, px)) * mix(1.0, 0.6, sstep(0.85, 1.0, fract(v)) * dtl(0.1, px));
  } else if (m == 2) {   // slate
    vec3 b = blocks(u, v, 1.0, 0.6, 0.5);
    c = mix(vec3(0.17, 0.19, 0.22), vec3(0.28, 0.30, 0.33), hash(b.xy + 6.1)) * (0.9 + 0.15 * vnoise(q * 3.0));
    c *= mix(1.0, 0.55, sstep(0.04, 0.015, b.z) * dtl(0.08, px));
  } else if (m == 3) {   // wood shingles
    vec3 b = blocks(u, v, 0.55, 0.45, 0.5);
    c = vec3(0.36, 0.24, 0.14) * (0.7 + 0.45 * hash(b.xy + 2.9)) * (0.88 + 0.15 * vnoise(vec2(u * 8.0, v)));
    c *= mix(1.0, 0.55, sstep(0.035, 0.01, b.z) * dtl(0.08, px));
  } else if (m == 4) {   // thatch, combed down the roof
    c = vec3(0.55, 0.45, 0.25) * (0.7 + 0.45 * vnoise(vec2(u * 9.0, v * 0.6))) * (0.85 + 0.2 * fbm(q * 0.4));
    c *= mix(1.0, 0.8, sstep(0.75, 1.0, fract(v / 1.5)) * dtl(0.2, px));
  } else if (m == 5) {   // corrugated sheet, patched and rusty
    float hs = hash(vec2(floor(u / 3.0), floor(v / 8.0)));
    c = hs < 0.6 ? vec3(0.45, 0.45, 0.44) : hs < 0.8 ? vec3(0.42, 0.24, 0.12) : vec3(0.25, 0.35, 0.33);
    c *= 1.0 - 0.25 * dtl(0.12, px) * (0.5 + 0.5 * sin(u * 6.2831 / 0.33));
    c = mix(c, vec3(0.38, 0.18, 0.08), smoothstep(0.55, 0.8, fbm(q * 0.6)) * 0.7);
  } else {               // standing-seam metal
    c = mix(vec3(0.30, 0.33, 0.36), skinTop(sk, xz, uv), 0.25) * (0.92 + 0.1 * vnoise(vec2(u * 0.5, v * 0.1)));
    float f = abs(fract(u / 1.5) - 0.5) * 1.5;
    c *= mix(1.0, f > 0.7 ? 1.35 : f > 0.66 ? 0.6 : 1.0, dtl(0.08, px));
  }
  return c;
}

// ---------------------------------------------------------------- raised areas that look like something
// face 0 = the front, 1 = a side, 2 = the back; U = 0..1 across the front (left to right as you face it), Uf = ft along the
// face, Y = ft over the floor, H = height (ft), W = width of the front (ft); tc = the top's colour, edge = the art at the top's
// edge; writes the self-lit part (screens, LEDs, neon) to gEmit
// ---------------------------------------------------------------- spell templates
// how much of a template covers a point of the map: fill (0/1) and the glowing edge (0..1); colour in tplCol
vec3 tplCol;
vec2 tplAt(vec2 xz, float pxw){
  vec2 r = vec2(0.0); tplCol = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uTplN) break;
    vec4 a = texelFetch(uTpl, ivec2(i, 0), 0), b = texelFetch(uTpl, ivec2(i, 1), 0);
    vec2 d = xz - a.xy, dir = vec2(cos(b.x), sin(b.x));
    vec2 loc = vec2(dot(d, dir), dot(d, vec2(-dir.y, dir.x)));
    int ty = int(a.w + 0.5); float R = a.z, e = -1.0;   // e: how far inside the edge (px)
    if (ty == 1) e = R - length(d);                                                         // circle
    else if (ty == 2) e = min(R - length(d), (b.y - abs(atan(loc.y, loc.x))) * length(d));  // cone
    else if (ty == 4) e = min(min(loc.x, R - loc.x), b.y * 0.5 - abs(loc.y));              // ray / line
    else if (ty == 3) { vec2 q = a.xy + dir * R, lo = min(a.xy, q), hi = max(a.xy, q); e = min(min(xz.x - lo.x, hi.x - xz.x), min(xz.y - lo.y, hi.y - xz.y)); }   // rectangle
    if (e < 0.0) continue;
    float edge = 1.0 - smoothstep(0.0, max(pxw * 2.0, 0.3 * uPpf), e);
    if (edge >= r.y) tplCol = texelFetch(uTpl, ivec2(i, 2), 0).rgb;
    r = max(r, vec2(1.0, edge));
  }
  return r;
}

vec3 propFace(int L, int face, float U, float Uf, float Y, float H, float W, float Us, float D, vec3 tc, vec3 edge, float px, float seed){
  float T = clamp(Y / max(H, 0.5), 0.0, 1.0);
  // a long block of cabinets / machines / racks: one unit every few feet along the front, each a little different
  float unit = L == 2 ? 3.0 : L == 3 ? 3.5 : L == 4 ? 2.2 : L == 11 ? 3.0 : L == 8 ? 4.0 : L == 16 ? 4.0 : 0.0;
  float edgeU = 1.0;
  if (unit > 0.0 && face == 0) { float n = max(1.0, floor(W / unit + 0.5)); seed = fract(seed + floor(U * n) * 0.37); U = fract(U * n); W /= n; edgeU = min(U, 1.0 - U) * W; }
  float mx = max(max(tc.r, tc.g), tc.b);
  vec3 sat = mx > 0.02 ? clamp(tc / mx, 0.0, 1.0) : vec3(0.5);   // the top's hue at full strength
  vec3 c = vec3(0.18);
  gEmit = vec3(0.0);
  if (L < 0) {   // (each look below is compiled in only when a scene uses it: LK_n)
#if LK_1
  } else if (L == 1) {                                     // the top's art carried down the sides
    c = edge * (0.5 + 0.5 * T);
#endif
#if LK_2
  } else if (L == 2) {                              // arcade cabinet
    if (face == 0) {
      c = vec3(0.05, 0.05, 0.07);
      if (T > 0.9) { c = sat * 0.3; gEmit = sat * (0.6 + 0.12 * sin(uTime * 3.0 + seed * 9.0)); }   // marquee
      else if (T > 0.6 && T < 0.87 && U > 0.12 && U < 0.88) {                                    // the screen
        vec2 q = vec2((U - 0.12) / 0.76, (T - 0.6) / 0.27);
        vec3 scr = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + q.x * 1.4 - q.y * 0.8 + uTime * 0.3 + seed * 3.0));
        scr *= 0.7 + 0.3 * step(0.5, fract(Y * 24.0));
        c = scr * 0.06; gEmit = scr * 0.42;
      } else if (T > 0.5 && T < 0.58) {                                                          // control panel
        c = vec3(0.14, 0.14, 0.18);
        float b = length(vec2((fract(U * 7.0) - 0.5) * W / 7.0, (T - 0.54) * H));
        if (b < 0.1 && U > 0.15 && U < 0.85) gEmit = hue3(floor(U * 7.0) / 7.0 + seed) * 0.9;
      } else if (T > 0.2 && T < 0.34 && abs(U - 0.5) < 0.12) {                                   // coin door
        c = vec3(0.11); if (abs(U - 0.5) < 0.025 && T > 0.25 && T < 0.29) gEmit = vec3(1.0, 0.35, 0.1) * 0.9;
      }
    } else if (face == 1) c = mix(vec3(0.04), sat * 0.55, smoothstep(0.3, 0.9, fract(Uf * 0.22 + T * 0.55 + seed))) * (0.55 + 0.45 * T);
    else c = vec3(0.06);
#endif
#if LK_3
  } else if (L == 3) {                              // vending machine
    c = sat * 0.3 + 0.04;
    if (face == 0) {
      if (U > 0.07 && U < 0.66 && T > 0.22 && T < 0.93) {                                        // glass, rows of drinks
        vec2 g6 = vec2((U - 0.07) / 0.59 * 5.0, (T - 0.22) / 0.71 * 6.0), f = fract(g6);
        vec3 item = hue3(hash(floor(g6) + seed)) * 0.8 + 0.1;
        float can = step(0.25, f.x) * step(f.x, 0.75) * step(0.15, f.y) * step(f.y, 0.75);
        c = mix(vec3(0.12, 0.14, 0.15), item * 0.35, can);
        gEmit = mix(vec3(0.07, 0.08, 0.09), item * 0.3, can);
      } else if (U > 0.72 && U < 0.92 && T > 0.6 && T < 0.7) gEmit = vec3(0.2, 1.0, 0.5) * 0.8;      // little display
      else if (U > 0.72 && U < 0.92 && T > 0.38 && T < 0.58) { c = vec3(0.15); if (fract(U * 30.0) < 0.5 && fract(T * 40.0) < 0.5) c = vec3(0.6); }
      else if (U > 0.12 && U < 0.6 && T > 0.06 && T < 0.17) c = vec3(0.02);                       // the slot
    }
#endif
#if LK_4
  } else if (L == 4) {                              // server rack
    c = vec3(0.07, 0.075, 0.09);
    if (face == 0) {
      float un = fract(Y / 0.15), lit = hash(vec2(floor(Y / 0.15), floor(U * 12.0)) + seed);
      if (un > 0.88) c *= 0.5;
      if (fract(U * 12.0) < 0.35 && un > 0.3 && un < 0.6 && lit > 0.55) {
        float blink = step(0.4, fract(uTime * (0.5 + lit * 3.0) + lit * 7.0));
        gEmit = (lit > 0.85 ? vec3(1.0, 0.6, 0.1) : lit > 0.7 ? vec3(0.2, 0.6, 1.0) : vec3(0.2, 1.0, 0.4)) * blink * 0.9;
      }
      if (U < 0.04 || U > 0.96) c = vec3(0.13);
    } else if (abs(fract(Uf / 2.0) - 0.5) > 0.48) c *= 0.6;
#endif
#if LK_5
  } else if (L == 5) {                              // bookshelf
    c = woodCol(Uf, Y, px, 0.9) * 0.9;
    if (face == 0 && U > 0.04 && U < 0.96 && Y > 0.4 && T < 0.95) {
      float sh = fract(Y / 1.25), row = floor(Y / 1.25), bi = floor(Uf / 0.16);
      if (sh > 0.1) {
        float bh = 0.55 + 0.4 * hash(vec2(bi, row + 7.0));
        vec3 book = hue3(hash(vec2(bi, row + 3.0))) * mix(0.25, 0.55, hash(vec2(bi + 2.0, row)));
        c = (sh - 0.1) / 0.9 < bh ? book * (0.8 + 0.2 * step(0.5, fract(Uf / 0.16))) : vec3(0.04);
      }
    }
#endif
#if LK_6
  } else if (L == 6) {                              // wooden crate: planks, a frame and a brace
    c = woodCol(Uf, Y, px, 0.55) * 1.15;
    vec2 q = vec2(fract(Uf / max(H, 1.0)), T);
    if (min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y)) * H < 0.28 || abs(q.x - q.y) * H < 0.18) c = woodCol(Y + Uf, Uf, px, 0.4) * 0.8;
#endif
#if LK_7
  } else if (L == 7) {                              // cargo container: painted corrugated steel
    c = mix(vec3(0.55, 0.2, 0.1), sat * 0.6, 0.5) * (0.75 + 0.25 * sin(Uf * 12.566));
    if (face == 0) { if (abs(U - 0.5) * W < 0.06) c *= 0.4; if (abs(fract(U * 4.0) - 0.5) * W / 4.0 < 0.05 && T > 0.1 && T < 0.9) c = vec3(0.5); }
    if (T > 0.94 || T < 0.05) c = vec3(0.12);
#endif
#if LK_8
  } else if (L == 8) {                              // computer console: screens and blinking buttons
    c = vec3(0.09, 0.1, 0.12);
    if (face == 0) {
      if (T > 0.55 && T < 0.9 && fract(U * 3.0) > 0.08 && fract(U * 3.0) < 0.92) {
        vec2 q = vec2(fract(U * 3.0), (T - 0.55) / 0.35);
        float ln = step(0.6, fract(q.y * 9.0 - uTime * 0.4 + hash(vec2(floor(U * 3.0), seed)))) * step(q.x, 0.2 + 0.7 * hash(vec2(floor(q.y * 9.0), floor(U * 3.0))));
        gEmit = mix(vec3(0.05, 0.35, 0.45), vec3(0.3, 1.0, 0.9), ln) * 0.7;
      } else if (T > 0.3 && T < 0.48 && hash(vec2(floor(U * 20.0), floor(T * 30.0)) + seed) > 0.75)
        gEmit = hue3(hash(vec2(floor(U * 20.0), 5.0))) * 0.7 * step(0.3, fract(uTime + hash(vec2(floor(U * 20.0), 1.0))));
    }
#endif
#if LK_9
  } else if (L == 9) {                              // bar counter: panels, a brass foot rail, underglow
    c = woodCol(Uf, Y, px, 0.35) * 0.8;
    if (face != 2) {
      if (abs(Y - 0.55) < 0.06) c = vec3(0.8, 0.6, 0.25);
      if (T > 0.9) c = woodCol(Uf * 2.0, Y, px, 1.0) * 1.2;
      if (Y < 0.12) { c = vec3(0.02); gEmit = sat * 0.9; }
      if (face == 0 && T > 0.25 && T < 0.85 && abs(fract(Uf / 2.5) - 0.5) > 0.47) c *= 0.5;
    }
#endif
#if LK_10
  } else if (L == 10) {                             // shop counter: a glass case on a wooden base
    c = woodCol(Uf, Y, px, 0.3) * 0.75;
    if (face == 0 && T > 0.45 && T < 0.93) {
      float sh = fract((T - 0.45) / 0.48 * 2.0), cell = fract(Uf / 0.6);
      vec3 item = hue3(hash(vec2(floor(Uf / 0.6), floor((T - 0.45) / 0.24)) + seed)) * 0.6;
      float it = step(0.25, cell) * step(cell, 0.7) * step(0.15, sh) * step(sh, 0.6);
      c = mix(vec3(0.07, 0.09, 0.1), item, it); gEmit = vec3(0.07, 0.08, 0.08) + item * it * 0.35;
    }
#endif
#if LK_11
  } else if (L == 11) {                             // fridge
    c = vec3(0.78, 0.8, 0.82) * (0.85 + 0.15 * T);
    if (face == 0) {
      if (abs(T - 0.68) * H < 0.03) c = vec3(0.2);
      if (abs(U - 0.85) * W < 0.06 && ((T > 0.73 && T < 0.85) || (T > 0.4 && T < 0.62))) c = vec3(0.35);
    }
#endif
#if LK_12
  } else if (L == 12) {                             // lockers
    c = mix(vec3(0.25, 0.32, 0.4), sat * 0.5, 0.45);
    if (face == 0) {
      float d = fract(Uf / 1.2) * 1.2;
      if (d < 0.04 || d > 1.16) c *= 0.35;
      if (T > 0.82 && T < 0.92 && fract(Y * 10.0) < 0.5 && d > 0.25 && d < 0.95) c *= 0.3;
      if (abs(d - 1.0) < 0.04 && T > 0.45 && T < 0.6) c = vec3(0.7);
    }
#endif
#if LK_13
  } else if (L == 13) {                             // stone plinth: blocks, a moulded cap and base
    vec3 bl = blocks(Uf, Y, 1.6, 0.9, 0.5);
    c = vec3(0.55, 0.53, 0.5) * (0.8 + 0.3 * hash(bl.xy)) * (0.85 + 0.15 * vnoise(vec2(Uf, Y) * 3.0));
    if (bl.z < 0.04) c *= 0.55;
    if (T > 0.9 || T < 0.1) c *= 1.15;
#endif
#if LK_14
  } else if (L == 14) {                             // barrels: staves and iron hoops
    c = woodCol(Uf, Y, px, 0.35) * (0.7 + 0.3 * sin(fract(Uf / 0.35) * 3.1416));
    if (min(abs(T - 0.18), abs(T - 0.82)) < 0.035) c = vec3(0.22, 0.22, 0.24) * (1.0 + 0.3 * sin(Uf * 40.0));
#endif
#if LK_15
  } else if (L == 15) {                             // machinery: pipes, vents, hazard stripes, a glowing gauge
    c = vec3(0.2, 0.22, 0.24) * (0.8 + 0.2 * vnoise(vec2(Uf, Y) * 2.0));
    if (Y < 0.35) c = hazard(Uf * 1.5, Y * 1.5);
    float pipe = abs(fract(Uf / 1.4) - 0.5) * 1.4;
    if (pipe < 0.12 && T > 0.15) c = vec3(0.45, 0.42, 0.38) * (0.6 + 0.4 * (1.0 - pipe / 0.12));
    if (fract(Y * 6.0) < 0.15 && T > 0.75 && face != 2) c *= 0.4;
    if (face == 0 && length(vec2((U - 0.5) * W, Y - H * 0.6)) < 0.35) { c = vec3(0.1); gEmit = vec3(1.0, 0.55, 0.1) * (0.5 + 0.3 * sin(uTime * 2.0)); }
#endif
#if LK_16
  } else if (L == 16) {                             // wardrobe / dresser: drawers and brass knobs
    c = woodCol(Uf, Y, px, 1.6) * 0.95;
    if (face == 0) {
      float dr = fract(T * 4.0);
      if (dr * H / 4.0 < 0.04) c *= 0.4;
      if (min(abs(U - 0.3), abs(U - 0.7)) * W < 0.06 && abs(dr - 0.5) * H / 4.0 < 0.06) c = vec3(0.75, 0.6, 0.3);
      if (U * W < 0.08 || (1.0 - U) * W < 0.08) c *= 0.6;
    }
#endif
#if LK_17
  } else if (L == 17) {                             // glass display case: lit shelves
    c = vec3(0.1, 0.12, 0.14);
    if (T > 0.15 && T < 0.95 && fract(Uf / 2.0) > 0.03) {
      float sh = fract((T - 0.15) / 0.8 * 3.0), cell = fract(Uf / 0.7);
      vec3 item = hue3(hash(vec2(floor(Uf / 0.7), floor((T - 0.15) / 0.8 * 3.0)) + seed)) * 0.7;
      float it = step(0.3, cell) * step(cell, 0.65) * step(0.12, sh) * step(sh, 0.55);
      c = mix(vec3(0.09, 0.1, 0.12), item, it) + 0.06 * step(0.9, fract((Uf + Y) * 0.6));
      gEmit = vec3(0.06, 0.06, 0.07) + item * it * 0.25;
    }
#endif
#if LK_18
  } else if (L == 18) {                             // sandbags
    vec3 bl = blocks(Uf, Y, 1.4, 0.45, 0.5);
    vec2 f = vec2(fract(Uf / 1.4 + 0.5 * mod(bl.y, 2.0)) - 0.5, fract(Y / 0.45) - 0.5);
    c = vec3(0.62, 0.55, 0.4) * (0.55 + 0.6 * (1.0 - smoothstep(0.2, 0.6, length(f * vec2(1.0, 1.2))))) * (0.9 + 0.2 * hash(bl.xy));
#endif
#if LK_19
  } else if (L == 19) {                             // hay bales: straw and twine
    c = vec3(0.86, 0.72, 0.38) * (0.62 + 0.25 * vnoise(vec2(Uf * 40.0, Y * 7.0)) + 0.25 * vnoise(vec2(Uf * 9.0 + Y * 13.0, Y * 31.0)));
    if (min(abs(fract(Uf / 2.5) - 0.3), abs(fract(Uf / 2.5) - 0.7)) < 0.015) c = vec3(0.4, 0.3, 0.15);
#endif
#if LK_20
  } else if (L == 20) {                             // neon kiosk: a dark box outlined in neon, a lit window
    c = vec3(0.05, 0.05, 0.07);
    float e = face == 0 ? min(min(U * W, (1.0 - U) * W), min(Y, H - Y)) : min(Y, H - Y);
    if (e < 0.12) gEmit = sat * 1.4;
    if (face == 0 && T > 0.45 && T < 0.8 && U > 0.15 && U < 0.85) { c = vec3(0.08); gEmit = sat * 0.12 + vec3(0.03); }
#endif
#if LK_21
  } else if (L == 21) {                             // altar: carved stone, a glowing rune panel, candles on top
    vec3 bl = blocks(Uf, Y, 2.0, 1.0, 0.5);
    c = vec3(0.5, 0.47, 0.44) * (0.8 + 0.25 * hash(bl.xy)); if (bl.z < 0.04) c *= 0.6;
    if (face == 0 && U > 0.15 && U < 0.85 && T > 0.2 && T < 0.75) {
      c = vec3(0.3, 0.28, 0.26);
      if (abs(fract(U * 6.0 + T * 3.0) - 0.5) < 0.04 || abs(T - 0.47) * H < 0.03) gEmit = vec3(1.0, 0.75, 0.35) * 0.7;
    }
    if (face == 0 && T > 0.9 && abs(fract(U * 4.0) - 0.5) * W / 4.0 < 0.06) gEmit = vec3(1.0, 0.7, 0.3) * (1.0 + 0.2 * sin(uTime * 7.0 + U * 20.0));
#endif
#if LK_22
  } else if (L == 22) {                             // table: a thick top, legs at the corners, shadow underneath
    float x = face == 0 || face == 2 ? min(U, 1.0 - U) * W : min(Us, 1.0 - Us) * D;
    c = vec3(0.02);
    if (T > 0.82) c = woodCol(Uf, Y, px, 0.7) * 1.1;
    else if (x < 0.35) c = woodCol(Y, Uf, px, 0.35) * 0.8;
#endif
#if LK_23
  } else if (L == 23) {                             // bed: a wooden frame, a blanket draped over the top
    vec3 cloth = sat * 0.55 + 0.08;
    c = woodCol(Uf, Y, px, 0.5) * 0.85;
    float drape = face == 0 ? 0.55 : 0.35 + 0.05 * sin(Uf * 3.0);
    if (T > drape) c = cloth * (0.75 + 0.25 * sin(Uf * 2.2 + T * 4.0)) * (0.8 + 0.2 * T);
    if (face == 2) c = woodCol(Uf, Y, px, 0.4) * 0.9;   // the headboard
#endif
#if LK_24
  } else if (L == 24) {                             // hearth: stone, a fire in an arched opening, a wooden mantel
    vec3 bl = blocks(Uf, Y, 1.2, 0.7, 0.5);
    c = vec3(0.45, 0.42, 0.4) * (0.8 + 0.3 * hash(bl.xy)); if (bl.z < 0.04) c *= 0.55;
    if (face == 0) {
      vec2 q = vec2((U - 0.5) * W, Y);
      float hw = W * 0.25, top = H * 0.55;
      if (abs(q.x) < hw && (q.y < top - hw || length(vec2(q.x, q.y - (top - hw))) < hw)) {
        float fl = vnoise(vec2(q.x * 3.0, q.y * 2.0 - uTime * 3.0)) * (1.0 - q.y / top);
        c = vec3(0.02); gEmit = mix(vec3(0.8, 0.15, 0.02), vec3(1.4, 0.8, 0.25), fl) * smoothstep(0.1, 0.5, fl + 0.2);
      }
      if (T > 0.66 && T < 0.74) c = woodCol(Uf, Y, px, 1.0);
    }
#endif
#if LK_25
  } else if (L == 25) {                             // treasure chest: planks, iron bands, a gold lock
    c = woodCol(Y * 3.0, Uf, px, 0.45) * 0.95;
    if (abs(T - 0.55) * H < 0.05) c = vec3(0.15);
    float band = face == 0 || face == 2 ? min(abs(U - 0.18), abs(U - 0.82)) * W : min(abs(Us - 0.15), abs(Us - 0.85)) * D;
    if (band < 0.1) c = vec3(0.25, 0.24, 0.26) * (0.9 + 0.2 * sin(Y * 30.0));
    if (face == 0 && abs(U - 0.5) * W < 0.14 && T > 0.42 && T < 0.62) c = vec3(0.85, 0.65, 0.2);
#endif
#if LK_26
  } else if (L == 26) {                             // sofa: cushions, a back rest, fabric in the top's colour
    vec3 cloth = sat * 0.45 + 0.06;
    c = cloth * 0.8;
    if (face == 0) {
      if (T > 0.42 && T < 0.6) { c = cloth * (1.0 - 0.3 * step(abs(fract(U * 3.0) - 0.5), 0.0) ); if (abs(fract(U * 3.0)) * W / 3.0 < 0.04) c *= 0.5; }
      if (T >= 0.6) c = cloth * 0.65;
      if (T < 0.12) c = vec3(0.05);
    } else c = cloth * (0.7 + 0.2 * T);
#endif
#if LK_27
  } else if (L == 27) {                             // ATM: steel, a lit screen, keypad, card and cash slots
    c = vec3(0.5, 0.52, 0.55) * (0.8 + 0.2 * T);
    if (face == 0) {
      if (U > 0.2 && U < 0.8 && T > 0.56 && T < 0.78) { c = vec3(0.02); gEmit = vec3(0.15, 0.45, 1.0) * (0.6 + 0.1 * step(0.5, fract(T * 40.0))); }
      else if (U > 0.3 && U < 0.7 && T > 0.4 && T < 0.52) { c = vec3(0.2); if (fract(U * 12.0) < 0.6 && fract(T * 30.0) < 0.6) c = vec3(0.7); }
      else if (abs(U - 0.78) * W < 0.08 && abs(T - 0.46) * H < 0.03) gEmit = vec3(0.2, 1.0, 0.3);
      else if (U > 0.3 && U < 0.7 && abs(T - 0.32) * H < 0.03) c = vec3(0.02);
    }
#endif
#if LK_28
  } else if (L == 28) {                             // jukebox: a glowing arch, bubbling tubes, a speaker grille
    c = woodCol(Uf, Y, px, 0.6) * 0.6;
    if (face == 0) {
      vec2 q = vec2((U - 0.5) * 2.0, T);
      float arch = length(vec2(q.x, max(q.y - 0.6, 0.0) * 2.2));
      if (arch < 0.95 && arch > 0.8) gEmit = hue3(fract(uTime * 0.15 + q.y * 0.5 + seed)) * 0.7;
      else if (arch <= 0.8 && T > 0.45 && T < 0.75) { c = vec3(0.35, 0.25, 0.12); gEmit = vec3(0.9, 0.6, 0.25) * 0.15; }
      else if (arch <= 0.78 && T < 0.35 && fract(Y * 8.0) < 0.5) c = vec3(0.08);
    }
#endif
#if LK_29
  } else if (L == 29) {                             // reactor core: dark steel, pulsing rings of light, pipes
    c = vec3(0.12, 0.13, 0.15) * (0.8 + 0.2 * vnoise(vec2(Uf, Y) * 2.0));
    float ring = abs(fract(Y / 1.5) - 0.5) * 1.5;
    if (ring < 0.08) gEmit = mix(vec3(0.1, 0.9, 1.0), sat, 0.3) * (0.8 + 0.4 * sin(uTime * 3.0 - Y * 1.5));
    if (abs(fract(Uf / 2.0) - 0.5) * 2.0 < 0.1) c = vec3(0.3, 0.32, 0.35);
#endif
#if LK_30
  } else if (L == 30) {                             // stacked tyres
    float row = fract(Y / 0.8);
    c = vec3(0.05) * (1.0 + 0.6 * step(0.5, fract(Uf * 6.0 + floor(Y / 0.8) * 0.5)));
    if (row < 0.08 || row > 0.92) c = vec3(0.015);
#endif
#if LK_31
  } else if (L == 31) {                             // dumpster: green ribbed steel, a lid, rust
    c = vec3(0.12, 0.32, 0.18) * (0.75 + 0.25 * sin(Uf * 6.2831 / 1.2));
    c = mix(c, vec3(0.32, 0.16, 0.07), smoothstep(0.62, 0.8, fbm(vec2(Uf, Y) * 1.3 + seed * 9.0)) * 0.7);
    if (T > 0.88) c = vec3(0.08, 0.2, 0.11);
    if (abs(T - 0.88) * H < 0.04) c = vec3(0.03);
    if (Y < 0.35) c = vec3(0.03);
#endif
#if LK_32
  } else if (L == 32) {                             // car: paint, windows, wheels on the sides, lights at the ends
    vec3 paint = sat * 0.55 + 0.05;
    c = paint * (0.8 + 0.2 * T);
    if (T > 0.5 && T < 0.86) c = vec3(0.04, 0.06, 0.08) + vec3(0.1, 0.14, 0.18) * step(0.7, fract(Uf * 0.4 + T * 0.8));   // glass
    if (T < 0.08) c = vec3(0.02);
    if (face == 1) {
      float w1 = length(vec2((Us - 0.2) * D, Y - 1.1)), w2 = length(vec2((Us - 0.8) * D, Y - 1.1));
      float wd = min(w1, w2);
      if (wd < 1.15) c = wd < 0.55 ? vec3(0.45) : vec3(0.03);   // wheels: tyre and hub
    } else if (face == 0) {
      if (min(abs(U - 0.17), abs(U - 0.83)) * W < 0.35 && abs(T - 0.36) * H < 0.18) { c = vec3(0.8); gEmit = vec3(1.0, 0.95, 0.8) * 0.9; }
      if (abs(U - 0.5) * W < 1.0 && T > 0.15 && T < 0.32) c = vec3(0.05);
    } else if (min(abs(U - 0.15), abs(U - 0.85)) * W < 0.3 && abs(T - 0.38) * H < 0.15) gEmit = vec3(1.0, 0.08, 0.05) * 0.9;
#endif
#if LK_33
  } else if (L == 33) {                             // warehouse shelving: orange uprights, blue beams, boxes
    c = vec3(0.02);
    float up = face == 0 || face == 2 ? abs(fract(U * max(1.0, floor(W / 4.0 + 0.5))) - 0.5) : 0.5 - min(Us, 1.0 - Us);
    float lvl = fract(Y / 2.2);
    vec3 box = vec3(0.55, 0.4, 0.22) * (0.75 + 0.4 * hash(vec2(floor(Uf / 1.3), floor(Y / 2.2)) + seed));
    if (lvl > 0.1 && lvl < 0.75 && fract(Uf / 1.3) > 0.08) c = box * (0.85 + 0.15 * step(0.5, fract(Uf / 1.3 + lvl)));
    if (lvl < 0.1) c = vec3(0.1, 0.25, 0.6);
    if (up > 0.46) c = vec3(0.85, 0.42, 0.08);
#endif
#if LK_34
  } else if (L == 34) {                             // piano: black lacquer, the keys
    c = vec3(0.03) + vec3(0.12) * step(0.92, fract((Uf + Y) * 0.35));
    if (face == 0 && T > 0.58 && T < 0.68 && U > 0.06 && U < 0.94) {
      float k = fract(Uf / 0.08);
      c = k < 0.1 ? vec3(0.2) : vec3(0.9);
      float bk = fract(Uf / 0.08 / 7.0) * 7.0;
      if (T > 0.63 && (abs(bk - 1.0) < 0.3 || abs(bk - 2.0) < 0.3 || abs(bk - 4.0) < 0.3 || abs(bk - 5.0) < 0.3 || abs(bk - 6.0) < 0.3)) c = vec3(0.03);
    }
#endif
#if LK_35
  } else if (L == 35) {                             // market stall: a wooden counter, goods, a striped awning
    c = woodCol(Uf, Y, px, 0.5) * 0.85;
    if (T > 0.82) c = mod(floor(Uf / 0.8), 2.0) < 1.0 ? sat * 0.7 + 0.1 : vec3(0.85);
    else if (T > 0.5) {
      c = vec3(0.03);
      if (face == 0 && T < 0.62) c = hue3(hash(vec2(floor(Uf / 0.5), 3.0) + seed)) * 0.6 + 0.1;
      if (face == 0 && min(U, 1.0 - U) * W < 0.25) c = woodCol(Y, Uf, px, 0.25);
    }
#endif
#if LK_36
  } else if (L == 36) {                             // planter: brick, plants spilling over the top
    vec3 bl = blocks(Uf, Y, 0.75, 0.25, 0.5);
    c = vec3(0.5, 0.25, 0.18) * (0.8 + 0.3 * hash(bl.xy)); if (bl.z < 0.02) c = vec3(0.6, 0.57, 0.52);
    float leaf = vnoise(vec2(Uf * 3.0, Y * 3.0) + seed * 5.0);
    if (T > 0.75 - 0.25 * leaf) c = vec3(0.12, 0.35, 0.1) * (0.6 + 0.8 * vnoise(vec2(Uf * 9.0, Y * 9.0)));
#endif
#if LK_37
  } else if (L == 37) {                             // boulder: rough rock
    float n = fbm(vec2(Uf, Y) * 0.8 + seed * 7.0);
    c = vec3(0.42, 0.4, 0.37) * (0.55 + 0.6 * n) * (0.85 + 0.15 * sin(Y * 3.0 + Uf));
    if (abs(fbm(vec2(Uf, Y) * 1.7 + 3.0) - 0.5) < 0.02) c *= 0.5;
#endif
#if LK_38
  } else if (L == 38) {                             // ice: pale blue, cracks, a cold glow inside
    float n = fbm(vec2(Uf, Y) * 0.9 + seed * 3.0);
    c = vec3(0.55, 0.75, 0.9) * (0.55 + 0.5 * n);
    if (abs(fbm(vec2(Uf, Y) * 1.4 + 9.0) - 0.5) < 0.015) c = vec3(0.95);
    gEmit = vec3(0.2, 0.5, 0.7) * 0.18 * n;
#endif
#if LK_39
  } else if (L == 39) {                             // crystals: dark stone with glowing facets
    c = vec3(0.1, 0.09, 0.12);
    vec2 cell = floor(vec2(Uf, Y) * 1.4), f = fract(vec2(Uf, Y) * 1.4);
    float hc = hash(cell + seed);
    if (hc > 0.45 && f.y > abs(f.x - 0.5) * 1.6 && f.y < 0.95) {
      vec3 cc = mix(vec3(0.6, 0.2, 1.0), sat, 0.35);
      c = cc * 0.25; gEmit = cc * (0.35 + 0.5 * f.y) * (0.8 + 0.2 * sin(uTime * 2.0 + hc * 20.0));
    }
#endif
#if LK_40
  } else if (L == 40) {                             // cage / jail bars: bars over a dark inside
    c = vec3(0.015);
    if (abs(fract(Uf / 0.45) - 0.5) * 0.45 < 0.03 || min(min(abs(T - 0.04), abs(T - 0.5)), abs(T - 0.96)) * H < 0.05) c = vec3(0.32, 0.32, 0.34);
#endif
  }
  if (edgeU < 0.05) { c *= 0.35; gEmit *= 0.2; }   // the gap between two units
  return c;
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
      if (skip > 0.0) { tp = t; t += skip; if (t > tf) { vec3 q = o + d * tf; if (solidAt(q, tf)) { t = tf; hit = true; } break; } continue; }
      if (solidAt(p, t)) { hit = true; break; }
      tp = t; t += max(texel * 0.55, t * 0.0013);
      if (t > tf) { vec3 q = o + d * tf; if (solidAt(q, tf)) { t = tf; hit = true; } break; }
    }
  }
  vec3 col; float tHit = 1e12;
  if (hit) {
    float a = tp, b = t;
    for (int k = 0; k < 9; k++) { float m = 0.5 * (a + b); vec3 q = o + d * m; if (solidAt(q, m)) b = m; else a = m; }
    t = b;
  }
  bool isCeil = false, isRoof = false;   // a room's ceiling overhead, or (a token's eye view) a roof from above, nearer than the march's hit
  vec4 cP = vec4(0.0);
  if (uCeilN > 0) {
    int cw; float tc = ceilHit(o, d, true, cw);
    if (cw >= 0 && tc < (hit ? t : 1e12) && tc > 0.0) { hit = true; t = tc; cP = uCeilP[cw]; isRoof = cP.x + cP.y * o.x + cP.z * o.z < o.y; isCeil = !isRoof; }
  }
  if (hit) {
    tHit = t;
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
    // an overhang (bridge, roof, ceiling) rather than the ground under it: its top, its underside or its edge
    vec2 sl = slabAt(p.xz);
    bool onSlab = sl.y > sl.x && p.y > hb + 0.2 * uPpf && p.y > sl.x - 0.4 * uPpf;
    bool underSlab = !onSlab && sl.y > sl.x && p.y < sl.x;
    if (isCeil || isRoof) { onSlab = true; underSlab = false; }
    float slabG = !onSlab ? 0.0 : texelFetch(uCeil, ivec2(clamp(p.xz / uWorld * uHRes, vec2(0.0), uHRes - 1.0)), 0).g;   // (only on slabs: a fetch per pixel costs ~10%)
    bool lintel = onSlab && !isCeil && !isRoof && slabG > 0.3 && slabG < 0.75;   // the wall over a door
    int sf = 0;
    vec2 en = vec2(0.0);
    if (onSlab) {
      sf = isCeil ? 2 : isRoof ? 4 : (p.y > sl.y - 0.35 * uPpf && d.y < 0.0) ? 1 : (p.y < sl.x + 0.35 * uPpf && d.y > 0.0) ? 2 : 3;
      if (sf == 3) {   // which way its edge faces
        float ee = texel * 1.5;
        vec2 so = vec2((slabAt(p.xz + vec2(ee, 0.0)).y > -0.5 ? 1.0 : 0.0) - (slabAt(p.xz - vec2(ee, 0.0)).y > -0.5 ? 1.0 : 0.0),
                       (slabAt(p.xz + vec2(0.0, ee)).y > -0.5 ? 1.0 : 0.0) - (slabAt(p.xz - vec2(0.0, ee)).y > -0.5 ? 1.0 : 0.0));
        en = length(so) > 0.0 ? -normalize(so) : -normalize(d.xz + 1e-5);
      }
      side = sf != 1; cut = false; kd = 0;
    }
    // a wall face: take the top height of the column we hit for the trim/shading reference
    vec2 inward = length(g) > 1e-6 ? normalize(g) : vec2(0.0);
    if (side && !onSlab) { hb = max(hb, hAt(p.xz + inward * texel * 1.5)); kd = kindAt(p.xz + inward * texel * 1.0); }
    // per point: a raised area's look / front / region (rgb) and a region's own wall skin (a, 0 = the scene's)
    ivec4 pd = ivec4(texelFetch(uPropData, ivec2(clamp((p.xz + (side ? inward * texel : vec2(0.0))) / uWorld * uHRes, vec2(0.0), uHRes - 1.0)), 0) * 255.0 + 0.5);
    if (!(side && kd == 5)) pd.xyz = ivec3(0);
    int sk = pd.w > 0 ? pd.w - 1 : uSkin;
    vec3 emit = vec3(0.0);   // self-lit bits of props (screens, LEDs): added after the light
    vec2 n2 = length(g) > 1e-4 ? normalize(-g) : -normalize(d.xz + 1e-5);
    if (sf == 3) n2 = en;
    vec3 N = side ? vec3(n2.x, 0.0, n2.y) : vec3(0.0, 1.0, 0.0);
    if (sf == 2) N = isCeil ? normalize(vec3(cP.y, -1.0, cP.z)) : vec3(0.0, -1.0, 0.0);
    if (sf == 4) N = normalize(vec3(-cP.y, 1.0, -cP.z));
    float glow = 0.0; vec3 glowCol = uTrim;   // self-lit bits (glow trims, token rings): a dark mood doesn't dim them
    bool skinCeil = false;                     // a ceiling in the wall skin's material
    float pxFt = t * 2.0 * uTanX / uRes.x / uPpf / (side ? max(abs(dot(d, N)), 0.25) : max(abs(d.y), 0.25));
    wsSk = -1; wsMul = 1.0; wsDoor = false; int wsCase = 0;   // the wall-skin pattern this pixel wants (drawn once, below)
    if (!side) {
      col = underSlab ? textureLod(uFloor, uv, 4.5).rgb * 0.8 : texture(uFloor, uv).rgb;
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
      else if ((kd == 2 || kd == 3) && sk != 0) col = mix(skinTop(sk, p.xz, uv), col, 0.2);   // wall tops wear the skin
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
      // where a click would go: a pulsing ring on the floor
      if (uHoverCol.a > 0.5 && abs(p.y - uHover.w) < 1.5 * uPpf) {
        float hd = distance(p.xz, uHover.xy);
        if (abs(hd - uHover.z) < max(uHover.z * 0.08, 1.5 * texel) || (uHoverCol.a < 1.2 && hd < uHover.z * 0.18)) { glow = 1.0; glowCol = uHoverCol.rgb * (1.25 + 0.35 * sin(uTime * 6.0)); }
      }
    } else if (sf == 0) {   // (slabs' undersides, edges and roofs are drawn below)
      vec3 base = mix(vec3(0.20, 0.22, 0.25), textureLod(uFloor, uv, 3.0).rgb, 0.35);
      float rel = clamp(1.0 - (hb - p.y) / (30.0 * uPpf), 0.0, 1.0);
      float dt = (hb - p.y) / uPpf;
      float foot = (p.y - hAt(p.xz + n2 * texel * 3.0)) / uPpf;   // ft above the floor in front of this face
      float fu = dot(p.xz, vec2(-n2.y, n2.x)) / uPpf;               // ft along the face
      col = base * (0.45 + 0.55 * rel);
      if (kd == 1) {
        float strata = 0.8 + 0.2 * sin(p.y / (1.5 * uPpf) + (p.x + p.z) / (11.0 * uPpf)) + 0.08 * sin(p.y / (3.5 * uPpf) - (p.x - p.z) / (5.6 * uPpf));
        col = vec3(0.15, 0.17, 0.21) * (0.7 + 0.6 * vnoise(p.xz / (6.0 * uPpf))) * strata * (0.55 + 0.45 * rel);
      } else if (kd == 5 && pd.z > 0) {
        // a raised area that looks like something (Region Config > Vantage): front, sides and back drawn as it
        vec4 inf = texelFetch(uPropInfo, ivec2(pd.z - 1, 0), 0);
        float az = float(pd.y) / 256.0 * 6.2831853;
        float fd = dot(n2, vec2(sin(az), -cos(az)));
        int face = fd > 0.7 ? 0 : fd < -0.7 ? 2 : 1;
        float U = clamp((dot(p.xz, vec2(-cos(az), -sin(az))) - inf.x) / inf.y, 0.0, 1.0);
        float Hft = max(foot + dt, 0.5);
        vec3 tc = textureLod(uFloor, (p.xz + inward * texel * 3.0) / uWorld, 5.0).rgb;
        vec3 edge = textureLod(uFloor, (p.xz + inward * texel * 1.5) / uWorld, 1.0).rgb;
        vec4 dep = texelFetch(uPropInfo, ivec2(pd.z - 1, 2), 0);   // how deep it is, front to back
        float Us = clamp((dot(p.xz, vec2(sin(az), -cos(az))) - dep.x) / max(dep.y, 1.0), 0.0, 1.0);
        col = pd.x > 0 ? propFace(pd.x, face, U, fu, foot, Hft, inf.y / uPpf, Us, dep.y / uPpf, tc, edge, pxFt, inf.w) : mix(vec3(0.15, 0.17, 0.2), tc, 0.3) * (0.62 + 0.38 * rel);
        emit = pd.x > 0 ? gEmit : vec3(0.0);
        if (inf.z > 0.0 && face == 0) {   // its front picture: full height, its own width (centred), never wider than the front
          vec4 pr = texelFetch(uPropInfo, ivec2(pd.z - 1, 1), 0);
          float pw = min(1.0, Hft * inf.z / max(inf.y / uPpf, 0.1)), pu = (U - 0.5) / pw + 0.5;
          if (pu >= 0.0 && pu <= 1.0) {
            vec4 pic = texture(uPropPic, mix(pr.xy, pr.zw, vec2(pu, 1.0 - clamp(foot / Hft, 0.0, 1.0))));
            col = mix(col, pic.rgb, pic.a); emit *= 1.0 - pic.a;
          }
        }
        if (dt < 0.1) col = mix(col, textureLod(uFloor, uv, 1.0).rgb, 0.5);   // the top's lip
      } else if (kd == 5 && raisedSkin(sk) == 0) {
        // raised area (crate, console, dais): plain dark metal, a soft lighter lip at the top, no glow trim
        // the top's own colour tints the metal a little, darker toward the foot; panel seams every 2 ft and down the sides
        col = mix(vec3(0.15, 0.17, 0.20), textureLod(uFloor, uv, 6.5).rgb, 0.3) * (0.62 + 0.38 * rel);
        if (dt < 0.12) col = mix(col, textureLod(uFloor, uv, 1.0).rgb, 0.6) * 1.35;
        if (abs(mod(p.y / uPpf, 2.0) - 1.0) > 0.95) col *= 0.72;
        if (abs(mod(fu, 3.0) - 1.5) > 1.44) col *= 0.8;
      } else if (kd == 5) {
        // raised areas in a skinned scene are built of the same material, with the top's art showing at the lip
        wsSk = raisedSkin(sk); wsU = fu; wsY = p.y / uPpf; wsDt = dt; wsFt = foot; wsN = n2; wsMul = 0.62 + 0.38 * rel; wsCase = 1;   // (its lip: below)
      } else if (kd == 6) {
        // height-map terrain: the map art carries down the slope
        col = texture(uFloor, uv).rgb * (0.6 + 0.4 * rel);
      } else if (kd == 4) {
        // stair risers: plain metal with a thin glowing nosing on every step
        col = base * (0.75 + 0.25 * rel);
        if (dt < 0.14) { glow = 1.0; glowCol = uTrim * 0.85; }
      } else if ((kd == 3 || kd == 2) && uHoverCol.a > 1.5 && distance(p.xz, uHover.xy) < uHover.z && p.y < uHover.w + 10.5 * uPpf) {
        // the door under the mouse lights up
        col = mix(base, uHoverCol.rgb, 0.45); glow = 0.35; glowCol = uHoverCol.rgb;
      } else if (sk == 0) {
        // neon panels: dark metal, panel seams, a glowing trim strip under the top, doors tinted teal
        bool seam = abs(mod(p.y / uPpf, 4.0) - 2.0) > 1.85 || abs(mod(fu, 5.0) - 2.5) > 2.42;
        if (seam) col *= 0.45;
        if (kd == 3) col = mix(col, vec3(0.12, 0.45, 0.55), 0.6);
        if (dt > 0.6 && dt < 1.1) glow = 1.0;
      } else {
        wsSk = sk; wsU = fu; wsY = p.y / uPpf; wsDt = dt; wsFt = foot; wsN = n2; wsDoor = kd == 3; wsMul = 0.55 + 0.45 * rel; wsCase = 2;
      }
    }
    if (sf == 2) {   // the underside of a deck, or a ceiling (rooms', and a higher level's floor): those wear the wall skin
      glow = 0.0; emit = vec3(0.0);
      ivec2 cij = ivec2(clamp(p.xz / uWorld * uHRes, vec2(0.0), uHRes - 1.0));
      if (lintel) col = skinTop(sk, p.xz, uv) * 0.5;   // under the wall over a door
      else if (isCeil || texelFetch(uCeil, cij, 0).g > 0.75) {
        skinCeil = true;
        col = ceilSkin(sk, p.xz, uv, pxFt, glow, glowCol); emit += gEmit; if (wsSk >= 0) wsCase = 4;   // (finished below)
      } else col = textureLod(uFloor, uv, 6.0).rgb * 0.3 + vec3(0.045, 0.04, 0.035);
    }
    else if (sf == 3 && lintel) {   // the wall over a door: the wall's own skin, its trim lined up with the wall's
      float fu2 = dot(p.xz, vec2(-en.y, en.x)) / uPpf, dt2 = (sl.y - p.y) / uPpf, ft2 = (p.y - hAt(p.xz + en * texel * 3.0)) / uPpf;
      glow = 0.0; emit = vec3(0.0);
      if (sk == 0) {
        col = mix(vec3(0.20, 0.22, 0.25), textureLod(uFloor, uv, 3.0).rgb, 0.35);
        if (abs(mod(p.y / uPpf, 4.0) - 2.0) > 1.85 || abs(mod(fu2, 5.0) - 2.5) > 2.42) col *= 0.45;
        if (dt2 > 0.6 && dt2 < 1.1) glow = 1.0;
      } else { wsSk = sk; wsU = fu2; wsY = p.y / uPpf; wsDt = dt2; wsFt = ft2; wsN = en; wsMul = 0.95; wsCase = 3; }
    }
    else if (sf == 3) { col = textureLod(uFloor, uv, 2.0).rgb * 0.55; glow = 0.0; emit = vec3(0.0); }      // its edge
    else if (sf == 4) {   // a roof seen from above
      int mo = int(texelFetch(uCeil, ivec2(clamp(p.xz / uWorld * uHRes, vec2(0.0), uHRes - 1.0)), 0).b * 255.0 + 0.5) - 1;
      col = roofSkin(sk, p.xz, uv, pxFt, cP.yz, mo >= 0 ? mo : uRoofMat); glow = 0.0; emit = vec3(0.0);
    }
    // the wall-skin pattern asked for above (a wall, a raised area, the wall over a door, a ceiling): drawn here, once
#if HAS_SKINS
    if (wsSk >= 0) {
      col = wallSkin(wsSk, wsU, wsY, wsDt, wsFt, uv, p.xz, wsN, wsDoor, pxFt) * wsMul; emit += gEmit;
      if (wsCase == 1 && wsDt < 0.12) col = mix(col, textureLod(uFloor, uv, 1.0).rgb, 0.6) * 1.2;   // a raised area's lip
      if (wsCase == 4) col = ceilPost(sk, p.xz / uPpf, col);
    }
#endif
    if (skinCeil) {   // a ceiling in the wall skin's material
      if (glow > 0.0) { emit += glowCol * glow * 1.1; col *= 0.4; glow = 0.0; }   // light strips shine in any light
      float nw = 0.0;   // darker where it meets a wall
      for (int q = 0; q < 8; q++) {
        float an = float(q) * 0.785398, rr = (q < 4 ? 0.7 : 1.6) * uPpf;
        nw += step(p.y - 0.8 * uPpf, hAt(p.xz + vec2(cos(an), sin(an)) * rr)) * (q < 4 ? 0.6 : 0.4);
      }
      col *= 1.0 - 0.14 * nw;
    }
    // light: "automatic" keeps the map's own light (walls shaded by a fixed key); a mood tints it, adds a sun (or moon)
    // with shadows, and scales the scene's lights
    float keyT = clamp(dot(N.xz, normalize(vec3(0.35, 0.8, -0.45)).xz), 0.0, 1.0);
    vec3 alb;
    if (uMood < 0.5) {
      col = mix(col, glowCol, glow);
      if (side) col *= sf == 4 ? 0.75 + 0.25 * clamp(N.y, 0.0, 1.0) : 0.5 + 0.5 * keyT;
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
    if (skinCeil) col += alb * textureLod(uFloor, uv, 7.5).rgb * (uMood > 0.5 ? 0.5 * clamp(dot(uAmb, vec3(0.33)) + 0.25 * uLightK, 0.12, 1.0) : 0.45);   // light bounced off the floor
    if (uWx > 0 || uWxFlash > 0.0) {
      float outd = p.y >= shelterAt(p.xz) - 0.5 * uPpf && !isCeil ? 1.0 : 0.0;   // under the open sky (not under a higher floor or a dry region)
      if (!side && !cut && outd > 0.0) {
        if (uWx == 1) {
          // wet ground: darker, with rain rings spreading in puddles (faded out where a pixel covers too much floor)
          col *= 0.8;
          vec2 q = p.xz / (1.3 * uPpf), ci = floor(q), f = fract(q) - 0.5;
          float hh = hash(ci), ph = fract(uTime * 1.1 + hh);
          float rr = length(f - (vec2(hash(ci + 3.1), hash(ci + 7.7)) - 0.5) * 0.5);
          float ring = (1.0 - smoothstep(0.0, 0.06, abs(rr - ph * 0.45))) * (1.0 - ph) * step(0.35, hh) * clamp(1.0 - pxFt * 5.0, 0.0, 1.0);
          col += ring * (uMood > 0.5 ? uAmb + uSunCol * 0.3 : vec3(0.35)) * 0.35;
        } else if (uWx == 2) col = mix(col, vec3(0.88, 0.90, 0.95) * (uMood > 0.5 ? max(uAmb + uSunCol * 0.5, vec3(0.3)) : vec3(0.85)), 0.2);
      }
      col += alb * uWxFlash * vec3(0.75, 0.8, 1.0) * (side ? 0.55 : 1.0) * mix(0.2, 1.0, outd);
    }
    if (uMood > 0.5) col = mix(col, glowCol * uTrimK, glow);
    col += emit * (uMood > 0.5 ? max(uTrimK, 1.0) : 1.0);
    if (uTplN > 0 && !isCeil) {   // spell templates: a tint over the area, a glowing edge
      vec2 tp = tplAt(p.xz, pxFt * uPpf);
      if (tp.x > 0.0) col = mix(col, tplCol * max(dot(col, vec3(0.33)) * 1.8, 0.4), 0.45) + tplCol * tp.y * 1.2;
    }
    if (uAO > 0.0 && !cut && !onSlab) col *= mix(1.0, side ? aoSide(p, n2, texel) : aoFloor(p, t), uAO * 0.85);
    if (underSlab) col *= 0.6;   // the shade under a bridge or roof
    float fog = 1.0 - exp(-max(t - uFogStart * uPpf, 0.0) / (uFogFt * uPpf));
    col = mix(col, uFogCol, fog);
    if (uVisOn > 0.5) {   // fog of war: out of sight is dark; explored places stay as a dim grey memory
      vec2 vm = texture(uVis, (p.xz + (side ? -n2 * texel * 2.0 : vec2(0.0))) / uWorld).rg;
      float sn = smoothstep(0.15, 0.6, vm.r), ex = smoothstep(0.15, 0.6, vm.g);
      col = mix(vec3(dot(col, vec3(0.3, 0.5, 0.2))) * 0.28 * ex, col, sn);
    }
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
  if (!hit) col += uWxFlash * vec3(0.55, 0.6, 0.75);
  // standees, sorted far -> near on the CPU
  float tOcc = tHit;   // what hides weather behind it: the scene, or a figure in front of it
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
    if (al > 0.5) tOcc = min(tOcc, ts);
  }
  // weather: ground mist, then rain / snow / embers... lit where they fall (the mood's sky, the map's own light, lamps, lightning)
  if (uWxMist > 0.0) col = mix(col, uWxMistCol, mistAmt(o, d, tOcc) * 0.85);
  if (uWx > 0) {
    wxPos = vec3(0.0); wxEm = vec3(0.0); wxSum = 0.0; wxOcc = tOcc;
    vec3 b0 = (vec3(0.0, uMinH - 2.0 * uPpf, 0.0) - o) * inv, b1 = (vec3(uWorld.x, uWxTop, uWorld.y) - o) * inv;
    vec3 bn = min(b0, b1), bx = max(b0, b1);
    float tin = max(max(max(bn.x, bn.y), bn.z), 0.3 * uPpf), tout = min(min(min(bx.x, bx.y), bx.z), tOcc);
    if (tout > tin) {
      float cs = uWxQ.x, a1 = tin + 12.0 * cs, a2 = a1 + 30.0 * cs, a3 = a2 + 80.0 * cs;
      // near, middle and far layers (bigger cells further out; the far ones lighter, so a distant shower doesn't hide the map)
      vec4 wa = wxOctave(o, d, dd, tin, min(tout, a1), cs, 0.0, 1.0, 1.0, vec4(0.0));
      wa = wxOctave(o, d, dd, a1, min(tout, a2), cs * 2.7, 17.0, 1.8, 0.7, wa);
      wa = wxOctave(o, d, dd, a2, min(tout, a3), cs * 7.0, 41.0, 3.2, 0.45, wa);
      vec3 lit = vec3(0.0);
      if (wxSum > 0.0) {
        vec3 P = wxPos / wxSum;
        lit = uMood > 0.5 ? uAmb * 1.1 + uSunCol * 0.45 : vec3(0.16) + textureLod(uFloor, P.xz / uWorld, 5.0).rgb * 1.1;
        vec3 la = vec3(0.0);
        for (int l = 0; l < ${MAX_LIGHTS}; l++) { if (l >= uNL) break; float dl = length(uLPos[l].xyz - P); la += pow(clamp(1.0 - dl / uLPos[l].w, 0.0, 1.0), 2.0) * uLCol[l].w * uLCol[l].rgb; }
        lit += min(la, vec3(1.5)) * 0.3 * uLightK + uWxFlash * vec3(0.9, 0.95, 1.1);   // lamps catch the drops
      }
      col = col * (1.0 - wa.a) + wa.rgb * lit + wxEm;
    }
  }
  // round templates rise as a dome (a sphere of effect): a faint shell, brighter at its rim
  for (int i = 0; i < 16; i++) {
    if (i >= uTplN) break;
    vec4 a = texelFetch(uTpl, ivec2(i, 0), 0);
    if (int(a.w + 0.5) != 1) continue;
    vec4 b = texelFetch(uTpl, ivec2(i, 1), 0);
    vec3 C = vec3(a.x, b.z, a.y), oc = o - C; float R = a.z, bb = dot(oc, d), h = bb * bb - (dot(oc, oc) - R * R);
    if (h <= 0.0) continue;
    float sq = sqrt(h), t1 = -bb - sq, t2 = -bb + sq;
    for (int k = 0; k < 2; k++) {   // the near and far side of the shell
      float ts = k == 0 ? t1 : t2;
      if (ts <= 0.0 || ts >= tOcc) continue;
      vec3 P = o + d * ts; if (P.y < C.y) continue;
      float fr = pow(1.0 - abs(dot((P - C) / R, d)), 3.0);
      col += texelFetch(uTpl, ivec2(i, 2), 0).rgb * (0.05 + 0.45 * fr) * (k == 0 ? 1.0 : 0.6);
    }
  }
  // cover lines: from the picked token to its targets, coloured by the cover (dashes run toward the target)
  for (int i = 0; i < 4; i++) {
    if (i >= uBeamN) break;
    vec3 A = uBeamA[i].xyz, sd = uBeamB[i].xyz - A; float L = length(sd); if (L < 1.0) continue; sd /= L;
    vec3 w0 = o - A; float bq = dot(d, sd), dw = dot(d, w0), e = dot(sd, w0);
    float u = clamp(e + bq * (bq * e - dw) / max(1.0 - bq * bq, 1e-4), 0.0, L), s = bq * u - dw;
    if (s <= 0.0 || s >= tOcc) continue;
    float dist = length(w0 + d * s - sd * u), rw = max(0.06 * uPpf, s * 2.0 * uTanX / uRes.x * 2.2);   // at least ~2 px wide
    float dash = step(0.45, fract(u / (1.2 * uPpf) - uTime * 1.5));
    float core = 1.0 - smoothstep(rw * 0.35, rw, dist), halo = 1.0 - smoothstep(0.0, rw * 3.5, dist);   // a bright core in a soft glow
    col += uBeamC[i].rgb * (core * (0.55 + 0.45 * dash) * 1.2 + halo * 0.3) * smoothstep(2.0 * uPpf, 6.0 * uPpf, u);   // fades in past the attacker's own head
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

// shaders: started without waiting (the big scene shader compiles in the background where the GPU allows it, so the page
// never freezes while a driver works on it), then finished: checked and its uniforms looked up
function startCompile(gl, vs, fs) {
  const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram(), v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, "aPos"); gl.linkProgram(p);
  return {p, v, f};
}
function finishCompile(gl, {p, v, f}) {
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    for (const s of [v, f]) if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Vantage shader: " + gl.getShaderInfoLog(s));
    throw new Error("Vantage link: " + gl.getProgramInfoLog(p));
  }
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, info.name); }
  return {p, u};
}
const compile = (gl, vs, fs) => finishCompile(gl, startCompile(gl, vs, fs));

/** haze colour: deep teal by default, pulled toward the map's own average colour (more of it in daylight) */
export function fogColour(day = 0, mean = null) {
  const n = [0.03, 0.09, 0.11];
  if (!mean) return n;
  const k = 0.35 + 0.5 * Math.max(0, Math.min(1, day)), lift = 0.75 + 0.45 * Math.max(0, Math.min(1, day));
  return n.map((v, i) => v + (Math.min(0.75, mean[i] * lift) - v) * k);
}

/** wall skins, in shader order (Settings > Wall skin, Scene Config > Vantage) */
export const WALL_SKINS = ["neon", "concrete", "brick", "stone", "rock", "wood", "timber", "steel", "scrap", "marble", "hedge", "sandstone", "map",
  "glass", "tile", "graffiti", "cinder", "wallpaper", "panel", "plywood", "neonbrick", "padded", "ledwall", "clinic", "container", "chrome",
  "carbon", "holo", "pipes", "rust", "biotech", "hex", "sigil", "shoji", "ruins", "dwarven", "elven", "crystal", "cryo", "server",
  "forcefield", "hangar", "artdeco", "reactor", "viewport"];
// the skins a wall skin also draws with: its raised areas' and its ceiling's patterns (as raisedSkin / ceilSkin in the shader)
export function skinDeps(i) {
  const raised = [1, 7, 8, 13, 15, 18, 20, 22, 23, 26, 27, 28, 31].includes(i) || (i >= 38 && i !== 42) ? 0 : [6, 17, 33].includes(i) ? 5 : [10, 32].includes(i) ? 3 : i === 37 ? 4 : i;
  const ceil = [15, 20].includes(i) ? 1 : [7, 40, 41].includes(i) ? 7 : i === 44 ? 18 : [0, 12, 13, 14, 16, 23, 17, 22, 39, 5, 19, 6].includes(i) ? 0 : i;
  return [i, raised, ceil];
}
// what a roof can be covered with (Scene / Region Config); empty = what suits the walls
export const ROOF_MATS = ["metal", "tiles", "slate", "shingles", "thatch", "corrugated"];

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
  blood:    {keep: 0.45, amb: [0.42, 0.15, 0.13], sun: [0.75, 0.14, 0.08], el: 30, az: 300, sky: [[0.06, 0.0, 0.0], [0.42, 0.06, 0.04]], fog: [0.22, 0.03, 0.03], fogK: 0.7, lightK: 1.3, sat: 1.0, bloom: 1.3},
  fey:      {keep: 0.5, amb: [0.42, 0.32, 0.56], sun: [0.78, 0.46, 1.05], el: 22, az: 300, sky: [[0.12, 0.05, 0.26], [0.78, 0.46, 0.88]], fog: [0.36, 0.22, 0.46], fogK: 0.7, lightK: 1.4, sat: 1.15, bloom: 1.6, trimK: 1.2},
  infernal: {keep: 0.5, amb: [0.40, 0.18, 0.10], sun: [1.20, 0.45, 0.12], el: 18, az: 200, sky: [[0.10, 0.02, 0.0], [0.80, 0.25, 0.05]], fog: [0.30, 0.08, 0.02], fogK: 0.6, lightK: 1.5, sat: 1.1, bloom: 1.6},
  eldritch: {keep: 0.6, amb: [0.18, 0.32, 0.34], sun: [0.25, 0.75, 0.65], el: 40, az: 60, sky: [[0.0, 0.05, 0.06], [0.10, 0.35, 0.32]], fog: [0.05, 0.20, 0.20], fogK: 0.55, lightK: 1.6, sat: 0.95, bloom: 1.4},
  frost:    {keep: 0, amb: [0.62, 0.70, 0.80], sun: [0.65, 0.75, 0.95], el: 12, az: 110, sky: [[0.35, 0.50, 0.75], [0.85, 0.88, 0.95]], fog: [0.70, 0.76, 0.86], fogK: 0.9, lightK: 0.8, sat: 0.8, bloom: 1.0},
  storm:     {keep: 0.3, amb: [0.40, 0.44, 0.50], sun: [0, 0, 0], el: 60, az: 0, sky: [[0.10, 0.12, 0.15], [0.32, 0.36, 0.42]], fog: [0.26, 0.30, 0.35], fogK: 0.5, lightK: 1.3, sat: 0.62, bloom: 0.9},
  desert:    {keep: 0, amb: [0.72, 0.60, 0.44], sun: [0.85, 0.66, 0.38], el: 50, az: 150, sky: [[0.62, 0.50, 0.32], [0.88, 0.72, 0.48]], fog: [0.74, 0.58, 0.38], fogK: 0.5, lightK: 0.6, sat: 0.9, bloom: 0.9},
  deep:      {keep: 0.5, amb: [0.10, 0.28, 0.54], sun: [0.16, 0.42, 0.78], el: 78, az: 0, sky: [[0.01, 0.10, 0.30], [0.04, 0.24, 0.46]], fog: [0.02, 0.14, 0.34], fogK: 0.4, lightK: 1.6, sat: 0.9, bloom: 1.3},
  aurora:    {keep: 0.55, amb: [0.28, 0.38, 0.36], sun: [0.32, 0.85, 0.42], el: 35, az: 20, sky: [[0.20, 0.06, 0.34], [0.22, 0.82, 0.48]], fog: [0.14, 0.26, 0.20], fogK: 0.8, lightK: 1.6, sat: 1.15, bloom: 1.5},
  holy:      {keep: 0.2, amb: [0.84, 0.80, 0.68], sun: [0.95, 0.86, 0.56], el: 72, az: 180, sky: [[0.78, 0.74, 0.56], [1.00, 0.95, 0.80]], fog: [0.92, 0.88, 0.74], fogK: 0.8, lightK: 0.9, sat: 0.95, bloom: 1.7},
  shadow:    {keep: 0.25, amb: [0.28, 0.27, 0.32], sun: [0.24, 0.23, 0.32], el: 40, az: 300, sky: [[0.05, 0.05, 0.07], [0.20, 0.19, 0.24]], fog: [0.16, 0.15, 0.20], fogK: 0.55, lightK: 1.2, sat: 0.35, bloom: 0.9},
  synthwave: {keep: 0.6, amb: [0.50, 0.30, 0.50], sun: [1.15, 0.42, 0.55], el: 7, az: 270, sky: [[0.16, 0.03, 0.32], [1.00, 0.38, 0.36]], fog: [0.45, 0.16, 0.36], fogK: 0.9, lightK: 1.8, sat: 1.25, bloom: 1.7, trimK: 1.3},
  alert:     {keep: 0.6, amb: [0.42, 0.10, 0.10], sun: [0, 0, 0], el: 60, az: 0, sky: [[0.05, 0.0, 0.0], [0.24, 0.02, 0.02]], fog: [0.18, 0.02, 0.02], fogK: 0.7, lightK: 2.2, sat: 1.1, bloom: 1.5, trimK: 1.2},
  // "Day cycle": follows the scene's darkness (Foundry's darkness slider or the window's time slider): noon -> golden hour ->
  // dusk -> night under the moon
  daycycle: {cycle: true},
  // "Custom colour": a neutral moonlit look that takes the scene's Light colour (purple until one is picked)
  custom:   {keep: 0.45, amb: [0.46, 0.46, 0.46], sun: [0.62, 0.62, 0.62], el: 32, az: 135, sky: [[0.06, 0.06, 0.06], [0.42, 0.42, 0.42]], fog: [0.26, 0.26, 0.26], fogK: 0.75, lightK: 1.4, sat: 1.1, bloom: 1.4}
};
const CUSTOM_TINT = [0.61, 0.36, 1.0];   // #9b5cff
// the day cycle's stops by darkness (twilight: the sun has set, the moon is not up yet)
const TWILIGHT = {keep: 0.45, amb: [0.30, 0.30, 0.45], sun: [0, 0, 0], el: 5, az: 275, sky: [[0.03, 0.04, 0.12], [0.30, 0.20, 0.32]], fog: [0.14, 0.12, 0.22], fogK: 0.95, lightK: 1.6, sat: 0.85, bloom: 1.3};
const CYCLE = [[0, "noon"], [0.3, "golden"], [0.55, "dusk"], [0.72, TWILIGHT], [1, "moon"]];
const lerpA = (a, b, k) => Array.isArray(a) ? a.map((v, i) => lerpA(v, b[i], k)) : a + (b - a) * k;
/** the day cycle at a darkness (0 = noon, 1 = night): neighbouring stops blended; the sun or moon keeps its direction while
 *  it fades (it does not swing across the sky) */
export function cycleMood(dark = 0) {
  const x = Math.max(0, Math.min(1, Number(dark) || 0));
  let i = 0; while (i < CYCLE.length - 2 && x > CYCLE[i + 1][0]) i++;
  const [x0, a0] = CYCLE[i], [x1, b0] = CYCLE[i + 1], k = (x - x0) / (x1 - x0 || 1);
  const a = typeof a0 === "string" ? MOODS[a0] : a0, b = typeof b0 === "string" ? MOODS[b0] : b0;
  const out = {};
  for (const key of ["keep", "amb", "sun", "sky", "fog", "fogK", "lightK", "sat", "bloom"]) out[key] = lerpA(a[key], b[key], k);
  out.trimK = lerpA(a.trimK ?? 1, b.trimK ?? 1, k);
  const dark0 = a.sun.every(v => v === 0), dark1 = b.sun.every(v => v === 0);
  const src = dark0 ? b : dark1 ? a : null;
  if (src) { out.el = src.el; out.az = src.az; }
  else { out.el = lerpA(a.el, b.el, k); let d = ((b.az - a.az + 540) % 360) - 180; out.az = (a.az + d * k + 360) % 360; }
  return out;
}
const lum = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
/**
 * the mood actually drawn: a Light colour (tint, [r,g,b] 0..1) recolours its sun or moon, sky and haze and leans its
 * ambient light that way, keeping each one's brightness. With "automatic" a colour switches to the custom mood.
 */
export function moodOf(mood, tint = null, dark = 0) {
  let M = MOODS[mood] ?? null;
  if (M?.cycle) M = cycleMood(dark);
  if (!M && tint) M = MOODS.custom;
  if (!M) return null;
  if (!tint && M === MOODS.custom) tint = CUSTOM_TINT;
  if (!tint) return M;
  const L = Math.max(lum(tint), 0.12);
  const as = (c, cap) => tint.map(t => Math.min(cap, t / L * lum(c)));
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  return {...M, sun: as(M.sun, 2), amb: mix(M.amb, as(M.amb, 1), 0.5),
    sky: [mix(M.sky[0], as(M.sky[0], 1), 0.75), mix(M.sky[1], as(M.sky[1], 1), 0.75)], fog: mix(M.fog, as(M.fog, 1), 0.7)};
}
/** direction toward the sun for a mood (az: compass degrees, overrides the mood's own) */
export function sunDirection(mood, az = null, tint = null, dark = 0) {
  const M = moodOf(mood, tint, dark); if (!M) return [0, 1, 0];
  const a = (Number.isFinite(az) ? az : M.az) * Math.PI / 180, e = M.el * Math.PI / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/**
 * weather (Scene Config > Vantage, or the scene's own Foundry weather): k = particle kind (see the shader), vel ft/s,
 * dens = share of cells holding a particle, streak = motion blur (s), size ft, cell ft, wobble ft, low = only this many ft
 * over the floor; fogK = haze distance x, mist = ground mist, sun / amb = how much of a mood's sun / ambient gets through
 */
export const WEATHER = {
  none: null,
  rain:      {k: 1, vel: [-3, -30, 1.5], dens: 0.55, streak: 1 / 30, size: 0.024, alpha: 0.42, col: [0.75, 0.80, 0.90], cell: 2.2, fogK: 0.75, mist: 0.15, sun: 0.55, amb: 0.9},
  storm:     {k: 1, vel: [-10, -36, 4], dens: 0.8, streak: 1 / 30, size: 0.028, alpha: 0.5, col: [0.72, 0.78, 0.88], cell: 2.0, fogK: 0.5, mist: 0.3, sun: 0.3, amb: 0.75, lightning: true},
  snow:      {k: 2, vel: [-1.2, -3.2, 0.6], dens: 0.55, size: 0.08, alpha: 0.9, col: [0.95, 0.96, 1.0], cell: 2.6, wobble: 0.45, fogK: 0.7, mist: 0.2, sun: 0.8, amb: 1.0},
  blizzard:  {k: 2, vel: [-16, -5, 7], dens: 0.85, streak: 1 / 40, size: 0.07, alpha: 0.85, col: [0.93, 0.95, 1.0], cell: 2.2, wobble: 0.35, fogK: 0.3, mist: 0.6, sun: 0.5, amb: 1.0},
  fog:       {k: 0, fogK: 0.3, mist: 1.2, sun: 0.6, amb: 1.0},
  ash:       {k: 3, vel: [-0.8, -1.6, 0.3], dens: 0.4, size: 0.06, alpha: 0.8, col: [0.45, 0.43, 0.41], cell: 3, wobble: 0.5, fogK: 0.65, mist: 0.25, sun: 0.7, amb: 0.95},
  embers:    {k: 4, vel: [0.8, 2.4, -0.4], dens: 0.3, size: 0.06, alpha: 1, col: [1.7, 0.55, 0.12], cell: 4, wobble: 0.7, emissive: true},
  leaves:    {k: 5, vel: [-2.5, -2.2, 1.0], dens: 0.16, size: 0.2, alpha: 0.95, col: [0.7, 0.32, 0.08], cell: 5, wobble: 0.9},
  fireflies: {k: 6, vel: [0, 0, 0], dens: 0.4, size: 0.08, alpha: 1, col: [1.4, 1.7, 0.45], cell: 4, wobble: 0.75, low: 8, emissive: true},
  sand:      {k: 7, vel: [-28, -1.5, 10], dens: 0.6, streak: 1 / 32, size: 0.03, alpha: 0.35, col: [0.86, 0.70, 0.46], cell: 2.2, fogK: 0.3, mist: 0.5, mistCol: [0.78, 0.62, 0.40], sun: 0.7, amb: 1.0}
};
/** a mood seen through the weather: storms and fog dim the sun and grey the colours a little */
function weathered(M, Wx) {
  if (!M || !Wx || (Wx.sun ?? 1) === 1 && (Wx.amb ?? 1) === 1) return M;
  return {...M, sun: M.sun.map(v => v * (Wx.sun ?? 1)), amb: M.amb.map(v => v * (Wx.amb ?? 1)), sat: M.sat * (0.85 + 0.15 * (Wx.sun ?? 1))};
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
    const budget = Math.max(120, gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 80);   // the rest: camera, mood, weather, cover lines...
    this.NL = Math.min(48, Math.floor(budget * 0.25 / 2));
    this.NS = Math.min(48, Math.floor((budget - this.NL * 2) / 5));
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");
    // the scene shader comes in variants with just the wall skins and looks a scene uses (see need()); compiled in the
    // background, and drawn with the last finished one until the one wanted is ready
    this.variants = []; this.scene = null; this.sceneSkins = null; this._want = null; this.onReady = null;
    this.bright = compile(gl, VS, BRIGHT_FS);
    this.blur = compile(gl, VS, BLUR_FS);
    this.comp = compile(gl, VS, COMP_FS);
    this.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.rts = {}; this.tex = {};
  }

  /**
   * the wall skins and raised-area looks the scene shader must have (WALL_SKINS / PROP_LOOKS indices; full = all of them):
   * starts compiling a shader with them in the background, unless one that has them all is there already
   */
  need({skins = [], looks = [], full = false} = {}) {
    const S = full ? null : [...new Set(skins.flatMap(skinDeps))].filter(i => i > 0).sort((a, b) => a - b);
    const Lk = full ? null : [...new Set(looks)].filter(i => i > 0).sort((a, b) => a - b);
    const has = (have, want) => have === null || (want !== null && want.every(i => have.includes(i)));
    const ok = this.variants.filter(v => has(v.skins, S) && has(v.looks, Lk));
    let v = ok.find(x => x.prog) ?? ok[0];
    if (!v) {
      v = {skins: S, looks: Lk, pending: startCompile(this.gl, VS, SCENE_FS(this.NL, this.NS, S, Lk)), prog: null};
      this.variants.push(v);
    }
    this._want = v; this._watch();
    return v;
  }
  /** a shader to draw with is there (the one wanted, or the last finished one meanwhile); throws if the wanted one failed */
  _sceneReady() {
    const gl = this.gl, w = this._want;
    if (w && !w.prog && w.pending && (!this.parallel || gl.getProgramParameter(w.pending.p, this.parallel.COMPLETION_STATUS_KHR))) {
      const P = w.pending; w.pending = null;
      try { w.prog = finishCompile(gl, P); }
      catch (e) { this.variants = this.variants.filter(x => x !== w); this._want = null; gl.deleteProgram(P.p); throw e; }
      // keep the newest few
      for (const x of this.variants.filter(x => x !== w && x.prog).slice(0, -2)) { gl.deleteProgram(x.prog.p); this.variants = this.variants.filter(y => y !== x); }
    }
    if (w?.prog && this.scene !== w.prog) { this.scene = w.prog; this.sceneSkins = w.skins; }
    return !!this.scene;
  }
  /** while the wanted shader compiles, look every 100 ms and call onReady when it's done (so the window draws again) */
  _watch() {
    if (this._timer || !this._want || this._want.prog) return;
    this._timer = setInterval(() => {
      const w = this._want;
      if (w && !w.prog && w.pending && this.parallel && !this.gl.getProgramParameter(w.pending.p, this.parallel.COMPLETION_STATUS_KHR)) return;
      clearInterval(this._timer); this._timer = null;
      try { this._sceneReady(); } catch (e) { console.error(e); }
      this.onReady?.();
    }, 100);
  }
  /** resolves once the wanted scene shader is compiled */
  async ready() {
    if (!this._want) this.need();
    for (;;) { this._sceneReady(); if (!this._want || this._want.prog) return; await new Promise(r => setTimeout(r, 30)); }
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
    const SL = world.slabData;   // overhang tops count as tall (rays under them just march)
    const top = k => SL && SL[k * 2 + 1] > SL[k * 2] ? Math.max(world.heightData[k * 2], SL[k * 2 + 1]) : world.heightData[k * 2];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = -1e6;
      for (let dy = -1; dy <= 1; dy++) { const yy = Math.min(h - 1, Math.max(0, y + dy)); for (let dx = -1; dx <= 1; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); const v = top(yy * w + xx); if (v > m) m = v; } }
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
    // where weather can't fall (ft): under higher floors, in "suppress weather" regions
    if (this.tex.shelter) gl.deleteTexture(this.tex.shelter);
    const sh = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, sh);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, world.hw, world.hh, 0, gl.RED, gl.FLOAT, world.shelterFt ?? new Float32Array(world.hw * world.hh).fill(-1e4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.shelter = sh;
    // overhangs: (bottom, top) ft per point
    if (this.tex.slab) gl.deleteTexture(this.tex.slab);
    const slt = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, slt); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, world.hw, world.hh, 0, gl.RG, gl.FLOAT, world.slabData ?? new Float32Array(world.hw * world.hh * 2).fill(-1));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.slab = slt; this.slabOn = !!world.hasSlabs;
    // rooms' ceilings and roofs: which plane per point, and which slabs are a room's ceiling (255) or the wall over a door (128)
    if (this.tex.ceil) gl.deleteTexture(this.tex.ceil);
    const cn = world.hw * world.hh, cd = new Uint8Array(cn * 4), CP = world.ceilPlanes ?? [];
    if (CP.length && world.ceilIdx) for (let k = 0; k < cn; k++) cd[k * 4] = world.ceilIdx[k];
    if (world.slabCeil) for (let k = 0; k < cn; k++) if (world.slabCeil[k]) cd[k * 4 + 1] = world.slabCeil[k] === 2 ? 128 : 255;
    if (world.roofMatPx) for (let k = 0; k < cn; k++) cd[k * 4 + 2] = world.roofMatPx[k];
    let ceilTop = -Infinity; if (CP.length && world.ceilData) for (let k = 0; k < cn; k++) if (world.ceilData[k] > ceilTop) ceilTop = world.ceilData[k];
    const ct = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, ct); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, world.hw, world.hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, cd);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.ceil = ct; this.ceilTop = ceilTop;
    // planes in px: height = a * ppf + bx * x + bz * z
    this.ceilP = new Float32Array(64); CP.slice(0, 16).forEach((P, i) => this.ceilP.set([P.a * world.ppf, P.bx, P.bz, 0], i * 4)); this.ceilN = Math.min(16, CP.length);
    // raised areas that look like something: look / front / region per pixel, a box and picture per region
    for (const k of ["propData", "propInfo", "propPic"]) if (this.tex[k]) gl.deleteTexture(this.tex[k]);
    const nn = (t) => { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    let t2 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, world.hw, world.hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, world.propData ?? new Uint8Array(world.hw * world.hh * 4));
    this.tex.propData = nn(t2);
    // row 0: box along the front (lo, width px), the picture's aspect (-1 = none), a seed; row 1: the picture's cell in the
    // atlas; row 2: box from back to front (lo, depth px)
    const PI = world.propInfo ?? [], n = Math.max(1, PI.length), info = new Float32Array(n * 3 * 4);
    PI.forEach((r, i) => { info.set([r.lo, r.w, r.pic >= 0 && r.uv ? r.uv[4] || 1 : -1, r.seed ?? 0], i * 4); info.set(r.uv ? r.uv.slice(0, 4) : [0, 0, 1, 1], (n + i) * 4); info.set([r.flo ?? 0, r.fd ?? 1, 0, 0], (2 * n + i) * 4); });
    if (!PI.length) info.set([0, 1, -1, 0], 0);
    t2 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 3, 0, gl.RGBA, gl.FLOAT, info);
    this.tex.propInfo = nn(t2);
    if (world.propAtlas) this.tex.propPic = this._texture(world.propAtlas, {mip: true});
    else { t2 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t2); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); this.tex.propPic = nn(t2); }
  }

  /** replace the floor art (a video frame or a re-composited canvas) - for animated maps */
  updateFloor(src) {
    const gl = this.gl, t = this.tex.floor; if (!t || !src) return;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src); gl.generateMipmap(gl.TEXTURE_2D); } catch (e) { /* frame not ready */ }
  }

  /** spell templates: [{type, x, z, len, dir, half (cone half angle) or width, base (px), color}] */
  setTemplates(list) {
    const gl = this.gl, T = {circle: 1, cone: 2, rect: 3, ray: 4};
    const L = (list ?? []).filter(t => T[t.type]).slice(0, 16), n = Math.max(1, L.length), d = new Float32Array(n * 3 * 4);
    L.forEach((t, i) => {
      d.set([t.x, t.z, t.len, T[t.type]], i * 4);
      d.set([t.dir, t.type === "ray" ? t.width : t.half, t.base, 0], (n + i) * 4);
      d.set([...t.color, 1], (2 * n + i) * 4);
    });
    if (this.tex.tpl) gl.deleteTexture(this.tex.tpl);
    const tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 3, 0, gl.RGBA, gl.FLOAT, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.tex.tpl = tx; this.tplN = L.length;
  }

  /** a player's sight mask (RGBA bytes over the height grid), or null = everything shows */
  setVision(data, w, h) {
    const gl = this.gl;
    if (!data) { this.visOn = false; return; }
    if (!this.tex.vis || this._visW !== w || this._visH !== h) {
      if (this.tex.vis) gl.deleteTexture(this.tex.vis);
      this.tex.vis = gl.createTexture(); this._visW = w; this._visH = h;
      gl.bindTexture(gl.TEXTURE_2D, this.tex.vis);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else gl.bindTexture(gl.TEXTURE_2D, this.tex.vis);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.visOn = true;
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
    // the wall skin: the shader must have it (and the region skins and looks); until a new one is compiled, keep the last
    let skinI = Math.max(0, WALL_SKINS.indexOf(opts.skin ?? "neon"));
    if (skinI !== this._needSkin || W !== this._needWorld) { this._needSkin = skinI; this._needWorld = W; this.need({skins: [skinI, ...(W.skinsUsed ?? [])], looks: W.looksUsed ?? []}); }
    if (!this._sceneReady()) return;   // (still compiling: drawn when it's done, see onReady)
    if (this.sceneSkins && !skinDeps(skinI).every(i => i === 0 || this.sceneSkins.includes(i))) skinI = this._shownSkin ?? 0;
    this._shownSkin = skinI;
    const Wx = WEATHER[opts.weather] ?? null;
    const M = weathered(moodOf(opts.mood, opts.tint ?? null, opts.dark ?? 0), Wx);
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
      gl.uniform1f(u.uTime ?? null, (opts.time ?? 0) % 3600); gl.uniform1f(u.uPpf, W.ppf); gl.uniform1f(u.uMaxH, W.maxH * W.ppf); gl.uniform1f(u.uMinH, W.minH * W.ppf);
      gl.uniform1f(u.uTanX, Math.tan((cam.fov * Math.PI / 180) / 2)); gl.uniform1f(u.uFogFt, (opts.fogFt ?? 250) * (M?.fogK ?? 1) * (Wx?.fogK ?? 1)); gl.uniform1f(u.uFogStart, opts.fogStart ?? 0);
      gl.uniform3fv(u.uCamPos, cam.pos); gl.uniform3fv(u.uCamF, cam.f); gl.uniform3fv(u.uCamR, cam.r); gl.uniform3fv(u.uCamU, cam.u);
      gl.uniform3fv(u.uTrim, opts.trim ?? [0.2, 1.0, 1.1]);
      // the mood: its haze leans a little toward the map's own average colour, so it belongs to the map
      const fog = opts.fogCol ?? (M ? M.fog.map((v, i) => v * 0.85 + Math.min(0.6, W.meanCol?.[i] ?? v) * 0.15 * (0.4 + M.amb[i])) : fogColour(opts.daylight ?? 0, W.meanCol));
      gl.uniform3fv(u.uFogCol, fog);
      gl.uniform1i(u.uSkin ?? null, skinI);
      gl.uniform1f(u.uMood ?? null, M ? 1 : 0); gl.uniform1f(u.uSunShadow ?? null, (opts.shadowN ?? 4) > 0 ? 1 : 0);
      gl.uniform1f(u.uKeep ?? null, M?.keep ?? 0); gl.uniform1f(u.uLightK ?? null, M?.lightK ?? 1); gl.uniform1f(u.uSat ?? null, M?.sat ?? 1); gl.uniform1f(u.uTrimK ?? null, M?.trimK ?? 1);
      gl.uniform3fv(u.uSunDir ?? null, sunDirection(opts.mood, opts.sunAz, opts.tint ?? null, opts.dark ?? 0)); gl.uniform3fv(u.uSunCol ?? null, M?.sun ?? [0, 0, 0]);
      gl.uniform3fv(u.uAmb ?? null, M?.amb ?? [1, 1, 1]); gl.uniform3fv(u.uSkyTop ?? null, M?.sky[0] ?? [0, 0, 0]); gl.uniform3fv(u.uSkyHor ?? null, M?.sky[1] ?? [0, 0, 0]);
      // weather (feet -> pixels)
      const P = W.ppf, wk = Wx ? (Wx.k ?? 0) : 0;
      this._bindTex(5, this.tex.shelter, u.uShelter);
      if (!this.tex.tpl) this.setTemplates([]);
      if (!this.tex.vis) { this.setVision(new Uint8Array([255, 255, 0, 255]), 1, 1); this.visOn = false; }
      this._bindTex(10, this.tex.vis, u.uVis); gl.uniform1f(u.uVisOn ?? null, this.visOn && !opts.noVision ? 1 : 0);
      this._bindTex(11, this.tex.slab, u.uSlab); gl.uniform1f(u.uSlabOn ?? null, this.slabOn ? 1 : 0);
      this._bindTex(12, this.tex.ceil, u.uCeil);
      const CN = opts.noCeilings ? 0 : (this.ceilN ?? 0);
      gl.uniform1i(u.uCeilN ?? null, CN);
      gl.uniform1f(u.uCeilSun ?? null, CN && cam.pos[1] / W.ppf < this.ceilTop ? 1 : 0);
      gl.uniform1f(u.uRoofTop ?? null, CN && opts.roofTops ? 1 : 0);
      gl.uniform1i(u.uRoofMat ?? null, ROOF_MATS.indexOf(opts.roofMat ?? ""));
      if (u.uCeilP && this.ceilP) gl.uniform4fv(u.uCeilP, this.ceilP);
      this._bindTex(9, this.tex.tpl, u.uTpl); gl.uniform1i(u.uTplN ?? null, this.tplN ?? 0);
      const BM = (opts.beams ?? []).slice(0, 4), BA = new Float32Array(16), BB = new Float32Array(16), BC = new Float32Array(16);
      BM.forEach((b, i) => { BA.set([...b.from, 0], i * 4); BB.set([...b.to, 0], i * 4); BC.set([...b.color, 1], i * 4); });
      if (u.uBeamA) gl.uniform4fv(u.uBeamA, BA); if (u.uBeamB) gl.uniform4fv(u.uBeamB, BB); if (u.uBeamC) gl.uniform4fv(u.uBeamC, BC);
      gl.uniform1i(u.uBeamN ?? null, BM.length);
      this._bindTex(6, this.tex.propData, u.uPropData); this._bindTex(7, this.tex.propInfo, u.uPropInfo); this._bindTex(8, this.tex.propPic, u.uPropPic);
      gl.uniform1i(u.uWx ?? null, wk);
      gl.uniform3fv(u.uWxVel ?? null, (Wx?.vel ?? [0, 0, 0]).map(v => v * P));
      gl.uniform3fv(u.uWxCol ?? null, Wx?.col ?? [1, 1, 1]);
      gl.uniform4f(u.uWxP ?? null, Wx?.dens ?? 0, Wx?.streak ?? 0, (Wx?.size ?? 0.05) * P, Wx?.alpha ?? 1);
      gl.uniform4f(u.uWxQ ?? null, (Wx?.cell ?? 3) * P, (Wx?.wobble ?? 0) * P, (Wx?.low ?? 0) * P, Wx?.emissive ? 1 : 0);
      gl.uniform1f(u.uWxFlash ?? null, Wx?.lightning ? (opts.flash ?? 0) : 0);
      gl.uniform1f(u.uWxMist ?? null, Wx?.mist ?? 0);
      const mc = Wx?.mistCol ?? fog.map(v => Math.min(1, v * 1.25 + 0.05));
      gl.uniform3fv(u.uWxMistCol ?? null, M ? mc.map((v, i) => v * Math.min(1.2, 0.35 + (M.amb[i] + M.sun[i] * 0.5))) : mc);
      const gr = W.viewElev ?? W.baseElev ?? 0;
      gl.uniform1f(u.uWxGround ?? null, gr);
      gl.uniform1f(u.uWxTop ?? null, Math.max(gr + 32, (W.maxH ?? 0) + 12) * P);
      const hv = opts.hover;
      gl.uniform4f(u.uHover ?? null, hv?.x ?? 0, hv?.z ?? 0, hv?.r ?? 0, hv?.y ?? 0);
      gl.uniform4f(u.uHoverCol ?? null, ...(hv?.col ?? [0, 0, 0]), hv ? (hv.door ? 2 : hv.dot ? 1 : 1.3) : 0);   // 1 = ring + dot, 1.3 = ring, 2 = a door
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
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      for (const v of this.variants ?? []) { if (v.prog?.p) gl.deleteProgram(v.prog.p); if (v.pending?.p) gl.deleteProgram(v.pending.p); }
      for (const pr of [this.bright, this.blur, this.comp]) if (pr?.p) gl.deleteProgram(pr.p);
    } catch (e) { /* ignore */ }
    // Free the GPU context once the canvas is gone. Not right away: losing a context in the same moment another one is
    // created (or this canvas is reused, e.g. the players' Live viewer) leaves the new one dead.
    const cv = this.canvas;
    setTimeout(() => { if (!cv.isConnected) { try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (e) { /* ignore */ } } }, 1500);
  }
}
