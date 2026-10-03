/*
 * なかログ Service Worker
 *
 * 方針：「ネット優先 → だめならキャッシュ」
 *   - ネットにつながっていれば、常に最新のファイルを使う
 *     （GitHubにファイルを上書きアップロードするだけで更新が反映される）
 *   - 圏外・機内モードでは、前回保存したファイルで起動する
 *   - 記録データはIndexedDBにあるので、オフラインでもそのまま記録できる
 *
 * パスはすべて相対パス。GitHub Pages の https://ユーザー名.github.io/リポジトリ名/ でも動く。
 *
 * 夫婦で同期（Firebase）のプログラムは、初めて使ったときに保存しておき、次からはそれを使う
 * （URLにバージョンが入っていて中身が変わらないため）。圏外でも同期つきで起動できる。
 */
const CACHE_PREFIX = 'nakalog-';
const CACHE_NAME = CACHE_PREFIX + 'v0.2.2';
const SDK_CACHE = CACHE_PREFIX + 'sdk';
const SDK_PREFIX = 'https://www.gstatic.com/firebasejs/';
const NETWORK_TIMEOUT_MS = 3500; // 電波が弱いときは、これ以上待たずにキャッシュで起動

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(new Request(url, { cache: 'reload' }))
            .then((res) => (res.ok ? cleanResponse(res).then((r) => cache.put(url, r)) : null))
            .catch(() => null) // 1つ失敗しても他は保存する
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME && k !== SDK_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.url.startsWith(SDK_PREFIX)) {
    event.respondWith(sdkCacheFirst(req));
    return;
  }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebaseの通信などはそのまま通す

  const isNav = req.mode === 'navigate';
  // ナビゲーションのRequestはそのまま設定変更できないので、URLから作り直す
  const netReq = isNav
    ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(req, { cache: 'no-cache' });

  const network = fetch(netReq).then((res) => ({ res: res, copy: res.clone() }));

  // 取れたらキャッシュを更新（裏で）
  event.waitUntil(
    network
      .then(async ({ res, copy }) => {
        if (!res.ok || res.type !== 'basic') return;
        const cache = await caches.open(CACHE_NAME);
        await cache.put(req.url, await cleanResponse(copy));
      })
      .catch(() => {})
  );

  event.respondWith(
    (async () => {
      try {
        const { res } = await withTimeout(network, NETWORK_TIMEOUT_MS);
        return isNav ? cleanResponse(res) : res;
      } catch (_) {
        const cached = await fromCache(req, isNav);
        if (cached) return cached;
        const { res } = await network; // キャッシュもなければネットを待つ
        return isNav ? cleanResponse(res) : res;
      }
    })()
  );
});

async function sdkCacheFirst(req) {
  const cache = await caches.open(SDK_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

async function fromCache(req, isNav) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req.url, { ignoreSearch: true });
  if (hit) return hit;
  if (isNav) return (await cache.match('./')) || (await cache.match('./index.html'));
  return undefined;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/* リダイレクトを経たレスポンスはSafariでページ表示に使えないので作り直す */
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
