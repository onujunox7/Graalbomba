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


  /* ?prof=1 -> medidor no canto da tela: onde o tempo de cada quadro está indo (atualização, desenho, Pixi) */
  if (/[?&]prof=1/.test(location.search)) {
    const P = window.__PROF = { n: 0, u: 0, d: 0, p: 0, it: 0, t0: performance.now(), el: null };
    P.f = (u, d) => { P.n++; P.u += u; P.d += d };
    P.pp = (ms, it) => { P.p += ms; P.it = it };
    const show = () => {
      const now = performance.now(), s = (now - P.t0) / 1000, n = Math.max(1, P.n);
      const txt = Math.round(P.n / s) + ' fps | update ' + (P.u / n).toFixed(2) + ' ms | draw(JS) ' + (P.d / n).toFixed(2) + ' ms | Pixi ' + (P.p / n).toFixed(2) + ' ms | itens ' + P.it + ' | puladas ' + (P.sk | 0) + ' | ' + (window.__PIXI_ON ? 'Pixi' : 'Canvas2D');
      if (!P.el) { P.el = document.createElement('div'); P.el.style.cssText = 'position:fixed;left:6px;top:6px;z-index:99999;background:#000c;color:#9f9;font:11px monospace;padding:3px 6px;border-radius:4px;pointer-events:none'; (document.body || document.documentElement).appendChild(P.el) }
      P.el.textContent = txt; console.log('[prof]', txt); P.n = P.u = P.d = P.p = 0; P.sk = 0; P.t0 = now;
    };
    setInterval(show, 1000);
  }

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
      this.lastSig = null; this.texDirty = true; this.noSkip = false; this.tid = 0; // quadro igual ao anterior => não redesenha
      this.frame = 0; this.open = false; this.rw = cv.width; this.rh = cv.height;
      // estado 2D
      this.m = [1, 0, 0, 1, 0, 0]; this.globalAlpha = 1; this.fillStyle = '#000'; this.strokeStyle = '#000';
      this.lineWidth = 1; this.lineJoin = 'miter'; this.lineCap = 'butt'; this.font = '10px sans-serif';
      this.textAlign = 'left'; this.textBaseline = 'alphabetic';
      this.imageSmoothingEnabled = true; this.imageSmoothingQuality = 'low'; this.lineDashOffset = 0;
      this.dash = []; this.stack = []; this.path = []; this.sub = null;
      this.rootL = []; this.cur = this.rootL;
      this.tc = document.createElement('canvas').getContext('2d');
      window.__PIXI_ON = true; window.__PIXI_FORGET = src => this.forget(src);
      cv.addEventListener('webglcontextrestored', () => { this.lastSig = null; this.texDirty = true });
      // re-renderiza o último frame se o canvas for redimensionado fora do ciclo de desenho
      const watch = () => { if (!this.open && (cv.width !== this.rw || cv.height !== this.rh)) this.paint(); requestAnimationFrame(watch) };
      requestAnimationFrame(watch);
    }

    /* ---------- ciclo do frame ---------- */
    touch() {
      if (this.open) return; this.open = true; this.frame++; this.noSkip = false;
      this.si = 0; this.gi = 0; this.sni = 0; this.rootL = []; this.cur = this.rootL; this.stack.length = 0;
      queueMicrotask(() => { this.open = false; this.paint() });
    }
    paint() {
      const _t = window.__PROF ? performance.now() : 0;
      const cv = this.canvas; let force = false;
      if (cv.width !== this.rw || cv.height !== this.rh) { this.rw = cv.width; this.rh = cv.height; this.r.resize(this.rw, this.rh); force = true }
      for (const d of this.dead) { try { d.destroy({ children: false }) } catch (e) { } } this.dead.length = 0;
      // assinatura do quadro (textura, posição, escala, alfa e cor de cada item): se for igual à do último quadro desenhado e nenhuma
      // textura mudou de conteúdo, a tela já está certa e nem remontamos a cena nem mandamos nada para a GPU.
      const sig = this.sigList(this.rootL, 2166136261, 0) ^ (this.rw * 31 + this.rh);
      if (!force && !this.noSkip && !this.texDirty && this.lastSig !== null && sig === this.lastSig) {
        for (const t of this.grave) { try { t.destroy(true) } catch (e) { } } this.grave.length = 0;
        if (window.__PROF) { window.__PROF.sk = (window.__PROF.sk | 0) + 1; window.__PROF.pp(performance.now() - _t, this.si + this.gi) }
        return;
      }
      this.build(this.root, this.rootL);
      this.r.render(this.root);
      if (window.__BLOOM > 0) this.bloom();
      this.lastSig = this.noSkip ? null : sig; this.texDirty = false;
      for (const t of this.grave) { try { t.destroy(true) } catch (e) { } } this.grave.length = 0;
      if (_t) window.__PROF.pp(performance.now() - _t, this.si + this.gi);
    }
    /* v26.17 bloom: cena em 1/4 de resolução -> passa só as partes claras -> desfoque -> soma (ADD) por cima. Se der erro, desliga sozinho. */
    bloom() {
      try {
        const lv = window.__BLOOM | 0, w = this.rw, h = this.rh, bw = Math.max(16, w >> 2), bh = Math.max(16, h >> 2);
        let B = this.bl;
        if (!B || B.w !== bw || B.h !== bh) {
          if (B) { try { B.r1.destroy(true); B.r2.destroy(true) } catch (e) { } }
          const r1 = PIXI.RenderTexture.create({ width: bw, height: bh }), r2 = PIXI.RenderTexture.create({ width: bw, height: bh });
          const s1 = new PIXI.Sprite(r1), cm = new PIXI.ColorMatrixFilter(), bf = new PIXI.BlurFilter(3, 2);
          cm.matrix = [3, 0, 0, 0, -2, 0, 3, 0, 0, -2, 0, 0, 3, 0, -2, 0, 0, 0, 1, 0];
          s1.filters = [cm, bf];
          const s2 = new PIXI.Sprite(r2); s2.scale.set(w / bw, h / bh); s2.blendMode = PIXI.BLEND_MODES.ADD;
          B = this.bl = { w: bw, h: bh, r1, r2, s1, s2, bf, mx: new PIXI.Matrix(bw / w, 0, 0, bh / h, 0, 0) };
        }
        B.bf.blur = lv >= 2 ? 6 : 3; B.s2.alpha = lv >= 2 ? 0.8 : 0.4;
        this.r.render(this.root, { renderTexture: B.r1, clear: true, transform: B.mx });
        this.r.render(B.s1, { renderTexture: B.r2, clear: true });
        this.r.render(B.s2, { clear: false });
      } catch (e) { console.warn('[Pixi] bloom desligado:', e); window.__BLOOM = 0 }
    }
    build(c, list) {
      c.removeChildren();
      for (const it of list) { c.addChild(it); if (it.__cl) { this.build(it, it.__cl); this.dead.push(it, it.__cl[0]) } }
    }
    /* id próprio em cada textura (__id): não dependemos de Texture.uid, que o Pixi não garante */
    sigList(list, h, from) {
      const mx = (h, v) => Math.imul(h ^ ((v * 64) | 0), 16777619);
      for (let i = from; i < list.length; i++) {
        const it = list[i];
        if (it.__cl) { h = Math.imul(h ^ (it.__sg | 0), 16777619); h = this.sigList(it.__cl, h, 1); continue }
        const t = it.texture; if (!t) { this.noSkip = true; continue }
        const sc = it.scale, sk = it.skew;
        h = mx(h, t.__id || (t.__id = ++this.tid)); h = mx(h, it.x); h = mx(h, it.y); h = mx(h, sc.x); h = mx(h, sc.y); h = mx(h, sk.x); h = mx(h, sk.y); h = mx(h, it.rotation); h = mx(h, it.alpha * 255); h = mx(h, it.tint);
      }
      return h;
    }
    /* o retângulo (dx,dy,dw,dh), com a matriz atual, fica totalmente fora do canvas? (não adianta mandar pra GPU) */
    off(dx, dy, dw, dh) {
      const m = this.m, x1 = dx + dw, y1 = dy + dh;
      const a = m[0] * dx + m[2] * dy + m[4], b = m[0] * x1 + m[2] * dy + m[4], c = m[0] * dx + m[2] * y1 + m[4], d = m[0] * x1 + m[2] * y1 + m[4];
      const e = m[1] * dx + m[3] * dy + m[5], f = m[1] * x1 + m[3] * dy + m[5], g = m[1] * dx + m[3] * y1 + m[5], h = m[1] * x1 + m[3] * y1 + m[5];
      const W = this.canvas.width, H = this.canvas.height;
      return Math.max(a, b, c, d) <= 0 || Math.min(a, b, c, d) >= W || Math.max(e, f, g, h) <= 0 || Math.min(e, f, g, h) >= H;
    }
    sc() { const m = this.m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1 }

    /* ---------- pools ---------- */
    spr() {
      let s = this.sp[this.si++];
      if (!s) { s = new PIXI.Sprite(PIXI.Texture.WHITE); this.sp.push(s) }
      s.tint = 0xffffff; s.alpha = 1; s.visible = true; s.__vis = true; return s;
    }
    gfx() {
      let s = this.gp[this.gi++];
      if (!s) { s = new PIXI.Graphics(); this.gp.push(s) }
      s.clear(); s.alpha = 1; s.__vis = true; this.noSkip = true; return s;
    }
    place(s, w, h, dx, dy, dw, dh) { // texto/imagem w×h (px da textura) desenhada em (dx,dy,dw,dh) com a matriz atual
      const m = this.m, sx = dw / w, sy = dh / h;
      this.M.set(m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[0] * dx + m[2] * dy + m[4], m[1] * dx + m[3] * dy + m[5]);
      s.transform.setFromMatrix(this.M);
      s.__vis = !this.off(dx, dy, dw, dh);
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
        e.v = src.__v | 0; e.base.update(); this.texDirty = true;
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
      s.x.clearRect(0, 0, sw, sh); s.x.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh); s.base.update(); this.texDirty = true;
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
    add(s) { if (s.__vis !== false) this.cur.push(s) }
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
      if (this.off(dx, dy, dw, dh)) return; // fora da tela: nem cria textura nem sprite
      const ix = Math.round(sx), iy = Math.round(sy), iw = Math.max(1, Math.round(sw)), ih = Math.max(1, Math.round(sh));
      const en = this.entry(src); if (!en || !en.base.valid) return;
      let tex;
      if (en.dyn) tex = this.snap(src, ix, iy, iw, ih); else tex = this.subTex(en, ix, iy, iw, ih);
      const sm = !!this.imageSmoothingEnabled; if (en.sm !== sm) { en.sm = sm; en.base.scaleMode = sm ? LINEAR : NEAREST; this.texDirty = true }
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
      // se todas as paradas têm a MESMA cor e só o alfa muda (vinheta de dano, sombras), a textura é feita com alfa normalizado
      // e o alfa máximo vai no sprite: a vinheta pulsando não gera uma textura nova a cada quadro.
      const pc = gr.stops.map(t => parseColor(t[1])); let amax = 0, same = pc.length > 0;
      for (const c of pc) { if (c[0] !== pc[0][0]) same = false; if (c[1] > amax) amax = c[1] }
      const norm = same && amax > 0, hex = norm ? ('000000' + pc[0][0].toString(16)).slice(-6) : '';
      const rgb = norm ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] : null;
      const stops = norm ? gr.stops.map((t, i) => [t[0], 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (pc[i][1] / amax).toFixed(3) + ')']) : gr.stops;
      const key = 'g|' + (gr.rad ? 'r' + gr.r0 + ',' + gr.r1 : 'l') + '|' + cw + 'x' + ch + '|' + [gr.x0 - x, gr.y0 - y, gr.x1 - x, gr.y1 - y].join(',') + '|' + stops.map(t => t[0] + t[1]).join(';');
      const tex = this.lru(key, () => {
        const c = document.createElement('canvas'); c.width = cw; c.height = ch; const q = c.getContext('2d');
        const kx = cw / Math.abs(w), ky = ch / Math.abs(h);
        const G = gr.rad ? q.createRadialGradient((gr.x0 - x) * kx, (gr.y0 - y) * ky, gr.r0 * kx, (gr.x1 - x) * kx, (gr.y1 - y) * ky, gr.r1 * kx)
          : q.createLinearGradient((gr.x0 - x) * kx, (gr.y0 - y) * ky, (gr.x1 - x) * kx, (gr.y1 - y) * ky);
        stops.forEach(t => G.addColorStop(t[0], t[1])); q.fillStyle = G; q.fillRect(0, 0, cw, ch);
        return PIXI.Texture.from(c, { scaleMode: LINEAR });
      });
      const sp = this.spr(); sp.texture = tex; sp.alpha = this.globalAlpha * (norm ? amax : 1); this.place(sp, cw, ch, x, y, w, h); this.add(sp);
    }
    createLinearGradient(x0, y0, x1, y1) { return { __grad: 1, x0, y0, x1, y1, stops: [], addColorStop(o, c) { this.stops.push([o, c]) } } }
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return { __grad: 1, rad: 1, x0, y0, r0, x1, y1, r1, stops: [], addColorStop(o, c) { this.stops.push([o, c]) } } }

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
    save() { this.touch(); this.stack.push({ m: this.m, ga: this.globalAlpha, fs: this.fillStyle, ss: this.strokeStyle, lw: this.lineWidth, lj: this.lineJoin, f: this.font, ta: this.textAlign, tb: this.textBaseline, sm: this.imageSmoothingEnabled, cur: this.cur, ld: this.dash, ldo: this.lineDashOffset }) }
    restore() { const s = this.stack.pop(); if (!s) return; this.m = s.m; this.globalAlpha = s.ga; this.fillStyle = s.fs; this.strokeStyle = s.ss; this.lineWidth = s.lw; this.lineJoin = s.lj; this.font = s.f; this.textAlign = s.ta; this.textBaseline = s.tb; this.imageSmoothingEnabled = s.sm; this.cur = s.cur; this.dash = s.ld; this.lineDashOffset = s.ldo }
    setLineDash(a) { a = Array.from(a || [], Number); this.dash = a.some(v => !(v >= 0) || !isFinite(v)) ? [] : (a.length % 2 ? a.concat(a) : a) }
    getLineDash() { return this.dash.slice() }
    /* desenha a polilinha q (px do dispositivo) tracejada, usando setLineDash/lineDashOffset (em unidades do jogo -> px via sc()) */
    dashLine(G, q, closed) {
      const k = this.sc(), pat = this.dash.map(v => v * k), tot = pat.reduce((a, b) => a + b, 0);
      const pts = q.slice(); if (closed) pts.push(q[0], q[1]);
      let idx = 0, rem = pat[0], on = true, o = (((this.lineDashOffset * k) % tot) + tot) % tot;
      while (o > 0) { if (o >= rem) { o -= rem; idx = (idx + 1) % pat.length; rem = pat[idx]; on = !on } else { rem -= o; o = 0 } }
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const x0 = pts[i], y0 = pts[i + 1], dx = pts[i + 2] - x0, dy = pts[i + 3] - y0, len = Math.hypot(dx, dy); let pos = 0;
        while (pos < len) {
          const st = Math.min(rem, len - pos);
          if (on && st > 0) { G.moveTo(x0 + dx * pos / len, y0 + dy * pos / len); G.lineTo(x0 + dx * (pos + st) / len, y0 + dy * (pos + st) / len) }
          pos += st; rem -= st;
          if (rem <= 1e-9) { idx = (idx + 1) % pat.length; rem = pat[idx]; on = !on }
        }
      }
    }

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
    quadraticCurveTo(cx, cy, x, y) {
      if (!this.sub) this.moveTo(cx, cy); const p = this.sub.p, x0 = p[p.length - 2], y0 = p[p.length - 1];
      for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; p.push(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y) }
    }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      if (!this.sub) this.moveTo(c1x, c1y); const p = this.sub.p, x0 = p[p.length - 2], y0 = p[p.length - 1];
      for (let i = 1; i <= 20; i++) { const t = i / 20, u = 1 - t; p.push(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y) }
    }
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
    /* Forma (polígonos/linhas) vira UM sprite: o contorno é rasterizado uma vez em branco e fica em cache (chave = geometria relativa,
       independente da posição e da cor). A cor vai no tint do sprite, então sombras, bordas e caixas em movimento só trocam a posição. */
    shape(subs, isFill, hex, a, lw, join) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const o of subs) { const q = o.q; for (let i = 0; i < q.length; i += 2) { const x = q[i], y = q[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y } }
      const pad = isFill ? 2 : Math.ceil(lw / 2) + 2, bw = x1 - x0, bh = y1 - y0;
      if (!(bw <= 200 && bh <= 200)) return false; // grande demais (ou inválida): usa Graphics
      if (x1 + pad < 0 || y1 + pad < 0 || x0 - pad > this.canvas.width || y0 - pad > this.canvas.height) return true;
      const ox = Math.floor(x0), oy = Math.floor(y0), fx = Math.round((x0 - ox) * 4) / 4, fy = Math.round((y0 - oy) * 4) / 4;
      const W = Math.ceil(bw + fx) + pad * 2 + 1, H = Math.ceil(bh + fy) + pad * 2 + 1;
      let h1 = 2166136261, h2 = 5381;
      for (const o of subs) {
        const q = o.q; h1 = Math.imul(h1 ^ (q.length * 2 + (o.c ? 1 : 0)), 16777619);
        for (let i = 0; i < q.length; i += 2) { const vx = Math.round((q[i] - x0) * 100), vy = Math.round((q[i + 1] - y0) * 100); h1 = Math.imul(h1 ^ vx, 16777619); h1 = Math.imul(h1 ^ vy, 16777619); h2 = (Math.imul(h2, 33) + vx * 31 + vy) | 0 }
      }
      const key = 'p|' + (isFill ? 'f' : 's' + lw.toFixed(2) + join) + '|' + W + 'x' + H + '|' + fx + ',' + fy + '|' + (h1 >>> 0) + '|' + (h2 >>> 0);
      const tex = this.lru(key, () => {
        const c = document.createElement('canvas'); c.width = W; c.height = H; const q = c.getContext('2d');
        q.fillStyle = '#fff'; q.strokeStyle = '#fff'; q.lineWidth = lw; q.lineJoin = join;
        const ax = pad + fx - x0, ay = pad + fy - y0; q.beginPath();
        for (const o of subs) { const p = o.q; q.moveTo(p[0] + ax, p[1] + ay); for (let i = 2; i < p.length; i += 2) q.lineTo(p[i] + ax, p[i + 1] + ay); if (o.c || isFill) q.closePath() }
        if (isFill) q.fill(); else q.stroke();
        return PIXI.Texture.from(c, { scaleMode: NEAREST });
      });
      const sp = this.spr(); sp.texture = tex; sp.tint = hex; sp.alpha = a * this.globalAlpha;
      this.M.set(1, 0, 0, 1, ox - pad, oy - pad); sp.transform.setFromMatrix(this.M); this.add(sp); return true;
    }
    dashed() { return this.dash.length > 0 && this.dash.some(v => v > 0) }
    fill() {
      this.touch(); const fs = this.fillStyle; let col = fs;
      if (fs && fs.__grad) col = (fs.stops[fs.stops.length - 1] || [0, '#000'])[1];
      const [hex, a] = parseColor(col); if (a <= 0) return;
      const subs = [];
      for (const s of this.path) {
        if (s.rect) { this.rectSprite(s.rect[0], s.rect[1], s.rect[2], s.rect[3], hex, a); continue } // retângulo: sprite branco com tint, sem textura própria
        if (s.p.length >= 6) subs.push({ q: this.tp(s.p), c: true });
      }
      if (!subs.length || this.shape(subs, true, hex, a, 0, 'miter')) return;
      const G = this.gfx(); G.alpha = this.globalAlpha; G.beginFill(hex, a); // fallback (forma muito grande)
      for (const o of subs) G.drawPolygon(o.q);
      G.endFill(); this.add(G);
    }
    stroke() {
      this.touch(); const [hex, a] = parseColor(this.strokeStyle); if (a <= 0) return;
      const lw = Math.max(0.01, this.lineWidth * this.sc()), subs = [];
      for (const s of this.path) { if (s.p.length < 4) continue; subs.push({ q: this.tp(s.p), c: s.c }) }
      if (!subs.length) return;
      if (!this.dashed() && this.shape(subs, false, hex, a, lw, this.lineJoin)) return;
      const G = this.gfx(); G.alpha = this.globalAlpha; const J = PIXI.LINE_JOIN; // fallback: tracejado (editor) ou forma muito grande
      G.lineStyle({ width: lw, color: hex, alpha: a, alignment: 0.5, join: this.lineJoin === 'round' ? J.ROUND : this.lineJoin === 'bevel' ? J.BEVEL : J.MITER });
      for (const o of subs) {
        if (this.dashed()) { this.dashLine(G, o.q, o.c); continue }
        const q = o.q; G.moveTo(q[0], q[1]); for (let i = 2; i < q.length; i += 2) G.lineTo(q[i], q[i + 1]); if (o.c) G.closePath()
      }
      this.add(G);
    }
    strokeRect(x, y, w, h) {
      const m = this.m;
      if (!m[1] && !m[2] && !this.dashed() && this.lineJoin === 'miter') { // retângulo alinhado: 4 tiras (ou 1 bloco se for mais fino que a linha)
        this.touch(); const [hex, a] = parseColor(this.strokeStyle); if (a <= 0) return;
        const t = this.lineWidth, hh = t / 2, X = Math.min(x, x + w), Y = Math.min(y, y + h), W = Math.abs(w), H = Math.abs(h);
        if (W <= t || H <= t) { this.rectSprite(X - hh, Y - hh, W + t, H + t, hex, a); return }
        this.rectSprite(X - hh, Y - hh, W + t, t, hex, a); this.rectSprite(X - hh, Y + H - hh, W + t, t, hex, a);
        this.rectSprite(X - hh, Y + hh, t, H - t, hex, a); this.rectSprite(X + W - hh, Y + hh, t, H - t, hex, a); return;
      }
      const sp = this.path, ss = this.sub; this.beginPath(); this.rect(x, y, w, h); this.stroke(); this.path = sp; this.sub = ss
    }
    clip() {
      this.touch(); const mask = new PIXI.Graphics(); mask.beginFill(0xffffff, 1); let sg = 2166136261; const mxs = v => { sg = Math.imul(sg ^ ((v * 64) | 0), 16777619) };
      for (const s of this.path) {
        if (s.p.length < 6) continue; const m = this.m;
        if (s.rect && !m[1] && !m[2]) { const r = s.rect, x0 = m[0] * r[0] + m[4], y0 = m[3] * r[1] + m[5], x1 = m[0] * (r[0] + r[2]) + m[4], y1 = m[3] * (r[1] + r[3]) + m[5]; [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)].forEach(mxs); mask.drawRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)) }
        else { const q = this.tp(s.p); q.forEach(mxs); mask.drawPolygon(q) }
      }
      mask.endFill();
      const c = new PIXI.Container(); c.mask = mask; c.__cl = [mask]; c.__sg = sg;
      this.cur.push(c); this.cur = c.__cl;
    }
  }
})();
