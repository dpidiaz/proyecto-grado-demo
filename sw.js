const CACHE_PREFIX = 'cuaderno-grado-demo-799dc3f-';
const CACHE_NAME = 'cuaderno-grado-demo-799dc3f-shell-youtube-toggle-v1';
// Keep this cache across shell releases so previously available offline media survives updates.
const MEDIA_CACHE_NAME = 'cuaderno-grado-demo-799dc3f-media';
const APP_FILES = ['./', './index.html', './styles.css', './atlas-outline.js', './numbering.js', './app.js', './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png', './importaciones/contenido-proyecto-autosuficiente-v3.json', './importaciones/contenido-idml-para-importar.json', './importaciones/correcciones-apa-028-001.json', './importaciones/auditoria-apa-pdf-octubre-2026.json', './importaciones/apa-review-register-2026-10-18.json', './importaciones/respaldo-local-pre-unificacion-2026-10-18.json', './importaciones/registro-imagenes-generadas-2026.json', './importaciones/auditoria-figuras-apa-2026-10-20.json', './importaciones/auditoria-referencias-apa7-pwa-2026-10-21.json', './importaciones/registro-revision-academica-apa-2026-10-21.json', './offline-media-manifest.json'];
const APP_FILE_PATHS = new Set(APP_FILES.map((path) => new URL(path, self.registration.scope).pathname));
const MEDIA_PATH = new URL('./media/', self.registration.scope).pathname;
const OFFLINE_STATUS_URL = new URL('./__offline-media-status__.json', self.registration.scope);
const SHELL_STATUS_URL = new URL('./__offline-shell-status__.json', self.registration.scope);
const REQUIRED_SHELL_FILES = new Set([
  './', './index.html', './styles.css', './atlas-outline.js', './app.js', './manifest.webmanifest',
  './importaciones/contenido-proyecto-autosuficiente-v3.json', './importaciones/auditoria-referencias-apa7-pwa-2026-10-21.json', './importaciones/registro-revision-academica-apa-2026-10-21.json', './offline-media-manifest.json'
]);
const MEDIA_CACHE_MAX_ENTRIES = 192;
const MEDIA_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const MEDIA_CACHE_MAX_FILE_BYTES = 20 * 1024 * 1024;
const MEDIA_TYPES = /^(?:image\/(?:jpeg|png|webp|gif|svg\+xml)|application\/pdf)(?:\s*;|$)/i;
let bundledMediaCachePromise = null;

function ensureBundledMediaCache() {
  if (!bundledMediaCachePromise) {
    bundledMediaCachePromise = cacheBundledMediaOffline().finally(() => { bundledMediaCachePromise = null; });
  }
  return bundledMediaCachePromise;
}

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const failures = [];
  for (const asset of APP_FILES) {
    try {
      await cache.add(asset);
    } catch (error) {
      failures.push({ asset, message: String(error?.message || error) });
    }
  }
  const status = { expected: APP_FILES.length, cached: APP_FILES.length - failures.length, failures,
    requiredFailures: failures.filter(({ asset }) => REQUIRED_SHELL_FILES.has(asset)), completedAt: new Date().toISOString() };
  await cache.put(SHELL_STATUS_URL, new Response(JSON.stringify(status), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  }));
  if (failures.length) console.warn('Algunos archivos auxiliares del shell no se precargaron:', status);
  if (status.requiredFailures.length) throw new Error(`Faltan recursos principales del shell: ${status.requiredFailures.map(item => item.asset).join(', ')}`);
}

function appShellPath(url) {
  return APP_FILE_PATHS.has(url.pathname);
}

function mediaPath(url) {
  return url.pathname.startsWith(MEDIA_PATH);
}

function canonicalAssetRequest(url) {
  const canonical = new URL(url.href);
  canonical.search = '';
  canonical.hash = '';
  return new Request(canonical.href, { method: 'GET', credentials: 'same-origin' });
}

async function findCachedShellAsset(cache, request, url) {
  const exact = await cache.match(request);
  if (exact) return exact;
  if (!url.search || !appShellPath(url)) return null;
  return cache.match(canonicalAssetRequest(url));
}

async function trimMediaCache(cache) {
  const keys = await cache.keys();
  let totalBytes = 0;
  const records = [];
  for (const request of keys) {
    const response = await cache.match(request);
    const length = Number(response?.headers.get('content-length'));
    const bytes = Number.isFinite(length) && length >= 0 ? length : 0;
    totalBytes += bytes;
    records.push({ request, bytes });
  }

  while (records.length > MEDIA_CACHE_MAX_ENTRIES || totalBytes > MEDIA_CACHE_MAX_BYTES) {
    const oldest = records.shift();
    if (!oldest) break;
    await cache.delete(oldest.request);
    totalBytes -= oldest.bytes;
  }
}

async function cacheMediaResponse(request, response, url) {
  const contentType = response.headers.get('content-type') || '';
  const length = Number(response.headers.get('content-length'));
  if (response.status !== 200 || response.type === 'opaque' || !MEDIA_TYPES.test(contentType)) return;
  // Skip unknown-size bodies: Cache API has no portable quota query, and PDFs/images can be large.
  if (!Number.isFinite(length) || length <= 0 || length > MEDIA_CACHE_MAX_FILE_BYTES) return;

  const cache = await caches.open(MEDIA_CACHE_NAME);
  await cache.put(canonicalAssetRequest(url), response.clone());
  await trimMediaCache(cache);
}

async function cacheBundledMediaOffline() {
  const shellCache = await caches.open(CACHE_NAME);
  const manifestResponse = await shellCache.match(new URL('./offline-media-manifest.json', self.registration.scope));
  if (!manifestResponse) throw new Error('No se encontró el manifiesto de medios offline.');
  const manifest = await manifestResponse.json();
  const assets = Array.isArray(manifest) ? manifest : [];
  const mediaCache = await caches.open(MEDIA_CACHE_NAME);
  const failures = [];
  let cached = 0;
  let cachedBytes = 0;
  let nextIndex = 0;

  async function cacheNext() {
    while (nextIndex < assets.length) {
      const asset = assets[nextIndex++];
      const url = new URL(asset.url, self.registration.scope);
      const request = canonicalAssetRequest(url);
      try {
        const existing = await mediaCache.match(request);
        if (existing) {
          cached += 1;
          cachedBytes += Number(asset.bytes) || Number(existing.headers.get('content-length')) || 0;
          continue;
        }
        const response = await fetch(request);
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || response.type === 'opaque' || !MEDIA_TYPES.test(contentType)) {
          throw new Error(`Respuesta inválida (${response.status}, ${contentType || 'sin tipo'}).`);
        }
        await mediaCache.put(request, response);
        cached += 1;
        cachedBytes += Number(asset.bytes) || Number(response.headers.get('content-length')) || 0;
      } catch (error) {
        failures.push({ url: asset.url, message: String(error?.message || error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, assets.length) }, () => cacheNext()));
  await trimMediaCache(mediaCache);
  cached = 0;
  cachedBytes = 0;
  for (const asset of assets) {
    const response = await mediaCache.match(canonicalAssetRequest(new URL(asset.url, self.registration.scope)));
    if (!response) continue;
    cached += 1;
    cachedBytes += Number(asset.bytes) || Number(response.headers.get('content-length')) || 0;
  }
  const status = {
    expected: assets.length,
    cached,
    cachedBytes,
    expectedBytes: assets.reduce((sum, asset) => sum + (Number(asset.bytes) || 0), 0),
    failures,
    completedAt: new Date().toISOString()
  };
  await mediaCache.put(OFFLINE_STATUS_URL, new Response(JSON.stringify(status), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    cacheAppShell()
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (event) => {
  if (!['GET_OFFLINE_MEDIA_STATUS', 'CACHE_BUNDLED_MEDIA_OFFLINE'].includes(event.data?.type) || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    if (event.data.type === 'CACHE_BUNDLED_MEDIA_OFFLINE') {
      try {
        await ensureBundledMediaCache();
      } catch (error) {
        console.warn('No se pudieron guardar todos los medios para uso sin conexión:', error);
      }
    }
    const cache = await caches.open(MEDIA_CACHE_NAME);
    const response = await cache.match(OFFLINE_STATUS_URL);
    event.ports[0].postMessage(response ? await response.json() : null);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME && key !== MEDIA_CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isShellAsset = appShellPath(url);
  const isMediaAsset = mediaPath(url);
  if (!isShellAsset && !isMediaAsset && request.mode !== 'navigate') return;

  event.respondWith((async () => {
    const shellCache = await caches.open(CACHE_NAME);

    if (isShellAsset) {
      const cached = await findCachedShellAsset(shellCache, request, url);
      if (cached) return cached;
    }

    if (isMediaAsset) {
      const mediaCache = await caches.open(MEDIA_CACHE_NAME);
      const cached = await mediaCache.match(canonicalAssetRequest(url));
      if (cached) return cached;
    }

    try {
      const response = await fetch(request);
      if (isMediaAsset && response.ok) {
        try {
          // Await the write within respondWith so the worker cannot be stopped mid-cache.
          await cacheMediaResponse(request, response, url);
        } catch (error) {
          // A cache/quota failure must not prevent displaying the network response.
          console.warn('No se pudo guardar el recurso para uso sin conexión:', error);
        }
      }
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        return (await findCachedShellAsset(shellCache, new Request(new URL('./index.html', self.registration.scope)), new URL('./index.html', self.registration.scope)))
          || shellCache.match(new URL('./', self.registration.scope).href)
          || Response.error();
      }
      return Response.error();
    }
  })());
});
