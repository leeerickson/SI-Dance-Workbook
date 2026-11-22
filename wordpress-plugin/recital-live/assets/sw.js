/*
 * Recital Live service worker (served from /recital/sw.js).
 * Keeps the show pages working when the theatre's signal drops:
 *   - pages: network first, falling back to the last copy;
 *   - live data (the REST API): network first, falling back to the last reply, marked as offline;
 *   - styles, script and icons: cache first.
 */
var VERSION = __RL_VERSION__;
var SHELL = __RL_SHELL__;
var CACHE = 'recital-live-' + VERSION;

self.addEventListener('install', function (event) {
	event.waitUntil(
		caches.open(CACHE).then(function (cache) {
			return cache.addAll(SHELL).catch(function () { /* cache what we can later */ });
		}).then(function () { return self.skipWaiting(); })
	);
});

self.addEventListener('activate', function (event) {
	event.waitUntil(
		caches.keys().then(function (keys) {
			return Promise.all(keys.filter(function (k) {
				return k.indexOf('recital-live-') === 0 && k !== CACHE;
			}).map(function (k) { return caches.delete(k); }));
		}).then(function () { return self.clients.claim(); })
	);
});

// The page asks us to keep a copy of itself the first time it opens (before we were looking after it).
self.addEventListener('message', function (event) {
	var msg = event.data || {};
	if (msg.type !== 'recital-cache-page' || typeof msg.url !== 'string') return;
	var url;
	try { url = new URL(msg.url); } catch (e) { return; }
	if (url.origin !== self.location.origin) return;
	event.waitUntil(
		fetch(url.href, { credentials: 'same-origin' }).then(function (res) {
			if (res.ok) return caches.open(CACHE).then(function (c) { return c.put(url.href, res); });
		}).catch(function () {})
	);
});

function isApi(url) {
	return url.pathname.indexOf('/recital-live/v1/') >= 0 || (url.searchParams.get('rest_route') || '').indexOf('/recital-live/v1/') === 0;
}

// Crew and public replies are kept apart, so turning crew view off never shows old cues.
function apiCacheKey(request) {
	var u = new URL(request.url);
	u.searchParams.set('rl_cache', request.headers.get('X-Recital-Code') ? 'crew' : 'all');
	return u.href;
}

function apiFetch(request) {
	var key = apiCacheKey(request);
	return fetch(request).then(function (res) {
		if (res.ok) {
			var copy = res.clone();
			copy.blob().then(function (body) {
				var headers = new Headers(copy.headers);
				headers.set('X-Recital-Fetched', String(Date.now()));
				return caches.open(CACHE).then(function (c) {
					return c.put(key, new Response(body, { status: 200, headers: headers }));
				});
			}).catch(function () {});
		}
		return res;
	}).catch(function (err) {
		return caches.open(CACHE).then(function (c) { return c.match(key); }).then(function (hit) {
			if (!hit) throw err;
			return hit.blob().then(function (body) {
				var headers = new Headers(hit.headers);
				headers.set('X-Recital-Offline', '1');
				return new Response(body, { status: 200, headers: headers });
			});
		});
	});
}

self.addEventListener('fetch', function (event) {
	var req = event.request;
	if (req.method !== 'GET') return;
	var url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	if (isApi(url)) {
		event.respondWith(apiFetch(req));
		return;
	}

	// Only show pages: on sites without pretty permalinks our scope is the whole site.
	if (req.mode === 'navigate' && (url.pathname.indexOf('/recital/') >= 0 || url.searchParams.has('recital_show'))) {
		event.respondWith(
			fetch(req).then(function (res) {
				if (res.ok) {
					var copy = res.clone();
					caches.open(CACHE).then(function (c) { return c.put(req.url, copy); });
				}
				return res;
			}).catch(function () {
				return caches.match(req.url).then(function (hit) {
					return hit || new Response('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="background:#0d0f14;color:#eef0f5;font:18px system-ui;padding:32px;text-align:center"><h1>You\'re offline</h1><p>Open this page again when you have signal.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
				});
			})
		);
		return;
	}

	if (url.pathname.indexOf('/recital-live/assets/') >= 0) {
		event.respondWith(
			caches.match(req).then(function (hit) {
				return hit || fetch(req).then(function (res) {
					if (res.ok) {
						var copy = res.clone();
						caches.open(CACHE).then(function (c) { return c.put(req, copy); });
					}
					return res;
				});
			})
		);
	}
});
