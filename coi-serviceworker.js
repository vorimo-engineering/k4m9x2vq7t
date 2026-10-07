/* coi-serviceworker.js — CROSS-ORIGIN ISOLATION for a host that cannot send the headers.
 *
 * The in-browser matcher's evaluators share memory with its search
 * (SharedArrayBuffer + Atomics: match/worker.js), and a browser hands out shared
 * memory only to a cross-origin-isolated page — one served with
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 * GitHub Pages sends neither and has no way to configure them. A service worker
 * can: it sits between the page and the network and adds the two headers to
 * every response of its scope (this folder: the page, live.html, match/). The
 * page registers it (js/ui/match.js isolate()) and reloads once; every later
 * visit is isolated from its first byte.
 *
 * The page loads nothing from another origin (tests/bundle.mjs enforces it), so
 * require-corp blocks nothing it uses. Opened as a file:// page there is no
 * service worker and no isolation; the matcher then runs without evaluators.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;   /* a devtools quirk: leave it */
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0) return res;                                    /* opaque: nothing to add to */
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch((err) => new Response(String(err), { status: 502 })));
});
