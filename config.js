// Общие настройки сайта и админки — одно место вместо копий в app.js и admin/admin.js.
//
// Что здесь МОЖНО держать: значения, которые и так видит любой посетитель, открыв
// исходный код страницы (Ctrl+U). Firebase-конфиг именно такой — это идентификаторы
// проекта, а не пароль: вся защита живёт в правилах Firestore (firestore.rules).
//
// Что здесь ДЕРЖАТЬ НЕЛЬЗЯ: токен Telegram-бота, ключ ImgBB, сервисные ключи Google.
// Любой ключ, попавший в файл, который отдаётся браузеру, — это ключ, отданный
// публике; спрятать его на статическом сайте нельзя в принципе. Такие ключи живут
// секретами Cloudflare Worker (папка worker/) или .env у Node-релея (relay-node/).

export const firebaseConfig = {
  apiKey: "AIzaSyDKo5f366jIkLQVlrL9GHIHt_6dgHvIhUs",
  // Свой домен (должен быть в Firebase Console → Authentication → Authorized domains).
  // Не firebaseapp.com: у части сетей в РФ *.firebaseapp.com режется вместе с Google.
  authDomain: "voroninkostroma.ru",
  projectId: "voronin-jewelry",
  messagingSenderId: "1067796651938",
  appId: "1:1067796651938:web:3d89a194660765b4869cfb",
  measurementId: "G-FJ9Z8C6YG"
};

/**
 * Кандидаты релея (порядок важен).
 *
 * 1) relay.voroninkostroma.ru — Node на VPS ВНЕ Cloudflare (Selectel / Timeweb / Beget).
 *    Единственный путь, который стабильно работает у клиентов в РФ без VPN после
 *    throttling Cloudflare (~16 KB) с июня 2025. DNS: A-запись на IP VPS в reg.ru.
 * 2) workers.dev — запасной путь (VPN / заграница). С июня 2025 у многих РФ-провайдеров
 *    Cloudflare (включая *.workers.dev и custom domain Worker) недоступен без VPN —
 *    кастомный домен на Worker эту проблему НЕ лечит.
 *
 * Если оба не отвечают — applyFirebaseProxies оставляет прямые хосты Google
 * (удобно, когда VPN уже открыл googleapis).
 */
export const RELAY_CANDIDATES = [
  "https://relay.voroninkostroma.ru",
  "https://voronin-relay.gwho12345678.workers.dev"
];

// Совместимость со старым именем: первый кандидат (RU VPS). Активный адрес
// после probe — через relayUrl() / ensureRelayReady().
export const RELAY_URL = RELAY_CANDIDATES[0];

let _activeRelay = null;
let _probePromise = null;

export function relayUrl() {
  const base = _activeRelay || RELAY_URL || "";
  return String(base).replace(/\/+$/, "");
}

/** Проверка /health у кандидата (CORS). Таймаут короткий — не блокируем UI. */
async function probeRelay(base, ms = 2500) {
  const url = String(base).replace(/\/+$/, "") + "/health";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: ctrl.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Выбрать первый живой релей. Вызывать до getAuth / initializeFirestore.
 * Повторные вызовы переиспользуют результат.
 */
export function ensureRelayReady() {
  if (_probePromise) return _probePromise;
  _probePromise = (async () => {
    for (const candidate of RELAY_CANDIDATES) {
      if (await probeRelay(candidate)) {
        _activeRelay = candidate.replace(/\/+$/, "");
        return _activeRelay;
      }
    }
    // Прямой Google (VPN / сети без блокировок). relayUrl() пустой → /notify и /upload
    // пропускаются с понятной ошибкой, Auth/Firestore идут на *.googleapis.com.
    _activeRelay = "";
    return "";
  })();
  return _probePromise;
}

// Локальная копия Firebase JS SDK (vendor/) — без похода на gstatic.com.
// Абсолютный путь от корня домена, чтобы одинаково работал и /admin/, и корень.
export const FIREBASE_SDK_VERSION = "10.8.0";
export function firebaseSdkUrl(file) {
  return new URL(`/vendor/firebase/${FIREBASE_SDK_VERSION}/${file}`, location.origin).href;
}

/**
 * Направляет Auth и Firestore через reverse-proxy релея (если он выбран).
 * Вызывать сразу после getAuth / перед любыми запросами, пока сессия ещё не тронута.
 * host с путём поддерживается SDK (как у эмулятора): URL собирается как
 * https://{apiHost}/v1/accounts:... → relay/__/firebase/identitytoolkit/v1/...
 *
 * Для Firestore используйте firebase-firestore-lite.js (REST), не полный SDK:
 * WebChannel/Listen через reverse-proxy нестабилен.
 *
 * Если релей недоступен (пустой base) — не трогаем apiHost: SDK ходит на Google напрямую.
 */
export function applyFirebaseProxies(auth, firestoreSettings = {}) {
  const base = relayUrl();
  if (!base) {
    return { ...firestoreSettings };
  }
  const host = base.replace(/^https:\/\//i, "");
  auth.config.apiHost = `${host}/__/firebase/identitytoolkit`;
  auth.config.tokenApiHost = `${host}/__/firebase/securetoken`;
  auth.config.apiScheme = "https";
  return {
    host: `${host}/__/firebase/firestore`,
    ssl: true,
    ...firestoreSettings
  };
}
