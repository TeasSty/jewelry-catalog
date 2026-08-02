// Прогоняет ретушь + WebP/AVIF (см. enhance-images.mjs) по всем локальным фото
// товаров в images/. Отдельный разовый скрипт, а не часть pilot-режима —
// на ~3000 файлах нужен прогресс-лог и пул с ограниченной параллельностью,
// а не последовательный цикл (иначе это часы, а не минуты).
import { retouch } from "./enhance-images.mjs";
import { readdir, stat } from "node:fs/promises";

const CONCURRENCY = 8;
const dir = "../images";
const files = (await readdir(dir)).filter(f => /^items\d+\.jpg$/i.test(f));

console.log(`Найдено файлов: ${files.length}`);

let done = 0, failed = 0;
let bytesBefore = 0, bytesAfter = 0;
const start = Date.now();
const failedFiles = [];

async function processFile(f){
  const base = f.replace(/\.jpg$/i, "");
  const inPath = `${dir}/${f}`;
  try {
    const before = (await stat(inPath)).size;
    const pipeline = await retouch(inPath);
    const jpgBuf = await pipeline.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    const webpBuf = await pipeline.clone().webp({ quality: 84 }).toBuffer();
    const avifBuf = await pipeline.clone().avif({ quality: 55 }).toBuffer();
    const fs = await import("node:fs/promises");
    await fs.writeFile(inPath, jpgBuf);
    await fs.writeFile(`${dir}/${base}.webp`, webpBuf);
    await fs.writeFile(`${dir}/${base}.avif`, avifBuf);
    bytesBefore += before;
    bytesAfter += jpgBuf.length + webpBuf.length + avifBuf.length;
  } catch (err) {
    failed++;
    failedFiles.push({ file: f, error: err.message });
  }
  done++;
  if (done % 200 === 0 || done === files.length) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`${done}/${files.length} (${failed} ошибок) — ${elapsed}с`);
  }
}

// Простой пул: N воркеров разбирают общий индекс очереди.
let next = 0;
async function worker(){
  while (next < files.length) {
    const i = next++;
    await processFile(files[i]);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nГотово за ${elapsed}с. Успешно: ${done - failed}, ошибок: ${failed}`);
console.log(`Было (только jpg): ${(bytesBefore / 1024 / 1024).toFixed(1)} МБ`);
console.log(`Стало (jpg+webp+avif): ${(bytesAfter / 1024 / 1024).toFixed(1)} МБ`);
if (failedFiles.length) {
  const fs = await import("node:fs/promises");
  await fs.writeFile("../scratch-enhance-failures.json", JSON.stringify(failedFiles, null, 2));
  console.log(`Список ошибок: scratch-enhance-failures.json`);
}
