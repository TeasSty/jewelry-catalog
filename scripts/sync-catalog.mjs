// Забирает каталог товаров из Firestore (публичное чтение, ключ не нужен — см. правила
// безопасности: /products читается всем) и сохраняет в catalog.json рядом с сайтом.
// Запускается по расписанию через .github/workflows/sync-catalog.yml, а не вручную —
// так index.html не читает Firestore напрямую и не упирается в дневной лимит чтений.
const PROJECT_ID = "voronin-jewelry";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/products`;

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

const items = await fetchAllProducts();
const fs = await import("node:fs/promises");
await fs.writeFile("catalog.json", JSON.stringify({ items }, null, 2) + "\n", "utf8");
console.log(`Синхронизировано товаров: ${items.length}`);
