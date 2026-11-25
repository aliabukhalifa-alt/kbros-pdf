/*
 * KBros PDF Editor for iPhone (web app, 24 Nov 2026 - Ali: "iPhone installer that will work on all iPhones"; Apple has
 * no installer file, so: a web app added to the Home Screen from Safari). The Mac and Android apps' view rules
 * (RULES.md): any zoom from 1% to 1,000,000% - pinch, double-tap, - and +, hold + for the maximum, the zoom box (typed or
 * picked), Fit - all through Viewport.zoomTo / zoomFit; the page follows the finger - drag, flick, two-finger drag -
 * all through Viewport.panBy. Drawing: a small picture of each page while moving, then a sharp picture of exactly what
 * is on screen, drawn by PDF.js at the zoom of that moment (iPhone Safari draws with Core Graphics: checked exact at
 * 1,000,000%).
 * Lessons from the Android reviews built in from the start; the fixes of the iPhone review (24 Nov 2026, 61 agents,
 * 26 confirmed) are marked "review:" where they are.
 */
(function () {
  'use strict';
  var Zoom = KBCore.Zoom, Viewport = KBCore.Viewport;
  var VERSION = '1.0.1';
  var PDFJS_ROOT = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
  var PDFJS = PDFJS_ROOT + 'legacy/build/';
  // review: PDF.js reads every PDF - the copy from the CDN must be exactly the one checked (index.html checks the main
  // file with its integrity attribute; the worker is checked here before it runs)
  var WORKER_SRI = 'sha384-sS8B4COeBqzQV9DaPpp5cbpF+xz2jPcFbN3L8FL3/dx0RMC6WLUwTUOFm0iFb1lw';
  // review: an iPhone draws nothing on a canvas over 16,777,216 px (PDF.js makes some, e.g. for stencil masks, of the
  // whole mask's size): a picture that would need one is drawn at a smaller scale and enlarged - everywhere, the same
  var MAX_CANVAS_PX = 16777216;

  // the drawing engine: every iPhone browser is WebKit (Core Graphics) - sharp and exact to 1,000,000%. Elsewhere
  // (Chrome, Android, Firefox) the sharp picture stops getting sharper past what their renderer draws correctly.
  var ua = navigator.userAgent;
  var notSafari = /(Chrome|Chromium|Edg|OPR|Android|Firefox)\//.test(ua);   // CriOS (Chrome on iPhone) IS WebKit
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !notSafari);
  var isWebKit = isIOS || (/AppleWebKit/.test(ua) && !notSafari);
  var SAFE_PX = isWebKit ? Infinity : 2000000;

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body, canvas = $('pages'), ctx = canvas.getContext('2d');
  var vp = new Viewport();

  // ---------------------------------------------------------------- the PDF engine (checked before it runs)
  // the checked worker code; every document gets a worker of its own made from it (one shared worker could not take
  // the next document while the last one was still closing: "PDFWorker.fromPort - the worker is being destroyed")
  var workerUrl = null, docWorker = null;
  var MAIN_SRI = 'sha384-OemFRmhjDZwhIKuUld0HJozkF2YErsgDaCL41trxGQZt4/WgnopJQqQl2DvDZ07Z';
  function loadMain() {   // pdf.min.js, if the page could not load it at start (no network then): load it now, checked
    if (window.pdfjsLib) return Promise.resolve();
    return new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = PDFJS + 'pdf.min.js'; sc.integrity = MAIN_SRI; sc.crossOrigin = 'anonymous';
      sc.onload = function () { window.pdfjsLib ? res() : rej(new Error('offline')); };
      sc.onerror = function () { sc.remove(); rej(new Error('offline')); };
      document.head.appendChild(sc);
    });
  }
  function makeEngine() {
    return loadMain().then(function () {
      if (!(window.crypto && crypto.subtle && window.fetch && window.Blob && window.URL)) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';   // no way to check here: use it as is
        return;
      }
      return fetch(PDFJS + 'pdf.worker.min.js', { mode: 'cors' }).then(function (r) {
        if (!r.ok) throw new Error('offline');
        return r.arrayBuffer();
      }).then(function (buf) {
        return crypto.subtle.digest('SHA-384', buf).then(function (h) {
          var b = new Uint8Array(h), t = '';
          for (var i = 0; i < b.length; i++) t += String.fromCharCode(b[i]);
          if ('sha384-' + btoa(t) !== WORKER_SRI) throw new Error('integrity');
          workerUrl = URL.createObjectURL(new Blob([buf], { type: 'application/javascript' }));
        });
      });
    });
  }
  /** round 2: the engine is got when needed and tried again after a failure (patchy Wi-Fi at the first launch); every
   *  engine failure is reported as one ('offline' or 'integrity'), never as a bad PDF */
  var engineP = null;
  function getEngine() {
    return engineP || (engineP = makeEngine().catch(function (e) {
      engineP = null;
      throw new Error(e && e.message === 'integrity' ? 'integrity' : 'offline');
    }));
  }
  getEngine().catch(function (e) {
    setTimeout(function () {
      toast(e && e.message === 'integrity' ? 'The PDF engine did not pass its check. Reconnect and open the app again.'
                                            : 'Connect to the internet once to finish installing.');
    }, 300);
  });

  // review: PDF.js asks for its working canvases through this, so the app sees when one would be too big for an iPhone
  var canvasFactory = {
    asked: 0,
    create: function (w, h) {
      if (w <= 0 || h <= 0) throw new Error('Invalid canvas size');
      this.asked = Math.max(this.asked, w * h);
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      return { canvas: c, context: c.getContext('2d') };
    },
    reset: function (cc, w, h) {
      if (!cc.canvas) throw new Error('Canvas is not specified');
      if (w <= 0 || h <= 0) throw new Error('Invalid canvas size');
      this.asked = Math.max(this.asked, w * h);
      cc.canvas.width = w; cc.canvas.height = h;
    },
    destroy: function (cc) {
      if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; }
      cc.canvas = null; cc.context = null;
    }
  };

  // ---------------------------------------------------------------- state
  var doc = null, docGen = 0, loadingTask = null, current = null;   // current: {id, name}
  var pageProxies = [], rendered = new Set();                      // pages PDF.js holds memory for (review: cleanup)
  var base = new Map(), baseQueued = new Set(), BASE_MAX = 30;      // small pictures, at most 750,000 px each
  var tiles = [], viewGen = 0, viewTask = null;
  var queue = Promise.resolve();                                   // one PDF.js drawing at a time
  var dirty = false, settleTimer = 0, anim = null, animTarget = null, fling = null;
  var canvasColor = '#E7E9ED', updatePending = false;
  var lastError = null;   // the last reason a PDF did not open (the test hook reads it)

  // ---------------------------------------------------------------- sizes
  function readColors() {
    canvasColor = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#E7E9ED';
  }
  function layout() {
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    vp.density = dpr;
    var top = $('top').getBoundingClientRect(), zb = $('zoombar').getBoundingClientRect();
    vp.insetTop = Math.max(0, top.bottom + 8) * dpr;
    vp.insetBottom = Math.max(0, window.innerHeight - zb.top + 8) * dpr;
    vp.setSize(w, h);
    readColors();
    changed();
  }
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', function () { setTimeout(layout, 300); });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(function () { readColors(); redraw(); });
  }

  // ---------------------------------------------------------------- drawing
  /** the view moved or zoomed: draw, update the labels, and ask for a sharp picture once it settles */
  function changed() {
    redraw();
    updateLabels();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(renderView, 150);
  }
  /** review: a picture arrived - draw it, nothing more (it used to cancel the settle of a newer view) */
  function redraw() { if (!dirty) { dirty = true; requestAnimationFrame(draw); } }

  function clip(l, t, r, b, v) {
    var cl = Math.max(l, v[0]), ct = Math.max(t, v[1]), cr = Math.min(r, v[2]), cb = Math.min(b, v[3]);
    return cr <= cl || cb <= ct ? null : [cl, ct, cr, cb];
  }
  /** draws the part of picture `img` (covering l,t,r,b on screen) that falls inside dst - exact, fractional source */
  function drawPart(img, l, t, r, b, dst) {
    var sx = img.width / (r - l), sy = img.height / (b - t);
    var x0 = (dst[0] - l) * sx, y0 = (dst[1] - t) * sy, x1 = (dst[2] - l) * sx, y1 = (dst[3] - t) * sy;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(img.width, x1); y1 = Math.min(img.height, y1);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, l + x0 / sx, t + y0 / sy, (x1 - x0) / sx, (y1 - y0) / sy);
  }

  var drawn = [];   // the gate's view of what the last frame showed (test hook only)
  function draw() {
    dirty = false;
    drawn = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = canvasColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!doc) return;
    var p = vp.ppp(), view = [-4, -4, canvas.width + 4, canvas.height + 4];
    var first = vp.firstVisible(), last = vp.lastVisible();
    for (var i = first; i <= last; i++) {
      var l = vp.toViewX(vp.pageLeft(i)), t = vp.toViewY(vp.pageTop[i]);
      var r = l + vp.pageW[i] * p, b = t + vp.pageH[i] * p;
      var page = clip(l, t, r, b, view);
      if (!page) continue;
      var whole = vp.pageW[i] * p < canvas.width * 3;   // a soft edge while about the whole page shows; none deep in
      if (whole) { ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.fillRect(page[0] + 2, page[1] + 3, page[2] - page[0], page[3] - page[1]); }
      ctx.fillStyle = '#fff';
      ctx.fillRect(page[0], page[1], page[2] - page[0], page[3] - page[1]);
      var bb = base.get(i), baseShown = false;
      if (!bb) { if (last - first < 16) queueBase(i); }
      else if (p * vp.pageW[i] / bb.width < 12) { drawPart(bb, l, t, r, b, page); baseShown = true; }
      for (var k = 0; k < tiles.length; k++) {
        var tile = tiles[k];
        if (tile.page !== i) continue;
        if (p / tile.viewPpp > 24 || tile.viewPpp / p > 24) continue;   // made for another zoom, stretched far: wait
        // review: a coarser old picture never covers the better small picture underneath (pinching in from far out)
        if (baseShown && tile.rp < Math.min(bb.width / vp.pageW[i], p) * 0.999) continue;   // round 2: not finer ones
        var tl = vp.toViewX(vp.pageLeft(i) + tile.x0), tt = vp.toViewY(vp.pageTop[i] + tile.y0);
        var tr = vp.toViewX(vp.pageLeft(i) + tile.x1), tb = vp.toViewY(vp.pageTop[i] + tile.y1);
        var dst = clip(tl, tt, tr, tb, page);
        if (dst) { drawPart(tile.canvas, tl, tt, tr, tb, dst); drawn.push({ page: i, rp: tile.rp }); }
      }
      if (whole) { ctx.strokeStyle = 'rgba(0,0,0,.13)'; ctx.lineWidth = 1; ctx.strokeRect(page[0] + .5, page[1] + .5, page[2] - page[0] - 1, page[3] - page[1] - 1); }
    }
  }

  function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }   // iOS gives canvas memory back only like this
  function freeTile(t) { freeCanvas(t.canvas); t.canvas = null; }
  /** round 2: sharp pictures are kept within about 3 screens of pixels; the oldest go first, but never one of a page on
   *  screen that has no newer picture (pages flashed white while panning far out) */
  function trimTiles(made) {
    var px = function (t) { return t.canvas ? t.canvas.width * t.canvas.height : 0; };
    var total = 0, budget = 3 * canvas.width * canvas.height;
    tiles.forEach(function (t) { total += px(t); });
    var f = vp.firstVisible(), l = vp.lastVisible();
    for (var k = 0; k < tiles.length && total > budget; ) {
      var o = tiles[k];
      var covered = made.some(function (m) { return m.page === o.page && m !== o; });
      if (made.indexOf(o) < 0 && (o.page < f || o.page > l || covered)) { total -= px(o); freeTile(o); tiles.splice(k, 1); }
      else k++;
    }
  }

  function enqueue(job) { queue = queue.then(job, job).catch(function () {}); return queue; }

  /** review: let PDF.js give back what it keeps for pages far from the view (only inside the queue: nothing is drawing) */
  /** round 2: with many pages on screen (zoomed far out), a page gives its PDF.js memory back right after its picture */
  function cleanupIfMany(j) {
    if (vp.lastVisible() - vp.firstVisible() >= 6 && pageProxies[j]) { try { pageProxies[j].cleanup(); } catch (e) {} rendered.delete(j); }
  }
  function cleanupFar() {
    var f = vp.firstVisible() - 2, l = vp.lastVisible() + 2;
    rendered.forEach(function (j) {
      if ((j < f || j > l) && pageProxies[j]) { try { pageProxies[j].cleanup(); } catch (e) {} rendered.delete(j); }
    });
  }

  /** a small picture of a whole page, for while the view moves */
  function queueBase(i) {
    if (!doc || baseQueued.has(i)) return;
    baseQueued.add(i);
    var g = docGen, pw = vp.pageW[i], ph = vp.pageH[i];
    var k = Math.min(600 / pw, Math.sqrt(750000 / (pw * ph)));
    var bw = Math.max(1, Math.round(pw * k)), bh = Math.max(1, Math.round(ph * k));
    enqueue(function () {
      if (g !== docGen) return;
      var f = vp.firstVisible(), la = vp.lastVisible();
      if (i < f - 2 || i > la + 2) { baseQueued.delete(i); return; }   // the view moved on: ask again when needed
      var c = document.createElement('canvas');
      c.width = bw; c.height = bh;
      var cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, bw, bh);
      rendered.add(i);
      return pageProxies[i].render({ canvasContext: cx, viewport: pageProxies[i].getViewport({ scale: bw / pw }) }).promise.then(function () {
        if (g !== docGen) { freeCanvas(c); return; }
        base.set(i, c);
        cleanupIfMany(i);
        while (base.size > BASE_MAX) {   // drop the oldest; it may be asked for again (never blank for ever)
          var oldest = base.keys().next().value;
          freeCanvas(base.get(oldest)); base.delete(oldest); baseQueued.delete(oldest);
        }
        cleanupFar();
        redraw();
      }, function () { freeCanvas(c); baseQueued.delete(i); });
    });
  }

  /** draws one sharp picture of the page part t at rp px per point; smaller if PDF.js would need a canvas over the
   *  iPhone's limit (review: stencil masks vanished). Resolves to the tile, or null. */
  function renderTile(t, rp, tries, g, prev) {
    var ext = Viewport.tileExtent(t.x0, t.y0, t.vx1, t.vy1, rp);
    if (ext[0] * ext[1] > MAX_CANVAS_PX) return renderTile(t, rp * Math.sqrt(MAX_CANVAS_PX / (ext[0] * ext[1])) * 0.98, tries, g, prev);
    var c = document.createElement('canvas');
    c.width = ext[0]; c.height = ext[1];
    var cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    var pv = pageProxies[t.page].getViewport({ scale: rp, offsetX: -t.x0 * rp, offsetY: -t.y0 * rp });
    canvasFactory.asked = 0;
    rendered.add(t.page);
    viewTask = pageProxies[t.page].render({ canvasContext: cx, viewport: pv });
    var dropPrev = function () { if (prev) freeCanvas(prev.c); };
    return viewTask.promise.then(function () {
      viewTask = null;
      if (g !== viewGen) { freeCanvas(c); dropPrev(); return null; }
      var asked = canvasFactory.asked;
      var take = function (cv, e, r) { t.x1 = e[2]; t.y1 = e[3]; t.rp = r; t.canvas = cv; return t; };
      if (asked <= MAX_CANVAS_PX) { dropPrev(); return take(c, ext, rp); }   // every canvas fits now: this one
      if (prev && asked > prev.asked * 0.98) {
        // round 2: the big canvas did not shrink at all with the scale - it is image-sized (iOS before 16.4 paints
        // pictures through a canvas of their own size), so a smaller scale cannot help: keep the first, sharper one.
        // (A stencil mask's canvas shrinks with the scale squared, so it goes on to the retry below.)
        freeCanvas(c);
        return take(prev.c, prev.ext, prev.rp);
      }
      dropPrev();
      if (tries < 4) return renderTile(t, rp * Math.sqrt(MAX_CANVAS_PX / asked) * 0.95, tries + 1, g, { c: c, ext: ext, rp: rp, asked: asked });
      return take(c, ext, rp);
    }, function () { viewTask = null; freeCanvas(c); dropPrev(); return null; });
  }

  /** once the view settles: a sharp picture of exactly what is on screen, each shown as soon as it is drawn */
  function renderView() {
    if (!doc || anim || fling || touch.active) return;   // never while something moves
    var g = ++viewGen, ppp = vp.ppp(), want = [];
    // review: the drawing still running for the old view is cancelled, so the new one does not wait behind it
    if (viewTask) { try { viewTask.cancel(); } catch (e) {} viewTask = null; }
    for (var i = vp.firstVisible(); i <= vp.lastVisible(); i++) {
      var part = vp.visiblePart(i);
      if (part) want.push({ page: i, x0: part[0], y0: part[1], vx1: part[2], vy1: part[3], viewPpp: ppp });
    }
    enqueue(function () {
      if (g !== viewGen) return;
      var made = [];
      var step = function (n) {
        if (g !== viewGen) return;   // a newer view: what was made stays shown until that one is complete
        if (n >= want.length) {
          // complete: the older pictures go (their memory back), these stay
          tiles = tiles.filter(function (t) { if (made.indexOf(t) < 0) { freeTile(t); return false; } return true; });
          cleanupFar();
          if (window.__kbpdfSettled) window.__kbpdfSettled();
          redraw();
          return;
        }
        var t = want[n];
        var rp = Viewport.renderScale(ppp, vp.pageW[t.page], vp.pageH[t.page], t.x0, t.y0, SAFE_PX);
        return renderTile(t, rp, 0, g).then(function (tile) {
          if (tile) {
            made.push(tile);
            tiles.push(tile);   // review: shown at once (far out, many pages used to stay white until all were done)
            cleanupIfMany(tile.page);
            trimTiles(made);
            redraw();
          }
          return step(n + 1);
        });
      };
      return step(0);
    });
  }

  // ---------------------------------------------------------------- the document
  function close() {
    docGen++; viewGen++;
    if (viewTask) { try { viewTask.cancel(); } catch (e) {} viewTask = null; }
    var ending = [];
    $('pwDialog').hidden = true;   // round 2: a password sheet belongs to its own open only
    if (loadingTask) { loadingTask.onPassword = null; try { ending.push(loadingTask.destroy()); } catch (e) {} loadingTask = null; }
    if (doc) { try { ending.push(doc.destroy()); } catch (e) {} }
    if (docWorker) {   // its own worker goes once the document has finished closing
      var dw = docWorker; docWorker = null;
      Promise.all(ending).catch(function () {}).then(function () {
        try { dw.pdfWorker.destroy(); } catch (e) {}
        try { dw.port.terminate(); } catch (e) {}
      });
    }
    doc = null; pageProxies = []; rendered.clear();
    base.forEach(freeCanvas); base.clear(); baseQueued.clear();
    tiles.forEach(freeTile); tiles = [];
    stopMotion();
    busy(false);   // review: every way out of an open clears "Opening..."
    vp.setPages([], []);
    changed();
  }

  function openBytes(bytes, info, restore) {
    saveView();
    close();
    var g = docGen;
    current = info;
    $('title').textContent = info.name;
    showHome(false);
    busy(true, 'Opening…');
    return getEngine().then(function () {
      if (g !== docGen) return false;
      var opts = {
        data: bytes, isEvalSupported: false, canvasFactory: canvasFactory,
        // review: Chinese, Japanese and Korean text with predefined CMaps, and the 14 standard fonts, need these files
        cMapUrl: PDFJS_ROOT + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS_ROOT + 'standard_fonts/',
        useWorkerFetch: false   // fetched by the page, so sw.js keeps them for offline use
      };
      if (workerUrl) {
        var port = new Worker(workerUrl);
        docWorker = { port: port, pdfWorker: new pdfjsLib.PDFWorker({ port: port }) };
        opts.worker = docWorker.pdfWorker;
      }
      loadingTask = pdfjsLib.getDocument(opts);
      loadingTask.onPassword = function (update, reason) {
        if (g !== docGen) return;
        askPassword(reason === 2, function (pw) {
          if (g !== docGen) return;
          if (pw === null) { cancelOpen(g); return; }
          busy(true, 'Opening\u2026');
          update(pw);
        });
      };
      return loadingTask.promise.then(function (d) {
        if (g !== docGen) { d.destroy(); return false; }
        doc = d;
        var n = d.numPages, w = [], h = [], i = 0;
        busy(true, 'Opening ' + n + ' page' + (n === 1 ? '' : 's') + '…');
        var next = function () {
          if (g !== docGen) return false;
          if (i >= n) {
            vp.setPages(w, h);
            layout();
            if (restore) vp.restore(restore);
            busy(false);
            changed();
            oldIOSNote();
            return true;
          }
          return d.getPage(i + 1).then(function (p) {
            pageProxies[i] = p;
            var v = p.getViewport({ scale: 1 });
            w.push(v.width); h.push(v.height);
            i++;
            return next();
          });
        };
        return next();
      });
    }).catch(function (e) {
      lastError = e;
      if (g !== docGen) return false;
      close();   // round 2: the failed open's worker and bytes go too, and doc is never left set
      toast(e && e.name === 'PasswordException' ? 'This PDF is protected with a password.' :
            e && e.message === 'offline' ? 'Connect to the internet once to finish installing.' :
            e && e.message === 'integrity' ? 'The PDF engine did not pass its check. Reconnect and open the app again.' :
            'This file could not be opened as a PDF.');
      current = null;
      showHome(true);
      return false;
    });
  }
  function cancelOpen(g) {
    if (g !== docGen) return;
    close(); current = null; showHome(true); toast('Not opened.');
  }

  /** review: the password in a password field (not window.prompt's plain text, which iOS can learn and show) */
  function askPassword(wrong, done) {
    busy(false);
    var dlg = $('pwDialog'), input = $('pwInput');
    $('pwTitle').textContent = wrong ? 'Wrong password - try again' : 'This PDF is protected';
    input.value = '';
    dlg.hidden = false;
    input.focus();
    var finish = function (v) { dlg.hidden = true; input.blur(); done(v); };
    $('pwGo').onclick = function () { finish(input.value); };
    $('pwCancel').onclick = function () { finish(null); };
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } if (e.key === 'Escape') finish(null); };
  }

  /** review: iPhones before iOS 16.4 (no OffscreenCanvas) cannot show pictures over 16.7 megapixels inside a PDF */
  function oldIOSNote() {
    if (!isIOS || typeof OffscreenCanvas !== 'undefined') return;
    try { if (localStorage.getItem('note:ios164')) return; localStorage.setItem('note:ios164', '1'); } catch (e) {}
    setTimeout(function () { toast('Tip: update to iOS 16.4 or later to see very large pictures in PDFs.'); }, 800);
  }

  // ---------------------------------------------------------------- the zoom routes (all end in vp.zoomTo / zoomFit)
  function centre() { return [vp.vw / 2, vp.vh / 2]; }
  function animateTo(target, fx, fy) {
    stopMotion();
    if (!doc) return;
    var z0 = vp.zoom, z1 = target === Zoom.FIT ? vp.fitZoom() : Zoom.clamp(target);
    // the gate runs with the page out of sight, where the browser stops animation frames: same step, no glide
    if (window.__kbpdfInstant) { vp.zoomTo(z1, fx, fy); if (target === Zoom.FIT) vp.zoomFit(); changed(); return; }
    var dur = Math.abs(Math.log(z1 / z0)) > 6 ? 420 : 240, start = performance.now();
    animTarget = z1;
    // review: each frame checks it is still the glide that runs (a stopped or replaced glide did one more step)
    var me = anim = function (now) {
      if (anim !== me) return;
      var t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3);
      vp.zoomTo(z0 * Math.pow(z1 / z0, e), fx, fy);
      if (t >= 1) { if (target === Zoom.FIT) vp.zoomFit(); anim = null; animTarget = null; changed(); return; }
      changed();
      requestAnimationFrame(me);
    };
    requestAnimationFrame(me);
  }
  function stopMotion() { anim = null; animTarget = null; fling = null; }
  /** review: + and - step from where a glide is going, so quick repeated taps never lose a step */
  function stepFrom() { return anim && animTarget !== null ? animTarget : vp.zoom; }
  function zoomIn() { var c = centre(); animateTo(Zoom.next(stepFrom()), c[0], c[1]); }
  function zoomOut() { var c = centre(); animateTo(Zoom.previous(stepFrom()), c[0], c[1]); }
  function zoomFit() { var c = centre(); animateTo(Zoom.FIT, c[0], c[1]); }
  function zoomMax() { var c = centre(); animateTo(Zoom.MAX, c[0], c[1]); toast('Maximum zoom: 1,000,000%'); }
  function zoomValue(z) { var c = centre(); animateTo(z, c[0], c[1]); }
  function doubleTap(x, y) {   // in: 2.5 x Fit around the tap (or the next step); again: back to Fit
    if (vp.fit || vp.zoom <= vp.fitZoom() * 1.05) animateTo(Math.max(vp.fitZoom() * 2.5, Zoom.next(vp.zoom)), x, y);
    else animateTo(Zoom.FIT, x, y);
  }

  // ---------------------------------------------------------------- touch (the pan and zoom routes of the fingers)
  var touch = { active: false, mode: null, lastX: 0, lastY: 0, lastDist: 0, moved: false, downT: 0, startX: 0, startY: 0,
                samples: [], stopped: false, lastTapT: 0, lastTapX: 0, lastTapY: 0, tapTimer: 0 };
  function dpr() { return vp.density; }
  function pts(e) {
    var r = [];
    for (var i = 0; i < e.touches.length; i++) r.push([e.touches[i].clientX * dpr(), e.touches[i].clientY * dpr()]);
    return r;
  }
  function beginTouches(list) {
    if (list.length >= 2) {
      touch.mode = 'pinch';
      touch.lastX = (list[0][0] + list[1][0]) / 2; touch.lastY = (list[0][1] + list[1][1]) / 2;
      touch.lastDist = Math.max(1, Math.hypot(list[0][0] - list[1][0], list[0][1] - list[1][1]));
      touch.moved = true;
    } else if (list.length === 1) {
      touch.mode = 'pan';
      touch.lastX = list[0][0]; touch.lastY = list[0][1];
      touch.samples = [[performance.now(), touch.lastX, touch.lastY]];
    }
  }
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (!doc) return;
    var list = pts(e);
    if (!touch.active) {
      touch.active = true; touch.moved = false; touch.downT = performance.now();
      touch.startX = list[0][0]; touch.startY = list[0][1];
      touch.stopped = !!(anim || fling);   // this touch stops a glide: its tap is not for the bars
      stopMotion();
    }
    beginTouches(list);
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (!doc || !touch.active) return;
    var list = pts(e);
    if (touch.mode === 'pinch' && list.length >= 2) {
      var mx = (list[0][0] + list[1][0]) / 2, my = (list[0][1] + list[1][1]) / 2;
      var d = Math.max(1, Math.hypot(list[0][0] - list[1][0], list[0][1] - list[1][1]));
      vp.panBy(mx - touch.lastX, my - touch.lastY);          // the two fingers drag the page too
      vp.zoomTo(vp.zoom * d / touch.lastDist, mx, my);       // and zoom around the point between them
      touch.lastX = mx; touch.lastY = my; touch.lastDist = d;
      changed();
    } else if (touch.mode === 'pan' && list.length === 1) {
      var x = list[0][0], y = list[0][1];
      if (!touch.moved && Math.hypot(x - touch.startX, y - touch.startY) < 10 * dpr()) return;   // still a tap
      touch.moved = true;
      vp.panBy(x - touch.lastX, y - touch.lastY);
      touch.lastX = x; touch.lastY = y;
      var now = performance.now();
      touch.samples.push([now, x, y]);
      while (touch.samples.length > 2 && now - touch.samples[0][0] > 100) touch.samples.shift();
      changed();
    }
  }, { passive: false });
  function endTouch(e) {
    e.preventDefault();
    if (!touch.active) return;
    var list = pts(e);
    if (list.length > 0) { beginTouches(list); return; }   // a finger is still down: go on from it
    touch.active = false;
    var now = performance.now();
    if (touch.moved) {
      if (touch.mode === 'pan' && touch.samples.length >= 2) {
        var a = touch.samples[0], z = touch.samples[touch.samples.length - 1], dt = Math.max(1, z[0] - a[0]);
        startFling((z[1] - a[1]) / dt, (z[2] - a[2]) / dt);
      }
      changed();
      return;
    }
    // a tap: a quick one only (a finger that rested and lifted is not a tap)
    if (now - touch.downT > 500) { changed(); return; }
    var x = touch.startX, y = touch.startY;
    if (now - touch.lastTapT < 300 && Math.hypot(x - touch.lastTapX, y - touch.lastTapY) < 40 * dpr()) {
      clearTimeout(touch.tapTimer); touch.lastTapT = 0;
      doubleTap(x, y);
      return;
    }
    touch.lastTapT = now; touch.lastTapX = x; touch.lastTapY = y;
    var stopped = touch.stopped;
    touch.tapTimer = setTimeout(function () { if (!stopped) toggleBars(); }, 300);
    changed();
  }
  canvas.addEventListener('touchend', endTouch, { passive: false });
  canvas.addEventListener('touchcancel', endTouch, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });   // Safari's own page pinch: off

  function startFling(vx, vy) {   // px per ms
    if (Math.hypot(vx, vy) < 0.15) return;
    var last = performance.now();
    var me = fling = function (now) {
      if (fling !== me) return;   // stopped or replaced
      var dt = Math.min(40, now - last); last = now;
      var ox = vp.ox, oy = vp.oy;
      vp.panBy(vx * dt, vy * dt);
      var decay = Math.pow(0.995, dt);
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) < 0.02 || ((vx !== 0 || vy !== 0) && vp.ox === ox && vp.oy === oy)) { fling = null; changed(); return; }
      changed();
      requestAnimationFrame(me);
    };
    requestAnimationFrame(me);
  }

  // mouse and trackpad (a Mac or iPad with a pointer): drag pans, pinch (ctrl+wheel) zooms at the pointer
  var mouse = null;
  canvas.addEventListener('mousedown', function (e) { if (doc) { stopMotion(); mouse = [e.clientX * dpr(), e.clientY * dpr()]; } });
  window.addEventListener('mousemove', function (e) {
    if (!mouse) return;
    var x = e.clientX * dpr(), y = e.clientY * dpr();
    vp.panBy(x - mouse[0], y - mouse[1]); mouse = [x, y]; changed();
  });
  window.addEventListener('mouseup', function () { mouse = null; });
  canvas.addEventListener('dblclick', function (e) { doubleTap(e.clientX * dpr(), e.clientY * dpr()); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (!doc) return;
    stopMotion();
    if (e.ctrlKey) vp.zoomTo(vp.zoom * Math.exp(-e.deltaY * 0.01), e.clientX * dpr(), e.clientY * dpr());
    else vp.panBy(-e.deltaX * dpr(), -e.deltaY * dpr());
    changed();
  }, { passive: false });
  window.addEventListener('keydown', function (e) {
    if (!doc || !$('zoomDialog').hidden || !$('pwDialog').hidden || e.target.tagName === 'INPUT') return;
    if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-') zoomOut();
    else if (e.key === '0') zoomFit();
  });

  // ---------------------------------------------------------------- the bars and labels
  function toggleBars() { body.classList.toggle('bars-hidden'); }
  function updateLabels() {
    if (!doc || !vp.count()) {   // nothing loaded: no stale page count or made-up zoom
      $('zoomLabel').textContent = '…';
      $('zoomLabel').setAttribute('aria-label', 'Zoom');
      $('pageLabel').textContent = '';
      return;
    }
    $('zoomLabel').textContent = Zoom.text(vp.zoom) + '  ▾';
    $('zoomLabel').setAttribute('aria-label', 'Zoom ' + Zoom.text(vp.zoom) + '. Tap to type a zoom.');
    $('pageLabel').textContent = (vp.currentPage() + 1) + ' / ' + vp.count();
  }
  function showHome(on) {
    if (on && updatePending) { location.reload(); return; }   // a new version arrived during a PDF: take it at Home
    body.classList.toggle('home', on);
    body.classList.remove('bars-hidden');   // bars come back fully, seen and working
    if (on) fillRecents();
  }
  var toastTimer = 0;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  function busy(on, text) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; }

  $('minus').addEventListener('click', zoomOut);
  $('fit').addEventListener('click', zoomFit);
  // + : a click zooms in one step; holding it half a second jumps to the maximum
  (function () {
    var plus = $('plus'), holdTimer = 0, held = false;
    var down = function () { held = false; holdTimer = setTimeout(function () { held = true; zoomMax(); }, 550); };
    plus.addEventListener('touchstart', down, { passive: true });
    plus.addEventListener('mousedown', down);
    // review: after a hold, cancel iOS's own mousedown/click that follow the lift (they cut the glide short)
    plus.addEventListener('touchend', function (e) { clearTimeout(holdTimer); if (held && e.cancelable) e.preventDefault(); }, { passive: false });
    plus.addEventListener('mouseup', function () { clearTimeout(holdTimer); });
    plus.addEventListener('mouseleave', function () { clearTimeout(holdTimer); });
    plus.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    plus.addEventListener('click', function () { if (!held) zoomIn(); held = false; });
  })();
  $('back').addEventListener('click', function () {
    saveView(); close(); current = null; showHome(true);
  });
  $('openTop').addEventListener('click', pick);
  $('openHome').addEventListener('click', pick);

  // ---------------------------------------------------------------- the zoom box
  function zoomBox() {
    if (!doc) return;
    var dlg = $('zoomDialog'), input = $('zoomInput'), list = $('zoomList'), vv = window.visualViewport;
    input.value = Zoom.text(vp.zoom).replace('%', '');
    list.innerHTML = '';
    Zoom.listed().forEach(function (t) {
      var b = document.createElement('button'); b.textContent = t;
      b.addEventListener('click', function () { if (apply(t)) hide(); });
      list.appendChild(b);
    });
    // review: the sheet follows the visible area above the keyboard, so Zoom and the list stay reachable (the decimal
    // pad has no Go key; the Zoom button also sits right beside the field)
    var fit = function () {
      if (!vv) return;
      dlg.style.top = vv.offsetTop + 'px'; dlg.style.height = vv.height + 'px'; dlg.style.bottom = 'auto';
    };
    var hide = function () {
      dlg.hidden = true; input.blur();
      if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
      dlg.style.top = dlg.style.height = dlg.style.bottom = '';
    };
    dlg.hidden = false;
    if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
    input.focus(); input.select();   // inside the tap: iPhone opens the keyboard, the value selected
    $('zoomCancel').onclick = hide;
    $('zoomGo').onclick = function () { if (apply(input.value)) hide(); };
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); if (apply(input.value)) hide(); } if (e.key === 'Escape') hide(); };
    dlg.onclick = function (e) { if (e.target === dlg) hide(); };
  }
  function apply(text) {
    var z = Zoom.parse(text);
    if (z === null) { toast('Type a number from 1 to 1000000.'); return false; }
    zoomValue(z);
    return true;
  }
  $('zoomLabel').addEventListener('click', zoomBox);

  // ---------------------------------------------------------------- files and recents (kept on the phone)
  function pick() { var f = $('file'); f.value = ''; f.click(); }
  $('file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var info = { id: file.name + '|' + file.size + '|' + (file.lastModified || 0), name: file.name };
    readFile(file).then(function (buf) {
      // review: no extra copy - PDF.js takes the bytes over to its worker
      return openBytes(new Uint8Array(buf), info, viewOf(info.id)).then(function (ok) { if (ok) remember(info, file); });
    }).catch(function () { toast('This file could not be read.'); });
  });
  function readFile(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); });
  }

  var dbp = null;
  function db() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no db'));
      var rq = indexedDB.open('kbros-pdf', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('files', { keyPath: 'id' }); };
      rq.onsuccess = function () { var d = rq.result; d.onclose = function () { dbp = null; }; res(d); };   // review: reopen later
      rq.onerror = function () { dbp = null; rej(rq.error); };
    });
    return dbp;
  }
  function store(mode, fn, retried) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx;
        try { tx = d.transaction('files', mode); } catch (e) { dbp = null; return rej(e); }
        var out = fn(tx.objectStore('files'));
        tx.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function (e) {   // review: iOS can drop the connection while the app sleeps - open it again, once
      if (retried) throw e;
      dbp = null;
      return store(mode, fn, true);
    });
  }
  var MAX_RECENT = 6, MAX_BYTES = 150 * 1024 * 1024;
  function remember(info, blob) {
    if (blob.size > 60 * 1024 * 1024) return;   // very large files are opened, not kept
    store('readwrite', function (st) { st.put({ id: info.id, name: info.name, size: blob.size, time: Date.now(), blob: blob }); })
      .then(trimRecents).catch(function () {});
  }
  function allRecents() {
    return store('readonly', function (st) { return st.getAll(); }).then(function (r) {
      return (r || []).sort(function (a, b) { return b.time - a.time; });
    });
  }
  function trimRecents() {
    return allRecents().then(function (all) {
      var total = 0, drop = [];
      all.forEach(function (f, i) { total += f.size; if (i >= MAX_RECENT || total > MAX_BYTES) drop.push(f.id); });
      if (drop.length) return store('readwrite', function (st) { drop.forEach(function (id) { st.delete(id); }); });
    });
  }
  function emptyNote(box, text) { box.textContent = ''; var d = document.createElement('div'); d.className = 'empty'; d.textContent = text; box.appendChild(d); }
  function fillRecents() {
    var box = $('recents');
    allRecents().then(function (all) {
      box.textContent = '';
      if (!all.length) { emptyNote(box, 'Nothing yet – open a PDF to start.'); return; }
      all.forEach(function (f) {
        var row = document.createElement('div'); row.className = 'row';
        var open = document.createElement('button'); open.className = 'grow';
        open.style.textAlign = 'left';
        var n = document.createElement('div'); n.className = 'name'; n.textContent = f.name;   // a file name is never HTML
        var m = document.createElement('div'); m.className = 'meta'; m.textContent = ago(f.time) + ' · ' + size(f.size);
        open.appendChild(n); open.appendChild(m);
        open.addEventListener('click', function () {
          readFile(f.blob).then(function (buf) {
            return openBytes(new Uint8Array(buf), { id: f.id, name: f.name }, viewOf(f.id)).then(function (ok) {
              if (ok) store('readwrite', function (st) { f.time = Date.now(); st.put(f); }).catch(function () {});
            });
          }).catch(function () { toast('This file could not be read.'); });
        });
        var x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + f.name);
        x.addEventListener('click', function () { store('readwrite', function (st) { st.delete(f.id); }).then(fillRecents); });
        row.appendChild(open); row.appendChild(x); box.appendChild(row);
      });
    }).catch(function () { emptyNote(box, 'Recent files need storage this browser does not give.'); });
  }
  function ago(t) { var m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
  function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  // the place in each file, kept on the phone and put back when it is opened again
  function viewOf(id) { try { var v = JSON.parse(localStorage.getItem('view:' + id)); return v && v.length === 4 ? v : null; } catch (e) { return null; } }
  function saveView() { if (doc && current) { try { localStorage.setItem('view:' + current.id, JSON.stringify(vp.state())); } catch (e) {} } }
  window.addEventListener('pagehide', saveView);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveView(); });

  // ---------------------------------------------------------------- start
  function setVersion() {
    var ready = navigator.serviceWorker && navigator.serviceWorker.controller;
    $('version').textContent = 'Version ' + VERSION + (ready ? ' · ready offline' : '');
  }
  setVersion();
  if (window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) body.classList.add('standalone');
  // install-01: the installer profile is for Safari on an iPhone / iPad only, and only before the app is installed
  $('installProfile').hidden = !(isIOS && !body.classList.contains('standalone'));
  // install-01: GitHub Pages sends the .mobileconfig as a plain download (application/octet-stream - it cannot set
  // types), and Safari installs a profile only when it arrives as application/x-apple-aspen-config. So the button
  // hands Safari the same bytes with that type; the plain link stays for anything without Blob.
  function profileBlob() {
    return fetch($('installProfile').href, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('profile ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) { return new Blob([b], { type: 'application/x-apple-aspen-config' }); });
  }
  $('installProfile').addEventListener('click', function (e) {
    if (!window.Blob || !window.URL || !URL.createObjectURL) return;
    e.preventDefault();
    profileBlob().then(function (blob) { location.href = URL.createObjectURL(blob); })
      .catch(function () { toast('Connect to the internet to install, then try again.'); });
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    var hadWorker = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      // review: a Home Screen app is resumed, not reloaded - look for a new version each time it comes back
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () {}); });
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      setVersion();
      if (!hadWorker) { hadWorker = true; return; }   // the first install: nothing to replace
      if (!current) location.reload(); else updatePending = true;   // never in the middle of an open or a PDF: at Home
    });
  }
  // review: a nearly full iPhone may evict best-effort storage - ask to keep Recent and the offline copy
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  layout();
  showHome(true);

  // the test hook (test/browser-gate.js): the same steps the fingers and buttons take
  window.__kbpdf = {
    vp: vp, Zoom: Zoom, version: VERSION, engine: isWebKit ? 'WebKit (no cap)' : 'other (cap ' + SAFE_PX + ' px)',
    openUrl: function (url, name) {
      return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return openBytes(new Uint8Array(b), { id: 'test|' + url, name: name || url }, null); });
    },
    settled: function () { if (!doc) return Promise.resolve(); return new Promise(function (res) { window.__kbpdfSettled = function () { window.__kbpdfSettled = null; res(); }; clearTimeout(settleTimer); settleTimer = setTimeout(renderView, 0); }); },
    pixel: function (x, y) { draw(); var d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; },
    snapshot: function () { draw(); return ctx.getImageData(0, 0, canvas.width, canvas.height); },
    // the page point (x, y) to the middle of the screen: the content moves from where that point is to the middle
    centreOn: function (page, x, y) { vp.panBy(vp.vw / 2 - vp.toViewX(vp.pageLeft(page) + x), vp.vh / 2 - vp.toViewY(vp.pageTop[page] + y)); changed(); },
    routes: { zoomIn: zoomIn, zoomOut: zoomOut, zoomFit: zoomFit, zoomMax: zoomMax, apply: apply, doubleTap: doubleTap, toggleBars: toggleBars, back: function () { $('back').click(); } },
    labels: function () { return { zoom: $('zoomLabel').textContent, page: $('pageLabel').textContent, title: $('title').textContent }; },
    drawn: function () { draw(); return drawn.slice(); },
    hasBase: function (i) { return !!base.get(i); },
    tiles: function () { return tiles.map(function (t) { return { page: t.page, x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1, rp: t.rp, viewPpp: t.viewPpp }; }); },
    busy: function () { return !$('busy').hidden; },
    idle: function () { return !anim && !fling; },
    engineReady: getEngine,
    renderedPages: function () { return rendered.size; },
    isIOS: function () { return isIOS; },
    profileBlob: function () { return profileBlob(); },
    lastError: function () { return lastError ? String(lastError && (lastError.stack || lastError)) : null; }
  };
  // index.html#gate on a local server runs the browser gate (test/ is never published)
  if (location.hash === '#gate') { var gs = document.createElement('script'); gs.src = 'test/browser-gate.js'; document.body.appendChild(gs); }
})();
