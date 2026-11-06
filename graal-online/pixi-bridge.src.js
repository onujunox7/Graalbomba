/* ===== PixiJS bridge =====
   Troca o render do canvas principal (#c) de Canvas2D para WebGL via PixiJS v7,
   SEM mexer na lógica do jogo: o objeto `g` continua com a mesma API do CanvasRenderingContext2D
   (fillRect, drawImage, fillText, paths, save/restore, clip, gradiente linear...), mas cada chamada
   vira um Sprite/Graphics do Pixi, desenhado no fim do frame.
   Se o Pixi não carregar, ou o WebGL falhar, ou a URL tiver ?canvas2d=1, volta sozinho pro Canvas2D antigo. */
(function () {
  'use strict';
  window.__PIXI_ON = false;
  if (/[?&]canvas2d=1/.test(location.search)) return;

  /* 1) marca versão nos canvases que o jogo altera (editor, tocos de árvore, rótulos...) para o Pixi saber quando reenviar à GPU */
  try {
    const P = CanvasRenderingContext2D.prototype;
    ['drawImage', 'fillRect', 'clearRect', 'strokeRect', 'fill', 'stroke', 'fillText', 'strokeText', 'putImageData'].forEach(n => {
      const o = P[n]; if (!o) return;
      P[n] = function (...a) { const c = this.canvas; if (c) c.__v = (c.__v | 0) + 1; return o.apply(this, a) };
    });
  } catch (e) { }

  window.__mkGfx = function (cv) {
    try {
      if (!window.PIXI) throw new Error('PIXI ausente');
      return new PixiCtx(cv);
    } catch (err) {
      console.warn('[Pixi] usando Canvas2D:', err && err.message || err);
      window.__PIXI_ON = false;
      return null;
    }
  };

  const NEAREST = 0, LINEAR = 1;
  const colorCv = document.createElement('canvas').getContext('2d');
  const colorCache = new Map();
  /* qualquer cor CSS -> [hex, alpha] */
  function parseColor(s) {
    let r = colorCache.get(s); if (r) return r;
    colorCv.fillStyle = '#000'; colorCv.fillStyle = s;
    const n = colorCv.fillStyle; let hex = 0, a = 1;
    if (n[0] === '#') hex = parseInt(n.slice(1), 16);
    else { const m = n.match(/[\d.]+/g) || [0, 0, 0, 1]; hex = (m[0] << 16) | (m[1] << 8) | (+m[2]); a = m.length > 3 ? +m[3] : 1 }
    r = [hex, a]; if (colorCache.size > 800) colorCache.clear(); colorCache.set(s, r); return r;
  }

  class PixiCtx {
    constructor(cv) {
      const PIXI = window.PIXI;
      this.canvas = cv;
      PIXI.settings.ROUND_PIXELS = false;
      PIXI.BaseTexture.defaultOptions.scaleMode = NEAREST;
      this.r = PIXI.autoDetectRenderer({
        view: cv, width: cv.width || 1, height: cv.height || 1, antialias: false, resolution: 1,
        backgroundColor: 0x000000, backgroundAlpha: 1, powerPreference: 'high-performance',
        clearBeforeRender: true, autoDensity: false
      });
      if (!this.r || this.r.type !== PIXI.RENDERER_TYPE.WEBGL) throw new Error('sem WebGL');
      this.root = new PIXI.Container();
      this.M = new PIXI.Matrix();
      this.sp = []; this.gp = []; this.si = 0; this.gi = 0; // pools
      this.snaps = []; this.sni = 0;
      this.cache = new Map(); // texturas de texto/gradiente (LRU)
      this.bases = new WeakMap();
      this.dead = []; this.grave = [];
      this.frame = 0; this.open = false; this.rw = cv.width; this.rh = cv.height;
      // estado 2D
      this.m = [1, 0, 0, 1, 0, 0]; this.globalAlpha = 1; this.fillStyle = '#000'; this.strokeStyle = '#000';
      this.lineWidth = 1; this.lineJoin = 'miter'; this.lineCap = 'butt'; this.font = '10px sans-serif';
      this.textAlign = 'left'; this.textBaseline = 'alphabetic';
      this.imageSmoothingEnabled = true; this.imageSmoothingQuality = 'low'; this.lineDashOffset = 0;
      this.stack = []; this.path = []; this.sub = null;
      this.rootL = []; this.cur = this.rootL;
      this.tc = document.createElement('canvas').getContext('2d');
      window.__PIXI_ON = true; window.__PIXI_FORGET = src => this.forget(src);
      // re-renderiza o último frame se o canvas for redimensionado fora do ciclo de desenho
      const watch = () => { if (!this.open && (cv.width !== this.rw || cv.height !== this.rh)) this.paint(); requestAnimationFrame(watch) };
      requestAnimationFrame(watch);
    }

    /* ---------- ciclo do frame ---------- */
    touch() {
      if (this.open) return; this.open = true; this.frame++;
      this.si = 0; this.gi = 0; this.sni = 0; this.rootL = []; this.cur = this.rootL; this.stack.length = 0;
      queueMicrotask(() => { this.open = false; this.paint() });
    }
    paint() {
      const cv = this.canvas;
      if (cv.width !== this.rw || cv.height !== this.rh) { this.rw = cv.width; this.rh = cv.height; this.r.resize(this.rw, this.rh) }
      for (const d of this.dead) { try { d.destroy({ children: false }) } catch (e) { } } this.dead.length = 0;
      this.build(this.root, this.rootL);
      this.r.render(this.root);
      for (const t of this.grave) { try { t.destroy(true) } catch (e) { } } this.grave.length = 0;
    }
    build(c, list) {
      c.removeChildren();
      for (const it of list) { c.addChild(it); if (it.__cl) { this.build(it, it.__cl); this.dead.push(it, it.__cl[0]) } }
    }
    sc() { const m = this.m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1 }

    /* ---------- pools ---------- */
    spr() {
      let s = this.sp[this.si++];
      if (!s) { s = new PIXI.Sprite(PIXI.Texture.WHITE); this.sp.push(s) }
      s.tint = 0xffffff; s.alpha = 1; s.visible = true; return s;
    }
    gfx() {
      let s = this.gp[this.gi++];
      if (!s) { s = new PIXI.Graphics(); this.gp.push(s) }
      s.clear(); s.alpha = 1; return s;
    }
    place(s, w, h, dx, dy, dw, dh) { // texto/imagem w×h (px da textura) desenhada em (dx,dy,dw,dh) com a matriz atual
      const m = this.m, sx = dw / w, sy = dh / h;
      this.M.set(m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[0] * dx + m[2] * dy + m[4], m[1] * dx + m[3] * dy + m[5]);
      s.transform.setFromMatrix(this.M);
    }

    /* ---------- texturas ---------- */
    entry(src) {
      let e = this.bases.get(src);
      const isC = src instanceof HTMLCanvasElement, w = isC ? src.width : (src.naturalWidth || src.width), h = isC ? src.height : (src.naturalHeight || src.height);
      if (!w || !h) return null;
      if (e && (e.w !== w || e.h !== h)) { try { e.base.destroy() } catch (x) { } e = null }
      if (!e) {
        const base = PIXI.BaseTexture.from(src, { scaleMode: NEAREST, mipmap: PIXI.MIPMAP_MODES.OFF });
        e = { base, w, h, v: src.__v | 0, tex: new Map(), last: 0, dyn: false, sm: false };
        this.bases.set(src, e);
      } else if (isC && e.v !== (src.__v | 0)) {
        if (e.last === this.frame && w * h <= 65536) e.dyn = true; // mudou DENTRO do mesmo frame (ex.: canvas do personagem) -> precisa de cópia por uso
        e.v = src.__v | 0; e.base.update();
      }
      e.last = this.frame; return e;
    }
    subTex(e, sx, sy, sw, sh) {
      const k = sx + ',' + sy + ',' + sw + ',' + sh; let t = e.tex.get(k);
      if (!t) { t = new PIXI.Texture(e.base, new PIXI.Rectangle(sx, sy, sw, sh)); if (e.tex.size > 400) e.tex.clear(); e.tex.set(k, t) }
      return t;
    }
    snap(src, sx, sy, sw, sh) { // canvas que muda várias vezes por frame (ex.: montagem do personagem): textura por CONTEÚDO, reaproveitada entre frames e jogadores
      let id = null;
      try { id = src.getContext('2d').getImageData(sx, sy, sw, sh) } catch (e) { }
      if (id) {
        const u = new Uint32Array(id.data.buffer), n = u.length; let h1 = 2166136261, h2 = 5381;
        for (let i = 0; i < n; i++) { const v = u[i]; h1 = Math.imul(h1 ^ v, 16777619); h2 = (Math.imul(h2, 33) + v) | 0 }
        const key = 'k|' + sw + 'x' + sh + '|' + (h1 >>> 0) + '|' + (h2 >>> 0);
        return this.lru(key, () => {
          const c = document.createElement('canvas'); c.width = sw; c.height = sh; c.getContext('2d').putImageData(id, 0, 0);
          return PIXI.Texture.from(c, { scaleMode: NEAREST });
        });
      }
      let s = this.snaps[this.sni++];
      if (!s) { s = { c: document.createElement('canvas') }; this.snaps.push(s) }
      if (!s.base || s.c.width !== sw || s.c.height !== sh) {
        if (s.base) { try { s.tex.destroy(true) } catch (e) { } }
        s.c.width = sw; s.c.height = sh; s.x = s.c.getContext('2d');
        s.base = PIXI.BaseTexture.from(s.c, { scaleMode: NEAREST, mipmap: PIXI.MIPMAP_MODES.OFF }); s.tex = new PIXI.Texture(s.base);
      }
      s.x.clearRect(0, 0, sw, sh); s.x.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh); s.base.update();
      return s.tex;
    }
    lru(key, build) {
      let t = this.cache.get(key);
      if (t) { this.cache.delete(key); this.cache.set(key, t); return t }
      t = build(); this.cache.set(key, t);
      if (this.cache.size > 700) { const k = this.cache.keys().next().value; this.grave.push(this.cache.get(k)); this.cache.delete(k) }
      return t;
    }

    /* ---------- desenho ---------- */
    add(s) { this.cur.push(s) }
    drawImage(src, a, b, c, d, e, f, g2, h2) {
      if (!src) return; this.touch();
      let sx = 0, sy = 0, sw, sh, dx, dy, dw, dh;
      const isC = src instanceof HTMLCanvasElement;
      if (!isC && src instanceof HTMLImageElement && !(src.complete && src.naturalWidth)) return;
      const W = isC ? src.width : (src.naturalWidth || src.width), H = isC ? src.height : (src.naturalHeight || src.height);
      if (arguments.length >= 9) { sx = a; sy = b; sw = c; sh = d; dx = e; dy = f; dw = g2; dh = h2 }
      else if (arguments.length >= 5) { sw = W; sh = H; dx = a; dy = b; dw = c; dh = d }
      else { sw = W; sh = H; dx = a; dy = b; dw = W; dh = H }
      if (!(sw && sh && dw && dh) || !W || !H) return;
      // recorta o retângulo de origem ao tamanho real (igual ao Canvas2D)
      if (sx < 0) { dx -= sx * dw / sw; dw += sx * dw / sw; sw += sx; sx = 0 } if (sy < 0) { dy -= sy * dh / sh; dh += sy * dh / sh; sh += sy; sy = 0 }
      if (sx + sw > W) { const o = sx + sw - W; dw -= o * dw / sw; sw -= o } if (sy + sh > H) { const o = sy + sh - H; dh -= o * dh / sh; sh -= o }
      if (!(sw > 0 && sh > 0)) return;
      const ix = Math.round(sx), iy = Math.round(sy), iw = Math.max(1, Math.round(sw)), ih = Math.max(1, Math.round(sh));
      const en = this.entry(src); if (!en || !en.base.valid) return;
      let tex;
      if (en.dyn) tex = this.snap(src, ix, iy, iw, ih); else tex = this.subTex(en, ix, iy, iw, ih);
      const sm = !!this.imageSmoothingEnabled; if (en.sm !== sm) { en.sm = sm; en.base.scaleMode = sm ? LINEAR : NEAREST }
      const s = this.spr(); s.texture = tex; s.alpha = this.globalAlpha;
      this.place(s, iw, ih, dx, dy, dw * iw / sw, dh * ih / sh); this.add(s);
    }
    forget(src) {
      const e = this.bases.get(src); if (!e) return; this.bases.delete(src);
      this.grave.push({ destroy() { try { e.tex.forEach(t => t.destroy(false)); e.base.destroy() } catch (x) { } } });
    }
    chunk(cvs, dx, dy, dw, dh) { this.drawImage(cvs, 0, 0, cvs.width, cvs.height, dx, dy, dw, dh) }
    rectSprite(x, y, w, h, hex, a) {
      const s = this.spr(); s.texture = PIXI.Texture.WHITE; s.tint = hex; s.alpha = a * this.globalAlpha;
      this.place(s, 16, 16, x, y, w, h); this.add(s);
    }
    fillRect(x, y, w, h) {
      this.touch(); if (!w || !h) return;
      const fs = this.fillStyle;
      if (fs && fs.__grad) return this.gradRect(x, y, w, h, fs);
      const [hex, a] = parseColor(fs); if (a <= 0) return;
      this.rectSprite(x, y, w, h, hex, a);
    }
    clearRect(x, y, w, h) { /* o jogo só usa para limpar canvases auxiliares */ }
    gradRect(x, y, w, h, gr) {
      const s = Math.max(1, Math.ceil(this.sc())), cw = Math.max(1, Math.ceil(Math.abs(w) * s)), ch = Math.max(1, Math.ceil(Math.abs(h) * s));
      const key = 'g|' + cw + 'x' + ch + '|' + [gr.x0 - x, gr.y0 - y, gr.x1 - x, gr.y1 - y].join(',') + '|' + gr.stops.map(t => t[0] + t[1]).join(';');
      const tex = this.lru(key, () => {
        const c = document.createElement('canvas'); c.width = cw; c.height = ch; const q = c.getContext('2d');
        const kx = cw / Math.abs(w), ky = ch / Math.abs(h), G = q.createLinearGradient((gr.x0 - x) * kx, (gr.y0 - y) * ky, (gr.x1 - x) * kx, (gr.y1 - y) * ky);
        gr.stops.forEach(t => G.addColorStop(t[0], t[1])); q.fillStyle = G; q.fillRect(0, 0, cw, ch);
        return PIXI.Texture.from(c, { scaleMode: LINEAR });
      });
      const sp = this.spr(); sp.texture = tex; sp.alpha = this.globalAlpha; this.place(sp, cw, ch, x, y, w, h); this.add(sp);
    }
    createLinearGradient(x0, y0, x1, y1) { return { __grad: 1, x0, y0, x1, y1, stops: [], addColorStop(o, c) { this.stops.push([o, c]) } } }

    /* ---------- texto (rasterizado uma vez por combinação e guardado em cache) ---------- */
    measureText(t) { this.tc.font = this.font; return this.tc.measureText(t) }
    text(txt, x, y, stroke) {
      txt = String(txt); if (!txt) return; this.touch();
      const color = stroke ? this.strokeStyle : this.fillStyle; if (color && color.__grad) return;
      const s = Math.max(1, Math.round(this.sc())), font = this.font, lw = stroke ? this.lineWidth : 0;
      const m = /(\d+(?:\.\d+)?)px/.exec(font), size = m ? +m[1] : 10;
      const key = 't|' + s + '|' + font + '|' + (stroke ? 's' + lw + this.lineJoin : 'f') + '|' + color + '|' + txt;
      const o = this.lru(key, () => {
        const q = this.tc; q.font = font.replace(/(\d+(?:\.\d+)?)px/, (size * s) + 'px'); q.lineJoin = this.lineJoin; q.lineWidth = lw * s;
        const wpx = q.measureText(txt).width, pad = Math.ceil(lw * s) + 2, asc = pad + Math.ceil(size * s * 1.15);
        const c = document.createElement('canvas'); c.width = Math.ceil(wpx) + pad * 2; c.height = asc + Math.ceil(size * s * 0.5) + pad;
        const x2 = c.getContext('2d'); x2.font = q.font; x2.textAlign = 'left'; x2.textBaseline = 'alphabetic'; x2.lineJoin = this.lineJoin; x2.lineWidth = lw * s;
        if (stroke) { x2.strokeStyle = color; x2.strokeText(txt, pad, asc) } else { x2.fillStyle = color; x2.fillText(txt, pad, asc) }
        const t = PIXI.Texture.from(c, { scaleMode: LINEAR }); t.__m = { w: c.width, h: c.height, asc, pad, wpx }; return t;
      });
      const k = o.__m, al = this.textAlign, off = al === 'center' ? -k.wpx / 2 : (al === 'right' || al === 'end') ? -k.wpx : 0;
      let by = 0; if (this.textBaseline === 'middle') by = size * s * 0.35; else if (this.textBaseline === 'top') by = size * s * 0.8; else if (this.textBaseline === 'bottom') by = -size * s * 0.2;
      const sp = this.spr(); sp.texture = o; sp.alpha = this.globalAlpha;
      this.place(sp, k.w, k.h, x + (off - k.pad) / s, y - (k.asc - by) / s, k.w / s, k.h / s); this.add(sp);
    }
    fillText(t, x, y) { this.text(t, x, y, false) }
    strokeText(t, x, y) { this.text(t, x, y, true) }

    /* ---------- transformações e estado ---------- */
    setTransform(a, b, c, d, e, f) { if (a && a.a !== undefined) { const o = a; a = o.a; b = o.b; c = o.c; d = o.d; e = o.e; f = o.f } this.m = [a, b, c, d, e, f] }
    resetTransform() { this.m = [1, 0, 0, 1, 0, 0] }
    transform(a, b, c, d, e, f) { const m = this.m; this.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]] }
    translate(x, y) { const m = this.m; this.m = [m[0], m[1], m[2], m[3], m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] }
    scale(x, y) { const m = this.m; this.m = [m[0] * x, m[1] * x, m[2] * y, m[3] * y, m[4], m[5]] }
    rotate(t) { const m = this.m, c = Math.cos(t), s = Math.sin(t); this.m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, -m[0] * s + m[2] * c, -m[1] * s + m[3] * c, m[4], m[5]] }
    save() { this.touch(); this.stack.push({ m: this.m, ga: this.globalAlpha, fs: this.fillStyle, ss: this.strokeStyle, lw: this.lineWidth, lj: this.lineJoin, f: this.font, ta: this.textAlign, tb: this.textBaseline, sm: this.imageSmoothingEnabled, cur: this.cur }) }
    restore() { const s = this.stack.pop(); if (!s) return; this.m = s.m; this.globalAlpha = s.ga; this.fillStyle = s.fs; this.strokeStyle = s.ss; this.lineWidth = s.lw; this.lineJoin = s.lj; this.font = s.f; this.textAlign = s.ta; this.textBaseline = s.tb; this.imageSmoothingEnabled = s.sm; this.cur = s.cur }
    setLineDash() { } getLineDash() { return [] }

    /* ---------- paths ---------- */
    beginPath() { this.path = []; this.sub = null }
    moveTo(x, y) { this.sub = { p: [x, y], c: false }; this.path.push(this.sub) }
    lineTo(x, y) { if (!this.sub) return this.moveTo(x, y); this.sub.p.push(x, y) }
    closePath() { if (this.sub) { this.sub.c = true; const p = this.sub.p; this.sub = { p: [p[0], p[1]], c: false }; this.path.push(this.sub) } }
    rect(x, y, w, h) { this.path.push({ p: [x, y, x + w, y, x + w, y + h, x, y + h], c: true, rect: [x, y, w, h] }); this.sub = { p: [x, y], c: false }; this.path.push(this.sub) }
    arcPts(cx, cy, rx, ry, rot, a0, a1, ccw) {
      let d = a1 - a0; const T = Math.PI * 2;
      if (!ccw) { if (d < 0) d = (d % T) + T; if (d > T) d = T } else { if (d > 0) d = (d % T) - T; if (d < -T) d = -T }
      const n = Math.max(6, Math.ceil(Math.abs(d) / (Math.PI / 12))), cs = Math.cos(rot), sn = Math.sin(rot), o = [];
      for (let i = 0; i <= n; i++) { const a = a0 + d * i / n, px = Math.cos(a) * rx, py = Math.sin(a) * ry; o.push(cx + px * cs - py * sn, cy + px * sn + py * cs) }
      return o;
    }
    addPts(pts) { if (!this.sub) { this.sub = { p: [pts[0], pts[1]], c: false }; this.path.push(this.sub) } const p = this.sub.p; for (let i = 0; i < pts.length; i++) p.push(pts[i]) }
    arc(x, y, r, a0, a1, ccw) { this.addPts(this.arcPts(x, y, r, r, 0, a0, a1, ccw)) }
    ellipse(x, y, rx, ry, rot, a0, a1, ccw) { this.addPts(this.arcPts(x, y, rx, ry, rot, a0, a1, ccw)) }
    arcTo(x1, y1, x2, y2, r) {
      if (!this.sub) return this.moveTo(x1, y1);
      const p = this.sub.p, x0 = p[p.length - 2], y0 = p[p.length - 1];
      let ux = x0 - x1, uy = y0 - y1, vx = x2 - x1, vy = y2 - y1;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (!lu || !lv || !r) return this.lineTo(x1, y1);
      ux /= lu; uy /= lu; vx /= lv; vy /= lv;
      const cosA = Math.max(-1, Math.min(1, ux * vx + uy * vy)), ang = Math.acos(cosA);
      if (ang < 1e-4 || Math.abs(ang - Math.PI) < 1e-4) return this.lineTo(x1, y1);
      const d = r / Math.tan(ang / 2), t1x = x1 + ux * d, t1y = y1 + uy * d, t2x = x1 + vx * d, t2y = y1 + vy * d;
      let bx = ux + vx, by = uy + vy; const lb = Math.hypot(bx, by); bx /= lb; by /= lb;
      const h = r / Math.sin(ang / 2), cx = x1 + bx * h, cy = y1 + by * h;
      const s0 = Math.atan2(t1y - cy, t1x - cx); let dl = Math.atan2(t2y - cy, t2x - cx) - s0;
      while (dl > Math.PI) dl -= 2 * Math.PI; while (dl <= -Math.PI) dl += 2 * Math.PI;
      this.lineTo(t1x, t1y); this.addPts(this.arcPts(cx, cy, r, r, 0, s0, s0 + dl, dl < 0));
    }
    tp(p) { const m = this.m, o = []; for (let i = 0; i < p.length; i += 2) o.push(m[0] * p[i] + m[2] * p[i + 1] + m[4], m[1] * p[i] + m[3] * p[i + 1] + m[5]); return o }
    fill() {
      this.touch(); const fs = this.fillStyle; let col = fs;
      if (fs && fs.__grad) col = (fs.stops[fs.stops.length - 1] || [0, '#000'])[1];
      const [hex, a] = parseColor(col); if (a <= 0) return;
      const G = this.gfx(); G.alpha = this.globalAlpha; G.beginFill(hex, a);
      for (const s of this.path) if (s.p.length >= 6) G.drawPolygon(this.tp(s.p));
      G.endFill(); this.add(G);
    }
    stroke() {
      this.touch(); const [hex, a] = parseColor(this.strokeStyle); if (a <= 0) return;
      const G = this.gfx(); G.alpha = this.globalAlpha; const J = PIXI.LINE_JOIN;
      G.lineStyle({ width: Math.max(0.01, this.lineWidth * this.sc()), color: hex, alpha: a, alignment: 0.5, join: this.lineJoin === 'round' ? J.ROUND : this.lineJoin === 'bevel' ? J.BEVEL : J.MITER });
      for (const s of this.path) { if (s.p.length < 4) continue; const q = this.tp(s.p); G.moveTo(q[0], q[1]); for (let i = 2; i < q.length; i += 2) G.lineTo(q[i], q[i + 1]); if (s.c) G.closePath() }
      this.add(G);
    }
    strokeRect(x, y, w, h) { const sp = this.path, ss = this.sub; this.beginPath(); this.rect(x, y, w, h); this.stroke(); this.path = sp; this.sub = ss }
    clip() {
      this.touch(); const mask = new PIXI.Graphics(); mask.beginFill(0xffffff, 1);
      for (const s of this.path) {
        if (s.p.length < 6) continue; const m = this.m;
        if (s.rect && !m[1] && !m[2]) { const r = s.rect, x0 = m[0] * r[0] + m[4], y0 = m[3] * r[1] + m[5], x1 = m[0] * (r[0] + r[2]) + m[4], y1 = m[3] * (r[1] + r[3]) + m[5]; mask.drawRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)) }
        else mask.drawPolygon(this.tp(s.p));
      }
      mask.endFill();
      const c = new PIXI.Container(); c.mask = mask; c.__cl = [mask];
      this.cur.push(c); this.cur = c.__cl;
    }
  }
})();
