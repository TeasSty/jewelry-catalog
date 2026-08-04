// Service worker больше не используется сайтом (PWA отключён).
// Файл оставлен, чтобы клиенты со СТАРОЙ регистрацией получили обновление,
// сбросили Cache Storage и сняли SW — иначе часть пользователей вечно видит
// устаревшую/битую оболочку из кэша, а «чистые» браузеры работают нормально.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}
    try {
      await self.registration.unregister();
    } catch (_) {}
    try {
      await self.clients.claim();
    } catch (_) {}
    // Перезагружаем контролируемые вкладки на свежий документ с сети
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(clients.map((c) => {
        if (typeof c.navigate === "function") {
          return c.navigate(c.url).catch(() => {});
        }
        return Promise.resolve();
      }));
    } catch (_) {}
  })());
});

// Ничего не перехватываем и не отдаём из кэша — только сеть (на случай,
// пока activate ещё не успел снять регистрацию).
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
