// Разовый прогон softenHighlights() (см. soften-highlights.mjs) по всем фото
// категории "Гарнитуры" из catalog.json — точечная правка по запросу, не весь
// каталог. Перезаписывает .jpg на месте и пересобирает рядом .webp/.avif —
// те должны совпадать с новой версией jpg, а не остаться от старого прохода
// (scripts/enhance-all.mjs).
import { softenHighlights } from "./soften-highlights.mjs";
import { readFile, writeFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile("../catalog.json", "utf8"));
const items = catalog.items || catalog;
const files = [...new Set(
  items.filter(i => i.category === "garnitury" && /^items\d+\.jpg$/i.test(i.image || ""))
       .map(i => i.image)
)];

console.log(`Фото категории "Гарнитуры": ${files.length}`);

let done = 0, failed = 0;
const failedFiles = [];

async function processFile(f) {
  const base = f.replace(/\.jpg$/i, "");
  const inPath = `../images/${f}`;
  try {
    const pipeline = await softenHighlights(inPath);
    const jpgBuf = await pipeline.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    const webpBuf = await pipeline.clone().webp({ quality: 84 }).toBuffer();
    const avifBuf = await pipeline.clone().avif({ quality: 55 }).toBuffer();
    await writeFile(inPath, jpgBuf);
    await writeFile(`../images/${base}.webp`, webpBuf);
    await writeFile(`../images/${base}.avif`, avifBuf);
  } catch (err) {
    failed++;
    failedFiles.push({ file: f, error: err.message });
  }
  done++;
  if (done % 100 === 0 || done === files.length) console.log(`${done}/${files.length} (${failed} ошибок)`);
}

const CONCURRENCY = 6;
let next = 0;
async function worker() {
  while (next < files.length) {
    const i = next++;
    await processFile(files[i]);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`Готово. Успешно: ${done - failed}, ошибок: ${failed}`);
if (failedFiles.length) {
  await writeFile("../scratch-soften-failures.json", JSON.stringify(failedFiles, null, 2));
  console.log("Список ошибок: scratch-soften-failures.json");
}
