// Only these endpoints are independent of the current user and may be shared.
export const PUBLIC_CACHE_POLICIES = Object.freeze({
  '/api/products': { scope: 'catalog', edgeTtl: 30, browserTtl: 5 },
  '/api/categories': { scope: 'catalog', edgeTtl: 60, browserTtl: 10 },
  '/api/config': { scope: 'site', edgeTtl: 300, browserTtl: 30 },
  '/api/product': { scope: 'plans', edgeTtl: 60, browserTtl: 10 },
});

const CACHE_NAMESPACE = '/.onepay-cache/v3';
const GENERATION_TTL = 86400;
const PUBLIC_PAGES = new Set(['/', '/index.html', '/shop', '/shop.html', '/account', '/account.html']);
const STATIC_FILES = new Set(['/storefront.css', '/storefront.js', '/admin.css']);

function edgeCache() {
  try { return globalThis.caches?.default || null; } catch { return null; }
}

function generationKey(origin, scope) {
  return new Request(`${origin}${CACHE_NAMESPACE}/generation/${scope}`);
}

// Keep the public cache key and catalog filtering in lockstep for repeated tags.
export function productTagFilters(params) {
  return [...new Set(params.getAll('tag').map(value => String(value).trim().slice(0, 24)).filter(Boolean))].sort().slice(0, 8);
}

function dataKey(request, generation) {
  const original = new URL(request.url);
  const key = new URL(`${original.origin}${CACHE_NAMESPACE}${original.pathname}`);
  key.searchParams.set('generation', generation);
  if (original.pathname === '/api/products') {
    // Match listProducts' normalization. Ignore tracking parameters and order.
    for (const [name, limit] of [['q', 64], ['category', 64]]) {
      const value = String(original.searchParams.get(name) || '').trim().slice(0, limit);
      if (value) key.searchParams.set(name, value);
    }
    for (const tag of productTagFilters(original.searchParams)) key.searchParams.append('tag', tag);
  }
  return new Request(key.toString());
}

function generationResponse() {
  return new Response(crypto.randomUUID(), {
    headers: { 'cache-control': `public, max-age=${GENERATION_TTL}`, 'content-type': 'text/plain' },
  });
}

async function generation(cache, origin, scope) {
  const key = generationKey(origin, scope);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const value = await hit.text();
      if (value) return value;
    }
    // A new random generation also prevents old entries reappearing after eviction.
    const fresh = generationResponse();
    const value = await fresh.clone().text();
    await cache.put(key, fresh);
    return value;
  } catch {
    return null;
  }
}

function hasPrivateVary(response) {
  // Only content encoding may vary safely: our shared keys do not contain
  // arbitrary request headers that might identify a user or tenant.
  return (response.headers.get('vary') || '').split(',')
    .some(value => value.trim() && value.trim().toLowerCase() !== 'accept-encoding');
}

function cacheableJson(response) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return response.status === 200 && type === 'application/json' &&
    !response.headers.has('set-cookie') && !(response.headers.get('vary') || '').trim();
}

function withPrivateHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withPublicHeaders(response, policy, status) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', `public, max-age=${policy.browserTtl}, s-maxage=${policy.edgeTtl}, must-revalidate`);
  headers.set('x-cache', status);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isRefresh(request) {
  const value = request.headers.get('cache-control') || '';
  return /(?:^|,)\s*(?:no-cache|no-store|max-age\s*=\s*0)\s*(?:,|$)/i.test(value) ||
    /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(request.headers.get('pragma') || '');
}

export async function cachedPublicJson(request, produce, ctx) {
  const url = new URL(request.url);
  const policy = PUBLIC_CACHE_POLICIES[url.pathname];
  if (request.method !== 'GET' || !policy) return produce();

  const cache = edgeCache();
  const requestNoStore = /(?:^|,)\s*no-store\s*(?:,|$)/i.test(request.headers.get('cache-control') || '');
  const refresh = isRefresh(request);
  const version = cache && !requestNoStore ? await generation(cache, url.origin, policy.scope) : null;
  const key = version ? dataKey(request, version) : null;
  if (key && !refresh) {
    try {
      const hit = await cache.match(key);
      if (hit && cacheableJson(hit)) return withPublicHeaders(hit, policy, 'HIT');
    } catch { /* Cache is optional: serve from the source. */ }
  }

  const response = await produce();
  // Errors, cookies, and user-dependent variants must never be shared.
  if (!cacheableJson(response)) return withPrivateHeaders(response);
  if (requestNoStore) return withPrivateHeaders(response);
  const result = withPublicHeaders(response, policy, key ? (refresh ? 'REFRESH' : 'MISS') : 'BYPASS');
  if (key) {
    const copy = result.clone();
    const write = Promise.resolve().then(() => cache.put(key, copy)).catch(() => {});
    try {
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    } catch { /* A cache scheduling failure must not fail the response. */ }
  }
  return result;
}

// Cache API is per data center. Rotating the local generation invalidates every
// query variant without enumerating keys; other locations expire by their TTL.
export async function invalidatePublicCache(request, scopes) {
  const cache = edgeCache();
  if (!cache) return;
  const origin = new URL(request.url).origin;
  await Promise.all([...new Set(scopes)].map(async scope => {
    const key = generationKey(origin, scope);
    try { await cache.put(key, generationResponse()); }
    catch { try { await cache.delete(key); } catch { /* Writes remain successful if cache is unavailable. */ } }
  }));
}

export function withStaticCache(response, requestUrl) {
  const url = new URL(requestUrl);
  const headers = new Headers(response.headers);
  if (headers.has('set-cookie') || hasPrivateVary(response)) {
    headers.set('cache-control', 'private, no-store');
  } else if (url.pathname === '/admin' || url.pathname === '/admin.html') {
    headers.set('cache-control', 'private, no-store');
  } else if (/(?:^|,)\s*(?:private|no-store)(?:\s|=|,|$)/i.test(headers.get('cache-control') || '')) {
    return response;
  } else if (response.ok || response.status === 304) {
    if (PUBLIC_PAGES.has(url.pathname)) {
      // HTML is a generic shell; all account data is fetched separately, no-store.
      headers.set('cache-control', 'public, max-age=30, s-maxage=60, must-revalidate');
    } else if (STATIC_FILES.has(url.pathname) || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/monaco/')) {
      const versioned = (STATIC_FILES.has(url.pathname) || url.pathname.startsWith('/vendor/monaco/')) && Boolean(url.searchParams.get('v'));
      headers.set('cache-control', versioned
        ? 'public, max-age=86400, s-maxage=86400, immutable'
        : 'public, max-age=3600, s-maxage=3600');
    } else {
      return response;
    }
    headers.set('x-cache', 'ASSET');
  } else {
    return response;
  }
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (url.protocol === 'https:') headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
