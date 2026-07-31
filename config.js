// Общие настройки сайта и админки — одно место вместо копий в app.js и admin/admin.js.
//
// Что здесь МОЖНО держать: значения, которые и так видит любой посетитель, открыв
// исходный код страницы (Ctrl+U). Firebase-конфиг именно такой — это идентификаторы
// проекта, а не пароль: вся защита живёт в правилах Firestore (firestore.rules).
//
// Что здесь ДЕРЖАТЬ НЕЛЬЗЯ: токен Telegram-бота, ключ ImgBB, сервисные ключи Google.
// Любой ключ, попавший в файл, который отдаётся браузеру, — это ключ, отданный
// публике; спрятать его на статическом сайте нельзя в принципе. Такие ключи живут
// секретами Cloudflare Worker (папка worker/), см. SECURITY.md.

export const firebaseConfig = {
  apiKey: "AIzaSyDKo5f366jIkLQVlrL9GHIHt_6dgHvIhUs",
  authDomain: "voronin-jewelry.firebaseapp.com",
  projectId: "voronin-jewelry",
  messagingSenderId: "1067796651938",
  appId: "1:1067796651938:web:3d89a194660765b4869cfb",
  measurementId: "G-FJ9Z8C6YG"
};

// Адрес Cloudflare Worker из папки worker/ — единственное место, где лежат секреты.
// Через него идут два действия: уведомление о заказе в Telegram (/notify) и загрузка
// фото товара на ImgBB (/upload).
//
// Порядок развёртывания — SECURITY.md, раздел «Как поднять воркер».
// Секреты (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, IMGBB_API_KEY) в воркер ещё нужно
// задать отдельно командой `wrangler secret put ИМЯ` — без них /notify и /upload
// отвечают понятной ошибкой вместо тихой поломки, остальной сайт работает как обычно.
export const RELAY_URL = "https://voronin-relay.gwho12345678.workers.dev";

// Убирает хвостовые слэши, чтобы `${relayUrl()}/notify` не превратился в "//notify"
export function relayUrl() {
  return RELAY_URL.replace(/\/+$/, "");
}
