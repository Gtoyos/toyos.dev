/* glyphfield.js
 *
 * "Conflict-Freedom as a Progress Condition" (PODC'26), drawn as glowing glyph art.
 *
 * The object: a shared glyph canvas, i.e. an array of registers. Its operation
 * stroke(patch) paints a patch of cells. Strokes on disjoint cells commute; strokes
 * that overlap conflict, because the later one wins the shared cells.
 *
 * Three processes paint pictures together (a pizza slice, then the Eiffel tower) through the GCA-chain universal
 * construction. Left: the semilattice of traces (schedules up to swapping commuting
 * strokes, ordered by prefix) above the committed trace c, with each process's
 * proposal. Right: the object's state, the picture, which grows as traces commit.
 * Disjoint strokes form a cube and commit in one round. Where two patches overlap,
 * the cube's top splits in two, GCA adopts, and the next round fixes the order.
 * A stroke lands in its painter's colour and settles into the picture's own.
 *
 * Drawing happens on the GPU, in four steps:
 *   1. cell pass   (cols x rows)     the scene is evaluated once per character
 *                                    cell and gives a colour and a glyph index
 *   2. glyph pass  (full resolution) each cell's glyph is copied from an atlas
 *   3. bloom       (1/2, 1/4, 1/8)   a separable blur chain
 *   4. composite                     bloom, colour fringe, scanlines, grain
 * The CPU work per frame is a few dozen objects and one small texture upload.
 */
(() => {
  'use strict';

  const root = document.querySelector('[data-glyphfield]');
  if (!root) return;
  const stage = root.querySelector('.gf-stage');
  const canvas = stage.querySelector('canvas');
  const hudRoot = root.querySelector('.gf-hud');
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: 'low-power',
  });
  if (!gl) { root.classList.add('gf-off'); return; }

  /* ================================================================ settings */
  const CW = 7, CH = 9;                    // character cell, CSS px
  const MAXN = 32, MAXE = 48, MAXP = 24;   // nodes, edges, messages per frame
  const FONT = '700 {px}px "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Glyph atlas, 16 per row. Index ranges are mirrored in the cell shader.
  const RAMP = [' ', '.', ':', '-', '=', '+', '*', 'o', '0', '◎', '●', '■']; // 0..11  light -> heavy
  const DIRS = ['-', '\\', '|', '/'];                                      // 12..15 drawn as strokes
  const HEX = [...'0123456789abcdef'];                                     // 16..31 messages
  const GLYPHS = [...RAMP, ...DIRS, ...HEX];

  // Palette: mint, amber, magenta, ice, white (matches the CSS theme)
  const PAL = [[0.36, 0.95, 0.76], [1.0, 0.71, 0.28], [1.0, 0.31, 0.55], [0.55, 0.74, 1.0], [0.92, 0.98, 1.0]];
  const MINT = 0, AMBER = 1, MAGENTA = 2, ICE = 3, WHITE = 4;
  const CSSCOL = ['var(--phosphor)', 'var(--amber)', 'var(--magenta)', 'var(--ice)', 'var(--fg-strong)'];
  const PAL_FLAT = new Float32Array(PAL.flat());
  const BACK = [0.020, 0.027, 0.039];      // #05070a

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const ease = x => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  const SUBS = '₀₁₂₃₄₅₆₇₈₉';
  const sub = n => String(n).split('').map(d => SUBS[+d]).join('');

  /* ================================================================ shaders */
  const VS = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2. - 1., 0., 1.); }`;

  const FS_CELL = `#version 300 es
precision highp float;
uniform vec2 uGrid, uCell;
uniform float uTime, uIntro;
uniform int uNN, uNE, uNP;
uniform vec4 uNode[${MAXN}];     // x, y, radius, shade
uniform vec4 uNodeC[${MAXN}];    // rgb, kind: 0 solid, 2 hollow
uniform float uFlash[${MAXN}];
uniform vec4 uEdge[${MAXE}];     // x1, y1, x2, y2
uniform vec4 uEdgeC[${MAXE}];    // rgb, w < 0 means dashed
uniform vec4 uPk[${MAXP}];       // x, y, palette index, strength
uniform vec4 uPulse;             // x, y, radius, strength
uniform vec3 uPal[5];
uniform sampler2D uCanvas;       // the object's state: rgb, glyph index per cell
uniform float uCanvasK;
out vec4 o;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ramp(float l){ return clamp(floor(l * 11.99), 0., 11.); }
float stroke(vec2 d){                        // direction in screen space, y down
  float a = mod(atan(d.y, d.x), 3.14159265);
  return 12. + mod(floor(a / .785398 + .5), 4.);
}

void main(){
  vec2 cid = vec2(floor(gl_FragCoord.x), uGrid.y - 1. - floor(gl_FragCoord.y));   // column, row from top
  vec2 p = (cid + .5) * uCell;                                                   // cell centre, CSS px
  float n0 = hash(cid);
  float g = 0.; vec3 col = vec3(0.);

  // faint dust
  if (n0 < .03) { g = n0 < .008 ? 2. : 1.; col = uPal[0] * (.08 + .05 * sin(uTime * .6 + n0 * 300.)); }

  // the canvas object
  vec4 cv = texelFetch(uCanvas, ivec2(cid), 0);
  float cg = floor(cv.a * 255. + .5);
  if (cg > 0.) { g = cg; col = cv.rgb * uCanvasK; }

  // commit pulse: a ring around the committed trace
  if (uPulse.w > 0.) {
    float k = abs(length(p - uPulse.xy) - uPulse.z) / (uCell.x * 1.3);
    if (k < 1.) { float a = uPulse.w * (1. - k); if (a > .05) { g = ramp(.2 + a * .45); col = uPal[4] * a * .5; } }
  }

  // edges: one cell thick, the glyph follows the direction, the brightest wins
  float eBest = 0.; float eG = 0.; vec3 eCol = vec3(0.);
  for (int i = 0; i < ${MAXE}; i++) {
    if (i >= uNE) break;
    vec4 e = uEdge[i], ec = uEdgeC[i];
    vec2 a = e.xy, ab = e.zw - a;
    float L = length(ab);
    if (L < 1.) continue;
    vec2 dir = ab / L;
    float h = clamp(dot(p - a, dir), 0., L);
    float d = length(p - a - dir * h);
    float hw = .5 * (uCell.x * abs(dir.y) + uCell.y * abs(dir.x));
    if (d < hw) {
      if (ec.w < 0. && mod(floor(h / (uCell.x * 1.5)), 2.) > .5) continue;
      float it = dot(ec.rgb, vec3(.3, .5, .2));
      if (it > eBest) { eBest = it; eG = stroke(dir); eCol = ec.rgb; }
    }
  }
  if (eBest > 0.) { g = eG; col = eCol; }

  // messages in flight: flickering hex digits
  float pb = 0.; vec3 pCol = vec3(0.);
  for (int i = 0; i < ${MAXP}; i++) {
    if (i >= uNP) break;
    vec4 k = uPk[i];
    float d = length((p - k.xy) / uCell * vec2(1., 1.25));
    float a = (1. - d / 1.4) * k.w;
    if (a > pb) { pb = a; pCol = uPal[int(k.z)]; }
  }
  if (pb > 0.) { g = 16. + floor(hash(cid + floor(uTime * 14.)) * 16.); col = pCol * (.55 + .75 * pb); }

  // traces: shaded spheres with a stroked outline; hollow ones are traces nobody holds
  for (int i = 0; i < ${MAXN}; i++) {
    if (i >= uNN) break;
    vec4 n = uNode[i];
    vec2 q = p - n.xy; float d = length(q), r = n.z;
    if (d < r + uCell.x * .8) {
      vec3 base = uNodeC[i].rgb; float kind = uNodeC[i].w, fl = uFlash[i];
      if (d > r - uCell.x * .4) {
        g = stroke(vec2(-q.y, q.x));
        col = mix(base, uPal[4], fl * .6) * (.85 + fl * .5) * n.w;
      } else if (kind > 1.5 && fl < .05) {
        g = 0.; col = vec3(0.);
      } else {
        vec3 nn = vec3(q / r, 0.); nn.z = sqrt(max(0., 1. - dot(nn.xy, nn.xy)));
        vec3 L = normalize(vec3(-.5, -.6, .65));
        float l = .12 + .78 * max(dot(nn, L), 0.) + .45 * pow(max(reflect(-L, nn).z, 0.), 14.);
        l *= .8 + .4 * n0;
        l = clamp(l + fl * .55, 0., 1.);
        g = ramp(l);
        col = mix(base, uPal[4], fl * .7) * (.3 + .8 * l) * n.w;
      }
    }
  }

  // reveal: rows appear bottom to top behind a band of scrambled digits
  float front = uIntro * (uGrid.y + 14.) - 7.;
  float yy = (uGrid.y - 1. - cid.y) + n0 * 5.;
  if (yy > front) { g = 0.; }
  else if (yy > front - 3. && g > 0.) { g = 16. + floor(hash(cid + floor(uTime * 24.)) * 16.); col = uPal[4] * .9; }

  o = vec4(col, g / 255.);
}`;

  const FS_GLYPH = `#version 300 es
precision highp float;
uniform sampler2D uCells, uAtlas;
uniform ivec2 uTile;
out vec4 o;
void main(){
  ivec2 fc = ivec2(gl_FragCoord.xy), c = fc / uTile, f = fc - c * uTile;
  vec4 cell = texelFetch(uCells, c, 0);
  int idx = int(cell.a * 255. + .5);
  float m = texelFetch(uAtlas, ivec2((idx % 16) * uTile.x + f.x, (idx / 16) * uTile.y + uTile.y - 1 - f.y), 0).r;
  o = vec4(cell.rgb * m, 1.);
}`;

  const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uT; uniform vec2 uRes, uDir;
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uT, uv).rgb * .227027;
  c += (texture(uT, uv + uDir * 1.384615).rgb + texture(uT, uv - uDir * 1.384615).rgb) * .316216;
  c += (texture(uT, uv + uDir * 3.230769).rgb + texture(uT, uv - uDir * 3.230769).rgb) * .070270;
  o = vec4(c, 1.);
}`;

  const FS_COMP = `#version 300 es
precision highp float;
uniform sampler2D uBase, uB1, uB2, uB3;
uniform vec2 uRes; uniform float uTime, uDpr; uniform vec3 uBack;
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes, d = uv - .5;
  float r2 = dot(d, d);
  vec2 off = d * (.002 + .008 * r2);
  vec3 base = vec3(texture(uBase, uv + off).r, texture(uBase, uv).g, texture(uBase, uv - off).b);
  vec3 bl = texture(uB1, uv).rgb * .7 + texture(uB2, uv).rgb * .6 + texture(uB3, uv).rgb * .55;
  vec3 col = base * 1.45 + bl * 1.7;
  col = 1. - exp(-col * 1.15);
  col *= .9 + .1 * cos(gl_FragCoord.y / uDpr * 2.0944);
  col *= 1. - r2 * .8;
  float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 97., vec2(12.9898, 78.233))) * 43758.5453) - .5;
  o = vec4(col + uBack + n * .016, 1.);
}`;

  /* ================================================================ GL plumbing */
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }
  function texture(filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h, filter) {
    const t = texture(filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  function freeTarget(x) { if (x) { gl.deleteFramebuffer(x.f); gl.deleteTexture(x.t); } }
  function use(prog, tgt) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.f : null);
    gl.viewport(0, 0, tgt ? tgt.w : canvas.width, tgt ? tgt.h : canvas.height);
    gl.useProgram(prog.p);
  }
  function bind(unit, tex, loc) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); }

  let PROG = null;
  let atlas = null, cells = null, base = null, levels = [], canvasTex = null;
  let cols = 0, rows = 0, tw = 0, th = 0, dpr = 1, W = 0, H = 0;

  function buildAtlas() {
    const c = document.createElement('canvas');
    c.width = tw * 16; c.height = th * Math.ceil(GLYPHS.length / 16);
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = g.strokeStyle = '#fff';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = FONT.replace('{px}', Math.round(th * 0.95));
    g.lineWidth = Math.max(1, Math.round(tw * 0.13)); g.lineCap = 'round';
    GLYPHS.forEach((ch, i) => {
      const x = (i % 16) * tw, y = Math.floor(i / 16) * th;
      const k = i - RAMP.length;
      if (k >= 0 && k < DIRS.length) {      // strokes reach further than font glyphs so edges read as lines
        const seg = [[.08, .5, .92, .5], [.12, .1, .88, .9], [.5, .06, .5, .94], [.12, .9, .88, .1]][k];
        g.beginPath(); g.moveTo(x + seg[0] * tw, y + seg[1] * th); g.lineTo(x + seg[2] * tw, y + seg[3] * th); g.stroke();
      } else {
        g.fillText(ch, x + tw / 2, y + th * 0.55);
      }
    });
    if (atlas) gl.deleteTexture(atlas);
    atlas = texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
  }

  function resize() {
    const r = root.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return false;
    dpr = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    cols = Math.max(24, Math.floor(r.width / CW));
    rows = Math.max(14, Math.floor(r.height / CH));
    tw = CW * dpr; th = CH * dpr;
    W = cols * CW; H = rows * CH;
    canvas.width = cols * tw; canvas.height = rows * th;
    stage.style.width = W + 'px'; stage.style.height = H + 'px';
    freeTarget(cells); freeTarget(base); levels.forEach(l => { freeTarget(l.a); freeTarget(l.b); });
    cells = target(cols, rows, gl.NEAREST);
    if (canvasTex) gl.deleteTexture(canvasTex);
    canvasTex = texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    base = target(canvas.width, canvas.height, gl.LINEAR);
    levels = [];
    let w = canvas.width, h = canvas.height;
    for (let i = 0; i < 3; i++) {
      w = Math.max(2, w >> 1); h = Math.max(2, h >> 1);
      levels.push({ a: target(w, h, gl.LINEAR), b: target(w, h, gl.LINEAR) });
    }
    buildAtlas();
    return true;
  }

  /* ================================================================ frame data -> GPU */
  const aNode = new Float32Array(MAXN * 4), aNodeC = new Float32Array(MAXN * 4), aFlash = new Float32Array(MAXN);
  const aEdge = new Float32Array(MAXE * 4), aEdgeC = new Float32Array(MAXE * 4), aPk = new Float32Array(MAXP * 4);
  const frameData = { nodes: [], edges: [], packets: [], pulse: null, canvas: null, canvasK: 1 };

  function render(t, intro) {
    const F = frameData;
    const nn = Math.min(MAXN, F.nodes.length), ne = Math.min(MAXE, F.edges.length), np = Math.min(MAXP, F.packets.length);
    for (let i = 0; i < nn; i++) {
      const n = F.nodes[i], o = i * 4;
      aNode[o] = n.x; aNode[o + 1] = n.y; aNode[o + 2] = Math.max(n.r, CW * 1.05); aNode[o + 3] = n.shade == null ? 1 : n.shade;
      aNodeC[o] = n.c[0]; aNodeC[o + 1] = n.c[1]; aNodeC[o + 2] = n.c[2]; aNodeC[o + 3] = n.kind || 0;
      aFlash[i] = n.flash || 0;
    }
    for (let i = 0; i < ne; i++) {
      const e = F.edges[i], o = i * 4;
      aEdge[o] = e.x1; aEdge[o + 1] = e.y1; aEdge[o + 2] = e.x2; aEdge[o + 3] = e.y2;
      aEdgeC[o] = e.c[0]; aEdgeC[o + 1] = e.c[1]; aEdgeC[o + 2] = e.c[2]; aEdgeC[o + 3] = e.dashed ? -1 : 1;
    }
    for (let i = 0; i < np; i++) {
      const k = F.packets[i], o = i * 4;
      aPk[o] = k.x; aPk[o + 1] = k.y; aPk[o + 2] = k.c; aPk[o + 3] = k.a == null ? 1 : k.a;
    }
    const pu = F.pulse;
    gl.bindTexture(gl.TEXTURE_2D, canvasTex);
    if (F.canvas) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, F.canvas);

    // 1. cell pass
    let pr = PROG.cell; use(pr, cells);
    bind(0, canvasTex, pr.u.uCanvas); gl.uniform1f(pr.u.uCanvasK, F.canvasK == null ? 1 : F.canvasK);
    gl.uniform2f(pr.u.uGrid, cols, rows); gl.uniform2f(pr.u.uCell, CW, CH);
    gl.uniform1f(pr.u.uTime, t); gl.uniform1f(pr.u.uIntro, intro);
    gl.uniform1i(pr.u.uNN, nn); gl.uniform1i(pr.u.uNE, ne); gl.uniform1i(pr.u.uNP, np);
    gl.uniform4fv(pr.u.uNode, aNode); gl.uniform4fv(pr.u.uNodeC, aNodeC); gl.uniform1fv(pr.u.uFlash, aFlash);
    gl.uniform4fv(pr.u.uEdge, aEdge); gl.uniform4fv(pr.u.uEdgeC, aEdgeC);
    gl.uniform4fv(pr.u.uPk, aPk); gl.uniform3fv(pr.u.uPal, PAL_FLAT);
    gl.uniform4f(pr.u.uPulse, pu ? pu.x : 0, pu ? pu.y : 0, pu ? pu.r : 0, pu ? pu.a : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. glyph pass
    pr = PROG.glyph; use(pr, base);
    bind(0, cells.t, pr.u.uCells); bind(1, atlas, pr.u.uAtlas); gl.uniform2i(pr.u.uTile, tw, th);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. bloom
    pr = PROG.blur; let prev = base;
    for (const l of levels) {
      use(pr, l.b); bind(0, prev.t, pr.u.uT); gl.uniform2f(pr.u.uRes, l.b.w, l.b.h); gl.uniform2f(pr.u.uDir, 1 / prev.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      use(pr, l.a); bind(0, l.b.t, pr.u.uT); gl.uniform2f(pr.u.uRes, l.a.w, l.a.h); gl.uniform2f(pr.u.uDir, 0, 1 / l.b.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      prev = l.a;
    }

    // 4. composite
    pr = PROG.comp; use(pr, null);
    bind(0, base.t, pr.u.uBase); bind(1, levels[0].a.t, pr.u.uB1); bind(2, levels[1].a.t, pr.u.uB2); bind(3, levels[2].a.t, pr.u.uB3);
    gl.uniform2f(pr.u.uRes, canvas.width, canvas.height); gl.uniform1f(pr.u.uTime, t); gl.uniform1f(pr.u.uDpr, dpr);
    gl.uniform3f(pr.u.uBack, BACK[0], BACK[1], BACK[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ================================================================ HUD helpers */
  const hudCache = new Map();
  function hudSet(key, html) {
    const el = hudRoot.querySelector(`[data-hud="${key}"]`);
    if (el && hudCache.get(key) !== html) { el.innerHTML = html; hudCache.set(key, html); }
  }
  function hudEl(cls, html) {
    const el = document.createElement('div');
    el.className = cls; if (html) el.innerHTML = html;
    hudRoot.appendChild(el);
    return el;
  }
  function place(el, x, y, left) { el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)` + (left ? ' translateX(-100%)' : ''); }

  /* ================================================================ the scene */
  function canvasScene(reveal) {
    const PCOL = { 1: AMBER, 2: MINT, 3: ICE };
    const PICS = ['pizza', 'eiffel'];
    const DUR = { INVOKE: 0.35, PROPOSE: 0.8, GCA: 0.95, OUTPUT: 0.85, SETTLE: 0.55, DONE: 3.4, CLEAR: 0.9 };
    const EMPTY = { S: [], O: [] };
    const st = {
      t: 0, phase: 'START', phaseT: 0, phaseDur: 0, round: 0, len: 0, rounds: 0, picIdx: -1,
      nodes: [], byKey: new Map(), edges: [], conf: {}, out: null, join: null, conflict: null,
      cap: ['', ''], packets: [], pulse: -9, pulseAt: null, old: null, drop: null, fade: 1,
    };
    const procs = [1, 2, 3].map(id => ({ id, col: PCOL[id], queue: [], cmd: null, s: EMPTY, path: ['c'], t0: 0, dur: 0, ret: '' }));
    let geo = null, pic = null, paint = null, cbuf = null;
    let labelEls = {}, trackers = [];
    let ux = 60, uy = 60, nr = 11;

    /* --- labels --- */
    const cmdLabel = p => `<span style="color:${CSSCOL[PCOL[p]]}">s${sub(p)}</span>`;
    const cmdPlain = p => 's' + sub(p);

    /* --- traces over the pending strokes: a set S of processes (one pending stroke
       each) and, for every conflicting pair in S, which of the two comes first --- */
    const sorted = a => a.slice().sort((x, y) => x - y);
    const key = t => t.S.join('') + '|' + t.O.join(',');
    const conf = (a, b) => !!(st.conf[a] && st.conf[a][b]);
    function perms(a) { return a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(r => [x, ...r])); }
    const before = o => o.split('<').map(Number);
    function linear(S, O) {                                 // a schedule respecting O, or null
      for (const s of perms(S)) if (O.every(o => { const [a, b] = before(o); return s.indexOf(a) < s.indexOf(b); })) return s;
      return null;
    }
    function extend(t, c) {                                 // t . c
      if (t.S.includes(c)) return t;
      const O = t.O.slice();
      for (const x of t.S) if (conf(x, c)) O.push(x + '<' + c);
      return { S: sorted([...t.S, c]), O: O.sort() };
    }
    function join(list) {                                   // least upper bound, or null
      const S = sorted([...new Set(list.flatMap(t => t.S))]);
      const O = new Set(list.flatMap(t => t.O));
      // a prefix x of J forces everything conflicting with x and outside x to come after it
      for (const t of list) for (const u of t.S) for (const y of S) if (!t.S.includes(y) && conf(u, y)) O.add(u + '<' + y);
      for (const o of O) { const [a, b] = before(o); if (O.has(b + '<' + a)) return null; }
      const Oa = [...O].sort();
      return linear(S, Oa) ? { S, O: Oa } : null;
    }
    const leq = (x, z) => { const j = join([x, z]); return !!j && key(j) === key(z); };
    const schedule = t => linear(t.S, t.O);

    /* --- the lattice of traces over the pending strokes, laid out by length --- */
    function rebuild(fresh) {
      const old = fresh ? new Map() : st.byKey;
      const P = procs.filter(p => p.cmd).map(p => p.id);
      st.conf = {};
      for (const a of P) { st.conf[a] = {}; for (const b of P) st.conf[a][b] = a !== b && overlap(a, b) > 0; }
      st.byKey = new Map(); st.nodes = []; st.edges = [];
      for (let m = 0; m < 1 << P.length; m++) {
        const S = P.filter((_, i) => (m >> i) & 1);
        const pairs = [];
        for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) if (conf(S[i], S[j])) pairs.push([S[i], S[j]]);
        for (let b = 0; b < 1 << pairs.length; b++) {
          const O = pairs.map(([x, y], k) => ((b >> k) & 1 ? y + '<' + x : x + '<' + y)).sort();
          if (!linear(S, O)) continue;
          const t = { S, O }, k = key(t), prev = old.get(k);
          const n = { t, k, rank: S.length, x: 0, born: prev ? prev.born : (S.length ? st.t : -9) };
          st.byKey.set(k, n); st.nodes.push(n);
        }
      }
      for (const n of st.nodes) for (const c of P) if (!n.t.S.includes(c)) {
        const ch = st.byKey.get(key(extend(n.t, c)));
        if (ch) st.edges.push({ a: n, b: ch, p: c, born: Math.max(n.born, ch.born) });
      }
      // order each rank by its parents (conflicting singletons side by side), then centre it
      let order1 = P.slice();
      if (P.length === 3) {
        const deg = id => P.filter(q => conf(id, q)).length;
        const mids = P.filter(id => deg(id) === 2), iso = P.find(id => deg(id) === 0);
        if (mids.length === 1) { const ends = P.filter(id => id !== mids[0]); order1 = [ends[0], mids[0], ends[1]]; }
        else if (iso && P.some(id => deg(id) === 1)) order1 = [...P.filter(id => id !== iso), iso];
      }
      const maxRank = P.length;
      st.width = 1;
      for (let r = 1; r <= maxRank; r++) {
        const row = st.nodes.filter(n => n.rank === r);
        for (const n of row) {
          if (r === 1) { n.bary = order1.indexOf(n.t.S[0]); continue; }
          const ps = st.edges.filter(e => e.b === n).map(e => e.a.x);
          n.bary = ps.reduce((a, b) => a + b, 0) / ps.length;
        }
        row.sort((a, b) => a.bary - b.bary || b.t.O.length - a.t.O.length || (a.k < b.k ? -1 : 1));   // the two orders of a conflict end up side by side
        row.forEach((n, i) => { n.x = i - (row.length - 1) / 2; });
        st.width = Math.max(st.width, row.length);
      }
      st.ranks = maxRank;
    }
    const node = t => st.byKey.get(key(t));

    /* --- the canvas object --- */
    function overlap(a, b) {
      const A = procs[a - 1].cmd, B = procs[b - 1].cmd;
      if (!A || !B) return 0;
      let n = 0; for (const i of A.cells) if (B.set.has(i)) n++;
      return n;
    }
    function makeGeo() {
      const wide = W >= 560, top = 46, bottom = H - 52, latTop = 72;
      const g = { wide, key: W + 'x' + H };
      if (wide) {
        g.lat = { x0: 14, x1: W * 0.46, y0: latTop, y1: bottom };
        const c0 = Math.ceil(W * 0.5 / CW), c1 = Math.floor((W - 16) / CW);
        const r0 = Math.ceil((top - 10) / CH), r1 = Math.floor((bottom + 8) / CH);
        g.cv = { c0, r0, w: c1 - c0, h: r1 - r0, k: 1 };
      } else {
        g.lat = { x0: 10, x1: W - 10, y0: latTop, y1: bottom };
        g.cv = { c0: 1, r0: 4, w: cols - 2, h: rows - 9, k: 0.32 };
      }
      return g;
    }
    // A picture is drawn in three layers, all in offscreen-canvas pixels (S x CSS px):
    //   fills  shapes on a 2D canvas; covered cells get a glyph and colour from look(x, y),
    //          cells on a shape's border get a stroke along the outline
    //   lines  segments drawn as stroke glyphs (- \ | /) along their direction
    //   cells  single glyphs set directly: stars, windows, ripples
    // Every cell also gets an effect: 1 sparkle (the tower's lights), 2 twinkle, 3 shimmer.
    const FX_SPARKLE = 1, FX_TWINKLE = 2, FX_SHIMMER = 3;
    function makePicture(kind) {
      const cv = geo.cv, S = 2, pw = cv.w * CW * S, ph = cv.h * CH * S, bw = CW * S, bh = CH * S, n = cv.w * cv.h;
      const c = document.createElement('canvas'); c.width = pw; c.height = ph;
      const g = c.getContext('2d');
      g.fillStyle = g.strokeStyle = '#fff';
      let seed = kind === 'pizza' ? 7 : 11;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const lines = [], sets = [];
      const line = (x1, y1, x2, y2, col, fx) => lines.push([x1, y1, x2, y2, col, fx || 0]);
      const curve = (pts, col, fx) => { for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], col, fx); };
      const poly = pts => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.closePath(); g.fill(); };
      const disc = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill(); };
      const cut = f => { g.globalCompositeOperation = 'destination-out'; f(); g.globalCompositeOperation = 'source-over'; };
      const set = (x, y, glyph, col, fx) => sets.push([x, y, glyph, col, fx || 0]);
      let look = () => ({ c: [0.8, 0.8, 0.8] });

      if (kind === 'pizza') {
        // A slice on its side, tilted a little: tip on the left, crust on the right, four pepperoni.
        const cx = pw / 2, cy = ph / 2, rot = -0.1, cr = Math.cos(rot), sr = Math.sin(rot);
        const unrot = (x, y) => [cx + (x - cx) * cr + (y - cy) * sr, cy - (x - cx) * sr + (y - cy) * cr];
        const tx = pw * 0.07, ty = ph * 0.53, R = pw * 0.86, th = Math.asin(Math.min(0.9, (ph * 0.38) / R));
        const at = (rf, af) => [tx + rf * R * Math.cos(af * th), ty + rf * R * Math.sin(af * th)];
        const CRUST = [0.86, 0.55, 0.22], CHEESE = [1.0, 0.8, 0.34], BROWN = [0.93, 0.56, 0.18];
        const RED = [0.95, 0.22, 0.16], RIM = [0.6, 0.1, 0.07], EDGE = [1.0, 0.88, 0.5];
        g.save(); g.translate(cx, cy); g.rotate(rot); g.translate(-cx, -cy);
        g.beginPath(); g.moveTo(tx, ty); g.arc(tx, ty, R * 0.87, -th, th); g.closePath(); g.fill();                      // cheese
        const outer = Array.from({ length: 41 }, (_, i) => { const a = -th * 1.04 + (2.08 * th * i) / 40; return [tx + R * (1 + 0.012 * Math.sin(i * 1.9)) * Math.cos(a), ty + R * (1 + 0.012 * Math.sin(i * 1.9)) * Math.sin(a)]; });
        const inner = Array.from({ length: 41 }, (_, i) => { const a = th * 1.04 - (2.08 * th * i) / 40; return [tx + R * 0.885 * Math.cos(a), ty + R * 0.885 * Math.sin(a)]; });
        poly([...outer, ...inner]);                                                                                  // crust, a little bumpy
        const peps = [[0.4, 0.02], [0.61, -0.5], [0.63, 0.48], [0.8, 0.02]].map(([rf, af]) => {   // four, with cheese between them
          const [x, y] = at(rf, af);
          return [x, y, Math.min(ph * 0.075, rf * R * Math.tan(th) * 0.36)];
        });
        cut(() => { for (const [x, y, r] of peps) disc(x, y, r * 1.3); });                                           // a thin gap around each one
        for (const [x, y, r] of peps) disc(x, y, r);
        g.restore();
        const rotp = (x, y) => [cx + (x - cx) * cr - (y - cy) * sr, cy + (x - cx) * sr + (y - cy) * cr];   // slice frame -> picture
        line(...rotp(tx, ty), ...rotp(...at(0.87, -1)), EDGE); line(...rotp(tx, ty), ...rotp(...at(0.87, 1)), EDGE);
        const bubbles = Array.from({ length: 9 }, () => { const rf = 0.2 + rnd() * 0.6, af = rnd() * 1.6 - 0.8; return [...at(rf, af), ph * (0.02 + rnd() * 0.02)]; });
        for (let i = 0; i < 16; i++) {                                                                               // oregano
          const [x, y] = at(0.15 + rnd() * 0.7, rnd() * 1.6 - 0.8);
          if (!peps.some(([px, py, r]) => Math.hypot(x - px, y - py) < r * 1.5)) set(...rotp(x, y), 1, [0.45, 0.62, 0.22]);
        }
        look = (x, y) => {
          const [ux, uy] = unrot(x, y), d = Math.hypot(ux - tx, uy - ty), a = Math.atan2(uy - ty, ux - tx) / th;
          for (const [px, py, r] of peps) {
            const e = Math.hypot(ux - px, uy - py);
            if (e < r * 1.32) return e < r * 0.62 ? { c: RED, glyph: 10 } : { c: e < r ? scale(RED, 0.8) : RIM, glyph: 9 };
          }
          if (d > R * 0.88) return { c: scale(CRUST, 0.75 + 0.35 * (1 - (a + 1) / 2)), glyph: d > R * 0.95 ? 11 : 10 };
          if (bubbles.some(([bx, by, r]) => Math.hypot(ux - bx, uy - by) < r)) return { c: BROWN, glyph: 9 };
          const wave = Math.sin(ux * 0.03 + 1.3) * Math.sin(uy * 0.045 + 0.4);
          return { c: scale(CHEESE, 0.82 + 0.18 * wave), glyph: wave > 0.2 ? 8 : 7 };
        };
      } else {
        // The tower at night, from across the Seine: real proportions (base = 0.4 of the
        // height, platforms at 0.19, 0.38 and 0.92), a curved outline that narrows
        // exponentially, the arch, the lattice; Paris rooftops, the river, a moon, stars.
        const GOLD = [1.0, 0.72, 0.28], GOLD_HI = [1.0, 0.88, 0.55], GOLD_DIM = [0.62, 0.4, 0.14];
        const MOON = [1.0, 0.95, 0.8], STAR = [0.85, 0.9, 1.0], ROOF = [0.3, 0.38, 0.62], WIN = [1.0, 0.78, 0.4];
        const WATER = [0.24, 0.36, 0.62], REFL = [0.8, 0.56, 0.2];
        const horizon = ph * 0.8, top = ph * 0.03, H = (horizon - top) / 1.12, cx = pw * 0.53, hw = 0.2 * H;
        const w = h => hw * Math.exp(-2.5 * h / H);                      // half width at height h
        const Y = h => horizon - h;
        const side = s => Array.from({ length: 47 }, (_, i) => { const h = (0.92 * H * i) / 46; return [cx + s * w(h), Y(h)]; });
        poly([...side(-1), ...side(1).reverse()]);                                                                    // silhouette
        cut(() => { g.beginPath(); g.ellipse(cx, horizon, hw * 0.62, H * 0.125, 0, Math.PI, 2 * Math.PI); g.fill(); }); // the arch
        const plats = [[0.19, 1.3, 0.045], [0.38, 1.35, 0.035], [0.92, 1.4, 0.03]];
        for (const [h, k, t] of plats) g.fillRect(cx - w(h * H) * k, Y(h * H) - t * H, 2 * w(h * H) * k, t * H);
        g.fillRect(cx - H * 0.013, Y(0.95 * H) - H * 0.05, H * 0.026, H * 0.05);                                    // lantern
        curve(side(-1), GOLD, FX_SPARKLE); curve(side(1), GOLD, FX_SPARKLE);
        for (const s of [-1, 1]) {                                                                                    // bracing in the legs
          const outer = h => cx + s * w(h), innerX = h => cx + s * (hw * 0.62 + (w(0.17 * H) * 0.55 - hw * 0.62) * (h / (0.17 * H)));
          line(outer(0), Y(0), innerX(0.17 * H), Y(0.17 * H), GOLD_DIM, FX_SPARKLE);
          line(innerX(0), Y(0), outer(0.17 * H), Y(0.17 * H), GOLD_DIM, FX_SPARKLE);
        }
        const xs = [[0.235, 0.38], [0.415, 0.54], [0.54, 0.67], [0.67, 0.8], [0.8, 0.92]];                         // X bracing above
        for (const [a, b] of xs) {
          line(cx - w(a * H), Y(a * H), cx + w(b * H), Y(b * H), GOLD_DIM, FX_SPARKLE);
          line(cx + w(a * H), Y(a * H), cx - w(b * H), Y(b * H), GOLD_DIM, FX_SPARKLE);
        }
        line(cx, Y(1.0 * H), cx, top, GOLD_HI, FX_SPARKLE);                                                           // antenna
        set(cx, top + bh * 0.3, 10, [1, 1, 1], FX_SPARKLE);                                                           // beacon
        // rooftops on both banks, leaving the tower's feet in view
        const roofs = [];
        for (let x = 0; x < pw;) {
          const bwid = pw * (0.045 + rnd() * 0.05), hgt = ph * (0.06 + rnd() * 0.09);
          if (Math.abs(x + bwid / 2 - cx) > hw * 1.35) {
            g.fillRect(x, horizon - hgt, bwid - bw * 0.5, hgt);
            poly([[x - bw * 0.2, horizon - hgt], [x + bw * 0.6, horizon - hgt - ph * 0.035], [x + bwid - bw * 1.1, horizon - hgt - ph * 0.035], [x + bwid - bw * 0.3, horizon - hgt]]);
            if (rnd() < 0.7) g.fillRect(x + bwid * (0.2 + rnd() * 0.5), horizon - hgt - ph * 0.06, bw * 0.7, ph * 0.03);   // chimney
            roofs.push([x, x + bwid - bw * 0.5, horizon - hgt]);
          }
          x += bwid;
        }
        for (const [x0, x1, yt] of roofs) for (let y = yt + bh * 1.2; y < horizon - bh * 0.6; y += bh * 2) for (let x = x0 + bw * 1.2; x < x1 - bw * 0.6; x += bw * 2) if (rnd() < 0.4) set(x, y, 11, WIN, FX_TWINKLE);
        line(0, horizon + bh * 0.5, pw, horizon + bh * 0.5, scale(ROOF, 1.2));                                        // the quay
        for (let y = horizon + bh * 1.6; y < ph; y += bh) for (let x = bw * 0.5; x < pw; x += bw) {                  // the Seine
          const under = Math.abs(x - cx) < hw * (1.1 - (y - horizon) / ph);
          if (rnd() < (under ? 0.75 : 0.3)) set(x, y, 12, under ? REFL : WATER, FX_SHIMMER);
        }
        const mx = pw * 0.15, my = ph * 0.2, mr = ph * 0.12;                                                          // crescent moon
        disc(mx, my, mr); cut(() => disc(mx + mr * 0.5, my - mr * 0.25, mr * 0.9));
        for (let i = 0; i < 26; i++) {                                                                               // stars
          const x = rnd() * pw, y = rnd() * horizon * 0.7;
          if (Math.abs(x - cx) > hw * 0.6 && Math.hypot(x - mx, y - my) > mr * 1.4) set(x, y, rnd() < 0.3 ? 6 : rnd() < 0.5 ? 5 : 1, STAR, FX_TWINKLE);
        }
        look = (x, y) => {
          if (Math.hypot(x - mx, y - my) < mr * 1.1) {
            const l = clamp(1 - Math.hypot(x - mx + mr * 0.4, y - my - mr * 0.3) / (mr * 1.6), 0.3, 1);
            return { c: scale(MOON, 0.65 + 0.35 * l), glyph: 9 + Math.round(l * 2) };
          }
          const h = horizon - y;
          if (h >= -bh && h <= 1.12 * H && Math.abs(x - cx) <= w(Math.max(0, h)) * 1.45 + bw) {
            for (const [ph2, k, t] of plats) if (h >= ph2 * H - bh * 0.3 && h <= (ph2 + t) * H + bh * 0.3) return { c: GOLD_HI, glyph: 11, fx: FX_SPARKLE };
            if (h > 0.93 * H) return { c: GOLD_HI, glyph: 10, fx: FX_SPARKLE };
            return { c: scale(GOLD, 0.75), glyph: 2, fx: FX_SPARKLE };          // the lattice itself: sparse dots between the girders
          }
          return { c: ROOF, glyph: 4 };
        };
      }

      // fills -> coverage per cell -> glyphs from look(), outline strokes on borders
      const data = g.getImageData(0, 0, pw, ph).data;
      const cov = new Float32Array(n);
      for (let j = 0; j < cv.h; j++) for (let i = 0; i < cv.w; i++) {
        let a = 0, m = 0;
        for (let y = j * bh; y < (j + 1) * bh; y += 2) for (let x = i * bw; x < (i + 1) * bw; x += 2) { a += data[(y * pw + x) * 4 + 3]; m++; }
        cov[j * cv.w + i] = a / (m * 255);
      }
      const glyph = new Uint8Array(n), rgb = new Float32Array(n * 3), fx = new Uint8Array(n);
      const put = (k, gi, col, f) => { glyph[k] = gi; rgb[k * 3] = col[0]; rgb[k * 3 + 1] = col[1]; rgb[k * 3 + 2] = col[2]; fx[k] = f || 0; };
      const covAt = (i, j) => (i < 0 || j < 0 || i >= cv.w || j >= cv.h ? 0 : cov[j * cv.w + i]);
      const strokeOf = (dx, dy) => 12 + (Math.floor((((Math.atan2(dy, dx) % Math.PI) + Math.PI) % Math.PI) / (Math.PI / 4) + 0.5) % 4);
      for (let j = 0; j < cv.h; j++) for (let i = 0; i < cv.w; i++) {
        const k = j * cv.w + i, c0 = cov[k];
        if (c0 <= 0.14) continue;
        const p = look((i + 0.5) * bw, (j + 0.5) * bh);
        const gi = c0 > 0.58 ? p.glyph : strokeOf(-(covAt(i, j + 1) - covAt(i, j - 1)) / CH, (covAt(i + 1, j) - covAt(i - 1, j)) / CW);
        put(k, gi, c0 > 0.58 ? p.c : scale(p.c, 0.85), p.fx);
      }
      const cellAt = (x, y) => { const i = Math.floor(x / bw), j = Math.floor(y / bh); return i < 0 || j < 0 || i >= cv.w || j >= cv.h ? -1 : j * cv.w + i; };
      for (const [x1, y1, x2, y2, col, f] of lines) {
        const m = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (bw * 0.3))), gi = strokeOf(x2 - x1, y2 - y1);
        for (let s = 0; s <= m; s++) { const k = cellAt(x1 + (x2 - x1) * s / m, y1 + (y2 - y1) * s / m); if (k >= 0) put(k, gi, col, f); }
      }
      for (const [x, y, gi, col, f] of sets) { const k = cellAt(x, y); if (k >= 0) put(k, gi, col, f); }
      return { kind, glyph, rgb, fx };
    }
    // Strokes: each process owns a vertical third of the canvas and paints it band by band,
    // two patches per band. p1 and p3 go left to right, p2 right to left, so the two patches
    // that meet at a seam are always in flight together. In alternate bands the patch left
    // of a seam reaches 3 columns past it, and those two strokes conflict.
    // Band height adapts to the picture so each one takes about 18 strokes, i.e. half a minute.
    function makeStrokes() {
      for (let bands = 8; bands >= 3; bands--) {
        strokesFor(Math.max(2, Math.round(geo.cv.h / bands)));
        if (procs.reduce((a, p) => a + p.queue.filter(Boolean).length, 0) <= 18) return;
      }
    }
    function strokesFor(bh) {
      const cv = geo.cv, bw = Math.ceil(cv.w / 3), half = Math.ceil(bw / 2);
      let id = 0;
      procs.forEach(p => { p.queue = []; });
      for (let b = 0, row = 0; b < cv.h; b += bh, row++) {
        for (const p of procs) {
          const base = (p.id - 1) * bw, sides = p.id === 2 ? [1, 0] : [0, 1];
          for (const side of sides) {
            const x0 = base + side * half;
            let x1 = Math.min(cv.w, base + (side ? bw : half));
            const seam = side === 1 && ((row % 2 === 0 && p.id === 1) || (row % 2 === 1 && p.id === 2));
            if (seam) x1 = Math.min(cv.w, x1 + 3);
            const cells = [];
            for (let j = b; j < Math.min(cv.h, b + bh); j++) for (let i = x0; i < x1; i++) if (pic.glyph[j * cv.w + i]) cells.push(j * cv.w + i);
            p.queue.push(cells.length ? { id: ++id, p: p.id, cells, set: new Set(cells) } : null);
          }
        }
      }
    }
    function newPicture() {
      st.picIdx = (st.picIdx + 1) % PICS.length;
      pic = makePicture(PICS[st.picIdx]);
      const n = geo.cv.w * geo.cv.h;
      paint = { g: new Uint8Array(n), o: new Uint8Array(n), t: new Float32Array(n).fill(-9) };
      cbuf = new Uint8Array(cols * rows * 4);
      makeStrokes();
      procs.forEach(p => { p.cmd = null; p.s = EMPTY; p.path = ['c']; p.dur = 0; p.ret = ''; });
      st.len = 0; st.rounds = 0; st.join = null; st.conflict = null; st.out = null; st.old = null; st.drop = null;
      rebuild(true);
    }
    function applyStroke(cmd) {
      for (const k of cmd.cells) { paint.g[k] = pic.glyph[k]; paint.o[k] = cmd.p; paint.t[k] = st.t; }
    }

    /* --- moves along the lattice --- */
    function pathUp(a, b) {                                 // a shortest route of single appends, random among equals
      const A = node(a), B = node(b);
      if (!A || !B) return null;
      const prev = new Map([[A.k, null]]), queue = [A];
      while (queue.length) {
        const n = queue.shift();
        if (n === B) break;
        const next = st.edges.filter(e => e.a === n).map(e => e.b).sort(() => Math.random() - 0.5);
        for (const m of next) if (!prev.has(m.k)) { prev.set(m.k, n.k); queue.push(m); }
      }
      if (!prev.has(B.k)) return null;
      const path = [];
      for (let k = B.k; k != null; k = prev.get(k)) path.unshift(k);
      return path;
    }
    function moveTo(p, t, dur) {
      const from = key(p.s), to = key(t);
      if (from === to) return;
      const path = pathUp(p.s, t);
      p.path = path || [from, to]; p.t0 = st.t; p.dur = dur || 0.7; p.s = t;
      for (let i = 0; i < 2; i++) st.packets.push({ path: p.path, t0: st.t + i * 0.08, dur: p.dur, c: path ? p.col : MAGENTA });
    }

    /* --- one GCA round per pass: INVOKE, PROPOSE, GCA, OUTPUT, (SETTLE) --- */
    const live = () => procs.filter(p => p.cmd);
    const traceHtml = t => (t.S.length ? schedule(t).map(cmdLabel).join('') : 'c');
    const tracePlain = t => (t.S.length ? schedule(t).map(cmdPlain).join('') : 'c');
    function enter(ph) {
      st.phase = ph; st.phaseT = 0; st.phaseDur = DUR[ph];
      if (ph === 'INVOKE') {
        let fresh = 0;
        for (const p of procs) if (!p.cmd && p.queue.length) { const c = p.queue.shift(); if (c) { p.cmd = c; p.s = EMPTY; fresh++; } }
        if (!live().length) { if (procs.some(p => p.queue.length)) return enter('INVOKE'); return enter('DONE'); }
        if (fresh) rebuild(false);
        st.join = null; st.conflict = null;
        st.cap = ['invoke', fresh ? live().map(p => 'p' + p.id).join(' ') + ' · stroke()' : 'retry with the adopted trace'];
      } else if (ph === 'PROPOSE') {
        st.round++; st.rounds++;
        for (const p of live()) if (!p.s.S.includes(p.id)) moveTo(p, extend(p.s, p.id));
        st.cap = ['propose', `GCA${sub(st.round)}: each proposes its trace · its stroke`];
      } else if (ph === 'GCA') {
        const ps = live(), J = join(ps.map(p => p.s));
        if (J) {
          st.out = { J, commit: true }; st.join = key(J);
          const anyConf = ps.some(a => ps.some(b => conf(a.id, b.id)));
          st.cap = ['compatible', `${anyConf ? 'the order is settled' : 'disjoint strokes commute'} → ⊔ = [${tracePlain(J)}]`];
        } else {
          // GCA adopts: everyone gets the join of a largest compatible group of proposals
          const pool = ps.slice().sort(() => Math.random() - 0.5);
          let group = [];
          for (const p of pool) if (join([...group, p].map(q => q.s))) group.push(p);
          const O = join(group.map(q => q.s));
          const [a, b] = (() => { for (const x of ps) for (const y of ps) if (x.id < y.id && !join([x.s, y.s])) return [x.id, y.id]; return [ps[0].id, ps[1].id]; })();
          st.out = { O, commit: false, losers: ps.filter(p => !O.S.includes(p.id)) };
          st.conflict = [key(extend(extend(EMPTY, a), b)), key(extend(extend(EMPTY, b), a)), a, b];
          st.cap = ['conflict', `${cmdPlain(a)} ≍ ${cmdPlain(b)}: they overlap on ${overlap(a, b)} cells → no ⊔`];
        }
      } else if (ph === 'OUTPUT') {
        if (st.out.commit) {
          const J = st.out.J;
          for (const p of live()) moveTo(p, J, 0.75);
          for (const id of schedule(J)) applyStroke(procs[id - 1].cmd);
          st.len += J.S.length;
          st.pulse = st.t; st.pulseAt = J;
          st.cap = ['commit', `paint [${tracePlain(J)}] · ${J.S.length} stroke${J.S.length > 1 ? 's' : ''}, one order`];
        } else {
          for (const p of live()) moveTo(p, st.out.O, 0.75);
          const L = st.out.losers.map(p => cmdPlain(p.id)).join(' ');
          st.cap = ['adopt', `no commit · everyone adopts [${tracePlain(st.out.O)}] · ${L} retries after it`];
        }
      } else if (ph === 'SETTLE') {
        // the committed trace drops down and becomes the new c
        const J = st.out.J;
        st.old = { nodes: st.nodes.map(n => ({ x: n.x, rank: n.rank })), edges: st.edges.map(e => ({ a: { x: e.a.x, rank: e.a.rank }, b: { x: e.b.x, rank: e.b.rank }, p: e.p })), t0: st.t };
        const jn = node(J);
        st.drop = { x: jn.x, rank: jn.rank, t0: st.t };
        for (const id of J.S) { procs[id - 1].cmd = null; procs[id - 1].ret = '✓'; }
        procs.forEach(p => { p.s = EMPTY; p.path = ['c']; p.dur = 0; });
        st.join = null;
        st.cap = ['commit', `c grows by ${J.S.length} · |c| = ${st.len}`];
      } else if (ph === 'DONE') {
        st.doneT = st.t;
        st.pulse = st.t; st.pulseAt = EMPTY;
        st.cap = ['done', `${PICS[st.picIdx]}: ${st.len} strokes linearized in ${st.rounds} GCA rounds`];
      } else if (ph === 'CLEAR') {
        st.cap = ['', ''];
      }
    }
    function next() {
      const ph = st.phase;
      if (ph === 'START' || ph === 'CLEAR') { if (ph === 'CLEAR') { newPicture(); reveal(); } return enter('INVOKE'); }
      if (ph === 'INVOKE') return enter('PROPOSE');
      if (ph === 'PROPOSE') return enter('GCA');
      if (ph === 'GCA') return enter('OUTPUT');
      if (ph === 'OUTPUT') return enter(st.out.commit ? 'SETTLE' : 'INVOKE');
      if (ph === 'SETTLE') { st.old = null; rebuild(true); return enter('INVOKE'); }
      if (ph === 'DONE') return enter('CLEAR');
    }

    function step(dt) {
      st.t += dt; st.phaseT += dt;
      if (!geo || geo.key !== W + 'x' + H) {               // first frame, or the frame was resized
        geo = makeGeo(); st.picIdx = st.picIdx < 0 ? -1 : st.picIdx - 1; newPicture();
        if (st.phase === 'START') reveal();
        st.phase = 'START'; st.phaseDur = 0;
      }
      if (st.phaseT >= st.phaseDur) next();
      st.packets = st.packets.filter(m => st.t < m.t0 + m.dur);
    }

    /* --- geometry of the lattice panel --- */
    function layout() {
      const L = geo.lat, w = L.x1 - L.x0, h = L.y1 - L.y0, ranks = Math.max(1, st.ranks || 1);
      uy = clamp(h / (ranks + 0.35), 30, 92);
      ux = clamp(Math.min(w / (Math.max(st.width, 1) + 0.6), uy * 1.5), 30, 120);
      nr = clamp(Math.min(ux * 0.17, uy * 0.24), 7, 14);
    }
    const lx = x => (geo.lat.x0 + geo.lat.x1) / 2 + x * ux;
    const ly = r => geo.lat.y1 - 6 - r * uy;
    const pos = k => { const n = st.byKey.get(k); return n ? [lx(n.x), ly(n.rank)] : [lx(0), ly(0)]; };
    function along(path, u) {
      if (path.length === 1) return pos(path[0]);
      const seg = Math.min(path.length - 2, Math.floor(u * (path.length - 1))), f = u * (path.length - 1) - seg;
      const a = pos(path[seg]), b = pos(path[seg + 1]);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    function dropPos() {                                    // the committed trace falling to c
      const u = ease(clamp((st.t - st.drop.t0) / (DUR.SETTLE * 0.85), 0, 1));
      return [lx(st.drop.x * (1 - u)), ly(st.drop.rank * (1 - u))];
    }
    const procPos = p => (st.phase === 'SETTLE' && st.drop ? dropPos() : along(p.path, p.dur ? ease(clamp((st.t - p.t0) / p.dur, 0, 1)) : 1));

    function below(t) { const s = new Set(); for (const n of st.nodes) if (leq(n.t, t)) s.add(n.k); return s; }

    function build(F) {
      if (!geo || geo.key !== W + 'x' + H) step(0);
      layout();
      const fadeAll = st.phase === 'CLEAR' ? 1 - clamp(st.phaseT / DUR.CLEAR, 0, 1) : 1;
      st.fade = fadeAll;
      const sinceCommit = st.t - st.pulse;

      // the canvas object: committed strokes, plus proposals flickering where they would paint
      const cv = geo.cv;
      cbuf.fill(0);
      const tick = Math.floor(st.t * 12);
      const put = (k, r, g, b, glyph) => {
        const i = ((cv.r0 + Math.floor(k / cv.w)) * cols + cv.c0 + (k % cv.w)) * 4;
        cbuf[i] = clamp(r, 0, 1) * 255; cbuf[i + 1] = clamp(g, 0, 1) * 255; cbuf[i + 2] = clamp(b, 0, 1) * 255; cbuf[i + 3] = glyph;
      };
      const finale = st.phase === 'DONE' || st.phase === 'CLEAR', glow = finale ? 1 + 0.45 * Math.exp(-(st.t - st.doneT) * 1.5) : 1;
      for (let k = 0; k < paint.g.length; k++) if (paint.g[k]) {
        // a fresh stroke lands in its painter's colour and settles into the picture's own
        const age = st.t - paint.t[k], m = clamp(age / 0.9, 0, 1), tint = PAL[PCOL[paint.o[k]]];
        let r = tint[0] + (pic.rgb[k * 3] - tint[0]) * m, g2 = tint[1] + (pic.rgb[k * 3 + 1] - tint[1]) * m, b = tint[2] + (pic.rgb[k * 3 + 2] - tint[2]) * m;
        let f = (1 + 0.9 * Math.exp(-age * 3)) * glow * fadeAll, gi = paint.g[k];
        const e = pic.fx[k];
        if (e === FX_SPARKLE) {                            // the tower's lights glitter, much more once it is finished
          const h = ((k * 2654435761) ^ (tick * 40503)) >>> 0;
          if (h % 1000 < (finale ? 110 : 5)) { r = g2 = b = 1; f = 1.5 * fadeAll; }
        } else if (e === FX_TWINKLE) f *= 0.55 + 0.45 * Math.sin(st.t * 2.3 + k * 1.7);
        else if (e === FX_SHIMMER) {                       // ripples drifting along the river
          const w = Math.sin(st.t * 1.4 - (k % cv.w) * 0.32 + Math.floor(k / cv.w) * 1.7);
          if (w < -0.35) continue;
          f *= 0.45 + 0.55 * w;
        }
        put(k, r * f, g2 * f, b * f, gi);
      }
      const proposing = st.phase === 'PROPOSE' || st.phase === 'GCA' || (st.phase === 'OUTPUT' && !st.out.commit) || (st.phase === 'INVOKE' && st.round > 0);
      if (proposing) {
        const clash = st.phase === 'GCA' && st.conflict && Math.floor(st.t * 5) % 2 === 0;
        for (const p of live()) {
          if (!p.s.S.includes(p.id) && st.phase !== 'GCA' && st.phase !== 'OUTPUT') continue;
          const tint = PAL[p.col], other = clash ? procs[(st.conflict[2] === p.id ? st.conflict[3] : st.conflict[2]) - 1].cmd : null;
          for (const k of p.cmd.cells) {
            const hot = clash && (st.conflict[2] === p.id || st.conflict[3] === p.id) && other && other.set.has(k);
            const h = ((k * 2654435761) ^ (tick * 40503)) >>> 0;
            if (!hot && (h % 7) > 1) continue;            // a sparse shimmer, not a solid block
            const c = hot ? PAL[MAGENTA] : scale(tint, 0.45);
            put(k, c[0], c[1], c[2], 16 + (h % 16));
          }
        }
      }
      F.canvas = cbuf; F.canvasK = cv.k;

      // the lattice
      const ps = live();
      const lit = new Set(); ps.forEach(p => below(p.s).forEach(k => lit.add(k)));
      const done = st.out && st.out.commit && (st.phase === 'OUTPUT') ? below(st.out.J) : new Set();
      const fadeIn = born => clamp((st.t - born) / 0.35, 0, 1);
      if (st.old) {                                         // the previous lattice fading away
        const f = (1 - clamp((st.t - st.old.t0) / (DUR.SETTLE * 0.8), 0, 1)) * fadeAll;
        for (const e of st.old.edges) F.edges.push({ x1: lx(e.a.x), y1: ly(e.a.rank), x2: lx(e.b.x), y2: ly(e.b.rank), c: scale(PAL[PCOL[e.p]], 0.3 * f) });
        for (const n of st.old.nodes) if (n.rank) F.nodes.push({ x: lx(n.x), y: ly(n.rank), r: nr, c: scale(PAL[MINT], 0.5 * f), kind: 2 });
        const d = dropPos();
        F.nodes.push({ x: lx(0), y: ly(0), r: nr * 1.25, c: scale(PAL[WHITE], fadeAll) });
        F.nodes.push({ x: d[0], y: d[1], r: nr * 1.2, c: scale(PAL[WHITE], fadeAll), flash: 0.6 });
      } else {
        for (const e of st.edges) {
          const [x1, y1] = pos(e.a.k), [x2, y2] = pos(e.b.k), oc = PAL[PCOL[e.p]];
          let c;
          if (done.has(e.b.k)) c = mix(oc, PAL[WHITE], 0.6);
          else if (st.conflict && (e.b.k === st.conflict[0] || e.b.k === st.conflict[1])) c = mix(oc, PAL[MAGENTA], 0.55);
          else if (lit.has(e.b.k)) c = scale(oc, 0.8);
          else c = scale(oc, 0.22);
          F.edges.push({ x1, y1, x2, y2, c: scale(c, fadeIn(e.born) * fadeAll) });
        }
        if (st.conflict && (st.phase === 'GCA' || st.phase === 'OUTPUT')) {
          const [a, b] = [pos(st.conflict[0]), pos(st.conflict[1])];
          F.edges.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], c: scale(PAL[MAGENTA], 0.95 * fadeAll), dashed: true });
        }
        const flash = st.join ? 0.5 + 0.5 * Math.sin(st.t * 9) : 0;
        for (const n of st.nodes) {
          const [x, y] = pos(n.k);
          const holder = ps.find(p => key(p.s) === n.k && (!p.dur || st.t >= p.t0 + p.dur * 0.85));
          let c, kind = 0, r = nr;
          if (n.rank === 0) { c = PAL[WHITE]; r = nr * 1.25; }
          else if (done.has(n.k) && sinceCommit > 0.5) c = scale(PAL[WHITE], 0.75);
          else if (holder) c = PAL[holder.col];
          else { c = scale(PAL[MINT], 0.45); kind = 2; }
          if (st.conflict && (n.k === st.conflict[0] || n.k === st.conflict[1])) c = mix(c, PAL[MAGENTA], 0.6);
          F.nodes.push({ x, y, r, c: scale(c, fadeIn(n.born) * fadeAll), kind, flash: n.k === st.join ? flash * fadeAll : 0 });
        }
      }

      for (const m of st.packets) {
        const u = (st.t - m.t0) / m.dur;
        if (u <= 0 || u >= 1 || st.old) continue;
        const q = along(m.path, ease(u));
        F.packets.push({ x: q[0], y: q[1], c: m.c, a: fadeAll });
      }
      const pa = sinceCommit / 1.2;
      if (st.pulseAt && pa > 0 && pa < 1 && !st.old) {
        const q = st.pulseAt.S.length ? pos(key(st.pulseAt)) : [lx(0), ly(0)];
        F.pulse = { x: q[0], y: q[1], r: nr * 1.4 + pa * ux * 1.3, a: (1 - pa) * 0.75 * fadeAll };
      }
    }

    /* --- HUD --- */
    function mountHud() {
      hudRoot.innerHTML = `
        <div class="gf-c gf-tl"><b>conflict-freedom</b><br><span class="gf-k">three processes paint one canvas</span></div>
        <div class="gf-c gf-tr"><b data-hud="gca"></b><br><span class="gf-k">|c|</span> <b data-hud="len"></b> <span class="gf-k">strokes</span></div>
        <div class="gf-c gf-bl"><b class="gf-step" data-hud="title"></b> <span data-hud="text"></span><br><span class="gf-k">strokes on disjoint cells commute · overlapping strokes conflict</span></div>
        <div class="gf-c gf-br" data-hud="pic"></div>`;
      trackers = procs.map(p => {
        const el = hudEl('gf-track');
        el.style.setProperty('--c', CSSCOL[p.col]);
        const label = document.createElement('i'); el.appendChild(label);
        return { el, label, text: '' };
      });
      labelEls = { c: hudEl('gf-lbl gf-lbl-c on', 'c'), join: hudEl('gf-lbl gf-lbl-join on', '⊔'), conf: hudEl('gf-lbl gf-lbl-bad on', '≍'), held: [1, 2, 3].map(() => hudEl('gf-lbl on')) };
    }

    function updateHud() {
      hudSet('gca', 'GCA' + sub(Math.max(1, st.round)));
      hudSet('len', String(st.len));
      hudSet('title', st.cap[0]);
      hudSet('text', st.cap[1]);
      const total = procs.reduce((a, p) => a + p.queue.filter(Boolean).length + (p.cmd ? 1 : 0), 0) + st.len;
      hudSet('pic', `${PICS[st.picIdx]} · ${total ? Math.round(100 * st.len / total) : 0}%`);
      hudRoot.style.setProperty('--fade', st.fade.toFixed(2));

      const settling = !!st.old;
      place(labelEls.c, lx(0) - nr - 8, ly(0) - 7, true);
      const showJ = st.join && !settling;
      labelEls.join.style.display = showJ ? '' : 'none';
      if (showJ) { const [x, y] = pos(st.join); place(labelEls.join, x - 5, y - nr - 24); }
      const showC = st.conflict && (st.phase === 'GCA' || st.phase === 'OUTPUT') && !settling;
      labelEls.conf.style.display = showC ? '' : 'none';
      if (showC) { const a = pos(st.conflict[0]), b = pos(st.conflict[1]); place(labelEls.conf, (a[0] + b[0]) / 2 - 5, (a[1] + b[1]) / 2 - 24); }

      // trace labels for the traces the processes hold
      const shown = new Set();
      procs.forEach((p, i) => {
        const el = labelEls.held[i], k = key(p.s);
        const visible = p.cmd && p.s.S.length && !settling && !shown.has(k) && (!p.dur || st.t >= p.t0 + p.dur * 0.85);
        el.style.display = visible ? '' : 'none';
        if (!visible) return;
        shown.add(k);
        const [x, y] = pos(k), left = x < lx(0) - 4;
        el.innerHTML = traceHtml(p.s);
        place(el, left ? x - nr - 5 : x + nr + 5, y - nr - 7, left);
      });

      procs.forEach((p, i) => {
        const tr = trackers[i], on = !!p.cmd || (settling && p.ret);
        tr.el.style.display = on ? '' : 'none';
        if (!on) return;
        const [x, y] = procPos(p), size = Math.round(nr * 2 + 12 + i * 8);
        tr.el.style.width = tr.el.style.height = size + 'px';
        const left = x < lx(0) - 4;
        tr.el.classList.toggle('gf-at-bl', left); tr.el.classList.toggle('gf-at-br', !left);
        place(tr.el, x - size / 2, y - size / 2);
        const text = p.cmd ? `p${p.id} ${cmdPlain(p.id)}` : `p${p.id} ✓`;
        if (tr.text !== text) { tr.label.textContent = text; tr.text = text; }
      });
    }

    function still() {
      let guard = 0;
      while (!(st.phase === 'GCA' && st.conflict && st.phaseT > 0.4 && st.len > 3) && guard++ < 20000) step(1 / 30);
    }

    return { step, build, mountHud, updateHud, still };
  }

  /* ================================================================ engine loop */
  let scene = null;
  let raf = 0, lastNow = 0, running = false, onScreen = true, introT = 0, clock = 0;
  const INTRO = 1.3;

  function draw(dt) {
    frameData.nodes.length = 0; frameData.edges.length = 0; frameData.packets.length = 0; frameData.pulse = null;
    scene.build(frameData);
    render(clock, reduceMotion ? 1 : Math.min(1, introT / INTRO));
    scene.updateHud(dt);
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - lastNow < 15) return;                // ~60 fps cap, even on 120 Hz screens
    const dt = Math.min(0.05, (now - lastNow) / 1000 || 0.016);
    lastNow = now;
    introT += dt; clock += dt;
    scene.step(dt);
    draw(dt);
    if (introT > INTRO * 0.5) hudRoot.classList.add('on');
  }
  function start() {
    if (running || reduceMotion || !onScreen || document.hidden) return;
    running = true; lastNow = performance.now(); raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function still() { scene.still(); draw(0); hudRoot.classList.add('on'); }
  function reveal() { if (!reduceMotion) { introT = 0; hudRoot.classList.remove('on'); } }

  function init() {
    try {
      PROG = { cell: program(FS_CELL), glyph: program(FS_GLYPH), blur: program(FS_BLUR), comp: program(FS_COMP) };
    } catch (e) {
      console.warn('glyphfield:', e); root.classList.add('gf-off'); return;
    }
    gl.bindVertexArray(gl.createVertexArray());
    if (!resize()) return;
    scene = canvasScene(reveal);
    scene.mountHud();
    scene.step(0);
    if (reduceMotion) still(); else { draw(0); start(); }

    new ResizeObserver(() => { if (resize() && !running) { if (reduceMotion) still(); else draw(0); } }).observe(root);
    new IntersectionObserver(es => { onScreen = es[0].isIntersecting; onScreen ? start() : stop(); }).observe(root);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); stop(); root.classList.add('gf-off'); });
  }

  const fontReady = document.fonts && document.fonts.load
    ? Promise.race([document.fonts.load(FONT.replace('{px}', 18)), new Promise(r => setTimeout(r, 1500))])
    : Promise.resolve();
  fontReady.then(init, init);
})();
