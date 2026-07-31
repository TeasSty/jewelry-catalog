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
 * Два маршрута:
 *   POST /notify — уведомление о новом заказе в Telegram.
 *                  Пускает вошедшего покупателя с подтверждённой почтой.
 *                  Текст сообщения собирается ЗДЕСЬ, а не на клиенте, — иначе через
 *                  этот же адрес можно было бы слать в чат произвольный текст.
 *   POST /upload — загрузка фото товара на ImgBB.
 *                  Пускает только администратора (проверяется документ admins/<uid>
 *                  в Firestore токеном самого вызывающего — сервисный ключ не нужен).
 *
 * Развёртывание — см. SECURITY.md, раздел «Как поднять воркер».
 *
 * Секреты (wrangler secret put ИМЯ):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, IMGBB_API_KEY
 * Обычные переменные (vars в wrangler.toml):
 *   FIREBASE_API_KEY, FIREBASE_PROJECT_ID, ALLOWED_ORIGIN
 */

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // ImgBB всё равно не принимает больше 32 МБ, но фото товара — это сотни КБ
const MAX_ITEMS = 100;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env);
    const corsOrigin = allowed.includes(origin) ? origin : allowed[0];

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

    const path = new URL(request.url).pathname.replace(/\/+$/, "");

    try {
      if (path === "/notify") return await handleNotify(request, env, corsOrigin);
      if (path === "/upload") return await handleUpload(request, env, corsOrigin);
      return json({ error: "Not found" }, 404, corsOrigin);
    } catch (err) {
      // Наружу — обезличенно, подробности только в логах воркера (wrangler tail)
      console.error(err);
      return json({ error: "Internal error" }, 500, corsOrigin);
    }
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

/**
 * Проверяет токен входа Firebase через официальный эндпоинт Google.
 * Возвращает данные пользователя либо null, если токен поддельный/просроченный.
 * Публичный ключ FIREBASE_API_KEY здесь уместен — он и так виден в коде сайта
 * и сам по себе ничего не открывает, вся защита в правилах Firestore.
 */
async function verifyIdToken(idToken, env) {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4096) return null;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) return null;

  const data = await res.json();
  const user = data.users && data.users[0];
  if (!user || user.disabled) return null;
  return user;
}

/** Есть ли документ admins/<uid>. Читаем токеном самого пользователя — правила
 *  разрешают ему прочитать только свою запись, поэтому сервисный ключ не нужен. */
async function isAdmin(uid, idToken, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/admins/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  return res.status === 200;
}

// ===== /notify =====

async function handleNotify(request, env, corsOrigin) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Bad request" }, 400, corsOrigin);

  const user = await verifyIdToken(body.idToken, env);
  if (!user) return json({ error: "Unauthorized" }, 401, corsOrigin);
  if (!user.emailVerified) return json({ error: "Email not verified" }, 403, corsOrigin);

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    // Бот не настроен — заказ всё равно уже лежит в Firestore и виден в /admin/
    return json({ ok: true, skipped: "telegram not configured" }, 200, corsOrigin);
  }

  const order = body.order && typeof body.order === "object" ? body.order : {};
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
  if (!/^image\//.test(file.type || "")) return json({ error: "Not an image" }, 415, corsOrigin);

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
