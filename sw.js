// Service worker больше не используется сайтом (PWA-установка отключена).
// Этот файл оставлен только чтобы клиенты со СТАРОЙ регистрацией подтянули
// обновление и сняли SW: иначе они могли бы бесконечно держать кеш оболочки.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
  );
});
