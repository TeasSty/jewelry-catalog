// Локальная ретушь + веб-оптимизация фото товаров. Не подменяет настоящий апскейл
// (сеть/детали фото не восстанавливает — для этого нужен внешний AI-сервис,
// см. переписку), а полирует то, что уже есть: резкость, локальный контраст
// (усиливает блеск металла точечно, не поднимая яркость всей картинки — поэтому
// без пересветов), мягкая цветокоррекция. Работает с уже обработанными старым
// workflow фото (unsharp+saturate через ImageMagick, .github/workflows/enhance-images.yml)
// как со следующим шагом, не заменой.
import sharp from "sharp";

// inputPath: путь ИЛИ Buffer. Путь читаем сами и передаём sharp() буфер, а не
// путь напрямую — на ~20 файлах из 2978 (без видимой закономерности, при этом
// fs.readFileSync те же файлы читает без проблем) sharp(path) падал с "UNKNOWN:
// unknown error, open", а sharp(buffer) те же байты обрабатывает нормально —
// похоже на редкий сбой в собственном открытии файла у libvips на Windows.
export async function retouch(inputPath) {
  if (typeof inputPath === "string") {
    const fs = await import("node:fs/promises");
    inputPath = await fs.readFile(inputPath);
  }
  // Первая попытка была через .clahe() (локальный контраст) — на гладком золоте
  // он равнял яркость по независимым RGB-каналам в каждом окне и красил ровные
  // участки грязно-серыми/сиреневыми пятнами (артефакт локального выравнивания
  // гистограммы по каналам, а не по яркости). Визуально проверил на пилоте —
  // непригодно, убрал полностью. Вместо этого — только безопасные операции,
  // не трогающие цветовой баланс: две резкости разного радиуса (мелкие детали +
  // широкий "clarity"-проход вместо настоящего локального контраста) и линейная
  // (то есть одинаковая на все три канала — не сдвигает оттенок) добавка контраста.
  return sharp(inputPath)
    // "Clarity" — широкий unsharp с низкой силой, имитирует локальный контраст
    // граней без пятен, которые давал clahe.
    .sharpen({ sigma: 3, m1: 0, m2: 0.25 })
    // Резкость мелких деталей — компенсирует компрессионную мягкость исходника.
    .sharpen({ sigma: 0.8, m1: 0.5, m2: 0.3 })
    // a>1 — то же линейное растяжение контраста для R, G и B одновременно,
    // поэтому оттенок металла не плывёт, только сцена становится чуть контрастнее.
    .linear(1.05, -4)
    // Едва заметная тёплая цветокоррекция: чуть больше насыщенности и капля
    // яркости — то, что в фотостудии делает свет теплее, а золото — золотее.
    .modulate({ saturation: 1.06, brightness: 1.01 })
    .withMetadata({ density: 72 });
}

export async function processOne(inputPath, outDir, baseName) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(outDir, { recursive: true });
  const pipeline = await retouch(inputPath);
  const buf = await pipeline.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  const webp = await pipeline.clone().webp({ quality: 84 }).toBuffer();
  const avif = await pipeline.clone().avif({ quality: 55 }).toBuffer();
  await fs.writeFile(`${outDir}/${baseName}.jpg`, buf);
  await fs.writeFile(`${outDir}/${baseName}.webp`, webp);
  await fs.writeFile(`${outDir}/${baseName}.avif`, avif);
  return { jpg: buf.length, webp: webp.length, avif: avif.length };
}

// Запуск как есть — пилот на явно перечисленных файлах (см. вызов ниже).
if (process.argv[1] && process.argv[1].endsWith("enhance-images.mjs") && process.argv[2] === "pilot") {
  const fs = await import("node:fs/promises");
  const files = process.argv.slice(3);
  const outDir = "../scratch-pilot";
  const results = [];
  for (const f of files) {
    const base = f.replace(/\.jpe?g$/i, "");
    const origSize = (await fs.stat(`../images/${f}`)).size;
    const sizes = await processOne(`../images/${f}`, outDir, base);
    results.push({ file: f, origSize, ...sizes });
    console.log(`${f}: orig ${origSize}B -> jpg ${sizes.jpg}B, webp ${sizes.webp}B, avif ${sizes.avif}B`);
  }
  await fs.writeFile(`${outDir}/results.json`, JSON.stringify(results, null, 2));
}
