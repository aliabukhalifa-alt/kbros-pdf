/*
 * KBros PDF Editor for iPhone (web app) - the view maths. The same rules as the Mac and Android apps (RULES.md):
 *  zoom-01  any zoom from 1% to 1,000,000%, typed or picked; - and + stop at the Mac's ladder; 100% = one PDF point
 *           per CSS pixel. Every zoom route ends in Viewport.zoomTo / zoomFit.
 *  pan-01   the page follows the finger: every pan route ends in Viewport.panBy; the page never leaves the screen and
 *           the first and last page come out from under the floating bars.
 * No DOM here: test/gate.mjs runs it with Node before every publish.
 */
(function (root) {
  'use strict';

  var Zoom = {
    MIN: 0.01,          // 1%
    MAX: 10000,         // 1,000,000%
    FIT: -1,            // what parse() gives for "Fit"
    STEPS: [0.01, 0.02, 0.04, 0.0833, 0.125, 0.25, 0.3333, 0.5, 0.6667, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24,
            32, 48, 64, 128, 256, 640, 1280, 2560, 5120, 10000],
    clamp: function (s) {
      if (typeof s !== 'number' || isNaN(s)) return 1;
      return Math.max(Zoom.MIN, Math.min(Zoom.MAX, s));
    },
    next: function (s) {
      for (var i = 0; i < Zoom.STEPS.length; i++) if (Zoom.STEPS[i] > s * 1.001) return Zoom.STEPS[i];
      return Zoom.MAX;
    },
    previous: function (s) {
      for (var i = Zoom.STEPS.length - 1; i >= 0; i--) if (Zoom.STEPS[i] < s / 1.001) return Zoom.STEPS[i];
      return Zoom.MIN;
    },
    /** 1.25 -> "125%", 0.0833 -> "8.33%" */
    text: function (s) {
      var p = s * 100;
      if (Math.abs(p - Math.round(p)) < 0.005) return Math.round(p) + '%';
      var t = p.toFixed(2);
      while (t.charAt(t.length - 1) === '0') t = t.slice(0, -1);
      if (t.charAt(t.length - 1) === '.') t = t.slice(0, -1);
      return t + '%';
    },
    /** "350", "350%", "3,5 %", "Fit" -> a scale (clamped), Zoom.FIT, or null when it is not a zoom */
    parse: function (raw) {
      if (raw === null || raw === undefined) return null;
      var t = String(raw).trim();
      if (/^fit/i.test(t)) return Zoom.FIT;
      // review: an Arabic or Persian iPhone types Eastern digits (٣٥٠, ۳۵۰), the Arabic decimal point and percent sign
      t = t.replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x660); })
           .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x6F0); })
           .replace(/\u066B/g, '.').replace(/\u066A/g, '%').replace(/\u066C/g, '');
      t = t.replace(/%/g, '').replace(/,/g, '.').trim();
      if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
      var v = parseFloat(t);
      if (!isFinite(v) || v <= 0) return null;
      return Zoom.clamp(v / 100);
    },
    listed: function () {
      var l = ['Fit width'];
      for (var i = 0; i < Zoom.STEPS.length; i++) if (Zoom.STEPS[i] >= 0.08) l.push(Zoom.text(Zoom.STEPS[i]));
      return l;
    }
  };

  /** THE view step. Document coordinates are PDF points: pages one under the other, GAP apart and centred; the view
   *  shows the document from (ox, oy) - the point at its top-left - at zoom * density device pixels per point. */
  function Viewport() {
    this.pageW = []; this.pageH = []; this.pageTop = [];
    this.docW = 0; this.docH = 0;
    this.zoom = 1; this.ox = 0; this.oy = 0;
    this.density = 1;          // device pixels per CSS pixel
    this.vw = 1; this.vh = 1;  // view size, device pixels
    this.fit = true;
    this.insetTop = 0; this.insetBottom = 0;   // device pixels covered by the floating bars
  }
  Viewport.GAP = 12;

  Viewport.prototype.setPages = function (w, h) {
    this.pageW = w; this.pageH = h; this.pageTop = [];
    var y = Viewport.GAP, maxW = 0;
    for (var i = 0; i < w.length; i++) { this.pageTop.push(y); y += h[i] + Viewport.GAP; maxW = Math.max(maxW, w[i]); }
    this.docW = maxW + 2 * Viewport.GAP;
    this.docH = y;
    this.fit = true;
    this.zoom = this.fitZoom();
    this.ox = 0;
    this.oy = -this.insetTop / this.ppp();   // a new document opens at its top, page 1 clear of the top bar
    this.clampOffsets();
  };
  Viewport.prototype.count = function () { return this.pageW.length; };
  Viewport.prototype.ppp = function () { return this.zoom * this.density; };
  Viewport.prototype.pageLeft = function (i) { return (this.docW - this.pageW[i]) / 2; };
  Viewport.prototype.fitZoom = function () { return this.docW <= 0 ? 1 : Zoom.clamp(this.vw / (this.docW * this.density)); };

  /** a new view size (rotation): the point in the middle stays in the middle; Fit stays Fit */
  Viewport.prototype.setSize = function (w, h) {
    var cx = this.ox + this.vw / 2 / this.ppp(), cy = this.oy + this.vh / 2 / this.ppp();
    this.vw = Math.max(1, w); this.vh = Math.max(1, h);
    if (this.fit) this.zoom = this.fitZoom();
    this.ox = cx - this.vw / 2 / this.ppp();
    this.oy = cy - this.vh / 2 / this.ppp();
    this.clampOffsets();
  };

  /** THE zoom step: clamps to 1%..1,000,000%, leaves Fit, keeps the document point under view pixel (fx, fy) */
  Viewport.prototype.zoomTo = function (wanted, fx, fy) {
    var s = Zoom.clamp(wanted);
    var dx = this.ox + fx / this.ppp(), dy = this.oy + fy / this.ppp();
    this.zoom = s; this.fit = false;
    this.ox = dx - fx / this.ppp();
    this.oy = dy - fy / this.ppp();
    this.clampOffsets();
  };
  Viewport.prototype.zoomToCentre = function (wanted) { this.zoomTo(wanted, this.vw / 2, this.vh / 2); };

  /** Fit width: the place in the middle stays in the middle */
  Viewport.prototype.zoomFit = function () {
    var cy = this.oy + this.vh / 2 / this.ppp();
    this.zoom = this.fitZoom(); this.fit = true;
    this.ox = 0;
    this.oy = cy - this.vh / 2 / this.ppp();
    this.clampOffsets();
  };

  /** THE pan step: the document follows the finger by (dx, dy) device pixels */
  Viewport.prototype.panBy = function (dx, dy) {
    this.ox -= dx / this.ppp();
    this.oy -= dy / this.ppp();
    this.clampOffsets();
  };

  /** the document never leaves the view; smaller than the view it is centred; the bars' strips are allowed past the
   *  first and last page so their edges come out from under the floating bars */
  Viewport.prototype.clampOffsets = function () {
    var p = this.ppp(), w = this.vw / p, h = this.vh / p, it = this.insetTop / p, ib = this.insetBottom / p;
    this.ox = this.docW <= w ? (this.docW - w) / 2 : Math.max(0, Math.min(this.docW - w, this.ox));
    var room = h - it - ib;
    this.oy = this.docH <= room ? (this.docH - room) / 2 - it : Math.max(-it, Math.min(this.docH - h + ib, this.oy));
  };

  /** {zoom, fit, the document point in the middle} - kept per file, put back when it is opened again */
  Viewport.prototype.state = function () {
    return [this.zoom, this.fit ? 1 : 0, this.ox + this.vw / 2 / this.ppp(), this.oy + this.vh / 2 / this.ppp()];
  };
  Viewport.prototype.restore = function (s) {
    if (!s || s.length !== 4) return;
    this.fit = s[1] > 0;
    this.zoom = this.fit ? this.fitZoom() : Zoom.clamp(s[0]);
    this.ox = s[2] - this.vw / 2 / this.ppp();
    this.oy = s[3] - this.vh / 2 / this.ppp();
    this.clampOffsets();
  };

  Viewport.prototype.toViewX = function (x) { return (x - this.ox) * this.ppp(); };
  Viewport.prototype.toViewY = function (y) { return (y - this.oy) * this.ppp(); };
  Viewport.prototype.toDocX = function (px) { return this.ox + px / this.ppp(); };
  Viewport.prototype.toDocY = function (py) { return this.oy + py / this.ppp(); };

  Viewport.prototype.currentPage = function () {
    if (!this.count()) return 0;
    var y = this.oy + this.vh / 2 / this.ppp();
    for (var i = 0; i < this.count(); i++) if (y < this.pageTop[i] + this.pageH[i] + Viewport.GAP / 2) return i;
    return this.count() - 1;
  };
  Viewport.prototype.firstVisible = function () {
    for (var i = 0; i < this.count(); i++) if (this.pageTop[i] + this.pageH[i] >= this.oy) return i;
    return this.count();
  };
  Viewport.prototype.lastVisible = function () {
    var bottom = this.oy + this.vh / this.ppp(), last = -1;
    for (var i = 0; i < this.count(); i++) { if (this.pageTop[i] <= bottom) last = i; else break; }
    return last;
  };
  /** the part of page i in view, in page points from the page's top-left, or null */
  Viewport.prototype.visiblePart = function (i) {
    var l = this.pageLeft(i), t = this.pageTop[i], p = this.ppp();
    var x0 = Math.max(l, this.ox), y0 = Math.max(t, this.oy);
    var x1 = Math.min(l + this.pageW[i], this.ox + this.vw / p), y1 = Math.min(t + this.pageH[i], this.oy + this.vh / p);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0 - l, y0 - t, x1 - l, y1 - t];
  };
  /** the scale (device px per point) the sharp picture of a page part starting at (x0, y0) is drawn at: the view's,
   *  or less, so that no point of the page lies more than safePx from the picture's corner. WebKit (every iPhone
   *  browser) passes Infinity: checked exact at 1,000,000%. Chromium's Skia dropped half a curve there (fine at
   *  100,000%), so other browsers pass 2,000,000 and get an enlarged, correct picture beyond that. */
  Viewport.renderScale = function (ppp, pageW, pageH, x0, y0, safePx) {
    var reach = Math.max(Math.max(x0, pageW - x0), Math.max(y0, pageH - y0));
    return Math.min(ppp, safePx / Math.max(reach, 1));
  };
  /** a sharp picture of a page part at rp px per point: [width px, height px, x1, y1 it really covers] */
  Viewport.tileExtent = function (x0, y0, x1, y1, rp) {
    var w = Math.max(1, Math.ceil((x1 - x0) * rp)), h = Math.max(1, Math.ceil((y1 - y0) * rp));
    return [w, h, x0 + w / rp, y0 + h / rp];
  };

  var api = { Zoom: Zoom, Viewport: Viewport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KBCore = api;
})(this);
