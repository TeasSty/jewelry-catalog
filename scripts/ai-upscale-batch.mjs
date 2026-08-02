// Настоящий апскейл через Real-ESRGAN x4 (ncnn-vulkan — тот же движок, что
// использует Upscayl; умеет Vulkan-GPU на AMD/Intel/NVIDIA, не только CUDA).
// На встроенной AMD Vega 8 вышло ~55-57с/фото на CPU-инференс (onnxruntime-node,
// удалён) уходило ~168с — втрое медленнее при том же качестве.
//
// scripts/rvk/ — сам инструмент (exe + веса), качается отдельно (см. README
// ниже), в git не идёт (.gitignore) — локальный инструмент для разовой
// обработки, не часть сайта.
//
// Пишет НЕ поверх обычного файла, а рядом: images/itemsNNN-hd.jpg/.webp/.avif.
// Обычный файл (миниатюра в сетке карточек) не трогаем вообще — вес каталога
// не меняется. HD-версию app.js подхватывает только в лайтбоксе, и только
// когда её открывают, с откатом на обычный файл, если HD ещё не готов
// (см. openLightbox/hdVariant в app.js).
//
// Идемпотентно: уже готовые -hd.* пропускает, поэтому прогон можно прервать
// и перезапустить теми же аргументами — досчитает только недостающее.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink, access } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
// Всё завязано на путь этого файла (import.meta.url), а не на process.cwd() —
// скрипт даёт верный результат независимо от того, из какой папки его
// запустили (сам так ошибся при проверке: часть путей ниже раньше была
// "../images" — верно только если запускать строго из scripts/).
const SCRIPTS_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const RVK_DIR = path.join(SCRIPTS_DIR, "rvk");
const RVK_EXE = path.join(RVK_DIR, "realesrgan-ncnn-vulkan.exe");
const IMAGES_DIR = path.join(SCRIPTS_DIR, "..", "images");
const CATALOG_PATH = path.join(SCRIPTS_DIR, "..", "catalog.json");

// 1200px — под retina-лайтбокс (CSS max-width:min(90vw,560px), то есть ×2 под
// плотные экраны ~ 1120px с запасом). Больше — только лишний вес без видимой
// пользы, меньше — на retina всё ещё будет заметно мягче настоящего фото.
const TARGET_WIDTH = Number(process.env.HD_WIDTH) || 1200;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function upscaleOne(inputPath, tmpOutPath) {
  // exe запускается с cwd:RVK_DIR (scripts/rvk/) — относительные пути типа
  // "../images/..." иначе считались бы от rvk/, а не от scripts/, и промахивались
  // мимо на один уровень. path.resolve() берёт их от текущего cwd самого node,
  // чтобы cwd дочернего процесса на это не влиял.
  await execFileAsync(RVK_EXE,
    ["-i", path.resolve(inputPath), "-o", path.resolve(tmpOutPath), "-n", "realesrgan-x4plus"],
    { cwd: RVK_DIR });
}

// После настоящего апскейла сеть уже даёт чёткий, детализированный результат —
// поверх него НЕ гоняем retouch() (резкость+контраст из enhance-images.mjs):
// это для полировки мягких исходников, а тут источник уже не мягкий, второй
// слой резкости рисковал бы пересветить грани. Только уменьшение под целевой
// размер показа и формат/сжатие.
export async function upscaleAndOptimize(inputPath, hdBasePath) {
  const sharp = (await import("sharp")).default;
  const tmp = `${hdBasePath}-rvk-tmp.jpg`;
  await upscaleOne(inputPath, tmp);
  const img = sharp(await readFile(tmp)).resize({ width: TARGET_WIDTH });
  const jpg = await img.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const webp = await img.clone().webp({ quality: 84 }).toBuffer();
  const avif = await img.clone().avif({ quality: 55 }).toBuffer();
  await writeFile(`${hdBasePath}.jpg`, jpg);
  await writeFile(`${hdBasePath}.webp`, webp);
  await writeFile(`${hdBasePath}.avif`, avif);
  await unlink(tmp).catch(() => {});
}

// Запуск:
//   node ai-upscale-batch.mjs items530.jpg items2963.jpg ...      — по списку файлов
//   node ai-upscale-batch.mjs --category garnitury                — по категории из catalog.json
//   node ai-upscale-batch.mjs --all                                — весь каталог
if (process.argv[1] && process.argv[1].endsWith("ai-upscale-batch.mjs")) {
  const args = process.argv.slice(2);
  let files;
  if (args[0] === "--category" || args[0] === "--all") {
    const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
    const items = catalog.items || catalog;
    const filtered = args[0] === "--all" ? items : items.filter(i => i.category === args[1]);
    files = [...new Set(filtered.filter(i => /^items\d+\.jpg$/i.test(i.image || "")).map(i => i.image))];
  } else {
    files = args;
  }

  console.log(`К обработке: ${files.length} фото, целевая ширина HD: ${TARGET_WIDTH}px`);

  let done = 0, skipped = 0;
  const start = Date.now();
  for (const f of files) {
    const base = f.replace(/\.jpg$/i, "");
    const hdBase = path.join(IMAGES_DIR, `${base}-hd`);
    if (await exists(`${hdBase}.jpg`)) { skipped++; continue; }
    const t0 = Date.now();
    try {
      await upscaleAndOptimize(path.join(IMAGES_DIR, f), hdBase);
    } catch (err) {
      console.log(`ОШИБКА на ${f}: ${err.message}`);
      continue;
    }
    done++;
    const elapsed = (Date.now() - t0) / 1000;
    const totalElapsed = (Date.now() - start) / 1000;
    const remaining = files.length - skipped - done;
    const eta = (remaining * (totalElapsed / done) / 3600).toFixed(1);
    console.log(`${done + skipped}/${files.length} ${f} — ${elapsed.toFixed(0)}с (ETA ~${eta}ч, пропущено уже готовых: ${skipped})`);
  }
  console.log(`Готово: обработано ${done}, пропущено (уже было) ${skipped}, за ${((Date.now() - start) / 3600000).toFixed(1)}ч`);
}
