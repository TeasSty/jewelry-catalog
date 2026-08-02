// Минимальный service worker — нужен главным образом для того, чтобы Chrome/
// Android вообще посчитали сайт "устанавливаемым" и прислали beforeinstallprompt
// (см. initInstallPrompt в app.js): без зарегистрированного SW с обработчиком
// fetch это событие не наступает никогда, сколько ни жди.
//
// Кэшируем только "оболочку" — статичную разметку/скрипт/иконки, ничего, что
// часто меняется. catalog.json и фото товаров НЕ кэшируем нарочно: это то,
// что должно оставаться свежим при каждом заходе, а не залипать в кэше SW
// (для них уже есть свой контроль свежести — HTTP-кэш браузера и cache:"no-cache"
// на самом fetch в app.js). Всё, что не входит в SHELL_FILES, просто не
// перехватываем — уходит в сеть как обычно, будто SW не установлен вовсе.
const CACHE_NAME = "voronin-shell-v1";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/app.js",
  "/config.js",
  "/manifest.json",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!SHELL_FILES.includes(url.pathname)) return; // каталог/фото/всё остальное — мимо, в обычную сеть

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
