// Le bac — a marbling tray on the GPU.
// Two layers of physics share one ink texture:
//  - a 2D incompressible fluid (semi-Lagrangian advection, vorticity, Jacobi pressure) for freehand stirring;
//  - exact "mathematical marbling" transforms (ink drops, tine lines, combs, vortices, waves) that move ink
//    without diffusing it, so patterns stay as crisp as on a real ebru bath.

const VS = `#version 300 es
precision highp float;
in vec2 aPos;
uniform vec2 uTexel;
out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 o;
`;

// Sampling helper shared by every ink transform: positions are in "bath units" (x in [0, aspect], y in [0, 1]).
const AT = `
uniform sampler2D uDye;
uniform float uAspect;
vec2 bathPos() { return vec2(vUv.x * uAspect, vUv.y); }
vec3 inkAt(vec2 p) { return texture(uDye, vec2(p.x / uAspect, p.y)).rgb; }
`;

const FS = {
  copy: `uniform sampler2D uTex;
    void main() { o = texture(uTex, vUv); }`,

  scale: `uniform sampler2D uTex; uniform float uValue;
    void main() { o = uValue * texture(uTex, vUv); }`,

  fill: `uniform vec3 uColor;
    void main() { o = vec4(uColor, 1.0); }`,

  // Marbling inks never mix: every resampling pass blurs a little, so each frame we pull every texel
  // back toward the nearest pigment of the palette. Edges stay crisp; where three inks meet, thin veins appear.
  sharpen: `uniform sampler2D uDye; uniform vec3 uPal[6]; uniform float uK;
    void main() {
      vec3 c = texture(uDye, vUv).rgb, t = c;
      float best = 1e9;
      for (int i = 0; i < 6; i++) {
        vec3 d = c - uPal[i];
        float e = dot(d, d);
        if (e < best) { best = e; t = uPal[i]; }
      }
      o = vec4(mix(c, t, uK), 1.0);
    }`,

  splat: `uniform sampler2D uTarget; uniform float uAspect; uniform vec3 uColor; uniform vec2 uPoint; uniform float uRadius;
    void main() {
      vec2 p = vUv - uPoint; p.x *= uAspect;
      o = vec4(texture(uTarget, vUv).xyz + exp(-dot(p, p) / uRadius) * uColor, 1.0);
    }`,

  advect: `uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 uVelTexel; uniform float uDt; uniform float uDiss;
    void main() {
      vec2 c = vUv - uDt * texture(uVelocity, vUv).xy * uVelTexel;
      o = texture(uSource, c) / (1.0 + uDiss * uDt);
    }`,

  divergence: `uniform sampler2D uVelocity;
    void main() {
      float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;
      float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
      vec2 C = texture(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x;
      if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y;
      if (vB.y < 0.0) B = -C.y;
      o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`,

  curl: `uniform sampler2D uVelocity;
    void main() {
      float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;
      float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
      o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`,

  vorticity: `uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float uCurlAmt; uniform float uDt;
    void main() {
      float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
      float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x, C = texture(uCurl, vUv).x;
      vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      f /= length(f) + 1e-4;
      f *= uCurlAmt * C; f.y *= -1.0;
      vec2 v = texture(uVelocity, vUv).xy + f * uDt;
      o = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
    }`,

  pressure: `uniform sampler2D uPressure; uniform sampler2D uDivergence;
    void main() {
      float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
      o = vec4((L + R + B + T - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
    }`,

  gradient: `uniform sampler2D uPressure; uniform sampler2D uVelocity;
    void main() {
      float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
      o = vec4(texture(uVelocity, vUv).xy - vec2(R - L, T - B), 0.0, 1.0);
    }`,

  // A drop of radius r pushes every point outward so that area is conserved:
  // |p - c|^2 -> |p - c|^2 + r^2. We sample the inverse map. Growing a drop = adding r^2 increments.
  drop: AT + `uniform vec2 uCenter; uniform float uR2; uniform vec3 uColor; uniform float uPx;
    void main() {
      vec2 p = bathPos() - uCenter;
      float d2 = max(dot(p, p), 1e-9);
      vec3 src = inkAt(uCenter + p * sqrt(max(0.0, 1.0 - uR2 / d2)));
      float k = smoothstep(sqrt(uR2) - uPx, sqrt(uR2) + uPx, sqrt(d2));
      o = vec4(mix(uColor, src, k), 1.0);
    }`,

  // A tine (or a comb of tines every uSpacing) dragged along uDir. Displacement decays as lambda / (d + lambda)
  // with the distance d to the tine, and is windowed around the moving head so the stylus visibly travels.
  tine: AT + `uniform vec2 uOrigin; uniform vec2 uDir; uniform float uSpacing; uniform float uAmt;
    uniform float uLambda; uniform float uHead; uniform float uWidth;
    void main() {
      vec2 p = bathPos();
      vec2 rel = p - uOrigin;
      float d = dot(rel, vec2(-uDir.y, uDir.x));
      if (uSpacing > 0.0) d -= uSpacing * floor(d / uSpacing + 0.5);
      float a = dot(rel, uDir) - uHead;
      float z = uAmt * exp(-a * a / (uWidth * uWidth)) * uLambda / (abs(d) + uLambda);
      o = vec4(inkAt(p - z * uDir), 1.0);
    }`,

  vortex: AT + `uniform vec2 uCenter; uniform float uAngle; uniform float uSigma;
    void main() {
      vec2 p = bathPos() - uCenter;
      float th = -uAngle * exp(-dot(p, p) / (uSigma * uSigma));
      float c = cos(th), s = sin(th);
      o = vec4(inkAt(uCenter + vec2(c * p.x - s * p.y, s * p.x + c * p.y)), 1.0);
    }`,

  wave: AT + `uniform vec2 uDir; uniform float uAmt; uniform float uFreq; uniform float uPhase;
    void main() {
      vec2 p = bathPos();
      float z = uAmt * sin(dot(p, vec2(-uDir.y, uDir.x)) * uFreq + uPhase);
      o = vec4(inkAt(p - z * uDir), 1.0);
    }`,

  stamp: `uniform sampler2D uDye; uniform sampler2D uMask; uniform vec3 uColor; uniform float uAmt;
    void main() {
      vec3 c = texture(uDye, vUv).rgb;
      o = vec4(mix(c, uColor, texture(uMask, vUv).a * uAmt), 1.0);
    }`,

  // Wet ink under a moving light: veins darken where pigments meet, edges catch a glossy highlight.
  display: `uniform sampler2D uDye; uniform vec2 uDyeTexel; uniform vec2 uLight; uniform float uAspect; uniform vec3 uBath;
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    void main() {
      vec3 c = texture(uDye, vUv).rgb;
      // The bare bath (thickened water) gets a slow, cloudy depth of its own.
      vec2 np = vec2(vUv.x * uAspect, vUv.y);
      float cloud = vnoise(np * 3.0) * 0.6 + vnoise(np * 7.5) * 0.4;
      c *= mix(1.0, 0.8 + 0.42 * cloud, 1.0 - smoothstep(0.0, 0.06, distance(c, uBath)));
      vec2 t = uDyeTexel * 1.5;
      float l = luma(texture(uDye, vUv - vec2(t.x, 0.0)).rgb);
      float r = luma(texture(uDye, vUv + vec2(t.x, 0.0)).rgb);
      float u = luma(texture(uDye, vUv + vec2(0.0, t.y)).rgb);
      float b = luma(texture(uDye, vUv - vec2(0.0, t.y)).rgb);
      vec2 g = vec2(r - l, u - b);
      float edge = smoothstep(0.02, 0.22, length(g));
      c *= 1.0 - edge * 0.42;
      vec3 n = normalize(vec3(-g * 3.2, 1.0));
      vec2 pp = vec2(vUv.x * uAspect, vUv.y), lp = vec2(uLight.x * uAspect, uLight.y);
      vec3 L = normalize(vec3(lp - pp, 0.6));
      float ndh = max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0);
      c *= 0.92 + 0.12 * max(dot(n, L), 0.0);
      c += (pow(ndh, 50.0) * edge * 0.26 + pow(ndh, 1200.0) * 0.07) * vec3(1.0, 0.96, 0.88);
      vec2 dl = lp - pp;
      c += exp(-dot(dl, dl) * 14.0) * vec3(0.022, 0.02, 0.016);
      c += (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.03;
      vec2 q = vUv - 0.5;
      c *= 1.0 - dot(q, q) * 0.6;
      o = vec4(c, 1.0);
    }`,
};

const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeInOut = k => 0.5 - 0.5 * Math.cos(Math.PI * k);

export class Bath {
  constructor(canvas) {
    this.canvas = canvas;
    this.ops = [];
    this.snaps = [];
    this.time = 0;
    this.lastStir = -1e9;
    this.light = [0.5, 0.6];
    this.lightTarget = [0.5, 0.6];
    this.cfg = { pressureIters: 22, velDiss: 1.1, curl: 4, splatRadius: 0.0024 };
    this.palette = null;
  }

  // First entry is the bare bath; the rest are the inks.
  setPalette(colors) { this.palette = new Float32Array(colors.flat()); }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return false;
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return false;
    this.gl = gl;
    try {
      this.vs = this.shader(gl.VERTEX_SHADER, VS);
      this.p = {};
      for (const k in FS) this.p[k] = this.program(FS[k]);
    } catch (err) {
      console.warn('[houle] shader error', err);
      return false;
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    gl.disable(gl.BLEND);

    this.maskTex = gl.createTexture();
    this.resize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vel.read.fb);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  }

  shader(type, src) {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  program(src) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this.vs);
    gl.attachShader(p, this.shader(gl.FRAGMENT_SHADER, HEAD + src));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  fbo(w, h) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      tex, fb, w, h, texel: [1 / w, 1 / h],
      bind(unit) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); return unit; },
      free() { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); },
    };
  }

  double(w, h) {
    let a = this.fbo(w, h), b = this.fbo(w, h);
    return {
      w, h, texel: a.texel,
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
      free() { a.free(); b.free(); },
    };
  }

  // Resample an existing double buffer into a new size so the pattern survives a resize.
  redouble(old, w, h) {
    const next = this.double(w, h), gl = this.gl, u = this.use('copy');
    gl.uniform1i(u.uTex, old.read.bind(0));
    this.blit(next.read);
    old.free();
    return next;
  }

  res(base) {
    const a = this.aspect;
    let [w, h] = a >= 1 ? [Math.round(base * a), base] : [base, Math.round(base / a)];
    const cap = 2048 / Math.max(w, h);
    if (cap < 1) { w = Math.round(w * cap); h = Math.round(h * cap); }
    return [w, h];
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // A hidden or not-yet-laid-out page reports 0×0; build at a sane size and let the observer fix it later.
    const cw = this.canvas.clientWidth || innerWidth || 1280, ch = this.canvas.clientHeight || innerHeight || 720;
    this.canvas.width = Math.max(1, Math.round(cw * dpr));
    this.canvas.height = Math.max(1, Math.round(ch * dpr));
    this.aspect = cw / ch;
    const small = Math.min(cw, ch) < 600;
    const [sw, sh] = this.res(small ? 112 : 176);
    const [dw, dh] = this.res(small ? 760 : 1080);
    if (!this.vel) {
      this.vel = this.double(sw, sh);
      this.pres = this.double(sw, sh);
      this.dye = this.double(dw, dh);
      this.div = this.fbo(sw, sh);
      this.curlF = this.fbo(sw, sh);
      return;
    }
    if (this.vel.w !== sw || this.vel.h !== sh) {
      this.vel = this.redouble(this.vel, sw, sh);
      this.pres.free(); this.pres = this.double(sw, sh);
      this.div.free(); this.div = this.fbo(sw, sh);
      this.curlF.free(); this.curlF = this.fbo(sw, sh);
    }
    if (this.dye.w !== dw || this.dye.h !== dh) this.dye = this.redouble(this.dye, dw, dh);
  }

  get simSize() { return [this.vel.w, this.vel.h]; }
  get dyeSize() { return [this.dye.w, this.dye.h]; }

  use(name) {
    const p = this.p[name];
    this.gl.useProgram(p.p);
    return p.u;
  }

  blit(target) {
    const gl = this.gl;
    if (target) {
      gl.viewport(0, 0, target.w, target.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  dyePass(name, set) {
    const gl = this.gl, u = this.use(name);
    gl.uniform2f(u.uTexel, ...this.dye.texel);
    gl.uniform1i(u.uDye, this.dye.read.bind(0));
    gl.uniform1f(u.uAspect, this.aspect);
    set(u);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  // ---- immediate operations -------------------------------------------------

  fill(rgb) {
    const gl = this.gl;
    let u = this.use('fill');
    gl.uniform3f(u.uColor, ...rgb);
    this.blit(this.dye.write);
    this.dye.swap();
    u = this.use('scale');
    for (const buf of [this.vel, this.pres]) {
      gl.uniform1i(u.uTex, buf.read.bind(0));
      gl.uniform1f(u.uValue, 0);
      this.blit(buf.write);
      buf.swap();
    }
  }

  // x, y in uv (0..1, y up); dx, dy in sim texels per second.
  splat(x, y, dx, dy, radius = this.cfg.splatRadius) {
    const gl = this.gl, u = this.use('splat');
    gl.uniform1i(u.uTarget, this.vel.read.bind(0));
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform2f(u.uPoint, x, y);
    gl.uniform3f(u.uColor, dx, dy, 0);
    gl.uniform1f(u.uRadius, radius * Math.max(1, this.aspect));
    this.blit(this.vel.write);
    this.vel.swap();
    this.lastStir = this.time;
  }

  applyDrop(x, y, r2, rgb) {
    const gl = this.gl;
    this.dyePass('drop', u => {
      gl.uniform2f(u.uCenter, x, y);
      gl.uniform1f(u.uR2, r2);
      gl.uniform3f(u.uColor, ...rgb);
      gl.uniform1f(u.uPx, 1.2 / this.dye.h);
    });
  }

  // ---- animated operations (positions in bath units: x in [0, aspect], y in [0, 1]) ----

  addOp(op) {
    op.t = 0;
    op.k = 0;
    op.delay = op.delay || 0;
    op.dur = Math.max(op.dur, 1e-3);
    this.ops.push(op);
    return op;
  }

  clearOps() { this.ops.length = 0; }

  drop(x, y, r, rgb, dur = 0.6, delay = 0) {
    return this.addOp({
      dur, delay, ease: easeOut,
      apply: (k0, k1) => {
        const a = (r * k1) ** 2 - (r * k0) ** 2;
        if (a > 0) this.applyDrop(x, y, a, rgb);
      },
    });
  }

  tine({ origin, dir, spacing = 0, amount, lambda = 0.02, width = 0.2, dur = 1.4, delay = 0 }) {
    const len = Math.hypot(dir[0], dir[1]), M = [dir[0] / len, dir[1] / len], A = this.aspect;
    const proj = [[0, 0], [A, 0], [0, 1], [A, 1]].map(([x, y]) => (x - origin[0]) * M[0] + (y - origin[1]) * M[1]);
    const h0 = Math.min(...proj) - width * 2, h1 = Math.max(...proj) + width * 2;
    const norm = width * Math.sqrt(Math.PI);
    const gl = this.gl;
    return this.addOp({
      dur, delay, ease: easeInOut,
      apply: (k0, k1) => {
        const a = h0 + (h1 - h0) * k0, b = h0 + (h1 - h0) * k1;
        const steps = Math.max(1, Math.ceil(Math.abs(b - a) / (width * 0.35)));
        for (let i = 0; i < steps; i++) {
          const s0 = a + (b - a) * i / steps, s1 = a + (b - a) * (i + 1) / steps;
          this.dyePass('tine', u => {
            gl.uniform2f(u.uOrigin, origin[0], origin[1]);
            gl.uniform2f(u.uDir, M[0], M[1]);
            gl.uniform1f(u.uSpacing, spacing);
            gl.uniform1f(u.uAmt, amount * (s1 - s0) / norm);
            gl.uniform1f(u.uLambda, lambda);
            gl.uniform1f(u.uHead, (s0 + s1) / 2);
            gl.uniform1f(u.uWidth, width);
          });
        }
      },
    });
  }

  vortex({ center, angle, sigma = 0.07, dur = 1, delay = 0 }) {
    const gl = this.gl;
    return this.addOp({
      dur, delay, ease: easeInOut,
      apply: (k0, k1) => this.dyePass('vortex', u => {
        gl.uniform2f(u.uCenter, center[0], center[1]);
        gl.uniform1f(u.uAngle, angle * (k1 - k0));
        gl.uniform1f(u.uSigma, sigma);
      }),
    });
  }

  wave({ dir, amount, freq, phase = 0, dur = 1.4, delay = 0 }) {
    const len = Math.hypot(dir[0], dir[1]), gl = this.gl;
    return this.addOp({
      dur, delay, ease: easeInOut,
      apply: (k0, k1) => this.dyePass('wave', u => {
        gl.uniform2f(u.uDir, dir[0] / len, dir[1] / len);
        gl.uniform1f(u.uAmt, amount * (k1 - k0));
        gl.uniform1f(u.uFreq, freq);
        gl.uniform1f(u.uPhase, phase);
      }),
    });
  }

  // Lay ink in the shape of a 2D canvas (white on transparent), fading in over `dur`.
  stamp(source, rgb, dur = 0.8, delay = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return this.addOp({
      dur, delay, ease: easeOut,
      apply: (k0, k1) => this.dyePass('stamp', u => {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
        gl.uniform1i(u.uMask, 1);
        gl.uniform3f(u.uColor, ...rgb);
        gl.uniform1f(u.uAmt, k0 >= 1 ? 1 : (k1 - k0) / (1 - k0));
      }),
    });
  }

  setLight(x, y) { this.lightTarget[0] = x; this.lightTarget[1] = y; }

  // Resolves with fn(canvas) right after the next frame is drawn, while the drawing buffer is still valid.
  snapshot(fn) { return new Promise(res => this.snaps.push(() => res(fn(this.canvas)))); }

  // ---- simulation ------------------------------------------------------------

  step(dt) {
    const gl = this.gl, { vel, pres } = this;
    let u = this.use('curl');
    gl.uniform2f(u.uTexel, ...vel.texel);
    gl.uniform1i(u.uVelocity, vel.read.bind(0));
    this.blit(this.curlF);

    u = this.use('vorticity');
    gl.uniform2f(u.uTexel, ...vel.texel);
    gl.uniform1i(u.uVelocity, vel.read.bind(0));
    gl.uniform1i(u.uCurl, this.curlF.bind(1));
    gl.uniform1f(u.uCurlAmt, this.cfg.curl);
    gl.uniform1f(u.uDt, dt);
    this.blit(vel.write);
    vel.swap();

    u = this.use('divergence');
    gl.uniform2f(u.uTexel, ...vel.texel);
    gl.uniform1i(u.uVelocity, vel.read.bind(0));
    this.blit(this.div);

    u = this.use('scale');
    gl.uniform1i(u.uTex, pres.read.bind(0));
    gl.uniform1f(u.uValue, 0.8);
    this.blit(pres.write);
    pres.swap();

    u = this.use('pressure');
    gl.uniform2f(u.uTexel, ...vel.texel);
    gl.uniform1i(u.uDivergence, this.div.bind(0));
    for (let i = 0; i < this.cfg.pressureIters; i++) {
      gl.uniform1i(u.uPressure, pres.read.bind(1));
      this.blit(pres.write);
      pres.swap();
    }

    u = this.use('gradient');
    gl.uniform2f(u.uTexel, ...vel.texel);
    gl.uniform1i(u.uPressure, pres.read.bind(0));
    gl.uniform1i(u.uVelocity, vel.read.bind(1));
    this.blit(vel.write);
    vel.swap();

    u = this.use('advect');
    gl.uniform2f(u.uVelTexel, ...vel.texel);
    gl.uniform1i(u.uVelocity, vel.read.bind(0));
    gl.uniform1i(u.uSource, vel.read.bind(0));
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uDiss, this.cfg.velDiss);
    this.blit(vel.write);
    vel.swap();

    gl.uniform1i(u.uVelocity, vel.read.bind(0));
    gl.uniform1i(u.uSource, this.dye.read.bind(1));
    gl.uniform1f(u.uDiss, 0);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  render() {
    const gl = this.gl, u = this.use('display');
    gl.uniform1i(u.uDye, this.dye.read.bind(0));
    gl.uniform2f(u.uDyeTexel, ...this.dye.texel);
    gl.uniform2f(u.uLight, ...this.light);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform3f(u.uBath, ...(this.palette ? this.palette.subarray(0, 3) : [0, 0, 0]));
    this.blit(null);
  }

  sharpen(k) {
    const gl = this.gl;
    this.dyePass('sharpen', u => {
      gl.uniform3fv(u['uPal[0]'], this.palette);
      gl.uniform1f(u.uK, k);
    });
  }

  // `dt` drives the solver and stays small for stability; `wall` is real elapsed time, so the
  // exact ink transforms keep their choreography on schedule even when frames are dropped.
  frame(dt, wall = dt) {
    this.time += wall;
    let changed = false;
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i];
      if (op.delay > 0) { op.delay -= wall; continue; }
      op.t += wall;
      const k1 = op.ease(Math.min(1, op.t / op.dur));
      op.apply(op.k, k1);
      op.k = k1;
      changed = true;
      if (op.t >= op.dur) this.ops.splice(i--, 1);
    }
    // Once the bath has been still for a while there is nothing left to advect: skip the solver.
    if (this.time - this.lastStir < 9) { this.step(dt); changed = true; }
    if (changed && this.palette) this.sharpen(0.14);
    const e = Math.min(1, dt * 5);
    this.light[0] += (this.lightTarget[0] - this.light[0]) * e;
    this.light[1] += (this.lightTarget[1] - this.light[1]) * e;
    this.render();
    if (this.snaps.length) this.snaps.splice(0).forEach(f => f());
  }
}
