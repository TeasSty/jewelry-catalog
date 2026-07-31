// Локальный статический сервер для проверки сайта перед публикацией.
// Нужен потому, что index.html подключает app.js как ES-модуль, а модули
// не работают при открытии файла напрямую через file:// — браузер их блокирует.
//
// Запуск: node scripts/dev-server.mjs  →  http://localhost:4173
// На работу опубликованного сайта не влияет: GitHub Pages раздаёт файлы сам.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = 4173;
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml"
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path.endsWith("/")) path += "index.html";
    // normalize + отсечение ".." — чтобы запрос вида /../../secret не вылез за корень
    const file = join(ROOT, normalize(path).replace(/^([/\\]\.\.)+/, ""));
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
