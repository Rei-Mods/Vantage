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
uniform vec4 uCap; uniform vec2 uCapRH;
uniform int uNL, uNS, uShadowN;
uniform float uAO;
uniform vec4 uLPos[${MAX_LIGHTS}], uLCol[${MAX_LIGHTS}];
uniform vec4 uSPos[${MAX_STANDEES}], uSUV[${MAX_STANDEES}], uSInfo[${MAX_STANDEES}], uSTint[${MAX_STANDEES}], uSRing[${MAX_STANDEES}];

float hAt(vec2 xz){
  vec2 uv = xz / uWorld;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1e6;
  return texture(uHeight, uv).r * uPpf;
}
// cutaway limit at a point: near the camera (t < uCutT) -> uCutH; inside the camera->target corridor -> uCapRH.y
float cutLim(vec2 xz, float t){
  float lim = t < uCutT ? uCutH : 1e9;
  if (uCapRH.x > 0.0) {
    vec2 a = uCap.xy, ab = uCap.zw - uCap.xy; float L2 = max(dot(ab, ab), 1e-6);
    float s = dot(xz - a, ab) / L2;
    if (s < 1.0 && distance(xz, a + ab * max(s, 0.0)) < uCapRH.x) lim = min(lim, uCapRH.y);
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
    if (!side) {
      col = texture(uFloor, uv).rgb;
      if (cut) col = vec3(0.05, 0.06, 0.08) + uTrim * 0.05;
      else if (kd == 1) col = vec3(0.13, 0.15, 0.19) * (0.75 + 0.5 * vnoise(p.xz / (6.0 * uPpf)));
      else if (kd == 6) {   // gentle height-map slopes: shade by the slope so bumps read as 3D
        vec3 tn = normalize(vec3(-g.x / (2.0 * e), 1.0, -g.y / (2.0 * e)));
        col *= 0.55 + 0.55 * clamp(dot(tn, normalize(vec3(0.35, 0.8, -0.45))), 0.0, 1.0);
      }
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
        if (uSRing[s].a > 0.5 && abs(dist - r) < max(r * 0.07, 1.5 * texel)) col = uSRing[s].rgb * 1.6;
      }
    } else {
      vec3 base = mix(vec3(0.20, 0.22, 0.25), textureLod(uFloor, uv, 3.0).rgb, 0.35);
      float rel = clamp(1.0 - (hb - p.y) / (30.0 * uPpf), 0.0, 1.0);
      col = base * (0.45 + 0.55 * rel);
      if (kd == 1) {
        float strata = 0.8 + 0.2 * sin(p.y / (1.5 * uPpf) + (p.x + p.z) / (11.0 * uPpf)) + 0.08 * sin(p.y / (3.5 * uPpf) - (p.x - p.z) / (5.6 * uPpf));
        col = vec3(0.15, 0.17, 0.21) * (0.7 + 0.6 * vnoise(p.xz / (6.0 * uPpf))) * strata * (0.55 + 0.45 * rel);
      } else if (kd == 5) {
        // raised area (crate, console, dais): plain dark metal, a soft lighter lip at the top, no glow trim
        // the top's own colour tints the metal a little, darker toward the foot; panel seams every 2 ft and down the sides
        col = mix(vec3(0.15, 0.17, 0.20), textureLod(uFloor, uv, 6.5).rgb, 0.3) * (0.62 + 0.38 * rel);
        if ((hb - p.y) / uPpf < 0.12) col = mix(col, textureLod(uFloor, uv, 1.0).rgb, 0.6) * 1.35;
        if (abs(mod(p.y / uPpf, 2.0) - 1.0) > 0.95) col *= 0.72;
        if (abs(mod((p.x + p.z) / uPpf, 3.0) - 1.5) > 1.44) col *= 0.8;
      } else if (kd == 6) {
        // height-map terrain: the map art carries down the slope
        col = texture(uFloor, uv).rgb * (0.6 + 0.4 * rel);
      } else if (kd == 4) {
        // stair risers: plain metal with a thin glowing nosing on every step
        col = base * (0.75 + 0.25 * rel);
        if ((hb - p.y) / uPpf < 0.14) col = uTrim * 0.85;
      } else {
        float yf = p.y / uPpf, hf = (p.x + p.z) / uPpf;
        bool seam = abs(mod(yf, 4.0) - 2.0) > 1.85 || abs(mod(hf, 5.0) - 2.5) > 2.42;
        if (seam) col *= 0.45;
        if (kd == 3) col = mix(col, vec3(0.12, 0.45, 0.55), 0.6);
        float dt = (hb - p.y) / uPpf;
        if (dt > 0.6 && dt < 1.1) col = uTrim;
      }
      vec3 key = normalize(vec3(0.35, 0.8, -0.45));
      col *= 0.5 + 0.5 * clamp(dot(N.xz, key.xz), 0.0, 1.0);
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
    col += acc * (side ? 1.0 : 0.6) * max(col, vec3(0.08)) * 2.2 + acc * 0.12;
    if (uAO > 0.0 && !cut) col *= mix(1.0, side ? aoSide(p, n2, texel) : aoFloor(p, t), uAO * 0.85);
    float fog = 1.0 - exp(-max(t - uFogStart * uPpf, 0.0) / (uFogFt * uPpf));
    col = mix(col, uFogCol, fog);
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
    sc = mix(sc, uFogCol, 1.0 - exp(-max(ts - uFogStart * uPpf, 0.0) / (uFogFt * uPpf)));
    col = mix(col, sc, al);
  }
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
      gl.uniform1f(u.uTanX, Math.tan((cam.fov * Math.PI / 180) / 2)); gl.uniform1f(u.uFogFt, opts.fogFt ?? 250); gl.uniform1f(u.uFogStart, opts.fogStart ?? 0);
      gl.uniform3fv(u.uCamPos, cam.pos); gl.uniform3fv(u.uCamF, cam.f); gl.uniform3fv(u.uCamR, cam.r); gl.uniform3fv(u.uCamU, cam.u);
      gl.uniform3fv(u.uTrim, opts.trim ?? [0.2, 1.0, 1.1]); gl.uniform3fv(u.uFogCol, opts.fogCol ?? fogColour(opts.daylight ?? 0, W.meanCol));
      gl.uniform1f(u.uCutT, opts.cutT ?? 0); gl.uniform1f(u.uCutH, opts.cutH ?? 1e9);
      const cap = opts.cap; gl.uniform4fv(u.uCap, cap ?? [0, 0, 0, 0]); gl.uniform2f(u.uCapRH, cap ? opts.capR : 0, cap ? opts.capH : 1e9);
      gl.uniform1i(u.uNL, Math.min(lights.length, MAX_LIGHTS)); gl.uniform1i(u.uNS, ns);
      gl.uniform1i(u.uShadowN, Math.max(0, Math.min(opts.shadowN ?? 4, lights.length))); gl.uniform1f(u.uAO, opts.ao ?? 1);
      if (u.uLPos) gl.uniform4fv(u.uLPos, L); if (u.uLCol) gl.uniform4fv(u.uLCol, LC);
      if (u.uSPos) gl.uniform4fv(u.uSPos, SP); if (u.uSUV) gl.uniform4fv(u.uSUV, SU);
      if (u.uSInfo) gl.uniform4fv(u.uSInfo, SI); if (u.uSTint) gl.uniform4fv(u.uSTint, ST); if (u.uSRing) gl.uniform4fv(u.uSRing, SR);
    });
    const bloom = opts.bloom ?? 1;
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
