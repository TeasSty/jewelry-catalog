// Смягчает жёсткие плоские блики (частый эффект на гранёных/чеканных поверхностях —
// каждая мелкая грань даёт свою резкую белую точку) в мягкий градиент света, не трогая
// форму, цвет и детали изделия. Работает выборочно: строим маску "насколько пиксель —
// блик" по яркости (плавный порог, не бинарный) и подмешиваем в такие места слегка
// размытую копию картинки — только туда, где она реально блик, а не везде. Обычный
// blur() поверх всего фото просто убрал бы резкость целиком, включая грани и текстуру,
// которые просили сохранить.
import sharp from "sharp";

// Порог в 8-битной яркости (0-255): ниже LOW — блик не трогаем вообще (0% подмеса),
// выше HIGH — смягчаем на полную (MAX_BLEND). Между ними — плавный (smoothstep,
// не линейный) переход, поэтому у самого смягчения тоже мягкий край, а не свой
// собственный резкий контур.
const LOW = 195;
const HIGH = 250;
const MAX_BLEND = 0.55;
const BLUR_SIGMA = 2.4;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export async function softenHighlights(input) {
  if (typeof input === "string") {
    const fs = await import("node:fs/promises");
    input = await fs.readFile(input);
  }

  const base = sharp(input);
  const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info; // 3, без альфы у этих фото

  const blurredBuf = await sharp(input).blur(BLUR_SIGMA).raw().toBuffer();

  const out = Buffer.alloc(data.length);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    // Яркость по стандартным весам (ITU-R BT.601) — не среднее R+G+B, глаз
    // воспринимает зелёный ярче синего, среднее давало бы промах по порогу.
    const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    const w = smoothstep(LOW, HIGH, luma) * MAX_BLEND;
    for (let c = 0; c < channels; c++) {
      out[o + c] = data[o + c] * (1 - w) + blurredBuf[o + c] * w;
    }
  }

  return sharp(out, { raw: { width, height, channels } });
}

if (process.argv[1] && process.argv[1].endsWith("soften-highlights.mjs") && process.argv[2] === "pilot") {
  const fs = await import("node:fs/promises");
  const files = process.argv.slice(3);
  const outDir = "../scratch-soften-pilot";
  await fs.mkdir(outDir, { recursive: true });
  for (const f of files) {
    const base = f.replace(/\.jpe?g$/i, "");
    const pipeline = await softenHighlights(`../images/${f}`);
    await pipeline.jpeg({ quality: 92, mozjpeg: true }).toFile(`${outDir}/${base}.jpg`);
    console.log("done", f);
  }
}
