/* KBros PDF Editor for iPhone - offline: the app and PDF.js are kept on the phone after the first visit.
   build.sh writes the version AND a hash of the app's files into CACHE, so any change to the app is a new cache: the
   phone installs it whole and the old one is removed (review, 24 Nov 2026). */
var CACHE = 'kbros-pdf-1.0.1-1e7a620841';
// PDF.js's CMaps and standard fonts, kept the first time a PDF needs them, in a cache of their own named for the PDF.js
// version: app updates delete old 'kbros-pdf-*' caches, never this one (review round 2: CJK PDFs broke offline after
// an update)
var DATA = 'kbros-pdfjs-3.11.174';
var PDFJS_ROOT = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
var PDFJS = PDFJS_ROOT + 'legacy/build/';
var FILES = ['./', 'index.html', 'app.css', 'core.js', 'app.js', 'manifest.webmanifest',
             'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/favicon-32.png',
             'icons/brand-512.png',
             PDFJS + 'pdf.min.js', PDFJS + 'pdf.worker.min.js'];
// round 2: PDF.js is checked by its hash when it is installed, so a bad copy from the CDN is never kept (install fails
// and is tried again next time)
var SRI = {};
SRI[PDFJS + 'pdf.min.js'] = 'sha384-OemFRmhjDZwhIKuUld0HJozkF2YErsgDaCL41trxGQZt4/WgnopJQqQl2DvDZ07Z';
SRI[PDFJS + 'pdf.worker.min.js'] = 'sha384-sS8B4COeBqzQV9DaPpp5cbpF+xz2jPcFbN3L8FL3/dx0RMC6WLUwTUOFm0iFb1lw';

self.addEventListener('install', function (e) {
  // 'reload': straight from the network, never from the browser's HTTP cache (GitHub Pages lets that keep a file for
  // 10 minutes, which put the old version into the new cache)
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (u) {
      return new Request(u, { mode: u.indexOf('http') === 0 ? 'cors' : 'same-origin', cache: 'reload', integrity: SRI[u] || '' });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('kbros-pdf-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// from the phone first, so it works with no network. A version arrives whole through install (above), never file by
// file in the background.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = req.url;
  var runtime = url.indexOf(PDFJS_ROOT) === 0 && url.indexOf(PDFJS) !== 0;   // CMaps, standard fonts
  var ours = url.indexOf(self.registration.scope) === 0 || url.indexOf(PDFJS_ROOT) === 0;
  if (!ours || url.indexOf('/test/') >= 0) return;   // the gate's own files are never kept
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true });
  }).then(function (hit) {
    if (hit) return hit;
    if (!runtime) return fetch(req);
    return caches.open(DATA).then(function (d) {
      return d.match(req).then(function (kept) {
        if (kept) return kept;
        return fetch(req).then(function (res) {
          if (res && res.ok) { var copy = res.clone(); e.waitUntil(d.put(req, copy)); }
          return res;
        });
      });
    });
  }));
});
