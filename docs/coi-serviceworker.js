/* coi-serviceworker — enables SharedArrayBuffer on static hosts (GitHub Pages etc.)
 * Adds COOP + COEP headers via a Service Worker so no server config is needed.
 * Uses COEP: credentialless (vs require-corp) so CDN resources don't need a
 * Cross-Origin-Resource-Policy header.
 *
 * Flow:
 *   1st load  → SW registers → page reloads automatically
 *   2nd load  → SW intercepts fetches → adds COOP/COEP → crossOriginIsolated = true
 *               → SharedArrayBuffer available → ffmpeg-core-mt pthreads work
 */

if (typeof window === 'undefined') {
  /* ── Service Worker context ─────────────────────────────────────────────── */
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', e => {
    // Skip opaque "only-if-cached" cross-origin requests (would throw a TypeError)
    if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;

    e.respondWith(
      fetch(e.request).then(response => {
        // Opaque responses (status 0) — don't touch
        if (response.status === 0) return response;

        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        // credentialless: cross-origin sub-resources load without credentials,
        // no CORP header required — works with jsDelivr/unpkg CDNs out of the box.
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');

        return new Response(response.body, {
          status:     response.status,
          statusText: response.statusText,
          headers,
        });
      })
    );
  });

} else {
  /* ── Page context — register this file as the Service Worker ───────────── */
  if (!crossOriginIsolated && 'serviceWorker' in navigator) {
    navigator.serviceWorker
      .register(document.currentScript.src)
      .then(() => location.reload())
      .catch(err => console.error('[coi-sw] registration failed:', err));
  }
}
