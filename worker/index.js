/**
 * Cloudflare Worker — единственное место, где живут секретные ключи проекта.
 *
 * Зачем он нужен. Сайт — статические файлы на GitHub Pages, своего сервера нет,
 * поэтому раньше токен Telegram-бота и ключ ImgBB лежали прямо в index.html и
 * admin/index.html. Любой посетитель мог открыть исходный код страницы (Ctrl+U),
 * забрать их и: писать от имени бота, читать переписку бота, заливать что угодно
 * в аккаунт ImgBB. Теперь ключи хранятся как секреты воркера, а браузер обращается
 * сюда и обязан предъявить токен входа Firebase.
 *
 * HTTP-маршруты:
 *   POST /notify — уведомление о новом заказе в Telegram.
 *                  Пускает вошедшего покупателя с подтверждённой почтой.
 *                  Текст сообщения читается из документа заказа в Firestore, а не
 *                  из тела запроса — иначе покупатель мог бы подменить состав или
 *                  контакты в уведомлении относительно того, что реально в базе.
 *   POST /upload — загрузка фото товара на ImgBB.
 *                  Пускает только администратора (проверяется документ admins/<uid>
 *                  в Firestore токеном самого вызывающего — сервисный ключ не нужен).
 *   /__/firebase/identitytoolkit/* — reverse-proxy → identitytoolkit.googleapis.com
 *   /__/firebase/securetoken/*     — reverse-proxy → securetoken.googleapis.com
 *   /__/firebase/firestore/*       — reverse-proxy → firestore.googleapis.com
 *                  Нужны потому, что у части сетей в РФ *.googleapis.com / gstatic
 *                  недоступны без VPN. Браузер ходит только на workers.dev; до Google
 *                  дотягивается уже Cloudflare (см. config.js applyFirebaseProxies).
 *
 * Плюс один Cron Trigger (см. scheduled() и [triggers] в wrangler.toml):
 *   ежедневная автоочистка Корзины — товары /admin/ с deleted:true старше 30 дней
 *   удаляются из Firestore насовсем, без участия администратора. У этой задачи нет
 *   пользователя с токеном в сессии, поэтому она — единственное место в проекте,
 *   где используется сервисный аккаунт Firebase (privileged-доступ в обход правил
 *   Firestore, как и полагается серверной фоновой задаче).
 *
 * Развёртывание — см. SECURITY.md, раздел «Как поднять воркер».
 *
 * Секреты (wrangler secret put ИМЯ):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, IMGBB_API_KEY,
 *   FIREBASE_SA_EMAIL, FIREBASE_SA_PRIVATE_KEY (сервисный аккаунт для автоочистки —
 *   роль в IAM должна быть сужена до Cloud Datastore User, не Editor всего проекта)
 * Обычные переменные (vars в wrangler.toml):
 *   FIREBASE_PROJECT_ID, ALLOWED_ORIGIN
 * (FIREBASE_API_KEY для проверки токена больше не нужен — verifyIdToken проверяет
 * подпись локально по публичным ключам Google, см. ниже.)
 */

import { jwtVerify, createRemoteJWKSet, SignJWT, importPKCS8 } from "jose";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // ImgBB всё равно не принимает больше 32 МБ, но фото товара — это сотни КБ
const MAX_ITEMS = 100;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env);
    const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
    const pathname = new URL(request.url).pathname;

    // Auth/Firestore proxy — GET+POST (long polling), чужой Origin не пускаем (open proxy).
    if (pathname.startsWith("/__/firebase/")) {
      return handleFirebaseProxy(request, env, corsOrigin, allowed);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsOrigin);
    }
    // Запрос с чужого сайта отсекаем до всякой работы: браузер всегда присылает Origin
    // на кросс-доменный POST, поэтому пустой/неизвестный Origin — это не наш сайт.
    if (!allowed.includes(origin)) {
      return json({ error: "Forbidden origin" }, 403, corsOrigin);
    }

    const path = pathname.replace(/\/+$/, "");

    try {
      if (path === "/notify") return await handleNotify(request, env, corsOrigin);
      if (path === "/upload") return await handleUpload(request, env, corsOrigin);
      return json({ error: "Not found" }, 404, corsOrigin);
    } catch (err) {
      // Наружу — обезличенно, подробности только в логах воркера (wrangler tail)
      console.error(err);
      return json({ error: "Internal error" }, 500, corsOrigin);
    }
  },

  // Cron Trigger — расписание в wrangler.toml, [triggers].crons. waitUntil держит
  // воркер живым до конца очистки: без него Cloudflare может остановить изолят сразу
  // после возврата из scheduled(), оборвав ещё не завершённые запросы к Firestore.
  // Ошибку глотаем здесь же (а не даём упасть необработанной) — если сервисный
  // аккаунт ещё не настроен или Google недоступен, это не должно шуметь как сбой
  // воркера в целом, только в логах (wrangler tail) до следующего запуска по расписанию.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      purgeExpiredTrash(env).catch(err => console.error("Автоочистка Корзины не удалась:", err))
    );
  }
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || "https://voroninkostroma.ru")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

// ===== Firebase Auth + Firestore reverse-proxy =====
//
// Префиксы совпадают с applyFirebaseProxies() в config.js. Браузер не ходит на
// *.googleapis.com напрямую — иначе на части сетей в РФ панель и вход «молчат».

const FIREBASE_PROXY_UPSTREAMS = [
  { prefix: "/__/firebase/identitytoolkit", host: "identitytoolkit.googleapis.com" },
  { prefix: "/__/firebase/securetoken", host: "securetoken.googleapis.com" },
  { prefix: "/__/firebase/firestore", host: "firestore.googleapis.com" }
];

const FIREBASE_PROXY_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "x-client-version",
  "x-client-data",
  "x-firebase-gmpid",
  "x-firebase-client",
  "x-firebase-appcheck",
  "x-goog-api-client",
  "x-goog-request-params",
  "x-http-method-override",
  "x-requested-with"
];

function firebaseProxyCorsHeaders(origin, request) {
  const requested = request.headers.get("Access-Control-Request-Headers");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      requested ||
      "Content-Type, Authorization, X-Goog-Api-Client, X-Goog-Request-Params, X-Firebase-GMPID, X-Client-Version, X-Firebase-Client, X-Firebase-AppCheck, X-HTTP-Method-Override",
    // Явный список: Access-Control-Expose-Headers: * в credentialed/XHR не всегда
    // открывает x-http-session-id — без него WebChannel (полный SDK) не продолжает сессию.
    // Lite/REST эти заголовки не читает, но прокси остаётся совместимым с обоими.
    "Access-Control-Expose-Headers":
      "Content-Type, X-HTTP-Session-Id, X-Client-Wire-Protocol, X-Goog-Api-Client, Date, ETag",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers"
  };
}

async function handleFirebaseProxy(request, env, corsOrigin, allowed) {
  const origin = request.headers.get("Origin") || "";
  if (!allowed.includes(origin)) {
    return json({ error: "Forbidden origin" }, 403, corsOrigin);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: firebaseProxyCorsHeaders(corsOrigin, request)
    });
  }

  const url = new URL(request.url);
  const match = FIREBASE_PROXY_UPSTREAMS.find(
    (entry) => url.pathname === entry.prefix || url.pathname.startsWith(entry.prefix + "/")
  );
  if (!match) {
    return json({ error: "Not found" }, 404, corsOrigin);
  }

  const upstreamPath = url.pathname.slice(match.prefix.length) || "/";
  const target = `https://${match.host}${upstreamPath}${url.search}`;

  const headers = new Headers();
  for (const name of FIREBASE_PROXY_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Browser API key restrictions (HTTP referrers) смотрят Referer — без него
  // запрос с IP Cloudflare к Google с ключом сайта может быть отклонён.
  headers.set("Referer", origin + "/");
  // Host задаёт сам runtime fetch по URL — вручную не ставим.

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    console.error("Firebase proxy upstream failed:", match.host, err);
    return json({ error: "Upstream unreachable" }, 502, corsOrigin);
  }

  const outHeaders = new Headers(firebaseProxyCorsHeaders(corsOrigin, request));
  for (const [key, value] of upstream.headers) {
    const low = key.toLowerCase();
    if (low.startsWith("access-control-")) continue;
    if (low === "content-encoding" || low === "transfer-encoding" || low === "connection") continue;
    // Не затираем CORS Vary значением upstream (Accept-Encoding) — иначе кэш
    // промежуточных узлов может отдать ответ без нужного Allow-Origin.
    if (low === "vary") {
      outHeaders.append("Vary", value);
      continue;
    }
    outHeaders.set(key, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders
  });
}

// Публичные ключи Google для проверки подписи Firebase ID Token — открытый эндпоинт,
// без API-ключа и без секретов. Тот же набор ключей, которым для той же задачи
// пользуется сам Firebase Admin SDK (см. официальную схему проверки:
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library).
//
// createRemoteJWKSet создаётся один раз на уровне модуля, а не внутри запроса —
// в Cloudflare Workers модульная область видимости переживает "тёплые" вызовы того
// же изолята, поэтому кэш ключей внутри jose реально работает между запросами, а не
// только внутри одного. cacheMaxAge — близко к Cache-Control, который реально отдаёт
// этот эндпоинт Google (проверено вручную: ~6.6 часа); jose всё равно досрочно
// обновит набор сам, если встретит token с неизвестным kid (ротация ключей Google).
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
  { cacheMaxAge: 6 * 60 * 60 * 1000, cooldownDuration: 30 * 1000 }
);

/**
 * Проверяет Firebase ID Token локально, по официальной схеме Firebase для сред без
 * Admin SDK — без единого сетевого похода к Identity Toolkit и без API-ключа:
 *
 *  - подпись RS256 проверяется по публичному ключу Google (сам jwtVerify находит
 *    нужный ключ по kid из заголовка токена в наборе JWKS);
 *  - algorithms:["RS256"] — жёсткое ограничение алгоритма. Без этого атакующий мог
 *    бы прислать токен с alg:"none" или другим неожиданным алгоритмом и обмануть
 *    менее строгую проверку — jose с явным списком алгоритмов такой токен отклонит
 *    ещё до попытки проверить подпись;
 *  - issuer — обязан быть https://securetoken.google.com/<projectId>: отсекает
 *    валidные-но-чужие токены (например, от другого Firebase-проекта);
 *  - audience — обязан быть <projectId>: тот же смысл с другой стороны (aud);
 *  - exp/iat — проверяет сам jwtVerify (истёкший или "из будущего" токен отклоняется);
 *  - sub — обязательное поле, это и есть Firebase uid; user_id (если есть в токене)
 *    должен ему совпадать — доп. защита от токена с несогласованными полями;
 *  - auth_time — должен быть не позже текущего момента (с запасом в 5 секунд на
 *    рассинхрон часов) — иначе токен структурно бессмыслен.
 *
 * Чего эта проверка НЕ делает (сознательный компромисс, обсуждён отдельно): не видит
 * live-статус disabled аккаунта — это единственное, что раньше давал вызов
 * accounts:lookup. У Firebase ID Token и так короткий срок жизни (1 час), а функция
 * "заблокировать покупателя" в админке сегодня не реализована — ручной бан через
 * Firebase Console подействует не мгновенно, а в пределах часа. isAdmin() ниже эту
 * проверку не использует вообще — админ-права читаются отдельным Firestore-запросом.
 */
async function verifyIdToken(idToken, env) {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4096) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ["RS256"]
    }));
  } catch {
    return null; // просрочен / неверная подпись / не тот issuer или audience / битый формат
  }

  if (typeof payload.sub !== "string" || !payload.sub) return null;
  if (payload.user_id !== undefined && payload.user_id !== payload.sub) return null;
  if (typeof payload.auth_time !== "number" || payload.auth_time > Math.floor(Date.now() / 1000) + 5) return null;

  return {
    localId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true
  };
}

/** Есть ли документ admins/<uid>. Читаем токеном самого пользователя — правила
 *  разрешают ему прочитать только свою запись, поэтому сервисный ключ не нужен. */
async function isAdmin(uid, idToken, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/admins/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  return res.status === 200;
}

/** Декодирует одно поле из ответа Firestore REST API в обычное JS-значение. */
function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if ("mapValue" in value) {
    const out = {};
    for (const [key, nested] of Object.entries(value.mapValue.fields || {})) {
      out[key] = decodeFirestoreValue(nested);
    }
    return out;
  }
  return undefined;
}

function decodeFirestoreDocument(doc) {
  const out = {};
  for (const [key, value] of Object.entries(doc.fields || {})) {
    out[key] = decodeFirestoreValue(value);
  }
  return out;
}

/** /notify принимает только заказы, которые реально лежат в Firestore и принадлежат
 *  вызывающему — иначе вошедший покупатель мог бы слать в Telegram фиктивные
 *  уведомления без оформления заказа (см. SECURITY.md). Читаем документ токеном
 *  самого пользователя: правила orders разрешают read только своему uid.
 *  Текст уведомления собирается из этого документа, а не из тела запроса. */
async function fetchVerifiedOrder(orderId, user, idToken, env) {
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) return null;

  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/orders/${encodeURIComponent(orderId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status !== 200) return null;

  const doc = await res.json().catch(() => null);
  if (!doc || !doc.fields) return null;

  const order = decodeFirestoreDocument(doc);
  if (order.uid !== user.localId) return null;

  const createdAt = order.createdAt;
  if (!createdAt) return null;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  // Окно 10 минут: достаточно для сетевой задержки после addDoc, но не для повторного спама.
  if (ageMs < 0 || ageMs > 10 * 60 * 1000) return null;

  return order;
}

// ===== Автоочистка Корзины (Cron Trigger, без пользователя в сессии) =====

// Должно совпадать с TRASH_LIFETIME_DAYS в admin/admin.js — то же ограничение, что
// и с GARNITURY_RING_PREFIXES там же: клиент и сервер не читают константы друг у
// друга, поэтому при изменении срока хранения менять нужно оба места.
const PURGE_AFTER_DAYS = 30;

/**
 * OAuth2-токен доступа по служебному аккаунту Firebase (JWT-bearer grant,
 * RFC 7523) — единственный способ получить привилегированный доступ к Firestore
 * (в обход правил безопасности) без интерактивного пользователя в сессии, что
 * ровно наш случай: Cron Trigger срабатывает сам, никто в этот момент не заходил
 * на сайт и не может предъявить свой ID-токен. Роль аккаунта в IAM должна быть
 * сужена до Cloud Datastore User — см. инструкцию в SECURITY.md, чтобы утечка
 * этого секрета не давала доступа шире, чем нужно этой же одной задаче.
 */
async function getServiceAccountAccessToken(env) {
  // \n может прийти как настоящий перевод строки или как два символа "\" + "n" —
  // зависит от того, как именно значение вставили через `wrangler secret put`
  // (напрямую из скачанного .json один в один или руками). Нормализуем в любом случае.
  const privateKey = await importPKCS8(env.FIREBASE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"), "RS256");
  const now = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(env.FIREBASE_SA_EMAIL)
    .setSubject(env.FIREBASE_SA_EMAIL)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!res.ok) throw new Error(`Обмен JWT на токен сервисного аккаунта не удался: HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return data.access_token;
}

/**
 * Ищет в коллекции products товары с deleted:true и удаляет насовсем те, что
 * помечены больше PURGE_AFTER_DAYS дней назад.
 *
 * Запрос — только "where deleted == true" (одно равенство, обычный автоматический
 * индекс Firestore, composite index заводить не нужно). Порог по deletedAt проверяем
 * уже здесь, в памяти воркера, а не добавляем его вторым условием в сам запрос:
 * "равенство по одному полю + диапазон по другому" потребовал бы отдельного составного
 * индекса ради одной редкой фоновой задачи раз в сутки — Корзина по объёму небольшая
 * (это отложенные на удаление товары одного небольшого каталога), прочитать её целиком
 * и отфильтровать на месте дешевле, чем поддерживать индекс только для этого.
 */
async function purgeExpiredTrash(env) {
  const accessToken = await getServiceAccountAccessToken(env);
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const queryRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "products" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "deleted" },
              op: "EQUAL",
              value: { booleanValue: true }
            }
          }
        }
      })
    }
  );
  if (!queryRes.ok) throw new Error(`runQuery HTTP ${queryRes.status}: ${await queryRes.text()}`);

  const rows = await queryRes.json();
  const cutoffMs = Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  const candidates = rows
    .filter(row => row.document)
    .map(row => ({
      name: row.document.name, // полный путь: projects/.../databases/(default)/documents/products/{sku}
      deletedAt: row.document.fields?.deletedAt?.timestampValue || null
    }));

  const toPurge = candidates.filter(item => item.deletedAt && new Date(item.deletedAt).getTime() <= cutoffMs);

  console.log(`Автоочистка Корзины: в корзине ${candidates.length}, старше ${PURGE_AFTER_DAYS} дней — ${toPurge.length}`);

  for (const item of toPurge) {
    // Удаление несуществующего документа Firestore не считает ошибкой (идемпотентно) —
    // безопасно и на случай, если один и тот же запуск Cron Trigger почему-то
    // выполнится дважды (Cloudflare гарантирует "не реже раза", а не "ровно раз").
    const delRes = await fetch(`https://firestore.googleapis.com/v1/${item.name}`, {
      method: "DELETE",
      headers: authHeader
    });
    if (!delRes.ok) {
      console.error(`Не удалось окончательно удалить ${item.name}: HTTP ${delRes.status}`);
    } else {
      console.log(`Окончательно удалён (был в Корзине с ${item.deletedAt}): ${item.name}`);
    }
  }
}

// ===== /notify =====

async function handleNotify(request, env, corsOrigin) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Bad request" }, 400, corsOrigin);

  const user = await verifyIdToken(body.idToken, env);
  if (!user) return json({ error: "Unauthorized" }, 401, corsOrigin);
  if (!user.emailVerified) return json({ error: "Email not verified" }, 403, corsOrigin);

  const orderId = clean(body.orderId, 128);
  const order = orderId ? await fetchVerifiedOrder(orderId, user, body.idToken, env) : null;
  if (!order) {
    return json({ error: "Order not found" }, 403, corsOrigin);
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    // Бот не настроен — заказ всё равно уже лежит в Firestore и виден в /admin/
    return json({ ok: true, skipped: "telegram not configured" }, 200, corsOrigin);
  }

  const items = Array.isArray(order.items) ? order.items.slice(0, MAX_ITEMS) : [];

  // Текст собираем сами из отдельных полей, обрезая длину. Клиент не может
  // прислать готовое сообщение — иначе через этот адрес полетел бы спам в чат.
  const itemsText = items
    .map(i => {
      const sku = clean(i && i.sku, 60);
      const qty = Math.max(1, Math.min(999, Number(i && i.qty) || 1));
      const weight = clean(i && i.weight, 20);
      const sizes = Array.isArray(i && i.sizes)
        ? i.sizes.filter(s => s != null).map(s => clean(s, 8)).slice(0, 100)
        : [];
      return `${sku} ×${qty}${weight ? ` (${weight} гр.)` : ""}` +
             `${sizes.length ? ` [размеры: ${sizes.join(", ")}]` : ""}`;
    })
    .join("\n");

  const text =
    "🛍 Новый заказ на сайте!\n\n" +
    `Покупатель: ${clean(order.name, 100) || clean(user.email, 100)}\n` +
    `Телефон: ${clean(order.phone, 32)}\n` +
    `Почта: ${clean(user.email, 100)}\n` +
    (clean(order.comment, 500) ? `Комментарий: ${clean(order.comment, 500)}\n` : "") +
    `\nТовары:\n${itemsText}`;

  const tgRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: text.slice(0, 4000), // лимит Telegram — 4096 символов
        disable_web_page_preview: true
      })
    }
  );

  if (!tgRes.ok) {
    console.error("Telegram error", tgRes.status, await tgRes.text());
    return json({ error: "Telegram send failed" }, 502, corsOrigin);
  }
  return json({ ok: true }, 200, corsOrigin);
}

/** Приводит значение к безопасной для сообщения строке: без управляющих символов,
 *  с ограничением длины. Разметку Telegram не включаем (parse_mode не задан),
 *  поэтому экранировать HTML/Markdown не требуется. */
function clean(value, maxLen) {
  if (value == null) return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ") // управляющие символы и переводы строк
    .trim()
    .slice(0, maxLen);
}

// ===== /upload =====

async function handleUpload(request, env, corsOrigin) {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Bad request" }, 400, corsOrigin);

  const idToken = form.get("idToken");
  const user = await verifyIdToken(idToken, env);
  if (!user) return json({ error: "Unauthorized" }, 401, corsOrigin);

  if (!(await isAdmin(user.localId, idToken, env))) {
    return json({ error: "Forbidden" }, 403, corsOrigin);
  }
  if (!env.IMGBB_API_KEY) {
    return json({ error: "IMGBB_API_KEY is not configured" }, 500, corsOrigin);
  }

  const file = form.get("image");
  if (!file || typeof file === "string") return json({ error: "No image" }, 400, corsOrigin);
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Image too large" }, 413, corsOrigin);
  // SVG отдельно исключён: это единственный "картиночный" формат, способный нести
  // исполняемый <script> — при прямом переходе по ссылке на файл он бы выполнился
  // в origin хостинга картинок (не нашего сайта, но всё равно незачем это пускать).
  if (!/^image\//.test(file.type || "") || file.type === "image/svg+xml") return json({ error: "Not an image" }, 415, corsOrigin);

  const out = new FormData();
  out.append("image", file, "upload");

  const res = await fetch(`https://api.imgbb.com/1/upload?key=${env.IMGBB_API_KEY}`, {
    method: "POST",
    body: out
  });
  const data = await res.json().catch(() => null);

  if (!res.ok || !data || !data.success) {
    console.error("ImgBB error", res.status, data);
    return json({ error: "Upload failed" }, 502, corsOrigin);
  }
  return json({ ok: true, url: data.data.url }, 200, corsOrigin);
}
