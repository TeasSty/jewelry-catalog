/**
 * Node-релей для РФ без VPN.
 *
 * Зачем: с июня 2025 многие провайдеры в РФ душат Cloudflare (~16 KB на соединение).
 * Cloudflare Worker (*.workers.dev и даже custom domain на Worker) для браузера
 * в РФ часто мёртв. Google (googleapis / gstatic) тоже режется.
 *
 * Этот процесс крутится на обычном VPS ВНЕ Cloudflare (Selectel, Timeweb, Beget,
 * VK Cloud, Yandex Cloud VM). Браузер ходит только на relay.voroninkostroma.ru;
 * до Google дотягивается уже сервер в датацентре.
 *
 * Маршруты — те же, что у worker/index.js:
 *   GET  /health
 *   *    /__/firebase/identitytoolkit|securetoken|firestore/*
 *   POST /notify, /upload
 *
 * Запуск:
 *   cp .env.example .env   # заполнить секреты
 *   npm install
 *   npm start
 *
 * Перед nginx: TLS на 443, proxy_pass на PORT (по умолчанию 8787).
 * DNS в reg.ru: A-запись relay → IP VPS (НЕ Cloudflare proxy / оранжевое облако).
 */

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { jwtVerify, createRemoteJWKSet, SignJWT, importPKCS8 } from "jose";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(__dirname, ".env"));

const env = {
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "voronin-jewelry",
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || "https://voroninkostroma.ru",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  IMGBB_API_KEY: process.env.IMGBB_API_KEY || "",
  FIREBASE_SA_EMAIL: process.env.FIREBASE_SA_EMAIL || "",
  FIREBASE_SA_PRIVATE_KEY: process.env.FIREBASE_SA_PRIVATE_KEY || ""
};

const PORT = Number(process.env.PORT || 8787);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 100;
const PURGE_AFTER_DAYS = 30;

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

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
  { cacheMaxAge: 6 * 60 * 60 * 1000, cooldownDuration: 30 * 1000 }
);

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function allowedOrigins() {
  return String(env.ALLOWED_ORIGIN)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function firebaseProxyCorsHeaders(origin, req) {
  const requested = req.headers["access-control-request-headers"];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      requested ||
      "Content-Type, Authorization, X-Goog-Api-Client, X-Goog-Request-Params, X-Firebase-GMPID, X-Client-Version, X-Firebase-Client, X-Firebase-AppCheck, X-HTTP-Method-Override",
    "Access-Control-Expose-Headers":
      "Content-Type, X-HTTP-Session-Id, X-Client-Wire-Protocol, X-Goog-Api-Client, Date, ETag",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers"
  };
}

function sendJson(res, body, status, origin) {
  const headers = { "Content-Type": "application/json", ...corsHeaders(origin) };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleFirebaseProxy(req, res, corsOrigin, allowed) {
  const origin = req.headers.origin || "";
  if (!allowed.includes(origin)) {
    sendJson(res, { error: "Forbidden origin" }, 403, corsOrigin);
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, firebaseProxyCorsHeaders(corsOrigin, req));
    res.end();
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const match = FIREBASE_PROXY_UPSTREAMS.find(
    (entry) => url.pathname === entry.prefix || url.pathname.startsWith(entry.prefix + "/")
  );
  if (!match) {
    sendJson(res, { error: "Not found" }, 404, corsOrigin);
    return;
  }

  const upstreamPath = url.pathname.slice(match.prefix.length) || "/";
  const target = `https://${match.host}${upstreamPath}${url.search}`;

  const headers = {};
  for (const name of FIREBASE_PROXY_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }
  headers.Referer = origin + "/";

  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await readBody(req);
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    console.error("Firebase proxy upstream failed:", match.host, err);
    sendJson(res, { error: "Upstream unreachable" }, 502, corsOrigin);
    return;
  }

  const outHeaders = { ...firebaseProxyCorsHeaders(corsOrigin, req) };
  upstream.headers.forEach((value, key) => {
    const low = key.toLowerCase();
    if (low.startsWith("access-control-")) return;
    if (low === "content-encoding" || low === "transfer-encoding" || low === "connection") return;
    if (low === "vary") {
      outHeaders.Vary = `${outHeaders.Vary || ""}, ${value}`.replace(/^, /, "");
      return;
    }
    outHeaders[key] = value;
  });

  res.writeHead(upstream.status, outHeaders);
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}

async function verifyIdToken(idToken) {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4096) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ["RS256"]
    }));
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  if (payload.user_id !== undefined && payload.user_id !== payload.sub) return null;
  if (typeof payload.auth_time !== "number" || payload.auth_time > Math.floor(Date.now() / 1000) + 5) {
    return null;
  }
  return {
    localId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true
  };
}

async function isAdmin(uid, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/admins/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  return res.status === 200;
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
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

async function fetchVerifiedOrder(orderId, user, idToken) {
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
  if (ageMs < 0 || ageMs > 10 * 60 * 1000) return null;
  return order;
}

function clean(value, maxLen) {
  if (value == null) return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLen);
}

async function handleNotify(req, res, corsOrigin) {
  const raw = await readBody(req, 256 * 1024);
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    sendJson(res, { error: "Bad request" }, 400, corsOrigin);
    return;
  }
  if (!body || typeof body !== "object") {
    sendJson(res, { error: "Bad request" }, 400, corsOrigin);
    return;
  }

  const user = await verifyIdToken(body.idToken);
  if (!user) {
    sendJson(res, { error: "Unauthorized" }, 401, corsOrigin);
    return;
  }
  if (!user.emailVerified) {
    sendJson(res, { error: "Email not verified" }, 403, corsOrigin);
    return;
  }

  const orderId = clean(body.orderId, 128);
  const order = orderId ? await fetchVerifiedOrder(orderId, user, body.idToken) : null;
  if (!order) {
    sendJson(res, { error: "Order not found" }, 403, corsOrigin);
    return;
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    sendJson(res, { ok: true, skipped: "telegram not configured" }, 200, corsOrigin);
    return;
  }

  const items = Array.isArray(order.items) ? order.items.slice(0, MAX_ITEMS) : [];
  const itemsText = items
    .map((i) => {
      const sku = clean(i && i.sku, 60);
      const qty = Math.max(1, Math.min(999, Number(i && i.qty) || 1));
      const weight = clean(i && i.weight, 20);
      const sizes = Array.isArray(i && i.sizes)
        ? i.sizes.filter((s) => s != null).map((s) => clean(s, 8)).slice(0, 100)
        : [];
      return (
        `${sku} ×${qty}${weight ? ` (${weight} гр.)` : ""}` +
        `${sizes.length ? ` [размеры: ${sizes.join(", ")}]` : ""}`
      );
    })
    .join("\n");

  const text =
    "🛍 Новый заказ на сайте!\n\n" +
    `Покупатель: ${clean(order.name, 100) || clean(user.email, 100)}\n` +
    `Телефон: ${clean(order.phone, 32)}\n` +
    `Почта: ${clean(user.email, 100)}\n` +
    (clean(order.comment, 500) ? `Комментарий: ${clean(order.comment, 500)}\n` : "") +
    `\nТовары:\n${itemsText}`;

  const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text.slice(0, 4000),
      disable_web_page_preview: true
    })
  });

  if (!tgRes.ok) {
    console.error("Telegram error", tgRes.status, await tgRes.text());
    sendJson(res, { error: "Telegram send failed" }, 502, corsOrigin);
    return;
  }
  sendJson(res, { ok: true }, 200, corsOrigin);
}

/** Минимальный multipart parser: только поля idToken (text) и image (file). */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundary = m && (m[1] || m[2]);
  if (!boundary) return null;
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buf.indexOf(sep);
  while (start !== -1) {
    let next = buf.indexOf(sep, start + sep.length);
    if (next === -1) break;
    let part = buf.subarray(start + sep.length, next);
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]+)"/i.exec(headerText);
      const fileMatch = /filename="([^"]*)"/i.exec(headerText);
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      if (nameMatch) {
        parts.push({
          name: nameMatch[1],
          filename: fileMatch ? fileMatch[1] : null,
          type: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
          data: body
        });
      }
    }
    start = next;
  }
  return parts;
}

async function handleUpload(req, res, corsOrigin) {
  const raw = await readBody(req, MAX_UPLOAD_BYTES + 256 * 1024);
  const parts = parseMultipart(raw, req.headers["content-type"]);
  if (!parts) {
    sendJson(res, { error: "Bad request" }, 400, corsOrigin);
    return;
  }

  const tokenPart = parts.find((p) => p.name === "idToken" && !p.filename);
  const filePart = parts.find((p) => p.name === "image" && p.filename != null);
  const idToken = tokenPart ? tokenPart.data.toString("utf8") : "";
  const user = await verifyIdToken(idToken);
  if (!user) {
    sendJson(res, { error: "Unauthorized" }, 401, corsOrigin);
    return;
  }
  if (!(await isAdmin(user.localId, idToken))) {
    sendJson(res, { error: "Forbidden" }, 403, corsOrigin);
    return;
  }
  if (!env.IMGBB_API_KEY) {
    sendJson(res, { error: "IMGBB_API_KEY is not configured" }, 500, corsOrigin);
    return;
  }
  if (!filePart) {
    sendJson(res, { error: "No image" }, 400, corsOrigin);
    return;
  }
  if (filePart.data.length > MAX_UPLOAD_BYTES) {
    sendJson(res, { error: "Image too large" }, 413, corsOrigin);
    return;
  }
  if (!/^image\//.test(filePart.type || "") || filePart.type === "image/svg+xml") {
    sendJson(res, { error: "Not an image" }, 415, corsOrigin);
    return;
  }

  const out = new FormData();
  out.append("image", new Blob([filePart.data], { type: filePart.type }), "upload");

  const upRes = await fetch(`https://api.imgbb.com/1/upload?key=${env.IMGBB_API_KEY}`, {
    method: "POST",
    body: out
  });
  const data = await upRes.json().catch(() => null);
  if (!upRes.ok || !data || !data.success) {
    console.error("ImgBB error", upRes.status, data);
    sendJson(res, { error: "Upload failed" }, 502, corsOrigin);
    return;
  }
  sendJson(res, { ok: true, url: data.data.url }, 200, corsOrigin);
}

async function getServiceAccountAccessToken() {
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
  if (!res.ok) throw new Error(`SA token HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function purgeExpiredTrash() {
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    console.log("Автоочистка пропущена: нет FIREBASE_SA_*");
    return;
  }
  const accessToken = await getServiceAccountAccessToken();
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
  const toPurge = rows
    .filter((row) => row.document)
    .map((row) => ({
      name: row.document.name,
      deletedAt: row.document.fields?.deletedAt?.timestampValue || null
    }))
    .filter((item) => item.deletedAt && new Date(item.deletedAt).getTime() <= cutoffMs);

  console.log(`Автоочистка: к удалению ${toPurge.length}`);
  for (const item of toPurge) {
    const delRes = await fetch(`https://firestore.googleapis.com/v1/${item.name}`, {
      method: "DELETE",
      headers: authHeader
    });
    if (!delRes.ok) console.error(`purge fail ${item.name}: ${delRes.status}`);
  }
}

const server = http.createServer(async (req, res) => {
  const allowed = allowedOrigins();
  const origin = req.headers.origin || "";
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  try {
    if (pathname === "/health" || pathname === "/health/") {
      const healthOrigin = allowed.includes(origin) ? origin : "*";
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": healthOrigin,
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify({ ok: true, via: "relay-node" }));
      return;
    }

    if (pathname.startsWith("/__/firebase/")) {
      await handleFirebaseProxy(req, res, corsOrigin, allowed);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(corsOrigin));
      res.end();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, { error: "Method not allowed" }, 405, corsOrigin);
      return;
    }
    if (!allowed.includes(origin)) {
      sendJson(res, { error: "Forbidden origin" }, 403, corsOrigin);
      return;
    }

    const path = pathname.replace(/\/+$/, "");
    if (path === "/notify") {
      await handleNotify(req, res, corsOrigin);
      return;
    }
    if (path === "/upload") {
      await handleUpload(req, res, corsOrigin);
      return;
    }
    sendJson(res, { error: "Not found" }, 404, corsOrigin);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, { error: "Internal error" }, 500, corsOrigin);
  }
});

server.listen(PORT, () => {
  console.log(`voronin-relay-node listening on :${PORT}`);
});

// Автоочистка раз в сутки (03:00 UTC ≈ как у CF cron)
function msUntilNextUtcHour(hour) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}
setTimeout(() => {
  purgeExpiredTrash().catch((e) => console.error("Автоочистка:", e));
  setInterval(
    () => purgeExpiredTrash().catch((e) => console.error("Автоочистка:", e)),
    24 * 60 * 60 * 1000
  );
}, msUntilNextUtcHour(3));
