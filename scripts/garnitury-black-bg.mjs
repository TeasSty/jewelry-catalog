// Вырезает студийный белый фон у фото категории «Гарнитуры» и кладёт
// изделие на чистый #000000 — без ретуши яркости/цвета металла.
//
// 1) BFS от края по «почти белым» — блики камней в центре не трогаем.
// 2) Choke 1px — съедаем белую кайму по контуру (иначе ореол на чёрном).
// 3) Лёгкое перо + деконтаминация белого мата на полупрозрачных пикселях.
// 4) Композит на #000. RGB украшения не меняем.
import sharp from "sharp";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SCRIPTS_DIR, "..");
const IMAGES_DIR = path.join(ROOT, "images");
const CATALOG_PATH = path.join(ROOT, "catalog.json");

const WHITE_THRESHOLD = 230;
const FEATHER_PX = 0.8;
const CHOKE_PX = 1;
const CONCURRENCY = 6;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

export async function cutoutOntoBlack(inputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const isWhite = (idx) => {
    const o = idx * channels;
    return data[o] >= WHITE_THRESHOLD && data[o + 1] >= WHITE_THRESHOLD && data[o + 2] >= WHITE_THRESHOLD;
  };

  const isBackground = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0, qTail = 0;

  const pushIfWhite = (x, y) => {
    const idx = y * width + x;
    if (visited[idx] || !isWhite(idx)) return;
    visited[idx] = 1;
    isBackground[idx] = 1;
    queue[qTail++] = idx;
  };
  for (let x = 0; x < width; x++) { pushIfWhite(x, 0); pushIfWhite(x, height - 1); }
  for (let y = 0; y < height; y++) { pushIfWhite(0, y); pushIfWhite(width - 1, y); }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;
      visited[nIdx] = 1;
      if (isWhite(nIdx)) {
        isBackground[nIdx] = 1;
        queue[qTail++] = nIdx;
      }
    }
  }

  let bg = isBackground;
  for (let pass = 0; pass < CHOKE_PX; pass++) {
    const next = new Uint8Array(bg);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (bg[idx]) continue;
        if (bg[idx - 1] || bg[idx + 1] || bg[idx - width] || bg[idx + width]) next[idx] = 1;
      }
    }
    bg = next;
  }

  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = bg[i] ? 0 : 255;

  const featheredAlpha = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(FEATHER_PX)
    .extractChannel(0)
    .raw()
    .toBuffer();

  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const a = featheredAlpha[i] / 255;
    const o = i * channels;
    if (a <= 0.002) {
      out[i * 3] = 0;
      out[i * 3 + 1] = 0;
      out[i * 3 + 2] = 0;
      continue;
    }
    if (a >= 0.998) {
      out[i * 3] = data[o];
      out[i * 3 + 1] = data[o + 1];
      out[i * 3 + 2] = data[o + 2];
      continue;
    }
    const whiteShare = 255 * (1 - a);
    out[i * 3]     = Math.max(0, Math.min(255, Math.round(data[o]     - whiteShare)));
    out[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(data[o + 1] - whiteShare)));
    out[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(data[o + 2] - whiteShare)));
  }

  return sharp(out, { raw: { width, height, channels: 3 } });
}

async function writeVariants(pipeline, basePath) {
  const jpg = await pipeline.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  const webp = await pipeline.clone().webp({ quality: 84 }).toBuffer();
  const avif = await pipeline.clone().avif({ quality: 55 }).toBuffer();
  await writeFile(`${basePath}.jpg`, jpg);
  await writeFile(`${basePath}.webp`, webp);
  await writeFile(`${basePath}.avif`, avif);
}

async function processFile(fileName) {
  const base = fileName.replace(/\.jpg$/i, "");
  const inPath = path.join(IMAGES_DIR, fileName);
  const pipeline = await cutoutOntoBlack(inPath);
  await writeVariants(pipeline, path.join(IMAGES_DIR, base));

  const hdBase = path.join(IMAGES_DIR, `${base}-hd`);
  if (await exists(`${hdBase}.jpg`)) {
    const hdPipe = await cutoutOntoBlack(`${hdBase}.jpg`);
    await writeVariants(hdPipe, hdBase);
    return { hd: true };
  }
  return { hd: false };
}

if (process.argv[1] && path.basename(process.argv[1]) === "garnitury-black-bg.mjs") {
  const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
  const items = catalog.items || catalog;
  const files = [...new Set(
    items
      .filter((i) => i.category === "garnitury" && /^items\d+\.jpg$/i.test(i.image || ""))
      .map((i) => i.image)
  )];

  console.log(`Гарнитуры: ${files.length} фото → чёрный фон #000`);

  let done = 0, failed = 0, hdDone = 0;
  const failedFiles = [];
  let next = 0;

  async function worker() {
    while (next < files.length) {
      const i = next++;
      const f = files[i];
      try {
        const r = await processFile(f);
        if (r.hd) hdDone++;
      } catch (err) {
        failed++;
        failedFiles.push({ file: f, error: err.message });
      }
      done++;
      if (done % 50 === 0 || done === files.length) {
        console.log(`${done}/${files.length} (ошибок: ${failed}, hd: ${hdDone})`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`Готово. Успешно: ${done - failed}, ошибок: ${failed}, HD: ${hdDone}`);
  if (failedFiles.length) {
    console.log(JSON.stringify(failedFiles, null, 2));
    process.exitCode = 1;
  }
}
