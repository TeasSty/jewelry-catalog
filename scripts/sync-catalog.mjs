// Забирает каталог товаров из Firestore (публичное чтение, ключ не нужен — см. правила
// безопасности: /products читается всем) и сохраняет в catalog.json рядом с сайтом.
// Запускается по расписанию через .github/workflows/sync-catalog.yml, а не вручную —
// так index.html не читает Firestore напрямую и не упирается в дневной лимит чтений.
//
// Полный/инкрементальный режим. Раньше скрипт всегда перечитывал всю коллекцию —
// на ~3000 товаров это ~72 000 чтений в сутки при часовом расписании, а бесплатный
// тариф Firebase (Spark) даёт только 50 000 в сутки. Поэтому по будним часам читаем
// только то, что изменилось с прошлого запуска (поле updatedAt, которое всегда
// проставляет admin/admin.js при сохранении товара) — обычно это единицы документов,
// а не тысячи. Раз в сутки (00:00 UTC) и при ручном запуске делаем честный полный
// проход — иначе удалённые из Firestore товары никогда не пропадали бы из catalog.json,
// ведь инкрементальный запрос по updatedAt в принципе не видит удаления.
const PROJECT_ID = "voronin-jewelry";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/products`;
const QUERY_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
const CATALOG_PATH = "catalog.json";

function parseValue(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return null;
  return null;
}

function parseDoc(doc) {
  const fields = doc.fields || {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = parseValue(value);
  }
  out.id = doc.name.split("/").pop();
  return out;
}

async function fetchAllProducts() {
  const items = [];
  let pageToken;

  do {
    const url = new URL(BASE_URL);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Firestore REST error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    for (const doc of data.documents || []) items.push(parseDoc(doc));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

// Товары, у которых updatedAt строго позже переданной отметки. Один documents:runQuery
// без курсора — при типичной нагрузке (единицы-десятки правок в час у небольшого
// магазина) результат далеко не дотягивает до лимита в 10 000 строк ответа, поэтому
// постраничная навигация здесь не нужна.
async function fetchChangedSince(isoTimestamp) {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "products" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "updatedAt" },
            op: "GREATER_THAN",
            value: { timestampValue: isoTimestamp }
          }
        }
      }
    })
  });
  if (!res.ok) {
    throw new Error(`Firestore REST error ${res.status}: ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.filter(row => row.document).map(row => parseDoc(row.document));
}

async function readExistingCatalog() {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(CATALOG_PATH, "utf8");
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : (data.items || []);
    return { items, lastSyncAt: data.lastSyncAt || null };
  } catch {
    return { items: [], lastSyncAt: null }; // первый запуск после этой правки или файла ещё нет
  }
}

const existing = await readExistingCatalog();

// Полный проход: раз в сутки (страхует от рассинхронизации и ловит удаления,
// которые инкрементальный запрос в принципе не видит), при ручном запуске
// из вкладки Actions, и всегда на первом запуске (нет ни файла, ни lastSyncAt).
const isManualRun = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const isDailyFullSync = new Date().getUTCHours() === 0;
const forceFullSync = isManualRun || isDailyFullSync || !existing.lastSyncAt;

const now = new Date().toISOString();
let items;

if (forceFullSync) {
  items = await fetchAllProducts();
  console.log(`Полный проход. Синхронизировано товаров: ${items.length}`);
} else {
  const changed = await fetchChangedSince(existing.lastSyncAt);
  const bySku = new Map(existing.items.map(item => [item.sku || item.id, item]));
  for (const item of changed) bySku.set(item.sku || item.id, item);
  items = [...bySku.values()];
  console.log(`Инкрементальный проход. Изменено товаров: ${changed.length}, всего в каталоге: ${items.length}`);
}

const fs = await import("node:fs/promises");
// Без отступов — файл читает только браузер, а не человек; на ~3000 товарах
// красивое форматирование почти удваивает вес файла, который качает каждый посетитель.
await fs.writeFile(CATALOG_PATH, JSON.stringify({ lastSyncAt: now, items }), "utf8");
