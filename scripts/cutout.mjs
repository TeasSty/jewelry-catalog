// Локальный вырез фона без AI-сервиса — годится именно для этих фото: чистый
// однородный белый бесшовный фон в студийной съёмке товара. Заливка (BFS) от
// края кадра по "почти белым" пикселям — а не порог по всей картинке — нарочно:
// яркие блики бриллиантов в центре тоже почти белые, но НЕ связаны с краем через
// другие белые пиксели (со всех сторон окружены металлом), поэтому не вырезаются
// вместе с фоном. Простой канальный порог без заливки прогрыз бы дыры прямо
// в камнях.
import sharp from "sharp";

const WHITE_THRESHOLD = 234; // r,g,b выше — кандидат в фон
const FEATHER_PX = 1.4; // мягкий край вместо зубчатого реза

async function floodFillAlpha(inputPath) {
  const { data, info } = await sharp(inputPath).ensureAlpha(0).raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info; // channels=4 (RGBA) после ensureAlpha
  const isWhite = (idx) => {
    const o = idx * channels;
    return data[o] >= WHITE_THRESHOLD && data[o + 1] >= WHITE_THRESHOLD && data[o + 2] >= WHITE_THRESHOLD;
  };

  const isBackground = new Uint8Array(width * height); // 1 = фон
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0, qTail = 0;

  const pushIfWhiteBorder = (x, y) => {
    const idx = y * width + x;
    if (visited[idx]) return;
    if (!isWhite(idx)) return;
    visited[idx] = 1;
    isBackground[idx] = 1;
    queue[qTail++] = idx;
  };
  for (let x = 0; x < width; x++) { pushIfWhiteBorder(x, 0); pushIfWhiteBorder(x, height - 1); }
  for (let y = 0; y < height; y++) { pushIfWhiteBorder(0, y); pushIfWhiteBorder(width - 1, y); }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width, y = (idx / width) | 0;
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
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

  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = isBackground[i] ? 0 : 255;

  // Мягкое перо по краю — размываем ТОЛЬКО альфа-канал, RGB остаётся как было.
  // extractChannel(0) обязателен: blur() на одноканальном raw-входе молча
  // превращает результат в 3 канала (RGB) — без этого joinChannel ниже читает
  // втрое length буфер как будто он однoканальный, и получается сдвиг байт
  // (на глаз — дикие полосы вместо края выреза; нашёл на первом прогоне).
  const featheredAlpha = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(FEATHER_PX)
    .extractChannel(0)
    .raw()
    .toBuffer();

  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = data[i * channels];
    rgb[i * 3 + 1] = data[i * channels + 1];
    rgb[i * 3 + 2] = data[i * channels + 2];
  }

  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(featheredAlpha, { raw: { width, height, channels: 1 } });
}

export async function cutoutAndRetouch(inputPath) {
  const { retouch } = await import("./enhance-images.mjs");
  const cut = await floodFillAlpha(inputPath);
  // Ретушь (резкость/контраст/цвет) поверх уже вырезанного RGBA — sharp одинаково
  // применяет цветовые операции к RGB-части, альфа-канал остаётся нетронутым.
  const buf = await cut.png().toBuffer();
  return retouch(buf);
}

if (process.argv[1] && process.argv[1].endsWith("cutout.mjs")) {
  const fs = await import("node:fs/promises");
  const files = process.argv.slice(2);
  const outDir = "../scratch-pilot/cutout";
  await fs.mkdir(outDir, { recursive: true });
  for (const f of files) {
    const base = f.replace(/\.jpe?g$/i, "");
    const pipeline = await cutoutAndRetouch(`../images/${f}`);
    await pipeline.clone().png({ quality: 92 }).toFile(`${outDir}/${base}.png`);
    await pipeline.clone().webp({ quality: 90 }).toFile(`${outDir}/${base}.webp`);
    console.log(`${f} -> ${outDir}/${base}.png / .webp`);
  }
}
