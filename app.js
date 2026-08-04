  // Firebase НЕ импортируем статически с gstatic.com: у части клиентов (блокировки,
  // DNS, корпоративный прокси, сбои CDN) модуль firebase-*.js не грузится — и тогда
  // ПАДАЕТ ВЕСЬ app.js, вместе с каталогом. Каталог должен открываться без Google.
  // Auth/Firestore подключаем лениво; если не вышло — витрина работает, вход/заказ нет.
  import { firebaseConfig, relayUrl } from "./config.js";

  let db = null;
  let auth = null;
  let firebaseAvailable = false;
  let signInWithEmailAndPassword;
  let createUserWithEmailAndPassword;
  let signOut;
  let onAuthStateChanged;
  let sendEmailVerification;
  let updateProfile;
  let sendPasswordResetEmail;
  let collection;
  let addDoc;
  let serverTimestamp;

  // Ссылка из письма (подтверждение почты, сброс пароля) ведёт на нашу собственную
  // страницу auth-action.html вместо белой страницы Google по умолчанию — там то же
  // самое действие завершает тот же Firebase SDK, просто в оформлении сайта.
  // handleCodeInApp:true обязателен — без него Firebase проигнорирует url и всё равно
  // откроет свою страницу.
  const actionCodeSettings = {
    url: location.origin + "/auth-action.html",
    handleCodeInApp: true
  };

  const FIREBASE_UNAVAILABLE_MSG =
    "Сервис входа временно недоступен (нет связи с сервером авторизации). Каталог можно смотреть — попробуйте войти позже или с другой сети.";

  async function initFirebase() {
    const [{ initializeApp }, firestoreMod, authMod] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js")
    ]);

    const app = initializeApp(firebaseConfig);
    // initializeFirestore вместо обычного getFirestore — настраиваем транспорт.
    //
    // По умолчанию Firestore общается по WebChannel — это потоковое соединение поверх HTTP.
    // Через VPN и корпоративные прокси (а из России к Google почти всегда идут именно так)
    // такое соединение часто рвётся или не устанавливается вовсе. Симптом характерный:
    // вход в аккаунт проходит нормально (Firebase Auth — обычные HTTPS-запросы, прокси их
    // пропускает), а любое обращение к базе тихо падает.
    //
    // experimentalAutoDetectLongPolling, а не жёсткий experimentalForceLongPolling: SDK
    // сам проверяет при подключении, работает ли быстрый потоковый канал, и переходит на
    // обычный HTTP-опрос только если нет — раньше опрос был включён всегда и для всех,
    // даже для тех посетителей, кому он не нужен, а он ощутимо медленнее (у каждого
    // запроса своя отдельная накладная на установление соединения, а не общий канал).
    db = firestoreMod.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
    auth = authMod.getAuth(app);

    collection = firestoreMod.collection;
    addDoc = firestoreMod.addDoc;
    serverTimestamp = firestoreMod.serverTimestamp;
    signInWithEmailAndPassword = authMod.signInWithEmailAndPassword;
    createUserWithEmailAndPassword = authMod.createUserWithEmailAndPassword;
    signOut = authMod.signOut;
    onAuthStateChanged = authMod.onAuthStateChanged;
    sendEmailVerification = authMod.sendEmailVerification;
    updateProfile = authMod.updateProfile;
    sendPasswordResetEmail = authMod.sendPasswordResetEmail;

    firebaseAvailable = true;
  }

  // Изображения лежат локально в папке проекта images/ (относительный путь — работает и на GitHub Pages в подкаталоге)
  const IMG_BASE = "images/";
  const PER_PAGE = 20;

  let rawItems = [];

  // В базе путь хранится по-разному: внешний URL, "/images/x.jpg", "images/x.jpg" или голое имя файла.
  // Приводим всё к относительному "images/x.jpg" — абсолютный "/" ломается на GitHub Pages в подкаталоге.
  //
  // Разрешаем ровно две формы: https-ссылку (так выглядят фото, загруженные через ImgBB)
  // и путь внутри images/. Всё остальное — включая data:, blob:, javascript: и голый http: —
  // отбрасываем: значение попадает в атрибут src, и пропускать туда произвольную схему
  // из базы не нужно ни для чего. На сегодняшнем каталоге (2979 товаров — все относительные
  // имена файлов) это ничего не меняет, но закрывает путь на будущее.
  function resolveImagePath(raw){
    const path = String(raw || "").trim();
    if (!path) return "";
    if (/^https:\/\//i.test(path)) return path;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return ""; // чужая схема или другой домен
    const clean = path.replace(/^\/+/, "");
    return clean.startsWith(IMG_BASE) ? clean : IMG_BASE + clean;
  }

  // createdAt приходит как Timestamp, Date или ISO-строка — в базе сейчас строки
  function toMillis(value){
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return isNaN(ms) ? 0 : ms;
    }
    return 0;
  }

  // Порядок повторяет меню исходного сайта производителя — дилеры уже к нему привыкли
  const categories = [
    { id: "koltsa", name: "Кольца", subs: [] },
    { id: "obruch", name: "Обручальные", subs: ["Гладкие", "С алмазной гранью"] },
    { id: "sergi", name: "Серьги", subs: ["Шары", "Конго", "Продевки", "Детские"] },
    { id: "garnitury", name: "Гарнитуры", subs: ["С алмазной гранью", "Со вставками"] },
    { id: "podveski", name: "Подвески", subs: ["Зодиак"] },
    { id: "kolie", name: "Колье", subs: [] },
    { id: "piercing", name: "Пирсинг", subs: [] },
    { id: "tsepi", name: "Цепи/Браслеты (ручная работа)", subs: [] },
    { id: "braslety", name: "Браслеты", subs: [] },
    { id: "lozhki", name: "Ложки", subs: [] },
    { id: "broshi", name: "Броши", subs: [] },
    { id: "pravoslavie", name: "Православные", subs: ["Кольца", "Подвески"] },
    { id: "vostok", name: "Восток", subs: [] },
    { id: "raznoe", name: "Разное", subs: [] }
  ];

  // Порядковый номер категории в том же порядке, что и в сайдбаре — нужен, чтобы "Все товары"
  // шли категория за категорией, а не вперемешку (иначе цепочка и брошь оказываются рядом
  // только из-за похожего начала артикула по алфавиту)
  const CATEGORY_ORDER = new Map(categories.map((c, i) => [c.id, i]));

  const ALL = "__all__";
  const NEW_ARRIVALS = "__new__";     // не поле в базе — вычисляется как N последних добавленных по createdAt
  const NEW_ARRIVALS_COUNT = 20;
  let activeCategory = ALL;   // хранит id категории из списка выше (в базе category = такой же слаг), либо ALL/NEW_ARRIVALS
  let activeSubcategory = "";
  let searchTerm = "";
  let currentPage = 1;
  let sortOrder = "default"; // "default" | "weight-asc" | "weight-desc"
  let weightMin = null;
  let weightMax = null;

  // Приводим документ из любого источника к тому виду, с которым работает интерфейс
  // Приводит артикул к виду для нечёткого поиска: без регистра, без дефисов/пробелов/точек,
  // без ведущих нулей в числах — чтобы "93", "093", "кл93" и "КЛ-93" находили один и тот же товар.
  // Ведущие нули убираются у каждого числового куска отдельно, а не у всей строки — иначе
  // "кл-100" превратился бы в "кл-1", потеряв разницу с "кл-1".
  function normalizeForSearch(str){
    return String(str || "")
      .toLowerCase()
      .replace(/[\s\-_./\\]+/g, "")
      .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
  }

  // Экранирование HTML перед вставкой через innerHTML — на случай, если каталог когда-либо
  // будет содержать данные не только из-под контроля админки (сейчас это в основном
  // подстраховка, а не активная дыра, т.к. каталог пишет только /admin/).
  function escapeHtml(value){
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  function normalizeProduct(data, fallbackId = "") {
    const sku = data.sku || fallbackId;
    return {
      img: resolveImagePath(data.image || data.img || ""),
      sku: sku,
      skuNorm: normalizeForSearch(sku), // считаем один раз при загрузке, а не на каждый ре-рендер
      weight: data.weight ?? "",
      category: (data.category || "").toLowerCase(),
      subcategory: (data.subcategory || "").toLowerCase(),
      createdAt: toMillis(data.createdAt),
      // Свой список размеров кольца (задаётся в админке для КА/КЛ) — пусто/не задано
      // означает обычный полный диапазон 14-24, см. ringSizesFor.
      sizes: Array.isArray(data.sizes) ? data.sizes.filter(s => typeof s === "number") : []
    };
  }

  // Число в Hero — реальный размер каталога на момент загрузки (rawItems.length),
  // а не выдуманная константа: если товаров станет 3500 или 2000, цифра сама
  // подстроится при следующей сборке catalog.json. Считаем от 0 плавно один раз,
  // при первой успешной загрузке; если пользователь просит меньше анимации
  // (prefers-reduced-motion), просто показываем итоговое число сразу.
  function animateHeroCount(target) {
    const el = document.getElementById("heroItemCount");
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = target;
      return;
    }
    const duration = 900;
    const start = performance.now();
    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      el.textContent = Math.round(target * eased);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    // Страховка: если страница открыта в фоновой вкладке, requestAnimationFrame
    // браузер может придержать до её активации — цифра тогда так и осталась бы
    // на "0" неопределённо долго. setTimeout не привязан к отрисовке кадров и
    // сработает в любом случае; если rAF к этому моменту уже показал верное
    // число, эта строка просто перезапишет его тем же значением.
    setTimeout(() => { el.textContent = target; }, duration + 300);
  }

  // Каталог ~3000 товаров читаем из статического catalog.json (лежит рядом с сайтом),
  // а не напрямую из Firestore — иначе каждый заход посетителя это ~3000 чтений базы,
  // и на бесплатном тарифе (Blaze недоступен из РФ — Google Cloud Billing не работает
  // с российскими картами) дневной лимит в 50 000 чтений кончается за пару десятков визитов.
  // Файл catalog.json обновляет отдельный GitHub Action по расписанию, забирая свежие
  // данные из Firestore (см. .github/workflows/sync-catalog.yml и scripts/sync-catalog.mjs) —
  // правки в /admin/ появляются на сайте с задержкой до часа, а не мгновенно.
  async function loadCatalog() {
    const loadingState = document.getElementById("loadingState");
    const errorState = document.getElementById("errorState");
    const productGrid = document.getElementById("productGrid");

    try {
      const res = await fetch("catalog.json", { cache: "no-cache" });
      if(!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const rawDocs = Array.isArray(data) ? data : (data.items || []);
      const loadedProducts = rawDocs.map(d => normalizeProduct(d, d.id || d.sku));

      // По умолчанию сортируем по артикулу по возрастанию (с учётом чисел внутри строки:
      // кл-3, кл-4, ... кл-30, а не как попало). "Новинки" ниже сортируются отдельно, по дате.
      loadedProducts.sort((a, b) => a.sku.localeCompare(b.sku, "ru", { numeric: true }));

      rawItems = loadedProducts;
      loadingState.style.display = "none";
      initCatalogInterface();
      animateHeroCount(rawItems.length);

    } catch (error) {
      console.error("Не удалось загрузить каталог: ", error);
      loadingState.style.display = "none";
      productGrid.style.display = "none";
      errorState.style.display = "block";
    }
  }

  function countFor(catId, subcatName = "") {
    if (catId === ALL) return rawItems.length;
    if (catId === NEW_ARRIVALS) return Math.min(NEW_ARRIVALS_COUNT, rawItems.length);
    const inCat = rawItems.filter(i => i.category === catId);
    if (subcatName && !subcatName.toLowerCase().startsWith("все ")) {
      return inCat.filter(i => i.subcategory === subcatName.toLowerCase()).length;
    }
    return inCat.length;
  }

  function renderCategories(){
    const list = document.getElementById("categoryList");
    
    // Категории, которых ещё нет в базе, не показываем — иначе половина меню это мёртвые нули
    const visible = categories.filter(cat => countFor(cat.id) > 0);

    list.innerHTML = visible.map(cat => {
      const count = countFor(cat.id);
      const isActive = cat.id === activeCategory;
      // Раскрывающийся аккордеон нужен только когда подкатегорий несколько.
      // Если она ровно одна (как «Зодиак» у Подвесок) — разворачивать нечего, показываем сразу.
      const realSubs = cat.subs.filter(sub => !sub.toLowerCase().startsWith("все ") && countFor(cat.id, sub) > 0);
      const isSingleSub = realSubs.length === 1;
      const subs = realSubs.length > 1 ? cat.subs.filter(sub => sub.toLowerCase().startsWith("все ") || realSubs.includes(sub)) : [];
      const hasSubs = subs.length > 0;

      const subsHtml = subs.map(sub => {
        const subCount = countFor(cat.id, sub);
        const isSubActive = activeSubcategory === sub.toLowerCase() && isActive;
        return `
            <button class="subcat-btn${isSubActive ? ' active' : ''}" data-sub="${sub.toLowerCase()}">
              ${sub} (${subCount})
            </button>
          `;
      }).join("");

      let singleSubHtml = "";
      if (isSingleSub) {
        const sub = realSubs[0];
        const subCount = countFor(cat.id, sub);
        const isSubActive = activeSubcategory === sub.toLowerCase() && isActive;
        singleSubHtml = `<button class="single-sub-btn${isSubActive ? ' active' : ''}" data-sub="${sub.toLowerCase()}">${sub} <span class="count">(${subCount})</span></button>`;
      }

      return `
        <div class="cat${isActive ? ' active' : ''}" data-cat="${cat.id}">
          <button class="cat-btn"${hasSubs ? ' aria-expanded="false"' : ''}>
            <span>${cat.name}</span>
            <span style="display:flex;align-items:center;">
              <span class="count">${count}</span>
              ${hasSubs ? '<span class="arrow">▾</span>' : ''}
            </span>
          </button>
          ${singleSubHtml}
          ${hasSubs ? `
          <div class="cat-panel">
            <div class="cat-panel-inner">
              ${subsHtml}
            </div>
          </div>` : ''}
        </div>`;
    }).join("");

    setupCategoryListeners(list);
  }

  function setupCategoryListeners(list) {
    list.querySelectorAll(".cat").forEach(el => {
      const catBtn = el.querySelector(".cat-btn");
      const catId = el.dataset.cat;
      const targetCategoryData = categories.find(c => c.id === catId);
      const hasSubs = el.querySelector(".cat-panel") !== null;

      catBtn.addEventListener("click", (e) => {
        e.stopPropagation();

        if (hasSubs) {
          const isOpen = el.classList.contains("open");
          list.querySelectorAll(".cat").forEach(c => {
            c.classList.remove("open");
            const b = c.querySelector(".cat-btn");
            if(b.hasAttribute("aria-expanded")) b.setAttribute("aria-expanded", "false");
          });

          if (!isOpen) {
            el.classList.add("open");
            catBtn.setAttribute("aria-expanded", "true");
            activeCategory = catId;
            activeSubcategory = "";
            currentPage = 1;
            
            list.querySelectorAll(".cat").forEach(c => c.classList.remove("active"));
            document.getElementById("allGoodsBtn").classList.remove("active");
            document.getElementById("newArrivalsBtn").classList.remove("active");
            el.classList.add("active");
            
            document.getElementById("activeCatName").textContent = targetCategoryData.name;
            scrollThenRenderGrid();
          } else {
            el.classList.remove("open");
          }
        } else {
          list.querySelectorAll(".cat").forEach(c => c.classList.remove("open"));
          activeCategory = catId;
          activeSubcategory = "";
          currentPage = 1;

          list.querySelectorAll(".cat").forEach(c => c.classList.remove("active"));
          document.getElementById("allGoodsBtn").classList.remove("active");
          document.getElementById("newArrivalsBtn").classList.remove("active");
          el.classList.add("active");

          document.getElementById("activeCatName").textContent = targetCategoryData.name;
          scrollThenRenderGrid();
          closeSidebarMobile();
        }
      });

      if (hasSubs) {
        el.querySelectorAll(".subcat-btn").forEach(subBtn => {
          subBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const subName = subBtn.dataset.sub;
            
            activeCategory = catId;
            activeSubcategory = subName;
            currentPage = 1;

            list.querySelectorAll(".cat").forEach(c => c.classList.remove("active"));
            el.classList.add("active");
            
            el.querySelectorAll(".subcat-btn").forEach(b => b.classList.remove("active"));
            subBtn.classList.add("active");

            const subCleanText = subBtn.textContent.trim().split(' (')[0];
            document.getElementById("activeCatName").textContent = `${targetCategoryData.name} → ${subCleanText}`;

            scrollThenRenderGrid();
            closeSidebarMobile();
          });
        });
      }

      const singleSubBtn = el.querySelector(".single-sub-btn");
      if (singleSubBtn) {
        singleSubBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const subName = singleSubBtn.dataset.sub;

          activeCategory = catId;
          activeSubcategory = subName;
          currentPage = 1;

          list.querySelectorAll(".cat").forEach(c => c.classList.remove("active"));
          document.getElementById("allGoodsBtn").classList.remove("active");
          document.getElementById("newArrivalsBtn").classList.remove("active");
          el.classList.add("active");
          singleSubBtn.classList.add("active");

          const subCleanText = singleSubBtn.textContent.trim().split(" (")[0];
          document.getElementById("activeCatName").textContent = `${targetCategoryData.name} → ${subCleanText}`;

          scrollThenRenderGrid();
          closeSidebarMobile();
        });
      }
    });
  }

  // Вес комплекта "Гарнитуры" — сумма всех его изделий (то же число, что уже
  // показано на карточке как "N гр. всего"), а не вес какого-то одного из них —
  // так фильтр/сортировка по весу остаются согласованы с тем, что видно на экране.
  function itemWeight(item){
    if (item.isSet) {
      return [item.ring, item.earring, item.pendant]
        .filter(Boolean)
        .reduce((sum, p) => sum + (parseFloat(p.weight) || 0), 0);
    }
    return parseFloat(item.weight) || 0;
  }

  // Фильтр по весу — после группировки в пары "Гарнитуры" (не до): весы отдельных
  // изделий комплекта по отдельности могли бы не уложиться в диапазон, хотя их
  // сумма укладывается (или наоборот), а на экране комплект всегда один блок
  // с одним суммарным весом — фильтровать нужно ровно по нему же.
  function applyWeightFilter(items){
    if (weightMin == null && weightMax == null) return items;
    return items.filter(item => {
      const w = itemWeight(item);
      if (weightMin != null && w < weightMin) return false;
      if (weightMax != null && w > weightMax) return false;
      return true;
    });
  }

  function applySortOrder(items){
    if (sortOrder === "weight-asc") return [...items].sort((a, b) => itemWeight(a) - itemWeight(b));
    if (sortOrder === "weight-desc") return [...items].sort((a, b) => itemWeight(b) - itemWeight(a));
    return items; // "default" — порядок уже задан getFilteredFlat/группировкой
  }

  // Применяет группировку пар "Гарнитуры" (см. groupGarnituryPairs ниже) поверх обычной
  // фильтрации — так пара выглядит парой в любом разрезе (вся категория, конкретная
  // подкатегория, поиск, "Все товары"). Вне "Гарнитуры" группировка не находит совпадений
  // и возвращает список без изменений.
  function getFiltered(){
    const grouped = groupGarnituryPairs(getFilteredFlat());
    return applySortOrder(applyWeightFilter(grouped));
  }

  function getFilteredFlat(){
    // Сравниваем по нормализованному артикулу (skuNorm уже посчитан один раз при загрузке) —
    // так поиск не зависит от регистра, дефисов/пробелов и ведущих нулей.
    const term = normalizeForSearch(searchTerm);

    // «Новинки» — не настоящая категория, а последние NEW_ARRIVALS_COUNT добавленных товаров
    // по всей базе (по createdAt), отдельно от обычной сортировки по возрастанию артикула.
    if (activeCategory === NEW_ARRIVALS) {
      return [...rawItems]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, NEW_ARRIVALS_COUNT)
        .filter(item => item.skuNorm.includes(term));
    }

    // "Все товары": плоская сортировка по артикулу мешает категории вперемешку (цепочка и брошь
    // соседствуют просто из-за похожего начала артикула). Группируем сначала по категории —
    // в том же порядке, что и в сайдбаре, — а внутри категории уже по возрастанию артикула.
    if (activeCategory === ALL) {
      return rawItems
        .filter(item => item.skuNorm.includes(term))
        .sort((a, b) => {
          const orderDiff = (CATEGORY_ORDER.get(a.category) ?? 999) - (CATEGORY_ORDER.get(b.category) ?? 999);
          return orderDiff !== 0 ? orderDiff : a.sku.localeCompare(b.sku, "ru", { numeric: true });
        });
    }

    // Внутри одной категории rawItems уже отсортирован по возрастанию артикула при загрузке
    return rawItems.filter(item => {
      const inCategory = item.category === activeCategory;
      let inSubcategory = true;
      if (activeSubcategory && !activeSubcategory.startsWith("все ")) {
        inSubcategory = item.subcategory === activeSubcategory;
      }
      const matchesSearch = item.skuNorm.includes(term);
      return inCategory && inSubcategory && matchesSearch;
    });
  }

  // При смене категории/страницы сразу оказываемся у каталога — без «пролёта»
  // через Hero. Порядок принципиален:
  // 1) Снять лок скролла мобильного меню БЕЗ восстановления старой позиции
  //    (раньше closeSidebarMobile() делал scrollTo(lockY) уже после перехода
  //    к каталогу → пользователь снова оказывался на Hero и листал вниз вручную).
  // 2) Мгновенно (behavior:"auto") встать на #catalog (scroll-margin учитывает шапку).
  // 3) Только потом отрисовать сетку — иначе reveal играет во время движения.
  function scrollThenRenderGrid(){
    const side = document.getElementById("sidebar");
    const ov = document.getElementById("overlay");
    const burger = document.getElementById("burgerBtn");
    if (window.innerWidth <= 900 && side) {
      side.classList.remove("open");
      if (ov) ov.classList.remove("show");
      if (burger) burger.classList.remove("open");
      if (document.body.classList.contains("sidebar-open")) {
        document.body.classList.remove("sidebar-open");
        document.body.style.top = "";
        // намеренно НЕ возвращаем прежний scrollY — уходим в каталог
      }
    }
    document.getElementById("catalog").scrollIntoView({ behavior: "auto", block: "start" });
    renderGrid();
  }

  // 1 товар / 2 товара / 5 товаров — раньше было только "товар" и "товаров",
  // из-за чего получалось "2 товаров".
  function pluralizeGoods(n){
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return "товаров";
    switch (n % 10) {
      case 1: return "товар";
      case 2: case 3: case 4: return "товара";
      default: return "товаров";
    }
  }

  function renderGrid(){
    const filtered = getFiltered();
    const grid = document.getElementById("productGrid");
    const empty = document.getElementById("emptyState");
    const resultCount = document.getElementById("resultCount");

    // Считаем именно товары, а не карточки: карточка комплекта — это 2-3 изделия, и
    // если считать карточками, счётчик разошёлся бы с "Все товары" в сайдбаре (2762
    // против 2979) и выглядел бы как будто часть каталога пропала. Пагинация при этом
    // по-прежнему идёт карточками, по PER_PAGE штук на страницу.
    const productCount = filtered.reduce((sum, item) =>
      sum + (item.isSet ? [item.ring, item.earring, item.pendant].filter(Boolean).length : 1), 0);
    resultCount.textContent = `${productCount} ${pluralizeGoods(productCount)}`;

    if(filtered.length === 0){
      grid.innerHTML = "";
      empty.style.display = "block";
      document.getElementById("pagination").innerHTML = "";
      return;
    }
    empty.style.display = "none";

    const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
    if(currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PER_PAGE;
    const pageItems = filtered.slice(start, start + PER_PAGE);

    currentPageItems = pageItems;

    // Обработчик "фото не загрузилось" раньше был инлайновым атрибутом onerror. Убран
    // по двум причинам: он мешает строгой Content-Security-Policy (та запрещает
    // выполнять код из атрибутов) и сам по себе собирал HTML внутри кавычек внутри
    // кавычек — легко ошибиться. Теперь то же самое делает один делегированный
    // слушатель ниже (событие error всплывает в фазе перехвата).
    grid.innerHTML = pageItems.map(item => item.isSet ? renderSetCard(item) : renderProductCard(item)).join("");

    renderPagination(totalPages);
    revealGridCards();
    initCardImageShimmer();
    optimizeGridColumns();
  }

  // ===== Число колонок сетки — на 1 меньше, если так ряды заполняются ровно =====
  // В отличие от прошлой попытки (растягивать отдельные карточки — выглядело
  // криво, карточки становились разного размера в одном ряду) здесь все карточки
  // остаются одинаковыми: просто пробуем сетку из columns-1 колонок и смотрим,
  // делится ли на неё общее число товаров без остатка. Если нет — не гонимся
  // дальше (columns-2, columns-3...), просто оставляем как есть.
  // Гарнитуры (grid-column:span 2) не трогаем — там своя раскладка.
  function optimizeGridColumns(){
    const grid = document.getElementById("productGrid");
    const items = [...grid.children];
    grid.style.gridTemplateColumns = ""; // сброс к обычному CSS-правилу (auto-fill/minmax)
    if (items.length === 0) return;
    if (items.some(el => el.classList.contains("card-set-pair"))) return;

    const naturalColumns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    if (naturalColumns <= 1 || items.length % naturalColumns === 0) return; // и так ровно

    const reducedColumns = naturalColumns - 1;
    // >=2, а не >=1: сжать до одной колонки во всю ширину ради одной пустой
    // клетки — это худший размен, чем сама пустота (см. предыдущий откат).
    if (reducedColumns >= 2 && items.length % reducedColumns === 0) {
      grid.style.gridTemplateColumns = `repeat(${reducedColumns}, 1fr)`;
    }
  }

  // Число колонок зависит от ширины экрана — пересчитываем и при изменении
  // размера окна, не только при смене страницы/фильтра.
  let gridColumnsResizeTicking = false;
  window.addEventListener("resize", () => {
    if (!gridColumnsResizeTicking) {
      requestAnimationFrame(() => { optimizeGridColumns(); gridColumnsResizeTicking = false; });
      gridColumnsResizeTicking = true;
    }
  }, { passive: true });

  // ===== Заглушка-shimmer на месте фото товара, пока оно грузится =====
  // img.complete проверяем сразу: для кэшированных фото событие load могло
  // случиться раньше, чем этот код вообще успел навесить слушатель, и без
  // проверки shimmer завис бы навсегда на уже загруженной картинке.
  function initCardImageShimmer(){
    document.querySelectorAll("#productGrid .card-img img").forEach(img => {
      const markLoaded = () => {
        img.classList.add("loaded");
        img.closest(".card-img")?.classList.add("img-loaded");
      };
      if (img.complete) { markLoaded(); return; }
      img.addEventListener("load", markLoaded, { once: true });
      img.addEventListener("error", markLoaded, { once: true });
    });
  }

  // ===== Плавное появление карточек при скролле =====
  // Наблюдаем НАПРЯМУЮ ПОТОМКОВ #productGrid (grid.children) — это ровно те элементы,
  // что реально стоят в сетке (обычная .card или рамка .card-set-pair целиком), а не
  // отдельные изделия ВНУТРИ комплекта: те получили бы reveal дважды — от рамки и от
  // самих себя, — и на анимации это было бы заметно как дублирующийся, дёрганый эффект.
  // Наблюдатель пересоздаётся при каждой отрисовке страницы (смена фильтра/страницы
  // пагинации даёт новые DOM-элементы — старый наблюдатель их просто не увидит).
  let gridRevealObserver = null;
  function revealGridCards(){
    const grid = document.getElementById("productGrid");
    if(gridRevealObserver) gridRevealObserver.disconnect();

    if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){
      [...grid.children].forEach(el => el.classList.add("in-view"));
      return;
    }

    gridRevealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          entry.target.classList.add("in-view");
          gridRevealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0.05 });

    [...grid.children].forEach((el, i) => {
      el.classList.add("reveal");
      // Первый экран карточек (обычно первый ряд) уже виден при заходе на страницу —
      // без задержки они выглядели бы как "внезапно появились одновременно" рывком.
      // Небольшой каскад по индексу (максимум 6 карточек вперёд) даёт то же ощущение
      // построчного появления, что и в остальных новых блоках сайта.
      el.style.transitionDelay = (Math.min(i, 6) * 45) + "ms";
      gridRevealObserver.observe(el);
    });
  }

  // AVIF/WebP лежат рядом с оригиналом под тем же именем (scripts/enhance-all.mjs
  // прогнал весь images/ разом, проверил — на все 2978 файлов есть оба варианта,
  // без исключений) — только для локальных images/itemsNNN.jpg, у внешних (ImgBB
  // и т.п.) вариантов нет и не будет, для них картинка остаётся как есть, без
  // <picture>. Раньше уже ловил баг именно тут: если сослаться на .webp/.avif,
  // которого ещё нет на диске, браузер показывает битую картинку и НЕ откатывается
  // на <img> сам — <picture> так не работает. Поэтому это подключено только
  // теперь, когда для каждого файла подтверждено наличие обоих вариантов.
  function localPictureSources(imgPath){
    const m = /^images\/(items\d+)\.jpg$/i.exec(imgPath);
    if (!m) return "";
    const base = m[1];
    return `<source srcset="images/${base}.avif" type="image/avif">`
         + `<source srcset="images/${base}.webp" type="image/webp">`;
  }

  function renderProductCard(item){
    // Без loading="lazy": пагинация и так ограничивает страницу разумным числом фото
    // (20 обычных товаров, до ~40 с учётом пар "Гарнитуры" — совсем немного для
    // современного соединения), а лень откладывала подгрузку до прокрутки и на
    // мгновение показывала иконку "битой" картинки, пока не долистаешь до неё.
    return `
      <div class="card">
        <div class="card-img" data-img="${escapeHtml(item.img)}">
          <picture>
            ${localPictureSources(item.img)}
            <img src="${escapeHtml(item.img)}" alt="${escapeHtml(item.sku)}">
          </picture>
        </div>
        <div class="card-body">
          <div class="card-sku">${escapeHtml(item.sku)}</div>
          <div class="card-bottom-row">
            <div class="card-weight">${escapeHtml(item.weight)}<span class="unit"> гр.</span></div>
            <div class="card-control" data-sku="${escapeHtml(item.sku)}">${cartControlHtml(item)}</div>
          </div>
        </div>
      </div>`;
  }

  // Пара (кольцо+серьги) или тройка (+ подвеска) из "Гарнитуры".
  // Раскладку задаёт CSS по data-count: 2 → две равные колонки, 3 → три
  // (без пустой ячейки у пары). Фото на белом студийном фоне.
  //
  // Основной сценарий — покупка комплекта целиком: одна кнопка кладёт в корзину все его
  // изделия разом. Отдельные кнопки у каждого изделия никуда не делись, но убраны под
  // неприметный переключатель "Купить отдельно" (класс separate-mode на рамке), чтобы не
  // спорить с главной кнопкой: те же изделия и так продаются в своих категориях
  // (Кольца/Серьги/Подвески), здесь же человек пришёл за комплектом.
  //
  // Размер кольца выбирается один раз на уровне комплекта. Он же хранится в общей карте
  // cardSelectedSize по артикулу кольца, поэтому пикер комплекта и личный пикер кольца
  // в режиме "купить отдельно" — это два вида на одно и то же значение, а не две настройки.
  function renderSetCard(setItem){
    const pieces = [setItem.ring, setItem.earring, setItem.pendant].filter(Boolean);
    const ring = setItem.ring;
    const ringNeedsSize = !!ring && isRingItem(ring);
    const setKey = escapeHtml(ring.sku); // комплект адресуем артикулом его кольца
    const totalWeight = pieces.reduce((sum, p) => sum + (parseFloat(p.weight) || 0), 0);

    return `
      <div class="card-set-pair" data-set-ring="${setKey}" data-count="${pieces.length}">
        <div class="card-set-head">
          <span class="card-set-label">Комплект</span>
          ${totalWeight ? `<span class="card-set-weight">${totalWeight.toFixed(2)} гр. всего</span>` : ""}
        </div>
        <div class="card-set-items" data-count="${pieces.length}">
          ${pieces.map(renderProductCard).join("")}
        </div>
        <div class="card-set-actions">
          ${ringNeedsSize ? `
          <div class="set-size-row">
            <span class="set-size-label">Размер кольца</span>
            ${sizePickerHtml(ring, "set-size-picker")}
          </div>` : ""}
          <button type="button" class="add-set-btn" data-set-ring="${setKey}">
            ${CART_ICON_SVG}<span>Добавить комплект в корзину</span>
          </button>
          <button type="button" class="set-separate-toggle" data-set-ring="${setKey}">Купить отдельно</button>
        </div>
      </div>`;
  }

  const CART_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="9.5" y1="10.5" x2="14.5" y2="10.5"/></svg>`;

  // Выбор размера, сделанный на карточке каталога (до добавления в корзину) — по одному
  // на артикул, не сохраняется между перезагрузками страницы (это просто подсказка на
  // время просмотра, не часть заказа). Дальше он же подставляется как размер по умолчанию
  // при увеличении количества — но точный размер каждой единицы всё ещё можно поправить
  // в корзине (там это работает как раньше, по одному значению на штуку).
  const cardSelectedSize = new Map();

  // Иконка "добавить", степпер количества, а для колец — ещё и пикер размера. Всё это
  // одна функция под общим data-sku в .card-control, поэтому refreshCardControl обновляет
  // сразу и пикер, и степпер одним вызовом.
  function cartControlHtml(item){
    const sku = item.sku;
    const qty = getCartQty(sku);
    const safeSku = escapeHtml(sku);

    const addOrQtyHtml = qty > 0
      ? `<div class="card-qty">
           <button type="button" data-action="dec" data-sku="${safeSku}">−</button>
           <span>${escapeHtml(qty)}</span>
           <button type="button" data-action="inc" data-sku="${safeSku}">+</button>
         </div>`
      : `<button class="add-cart-btn" data-sku="${safeSku}" type="button" aria-label="В корзину" title="В корзину">${CART_ICON_SVG}</button>`;

    if (!isRingItem(item)) return addOrQtyHtml;
    return `<div class="card-ring-controls">${sizePickerHtml(item, "card-size-picker")}${addOrQtyHtml}</div>`;
  }

  // Один и тот же пикер используется в двух местах: внутри карточки товара
  // (card-size-picker) и на уровне комплекта (set-size-picker). Оба адресуются артикулом
  // кольца и читают/пишут одно значение в cardSelectedSize, поэтому остаются согласованными.
  function sizePickerHtml(item, extraClass){
    const chosen = cardSelectedSize.get(item.sku) || null;
    return `
      <div class="size-picker ${extraClass}" data-sku="${escapeHtml(item.sku)}">
        <button type="button" class="size-picker-btn">${chosen ? escapeHtml(chosen) : "Размер"}</button>
        <div class="size-picker-grid">
          ${ringSizesFor(item).map(s => `<button type="button" class="size-chip${chosen === s ? " active" : ""}" data-size="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>`;
  }

  function refreshCardControl(sku){
    // Артикул подставляется в CSS-селектор, поэтому кавычка или скобка в нём уронила бы
    // querySelectorAll с исключением (корзина переставала бы обновляться). Сравниваем
    // значения напрямую — селектор строить из данных вообще не нужно.
    const item = findPageItem(sku);
    if (!item) return;
    document.querySelectorAll(".card-control").forEach(el => {
      if(el.dataset.sku === sku) el.innerHTML = cartControlHtml(item);
    });
    // Пикер размера на уровне комплекта лежит вне .card-control, поэтому обновляем его
    // тем же вызовом — иначе выбранный размер обновлялся бы только в одном из двух мест.
    document.querySelectorAll(".set-size-picker").forEach(el => {
      if(el.dataset.sku === sku) el.outerHTML = sizePickerHtml(item, "set-size-picker");
    });
  }

  function getCartQty(sku){
    const it = cart.find(i => i.sku === sku);
    return it ? it.qty : 0;
  }

  // Товары текущей страницы — нужны, чтобы клик по иконке "в корзину" знал вес/фото товара.
  // Обработчик один, назначен на #productGrid один раз (см. ниже), а не при каждом рендере.
  let currentPageItems = [];

  // Ищет товар текущей страницы по артикулу — заглядывая и внутрь комплектов "Гарнитуры"
  // (там на верхнем уровне лежит псевдо-товар isSet, а настоящие sku — в .ring/.earring/.pendant).
  // Перебираем части комплекта списком, а не по одной: пропущенная ветка означала бы,
  // что по такой карточке нельзя ни добавить товар в корзину, ни обновить её вид.
  function findPageItem(sku){
    for (const item of currentPageItems) {
      if (item.isSet) {
        const piece = [item.ring, item.earring, item.pendant].find(p => p && p.sku === sku);
        if (piece) return piece;
      } else if (item.sku === sku) {
        return item;
      }
    }
    return null;
  }

  // Комплект на текущей странице адресуется артикулом своего кольца (data-set-ring).
  function findPageSet(ringSku){
    return currentPageItems.find(i => i.isSet && i.ring.sku === ringSku) || null;
  }

  // Кладёт в корзину все изделия комплекта разом. Артикулы, количество и размер
  // проставляет обычный addToCart для каждого изделия по отдельности, поэтому в корзине
  // и в заказе комплект выглядит как несколько обычных позиций — оформление заказа,
  // правила Firestore и админка продолжают работать без единого изменения.
  // Размер получает только кольцо: для серёг и подвески isRingItem даёт false, и
  // ensureSizes внутри addToCart оставляет им пустой список размеров.
  function addSetToCart(ringSku){
    const setItem = findPageSet(ringSku);
    if (!setItem) return;
    const pieces = [setItem.ring, setItem.earring, setItem.pendant].filter(Boolean);
    const ring = setItem.ring;

    if (isRingItem(ring) && !cardSelectedSize.get(ring.sku)) {
      showNotice("Сначала выберите размер кольца — без него мы не сможем принять заказ.",
        { title: "Не указан размер", type: "error" });
      return;
    }

    pieces.forEach(piece => addToCart(piece));
    showNotice(`Добавлено изделий: ${pieces.length} — ${pieces.map(p => p.sku).join(", ")}.`,
      { title: "Комплект в корзине", type: "success" });
  }

  // Общая позиция попапа выбора размера — и для карточки каталога, и для корзины.
  // position:fixed выбран намеренно (не absolute): и карточка (overflow:hidden ради
  // скруглённых углов фото), и панель корзины (overflow-y:auto) обрезали бы попап,
  // окажись он позиционирован от них. Раз это viewport-координаты — при прокрутке
  // страницы попап перестаёт совпадать с кнопкой, поэтому при скролле его просто
  // закрываем (см. слушатель scroll ниже), а не пытаемся пересчитывать на лету.
  function positionSizePickerGrid(picker, trigger){
    const rect = trigger.getBoundingClientRect();
    const grid = picker.querySelector(".size-picker-grid");
    const gridWidth = 184;
    // На этот момент попап уже .open (display:grid), поэтому offsetHeight — его настоящая
    // высота, а не 0. Меряем и решаем, разворачивать ли попап вверх от кнопки: если снизу
    // не хватает места, а сверху хватает — открываем вверх, иначе как обычно вниз.
    const gridHeight = grid.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < gridHeight + 10 && spaceAbove > gridHeight + 10;
    grid.style.top = openUpward ? (rect.top - gridHeight - 6) + "px" : (rect.bottom + 6) + "px";
    grid.style.left = Math.max(8, rect.right - gridWidth) + "px";
  }

  // Скролл (страницы или прокручиваемой панели корзины) — закрываем открытый попап
  // размера, а не оставляем его висеть на старом месте экрана, оторванным от товара.
  window.addEventListener("scroll", () => {
    document.querySelectorAll(".size-picker.open").forEach(p => p.classList.remove("open"));
  }, { capture: true, passive: true });

  // Шапка компактнее после первых 40px скролла + тонкая золотая полоса прогресса
  // чтения страницы сверху. rAF-троттлинг — scroll стреляет чаще, чем нужно менять DOM.
  // --nav-height — только логическая высота контента шапки (74/68/60), без safe-area:
  // safe-area добавляется в CSS через env(), иначе измерение getBoundingClientRect
  // и запись обратно в переменную разгоняли бы высоту по кругу.
  const mainNav = document.getElementById("mainNav");
  const navProgressEl = document.getElementById("navProgress");
  let navScrollTicking = false;
  function syncNavHeightVar(scrolled){
    const narrow = window.matchMedia("(max-width:480px)").matches;
    const base = scrolled ? 60 : (narrow ? 68 : 74);
    document.documentElement.style.setProperty("--nav-height", base + "px");
  }
  function updateNavOnScroll(){
    const y = window.scrollY || document.documentElement.scrollTop;
    const scrolled = y > 40;
    mainNav.classList.toggle("scrolled", scrolled);
    syncNavHeightVar(scrolled);
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    navProgressEl.style.width = scrollable > 0 ? Math.min(100, (y / scrollable) * 100) + "%" : "0%";
    navScrollTicking = false;
  }
  window.addEventListener("scroll", () => {
    if(!navScrollTicking){
      requestAnimationFrame(updateNavOnScroll);
      navScrollTicking = true;
    }
  }, { passive:true });
  window.addEventListener("resize", () => {
    syncNavHeightVar(mainNav.classList.contains("scrolled"));
  }, { passive:true });
  updateNavOnScroll();

  // ===== Ripple на кнопках-действиях =====
  // Один делегированный обработчик на все перечисленные классы вместо того, чтобы
  // вешать свой на каждую кнопку по отдельности — новые кнопки (например, в новых
  // секциях) подхватываются сами, ничего дополнительно подключать не нужно.
  // Только визуальный эффект: click не перехватывается (нет preventDefault/
  // stopPropagation), поэтому реальные обработчики кнопок продолжают работать как раньше.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.addEventListener("click", (e) => {
    if (reduceMotion.matches) return;
    const btn = e.target.closest(".primary-btn, .add-cart-btn, .add-set-btn, .hero-btn");
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.4;
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = size + "px";
    span.style.left = (e.clientX - rect.left - size / 2) + "px";
    span.style.top = (e.clientY - rect.top - size / 2) + "px";
    btn.appendChild(span);
    span.addEventListener("animationend", () => span.remove(), { once: true });
  });

  // ===== "Наверх" в футере =====
  document.getElementById("backToTop").addEventListener("click", (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" });
  });

  // ===== Появление новых витринных секций при скролле =====
  // Те же классы .reveal/.in-view, что и у карточек товара (см. revealGridCards) —
  // единая система, а не вторая копия той же логики. Настраивается один раз при
  // загрузке: это статичная разметка, в отличие от сетки товаров она не перерисовывается.
  (function initStaticReveals(){
    const targets = document.querySelectorAll(".advantage-card, .process-steps > li, .cta-inner");
    if (targets.length === 0) return;
    if (reduceMotion.matches) {
      targets.forEach(el => el.classList.add("in-view"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -60px 0px", threshold: 0.08 });
    targets.forEach((el, i) => {
      el.classList.add("reveal");
      el.style.transitionDelay = (Math.min(i % 4, 3) * 70) + "ms";
      observer.observe(el);
    });
  })();

  // ===== Лёгкий параллакс Aurora-фона Hero от мыши =====
  // Только там, где есть настоящая мышь (hover:hover исключает тач-экраны, где
  // mousemove либо не стреляет вовсе, либо стреляет один раз после тапа —
  // не тот эффект, который нужен) и только когда не отключены анимации.
  // Сдвиг мал (±10px) — это подсказка глубины, а не заметный эффект сам по себе.
  (function initHeroParallax(){
    const hero = document.querySelector(".hero");
    const aurora = document.getElementById("heroAurora");
    if (!hero || !aurora) return;
    if (reduceMotion.matches || !window.matchMedia("(hover: hover)").matches) return;

    hero.addEventListener("mousemove", (e) => {
      const rect = hero.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      const py = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
      aurora.style.transform = `translate(${px * 10}px, ${py * 10}px)`;
    });
    hero.addEventListener("mouseleave", () => { aurora.style.transform = ""; });
  })();

  // ===== Небольшой докат по инерции после остановки колеса =====
  // Обе предыдущие версии перехватывали сам скролл (preventDefault) и вели его
  // сами — из-за этого он либо тянулся вязко, либо просто ощущался "не своим".
  // Здесь по-другому: сам скролл во время движения колеса остаётся ПОЛНОСТЬЮ
  // нативным (passive:true, preventDefault не вызывается вообще — "как будто
  // я скролю" в чистом виде). Единственное добавление — короткий, маленький
  // докат ПОСЛЕ того, как колесо перестало крутиться (100мс без новых wheel-
  // событий), похожий на инерцию тачпада: несколько кадров быстро затухающего
  // scrollBy, максимум ~50-60px, а не отдельная "поездка".
  //
  // Сайдбар/корзина/модалки (своя прокрутка через overflow) исключены явно.
  // При reduce-motion не включается вовсе.
  (function initScrollMomentumTail(){
    if (reduceMotion.matches) return;
    const noInterceptSelector = ".sidebar, .cart-panel-body, .modal-box";
    let lastDeltaY = 0;
    let idleTimer = null;
    let coastId = null;

    function stopCoast(){
      if (coastId) { cancelAnimationFrame(coastId); coastId = null; }
    }

    function startCoast(){
      const sign = lastDeltaY > 0 ? 1 : -1;
      // Старт всегда небольшой и почти не зависит от силы прокрутки — это
      // именно "довесок", а не продолжение того же движения в том же масштабе.
      let v = sign * Math.min(15, Math.abs(lastDeltaY) * 0.15);
      let steps = 0;
      function tick(){
        if (Math.abs(v) < 0.3 || steps++ > 12) { coastId = null; return; }
        window.scrollBy(0, v);
        v *= 0.75;
        coastId = requestAnimationFrame(tick);
      }
      coastId = requestAnimationFrame(tick);
    }

    window.addEventListener("wheel", (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (e.target.closest(noInterceptSelector)) return;
      // preventDefault нет намеренно — сам скролл нативный от начала до конца
      stopCoast();
      lastDeltaY = e.deltaY;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(startCoast, 100);
    }, { passive: true });
  })();

  document.getElementById("productGrid").addEventListener("click", (e) => {
    // Пикер размера в карточке каталога — выбирается ДО добавления в корзину, а не только
    // потом в самой корзине (там пикер с теми же классами продолжает работать как раньше).
    // Селектор без привязки к .card-ring-controls: этот обработчик висит только на
    // #productGrid, поэтому любой .size-chip внутри него — пикер каталога, будь он
    // в самой карточке или на уровне комплекта. У корзины свой отдельный обработчик.
    const chip = e.target.closest(".size-chip");
    if(chip){
      const picker = chip.closest(".size-picker");
      cardSelectedSize.set(picker.dataset.sku, Number(chip.dataset.size));
      picker.classList.remove("open");
      refreshCardControl(picker.dataset.sku);
      return;
    }
    const sizeTrigger = e.target.closest(".size-picker-btn");
    if(sizeTrigger){
      const picker = sizeTrigger.closest(".size-picker");
      const wasOpen = picker.classList.contains("open");
      document.querySelectorAll(".size-picker.open").forEach(p => p.classList.remove("open"));
      if(!wasOpen){
        picker.classList.add("open");
        positionSizePickerGrid(picker, sizeTrigger);
      }
      return;
    }

    // Главная кнопка комплекта — кладёт в корзину все его изделия разом
    const addSetBtn = e.target.closest(".add-set-btn");
    if(addSetBtn){
      addSetToCart(addSetBtn.dataset.setRing);
      return;
    }

    // "Купить отдельно" — раскрывает личные кнопки у каждого изделия комплекта
    const separateToggle = e.target.closest(".set-separate-toggle");
    if(separateToggle){
      const setEl = separateToggle.closest(".card-set-pair");
      const isOpen = setEl.classList.toggle("separate-mode");
      separateToggle.textContent = isOpen ? "Скрыть покупку по отдельности" : "Купить отдельно";
      return;
    }

    const addBtn = e.target.closest(".add-cart-btn");
    if(addBtn){
      const item = findPageItem(addBtn.dataset.sku);
      if(!item) return;
      if(isRingItem(item) && !cardSelectedSize.get(item.sku)){
        showNotice("Сначала выберите размер кольца в карточке товара.", { title: "Не указан размер", type: "error" });
        return;
      }
      addToCart(item);
      return;
    }
    const qtyBtn = e.target.closest(".card-qty button");
    if(qtyBtn){
      changeQty(qtyBtn.dataset.sku, qtyBtn.dataset.action === "inc" ? 1 : -1);
      return;
    }
    const imgEl = e.target.closest(".card-img");
    if(imgEl){
      openLightbox(imgEl.dataset.img, imgEl.querySelector("img")?.alt);
    }
  });

  function renderPagination(totalPages){
    const pagination = document.getElementById("pagination");
    if(totalPages <= 1){ pagination.innerHTML = ""; return; }

    // Окно из соседних страниц + первая/последняя, иначе при 1700 товарах получается 89 кнопок
    const pages = new Set([1, totalPages]);
    for(let p = currentPage - 2; p <= currentPage + 2; p++){
      if(p >= 1 && p <= totalPages) pages.add(p);
    }
    const sorted = [...pages].sort((a, b) => a - b);

    let html = `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">‹</button>`;
    let prev = 0;
    for(const p of sorted){
      if(p - prev > 1) html += `<span class="page-gap">…</span>`;
      html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
      prev = p;
    }
    html += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">›</button>`;
    pagination.innerHTML = html;

    pagination.querySelectorAll(".page-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const page = parseInt(btn.dataset.page, 10);
        if(!isNaN(page) && page >= 1 && page <= totalPages){
          currentPage = page;
          scrollThenRenderGrid();
        }
      });
    });
  }

  function initCatalogInterface() {
    const allGoodsBtn = document.getElementById("allGoodsBtn");
    const newArrivalsBtn = document.getElementById("newArrivalsBtn");
    document.getElementById("allGoodsCount").textContent = rawItems.length;
    document.getElementById("newArrivalsCount").textContent = countFor(NEW_ARRIVALS);

    allGoodsBtn.addEventListener("click", () => {
      document.querySelectorAll("#categoryList .cat").forEach(c => {
        c.classList.remove("open");
        c.classList.remove("active");
      });

      newArrivalsBtn.classList.remove("active");
      allGoodsBtn.classList.add("active");
      activeCategory = ALL;
      activeSubcategory = "";
      currentPage = 1;
      document.getElementById("activeCatName").textContent = "Все товары";

      scrollThenRenderGrid();
      closeSidebarMobile();
    });

    newArrivalsBtn.addEventListener("click", () => {
      document.querySelectorAll("#categoryList .cat").forEach(c => {
        c.classList.remove("open");
        c.classList.remove("active");
      });

      allGoodsBtn.classList.remove("active");
      newArrivalsBtn.classList.add("active");
      activeCategory = NEW_ARRIVALS;
      activeSubcategory = "";
      currentPage = 1;
      document.getElementById("activeCatName").textContent = "Новинки";

      scrollThenRenderGrid();
      closeSidebarMobile();
    });

    // Chrome игнорирует autocomplete="off" для полей, которые считает похожими на логин
    // (на странице есть поле пароля), и всё равно подставляет сохранённые email/пароли.
    // readonly до первого фокуса/клика — надёжный обходной путь: автозаполнение не
    // трогает readonly-поля, а обычному вводу это не мешает.
    const searchInputEl = document.getElementById("searchInput");
    const enableSearchInput = () => searchInputEl.removeAttribute("readonly");
    searchInputEl.addEventListener("focus", enableSearchInput);
    searchInputEl.addEventListener("mousedown", enableSearchInput);
    searchInputEl.addEventListener("touchstart", enableSearchInput);

    searchInputEl.addEventListener("input", (e) => {
      searchTerm = e.target.value.trim();
      currentPage = 1;
      renderGrid();
    });

    // Сортировка — свой дропдаун, не <select> (см. комментарий в index.html —
    // открытый список нативного <select> на Android рисует сама ОС, наш CSS
    // на него не действует). Тот же принцип открытия/закрытия, что и у
    // account-menu (клик по кнопке — toggle, клик вне — закрыть).
    const sortPicker = document.getElementById("sortPicker");
    const sortPickerBtn = document.getElementById("sortPickerBtn");
    sortPickerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !sortPicker.classList.contains("open");
      sortPicker.classList.toggle("open", willOpen);
      sortPickerBtn.setAttribute("aria-expanded", String(willOpen));
    });
    sortPicker.querySelectorAll(".sort-option").forEach(opt => {
      opt.addEventListener("click", () => {
        sortOrder = opt.dataset.value;
        sortPickerBtn.textContent = opt.textContent;
        sortPicker.querySelectorAll(".sort-option").forEach(o => {
          o.classList.toggle("active", o === opt);
          o.setAttribute("aria-selected", String(o === opt));
        });
        sortPicker.classList.remove("open");
        sortPickerBtn.setAttribute("aria-expanded", "false");
        // Как смена категории: список меняется целиком, значит и страница, и
        // позиция скролла должны вернуться к началу (scrollThenRenderGrid, не
        // renderGrid()+scroll по отдельности — см. её комментарий, почему
        // порядок важен).
        currentPage = 1;
        scrollThenRenderGrid();
      });
    });
    document.addEventListener("click", (e) => {
      if (sortPicker.classList.contains("open") && !e.target.closest(".sort-picker")) {
        sortPicker.classList.remove("open");
        sortPickerBtn.setAttribute("aria-expanded", "false");
      }
    });

    // Фильтр по весу — debounce вместо мгновенного рендера на каждый ввод цифры:
    // печатать "150" по одной цифре не должно трижды перестраивать сетку.
    let weightFilterTimer = null;
    function onWeightInput(){
      clearTimeout(weightFilterTimer);
      weightFilterTimer = setTimeout(() => {
        const minEl = document.getElementById("weightMin");
        const maxEl = document.getElementById("weightMax");
        weightMin = minEl.value !== "" ? parseFloat(minEl.value) : null;
        weightMax = maxEl.value !== "" ? parseFloat(maxEl.value) : null;
        currentPage = 1;
        scrollThenRenderGrid();
      }, 400);
    }
    document.getElementById("weightMin").addEventListener("input", onWeightInput);
    document.getElementById("weightMax").addEventListener("input", onWeightInput);

    renderCategories();
    renderGrid();
  }

  const burgerBtn = document.getElementById("burgerBtn");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  let sidebarScrollLockY = 0;

  // Блокируем скролл фона через position:fixed на body (см. body.sidebar-open в
  // CSS), а не через overflow:hidden на html/body: прошлый вариант на Яндекс.Браузере
  // ломал прокрутку самого списка категорий внутри сайдбара. top:-Y запоминает
  // позицию страницы, при закрытии возвращаем её scrollTo.
  function openSidebarMobile(){
    sidebarScrollLockY = window.scrollY || document.documentElement.scrollTop;
    sidebar.classList.add("open");
    overlay.classList.add("show");
    burgerBtn.classList.add("open");
    document.body.classList.add("sidebar-open");
    document.body.style.top = `-${sidebarScrollLockY}px`;
  }
  function closeSidebarMobile(){
    if(window.innerWidth > 900) return;
    sidebar.classList.remove("open");
    overlay.classList.remove("show");
    burgerBtn.classList.remove("open");
    if (document.body.classList.contains("sidebar-open")) {
      document.body.classList.remove("sidebar-open");
      document.body.style.top = "";
      window.scrollTo(0, sidebarScrollLockY);
    }
  }

  burgerBtn.addEventListener("click", () => {
    if(sidebar.classList.contains("open")){
      closeSidebarMobile();
    } else {
      openSidebarMobile();
    }
  });
  overlay.addEventListener("click", closeSidebarMobile);
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900 && sidebar.classList.contains("open")) {
      // closeSidebarMobile при width>900 сразу return — снимаем лок вручную.
      sidebar.classList.remove("open");
      overlay.classList.remove("show");
      burgerBtn.classList.remove("open");
      if (document.body.classList.contains("sidebar-open")) {
        document.body.classList.remove("sidebar-open");
        document.body.style.top = "";
        window.scrollTo(0, sidebarScrollLockY);
      }
    }
  }, { passive:true });

  // CSS scroll-behavior:smooth не везде срабатывает (например, если в системе включена
  // экономия анимаций) — прокручиваем вручную через JS, так стабильнее на всех браузерах
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener("click", (e) => {
      const id = link.getAttribute("href").slice(1);
      const target = id ? document.getElementById(id) : null;
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // ===== КОРЗИНА =====
  // Хранится в localStorage браузера — не требует входа, чтобы добавлять товары можно
  // было сразу при просмотре каталога. Вход нужен только на шаге оформления заказа.
  const CART_KEY = "voronin_cart_v1";

  // localStorage — это данные, которые пользователь может отредактировать руками, поэтому
  // при загрузке приводим корзину к ожидаемой форме, а не доверяем содержимому. Строки
  // остаются строками (их всё равно экранируют перед вставкой в разметку), а вот размеры
  // и количество приводим к числам: они попадают и в размётку, и в заказ, и в арифметику
  // подсчёта веса — мусор здесь ломал бы итоги, а не только вид.
  function sanitizeCartItem(raw){
    if (!raw || typeof raw !== "object") return null;
    const sku = String(raw.sku ?? "").trim();
    if (!sku) return null;
    const qty = Math.max(1, Math.min(999, Math.floor(Number(raw.qty)) || 1));
    const toSize = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
    };
    return {
      sku,
      // Через тот же фильтр схем, что и каталог: в localStorage могло остаться что угодно,
      // включая javascript:/data: — в атрибут src такое попадать не должно.
      img: resolveImagePath(raw.img),
      weight: typeof raw.weight === "number" ? raw.weight : String(raw.weight ?? ""),
      qty,
      category: String(raw.category ?? ""),
      subcategory: String(raw.subcategory ?? ""),
      sizes: Array.isArray(raw.sizes) ? raw.sizes.slice(0, 999).map(toSize) : [],
      availableSizes: Array.isArray(raw.availableSizes)
        ? raw.availableSizes.map(toSize).filter(n => n !== null).slice(0, 60)
        : []
    };
  }

  function loadCart(){
    try {
      const parsed = JSON.parse(localStorage.getItem(CART_KEY));
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, 200).map(sanitizeCartItem).filter(Boolean);
    }
    catch(e){ return []; }
  }
  function saveCart(){
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartBadge();
  }
  let cart = loadCart();

  function updateCartBadge(){
    const badge = document.getElementById("cartBadge");
    const totalQty = cart.reduce((s, i) => s + i.qty, 0);
    if(totalQty > 0){ badge.textContent = totalQty; badge.style.display = "flex"; }
    else { badge.style.display = "none"; }
  }

  // Выбор размера показываем только для колец — обручальные и православные кольца
  // (у "Православные" в подкатегориях есть ещё и подвески, им размер не нужен), а внутри
  // "Гарнитуры" — только у колец по префиксу артикула (ка-/кл-), не у серёг из той же
  // подкатегории (са-/сл-) и не у прочих артикулов вроде кбн-/сбн- — их эта задача не касается.
  const RING_SIZES = Array.from({ length: 21 }, (_, i) => 14 + i * 0.5); // 14, 14.5, 15, ..., 24
  // Префиксы колец внутри "Гарнитуры". кбн добавлен вместе с парой кбн↔сбн: это тоже
  // кольцо, и такие же кбн-артикулы в обычной категории "Кольца" размер уже получают —
  // без этого один и тот же товар вёл бы себя по-разному в зависимости от раздела.
  const GARNITURY_RING_PREFIXES = ["ка", "кл", "кбн"];
  function isGarniturySkuRing(sku){
    const m = String(sku || "").toLowerCase().match(/^([а-я]+)-/);
    return !!m && GARNITURY_RING_PREFIXES.includes(m[1]);
  }
  function isRingItem(item){
    if(item.category === "koltsa" || item.category === "obruch") return true;
    if(item.category === "pravoslavie" && item.subcategory === "кольца") return true;
    if(item.category === "garnitury" && isGarniturySkuRing(item.sku)) return true;
    return false;
  }
  // Кольцо может продаваться не во всём диапазоне 14-24 — тогда админка задаёт свой список
  // в поле sizes товара. Пусто/не задано — обычный полный диапазон, как было всегда.
  function ringSizesFor(item){
    return Array.isArray(item.sizes) && item.sizes.length ? item.sizes : RING_SIZES;
  }

  // ===== ГАРНИТУРЫ: авто-объединение колец и серёг в пару по совпадающей части артикула =====
  // "С алмазной гранью": ка-XXX (кольцо) + са-XXX (серьги). "Со вставками": кл-XXX + сл-XXX.
  // Пара/тройка показывается одной карточкой; если совпадения нет — товар остаётся
  // обычной отдельной карточкой, как раньше. У "Со вставками" бывает ещё и третий элемент
  // комплекта — подвеска (пл-XXX): она совпадает по тому же суффиксу с кл-/сл-, но в базе
  // у неё почему-то не проставлена подкатегория, поэтому её ищем по всей категории
  // "Гарнитуры", а не только внутри "со вставками" (см. pendantPrefix и pendantBySuffix ниже).
  const GARNITURY_PAIR_RULES = [
    { subcategory: "с алмазной гранью", ringPrefix: "ка", earringPrefix: "са" },
    { subcategory: "с алмазной гранью", ringPrefix: "кбн", earringPrefix: "сбн" },
    { subcategory: "со вставками", ringPrefix: "кл", earringPrefix: "сл", pendantPrefix: "пл" }
  ];

  function garniturySkuSuffix(sku, prefix){
    const m = String(sku || "").toLowerCase().match(new RegExp(`^${prefix}-(.+)$`));
    return m ? m[1] : null;
  }

  // Строит sku -> { ring, earring, pendant } по ВСЕМУ каталогу (rawItems).
  // Кэш обязателен: getFiltered() зовёт это на каждый ввод в поиск / смену
  // категории / страницы — раньше карта собиралась заново каждый раз по ~427
  // товарам "Гарнитуры". Каталог статичен после loadCatalog, инвалидируем
  // только когда подменили rawItems.
  let garnituryPartnerMapCache = null;
  let garnituryPartnerMapSource = null;
  function buildGarnituryPartnerMap(){
    if (garnituryPartnerMapCache && garnituryPartnerMapSource === rawItems) {
      return garnituryPartnerMapCache;
    }

    const partnerOf = new Map();

    const pendantBySuffix = new Map();
    for (const item of rawItems) {
      if (item.category !== "garnitury") continue;
      const suffix = garniturySkuSuffix(item.sku, "пл");
      if (suffix) pendantBySuffix.set(suffix, item);
    }

    for (const rule of GARNITURY_PAIR_RULES) {
      const ringsBySuffix = new Map();
      const earringsBySuffix = new Map();
      for (const item of rawItems) {
        if (item.category !== "garnitury" || item.subcategory !== rule.subcategory) continue;
        const ringSuffix = garniturySkuSuffix(item.sku, rule.ringPrefix);
        if (ringSuffix) ringsBySuffix.set(ringSuffix, item);
        const earringSuffix = garniturySkuSuffix(item.sku, rule.earringPrefix);
        if (earringSuffix) earringsBySuffix.set(earringSuffix, item);
      }
      for (const [suffix, ring] of ringsBySuffix) {
        const earring = earringsBySuffix.get(suffix);
        if (!earring) continue;
        const pendant = rule.pendantPrefix ? (pendantBySuffix.get(suffix) || null) : null;
        const set = { ring, earring, pendant };
        partnerOf.set(ring.sku, set);
        partnerOf.set(earring.sku, set);
        if (pendant) partnerOf.set(pendant.sku, set);
      }
    }

    garnituryPartnerMapCache = partnerOf;
    garnituryPartnerMapSource = rawItems;
    return partnerOf;
  }

  // На входе — уже отфильтрованный и отсортированный список товаров. На выходе тот же
  // список, но там, где нашлась пара (или тройка с подвеской) кольцо+серьги, вместо
  // отдельных элементов идёт один псевдо-товар { isSet:true, ring, earring, pendant }.
  // Каждый исходный товар встречается в результате не больше одного раза, порядок
  // остальных элементов не меняется.
  function groupGarnituryPairs(items){
    // Карта "какому комплекту принадлежит артикул" строится по ВСЕМУ каталогу (rawItems),
    // а не по уже отфильтрованному `items`. Это принципиально: стоит отфильтровать список
    // поиском по одному артикулу (например "кбн-01") или подкатегорией — партнёр с другим
    // префиксом (сбн-01, либо подвеска без подкатегории) выпал бы из `items` ещё до
    // группировки, и комплект показался бы неполным. Здесь же комплект собирается один
    // раз и целиком, а видимость каждого куска по-прежнему решает обычная фильтрация
    // ниже — просто раз найдя один кусок комплекта в отфильтрованном списке, показываем
    // его целиком, с остальными кусками из полного каталога.
    const partnerOf = buildGarnituryPartnerMap();
    if (partnerOf.size === 0) return items; // обычный случай вне "Гарнитуры" — работа без изменений

    const result = [];
    const emitted = new Set();
    for (const item of items) {
      const set = partnerOf.get(item.sku);
      if (!set) { result.push(item); continue; }
      if (emitted.has(set.ring.sku)) continue; // остальные части комплекта уже выведены как часть первой
      emitted.add(set.ring.sku);
      const skuParts = [set.ring.sku, set.earring.sku, set.pendant && set.pendant.sku].filter(Boolean);
      result.push({ isSet: true, sku: skuParts.join(" + "), ring: set.ring, earring: set.earring, pendant: set.pendant });
    }
    return result;
  }

  // Если взяли, скажем, 3 одинаковых кольца — это может быть 3 разных размера
  // (на троих разных людей), поэтому у колец не один размер на позицию, а массив
  // sizes — по одному значению на каждую единицу товара. ensureSizes держит длину
  // массива синхронной с qty при любом изменении количества.
  function ensureSizes(item){
    if(!isRingItem(item)) return;
    if(!Array.isArray(item.sizes)) item.sizes = item.size ? [item.size] : [];
    // Новые единицы товара по умолчанию получают размер, выбранный на карточке каталога
    // (если он был выбран) — так после "+" в степпере не нужно сразу лезть в корзину,
    // чтобы проставить размер. Можно всё равно поправить отдельно в самой корзине.
    const fallbackSize = cardSelectedSize.get(item.sku) || null;
    while(item.sizes.length < item.qty) item.sizes.push(fallbackSize);
    while(item.sizes.length > item.qty) item.sizes.pop();
  }

  function addToCart(item){
    if(!item) return;
    const existing = cart.find(i => i.sku === item.sku);
    if(existing) existing.qty += 1;
    else cart.push({
      sku: item.sku, img: item.img, weight: item.weight, qty: 1,
      category: item.category, subcategory: item.subcategory, sizes: [],
      // Список размеров, которые вообще продаются для этого товара (обычный диапазон
      // 14-24 или свой список из админки) — нужен пикеру в самой корзине ниже.
      availableSizes: isRingItem(item) ? ringSizesFor(item) : []
    });
    const it = cart.find(i => i.sku === item.sku);
    ensureSizes(it);
    saveCart();
    refreshCardControl(item.sku);
  }
  function removeFromCart(sku){
    cart = cart.filter(i => i.sku !== sku);
    saveCart();
    renderCart();
    refreshCardControl(sku);
  }
  function changeQty(sku, delta){
    const it = cart.find(i => i.sku === sku);
    if(!it) return;
    it.qty += delta;
    if(it.qty <= 0) { cart = cart.filter(i => i.sku !== sku); }
    else { ensureSizes(it); }
    saveCart();
    renderCart();
    refreshCardControl(sku);
  }
  function changeSize(sku, index, size){
    const it = cart.find(i => i.sku === sku);
    if(!it) return;
    ensureSizes(it);
    it.sizes[index] = size ? Number(size) : null;
    saveCart();
  }

  function renderCart(){
    const list = document.getElementById("cartItemsList");
    const empty = document.getElementById("cartEmpty");
    const checkoutSection = document.getElementById("checkoutSection");

    if(cart.length === 0){
      list.innerHTML = "";
      empty.style.display = "block";
      checkoutSection.style.display = "none";
      return;
    }
    empty.style.display = "none";
    checkoutSection.style.display = "block";

    list.innerHTML = cart.map(i => `
      <div class="cart-item">
        <div class="cart-item-row">
          <img src="${escapeHtml(i.img)}" alt="${escapeHtml(i.sku)}">
          <div class="cart-item-info">
            <div class="cart-item-sku">${escapeHtml(i.sku)}</div>
            <div class="cart-item-weight">${i.weight ? escapeHtml(i.weight) + " гр." : ""}</div>
          </div>
          <div class="qty-control">
            <button type="button" data-action="dec" data-sku="${escapeHtml(i.sku)}">−</button>
            <span>${escapeHtml(i.qty)}</span>
            <button type="button" data-action="inc" data-sku="${escapeHtml(i.sku)}">+</button>
          </div>
          <button class="remove-item-btn" type="button" data-sku="${escapeHtml(i.sku)}" aria-label="Удалить" title="Удалить">&times;</button>
        </div>
        ${isRingItem(i) ? `
        <div class="cart-item-sizes">
          ${(i.sizes || []).map((sz, idx) => `
          <div class="cart-item-size">
            <label>${(i.sizes || []).length > 1 ? `Размер (кольцо ${idx + 1} из ${i.sizes.length})` : "Размер кольца"}</label>
            <div class="size-picker" data-sku="${escapeHtml(i.sku)}" data-idx="${idx}">
              <button type="button" class="size-picker-btn">${sz ? escapeHtml(sz) : "Выбрать"}</button>
              <div class="size-picker-grid">
                ${(i.availableSizes && i.availableSizes.length ? i.availableSizes : RING_SIZES).map(s => `<button type="button" class="size-chip${sz === s ? " active" : ""}" data-size="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
              </div>
            </div>
          </div>`).join("")}
        </div>` : ""}
      </div>
    `).join("");

    list.querySelectorAll('[data-action="inc"]').forEach(b => b.addEventListener("click", () => changeQty(b.dataset.sku, 1)));
    list.querySelectorAll('[data-action="dec"]').forEach(b => b.addEventListener("click", () => changeQty(b.dataset.sku, -1)));
    list.querySelectorAll(".remove-item-btn").forEach(b => b.addEventListener("click", () => removeFromCart(b.dataset.sku)));

    const totalQty = cart.reduce((s, i) => s + i.qty, 0);
    const totalWeight = cart.reduce((s, i) => s + (parseFloat(i.weight) || 0) * i.qty, 0);
    document.getElementById("cartTotal").textContent =
      `Итого: ${totalQty} шт.${totalWeight ? ", " + totalWeight.toFixed(2) + " гр." : ""}`;

    updateCheckoutUI();
  }

  const cartOverlay = document.getElementById("cartOverlay");
  document.getElementById("cartBtn").addEventListener("click", () => {
    renderCart();
    cartOverlay.classList.add("show");
  });
  document.getElementById("cartClose").addEventListener("click", () => cartOverlay.classList.remove("show"));
  cartOverlay.addEventListener("click", (e) => { if(e.target === cartOverlay) cartOverlay.classList.remove("show"); });

  // ===== УВЕДОМЛЕНИЯ (вместо системных alert()) =====
  // Иконки — обводкой, в тон сайту (золото/красный), а не цветные эмодзи-смайлы.
  const NOTICE_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="7.5" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>'
  };

  const noticeOverlay = document.getElementById("noticeOverlay");
  function showNotice(text, opts = {}){
    const type = opts.type || "success";
    const iconEl = document.getElementById("noticeIcon");
    iconEl.className = "notice-icon " + type;
    iconEl.innerHTML = NOTICE_ICONS[type] || NOTICE_ICONS.success;
    document.getElementById("noticeTitle").textContent = opts.title || "";
    document.getElementById("noticeText").textContent = text;
    noticeOverlay.classList.add("show");
  }
  document.getElementById("noticeClose").addEventListener("click", () => noticeOverlay.classList.remove("show"));
  document.getElementById("noticeOkBtn").addEventListener("click", () => noticeOverlay.classList.remove("show"));
  noticeOverlay.addEventListener("click", (e) => { if(e.target === noticeOverlay) noticeOverlay.classList.remove("show"); });

  // ===== PWA ОТКЛЮЧЁН =====
  // Кнопка установки и связанный UI убраны. Снимаем ранее зарегистрированный
  // service worker и ВСЕ Cache Storage (не только voronin-shell*): старые оболочки
  // могли кэшировать битый index/app под другими именами.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => reg.unregister());
    }).catch(() => {});
  }
  if (typeof caches !== "undefined" && caches.keys) {
    caches.keys().then((keys) => {
      keys.forEach((k) => caches.delete(k));
    }).catch(() => {});
  }

  // ===== УВЕЛИЧЕННОЕ ФОТО =====
  const lightboxOverlay = document.getElementById("lightboxOverlay");
  // Раньше img.src менялся сразу — но это не очищает то, что уже нарисовано в
  // <img>: браузер продолжает показывать СТАРЫЙ кадр (фото, открытое прошлый раз),
  // пока новый файл не декодирован, и только потом перерисовывает. Оверлей же
  // становится видимым сразу (у него свой opacity-переход), поэтому на долю
  // секунды было видно предыдущее фото вместо того, что открыли — не баг анимации,
  // а порядок операций. Фикс: декодируем новую картинку ЗАРАНЕЕ, в скрытом Image(),
  // и подставляем в видимый <img> и открываем оверлей только когда она уже готова
  // к отрисовке — тогда браузер рисует сразу нужный кадр. Почти всегда это тот же
  // файл, что и миниатюра в карточке, значит уже в кэше — decode() занимает
  // миллисекунды, не новый сетевой запрос.
  // decode() гарантирует, что байты картинки готовы, но НЕ гарантирует, что
  // браузер уже перерисовал именно этот <img> новым содержимым в тот же такт —
  // по спецификации присвоение .src элементу заводит новый "image request",
  // а не мгновенную синхронную замену кадра. На практике это иногда означает,
  // что на один кадр всё ещё виден предыдущий рисунок, даже после decode().
  // Поэтому после img.src ждём два кадра requestAnimationFrame (первый только
  // планирует перерисовку, второй наступает уже гарантированно после нее) и
  // только тогда открываем оверлей — до этого момента <img> невидим
  // (visibility:hidden у .modal-overlay), так что даже гипотетический
  // "старый кадр" просто некому увидеть.
  // Для локальных фото (images/itemsNNN.jpg) может существовать отдельная
  // HD-версия (images/itemsNNN-hd.jpg) — тот же кадр, прогнанный через
  // ИИ-апскейл (см. scripts/ai-upscale-batch.mjs), специально под лайтбокс:
  // обычный файл остаётся маленьким для сетки карточек, HD грузится только
  // здесь, только когда фото реально открывают. Обрабатывается не весь каталог
  // разом, поэтому HD-версия есть не у всех — если её нет (404), тихо
  // откатываемся на обычный файл, без ошибки на экране.
  function hdVariant(src){
    const m = /^(images\/items\d+)\.jpg$/i.exec(src);
    return m ? `${m[1]}-hd.jpg` : null;
  }

  // decode() гарантирует готовые байты, но не факт, что браузер уже перерисовал
  // этот <img> — resolve только после факта, а не раньше.
  function preloadDecode(src){
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = src;
      if (typeof img.decode === "function") {
        img.decode().then(() => resolve(img)).catch(reject);
      } else {
        img.onload = () => resolve(img);
        img.onerror = reject;
      }
    });
  }

  // decode() у свёрнутой/неактивной вкладки браузер может не тронуть вовсе —
  // ни resolve, ни reject, просто бесконечно висит (нашёл при проверке). Без
  // таймаута весь openLightbox застревал бы навсегда, и лайтбокс не открылся
  // бы. Таймаут не про качество сети — это защита от зависания как класса.
  function preloadDecodeWithTimeout(src, ms){
    return Promise.race([
      preloadDecode(src),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
    ]);
  }

  let lightboxRequestId = 0;
  async function openLightbox(src, alt){
    if(!src) return;
    const img = document.getElementById("lightboxImg");
    const requestId = ++lightboxRequestId;

    const hd = hdVariant(src);
    let finalSrc = src;
    if (hd) {
      try { await preloadDecodeWithTimeout(hd, 4000); finalSrc = hd; }
      catch { /* HD ещё не сделан для этого фото (или не успел за 4с) — остаёмся на обычном src */ }
    }
    try { await preloadDecodeWithTimeout(finalSrc, 4000); } catch { /* ниже всё равно попробуем показать */ }

    if (requestId !== lightboxRequestId) return; // успели открыть другое фото — это устарело
    img.src = finalSrc;
    img.alt = alt || "";
    // Присвоение .src — новый "image request" по спецификации, не гарантированно
    // мгновенная перерисовка даже после decode(). Два кадра rAF — до реальной
    // отрисовки, оверлей открываем только после неё (см. историю правок).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (requestId !== lightboxRequestId) return;
        lightboxOverlay.classList.add("show");
      });
    });
  }
  document.getElementById("lightboxClose").addEventListener("click", () => lightboxOverlay.classList.remove("show"));
  lightboxOverlay.addEventListener("click", (e) => { if(e.target === lightboxOverlay) lightboxOverlay.classList.remove("show"); });

  // ===== АККАУНТ ПОКУПАТЕЛЯ (Firebase Auth) =====
  let currentUser = null;
  const authOverlay = document.getElementById("authOverlay");
  let authMode = "login";

  function bindAuthStateListener() {
    if (!firebaseAvailable || !auth) return;
    onAuthStateChanged(auth, async (user) => {
    // Сессия могла остаться с прошлого раза (Firebase хранит вход между визитами) —
    // если почта так и не подтверждена, не считаем человека вошедшим.
    //
    // user.emailVerified — это то, что было в токене на момент его последнего обновления,
    // а не обязательно самая свежая правда: например, человек мог подтвердить почту минуту
    // назад в другой вкладке, и здесь при загрузке страницы ещё лежит старое значение.
    // Раньше это сразу вело к signOut() — то есть уже подтверждённого покупателя могло
    // выкинуть просто из-за не успевшего обновиться кэша, да ещё и без сети (VPN/прокси)
    // reload() тоже упал бы, и тогда signOut() случился бы совсем зря, по сбою, а не по делу.
    // Поэтому сначала перечитываем токен и разлогиниваем только если после этого
    // подтверждение почты ДЕЙСТВИТЕЛЬНО не пройдено. Если сеть подвела и перечитать не
    // удалось — не гадаем, оставляем сессию как есть: реальную защиту всё равно обеспечивает
    // не это, а isVerified() в firestore.rules на сервере, значит клиентская проверка
    // здесь только для интерфейса и не обязана быть категоричной при сбое.
    if(user && !user.emailVerified){
      let reloadedOk = true;
      try {
        await user.reload();
      } catch(err) {
        reloadedOk = false; // сеть подвела — ниже это учитываем, а не притворяемся, что перечитали
        console.error("Не удалось обновить статус подтверждения почты (сеть?):", err);
      }
      // Разлогиниваем только когда действительно ЗНАЕМ актуальный статус (reload прошёл)
      // и он по-прежнему "не подтверждено". Если reload не удался — не решаем вслепую.
      if(reloadedOk && auth.currentUser && !auth.currentUser.emailVerified){
        await signOut(auth);
        return;
      }
    }
    currentUser = auth.currentUser;
    const accountBtn = document.getElementById("accountBtn");
    // Имя показываем, если его указали при регистрации; для старых аккаунтов без имени — email как раньше
    const displayLabel = currentUser ? (currentUser.displayName || currentUser.email) : "";
    accountBtn.title = currentUser ? `Вы вошли как ${displayLabel}` : "Войти";
    accountBtn.classList.toggle("logged-in", !!currentUser);
    document.getElementById("accountDot").classList.toggle("show", !!currentUser);
    document.getElementById("accountMenuEmail").textContent = displayLabel;
    if(!currentUser) document.getElementById("accountMenu").classList.remove("show");
    updateCheckoutUI();
    });
  }

  function updateCheckoutUI(){
    const loggedOut = document.getElementById("checkoutLoggedOut");
    const loggedIn = document.getElementById("checkoutLoggedIn");
    if(!loggedOut) return;
    loggedOut.style.display = currentUser ? "none" : "block";
    loggedIn.style.display = currentUser ? "block" : "none";
  }

  document.getElementById("accountBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    if(currentUser){
      document.getElementById("accountMenu").classList.toggle("show");
    } else {
      if(!firebaseAvailable){
        showNotice(FIREBASE_UNAVAILABLE_MSG, { title: "Вход недоступен", type: "error" });
        return;
      }
      openAuthModal("login");
    }
  });
  document.getElementById("accountLogoutBtn").addEventListener("click", () => {
    if(firebaseAvailable && auth) signOut(auth);
    document.getElementById("accountMenu").classList.remove("show");
  });
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("accountMenu");
    if(menu.classList.contains("show") && !e.target.closest(".account-wrap")){
      menu.classList.remove("show");
    }
  });
  document.getElementById("checkoutLoginBtn").addEventListener("click", () => {
    cartOverlay.classList.remove("show");
    if(!firebaseAvailable){
      showNotice(FIREBASE_UNAVAILABLE_MSG, { title: "Вход недоступен", type: "error" });
      return;
    }
    openAuthModal("login");
  });

  function openAuthModal(mode){
    // Одновременно должно быть открыто только одно модальное окно — если открывали
    // восстановление пароля, закрываем его, иначе оба окна оказались бы видны разом.
    resetOverlay.classList.remove("show");
    authMode = mode;
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === mode));
    document.getElementById("authSubmitBtn").textContent = mode === "login" ? "Войти" : "Зарегистрироваться";
    document.getElementById("authNameGroup").style.display = mode === "register" ? "block" : "none";
    document.getElementById("forgotPasswordBtn").style.display = mode === "login" ? "block" : "none";
    document.getElementById("authError").style.display = "none";
    authOverlay.classList.add("show");
  }
  document.getElementById("authClose").addEventListener("click", () => authOverlay.classList.remove("show"));
  authOverlay.addEventListener("click", (e) => { if(e.target === authOverlay) authOverlay.classList.remove("show"); });
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => openAuthModal(tab.dataset.tab));
  });

  const AUTH_ERROR_MESSAGES = {
    "auth/invalid-email": "Некорректный email",
    "auth/user-not-found": "Пользователь не найден",
    "auth/wrong-password": "Неверный пароль",
    "auth/invalid-credential": "Неверный email или пароль",
    "auth/email-already-in-use": "Этот email уже зарегистрирован — попробуйте войти",
    "auth/weak-password": "Пароль слишком короткий (минимум 6 символов)"
  };

  document.getElementById("authSubmitBtn").addEventListener("click", async () => {
    const email = document.getElementById("authEmailInput").value.trim();
    const pass = document.getElementById("authPasswordInput").value;
    const name = document.getElementById("authNameInput").value.trim();
    const errEl = document.getElementById("authError");
    const submitBtn = document.getElementById("authSubmitBtn");
    errEl.style.display = "none";

    if(!firebaseAvailable || !auth){
      errEl.textContent = FIREBASE_UNAVAILABLE_MSG;
      errEl.style.display = "block";
      return;
    }

    if(!email || !pass){
      errEl.textContent = "Заполните email и пароль";
      errEl.style.display = "block";
      return;
    }
    if(authMode === "register" && !name){
      errEl.textContent = "Укажите, как к вам обращаться";
      errEl.style.display = "block";
      return;
    }

    try {
      submitBtn.disabled = true;

      if(authMode === "register") {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await updateProfile(cred.user, { displayName: name });
        await sendEmailVerification(cred.user, actionCodeSettings);
        // Не оставляем вошедшим сразу после регистрации — вход разрешаем только
        // после того, как человек перейдёт по ссылке из письма и подтвердит почту.
        await signOut(auth);

        authOverlay.classList.remove("show");
        document.getElementById("authNameInput").value = "";
        document.getElementById("authEmailInput").value = "";
        document.getElementById("authPasswordInput").value = "";
        showNotice(`На ${email} отправлено письмо для подтверждения почты. Перейдите по ссылке из письма, затем войдите.`, { title: "Регистрация успешна!", type: "success" });
        return;
      }

      // Вход
      const cred = await signInWithEmailAndPassword(auth, email, pass);
      if(!cred.user.emailVerified){
        await signOut(auth);
        errEl.textContent = "Сначала подтвердите почту по ссылке из письма, потом войдите.";
        errEl.style.display = "block";
        return;
      }

      authOverlay.classList.remove("show");
      document.getElementById("authNameInput").value = "";
      document.getElementById("authEmailInput").value = "";
      document.getElementById("authPasswordInput").value = "";
      renderCart();
      if(cart.length > 0) cartOverlay.classList.add("show");
    } catch(err) {
      errEl.textContent = AUTH_ERROR_MESSAGES[err.code] || err.message;
      errEl.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ===== ВОССТАНОВЛЕНИЕ ПАРОЛЯ =====
  // Отдельное окно, а не переиспользование поля email из входа/регистрации. Раньше
  // "Забыли пароль?" сразу отправляло письмо на то, что уже было в общем поле —
  // выглядело так, будто адрес зашит заранее и его нельзя изменить, а окно уведомления
  // при этом оставалось поверх ещё открытого окна входа. Теперь это два чётких шага:
  // ввод email в своей форме → явный клик "Отправить" → и только после успеха —
  // экран подтверждения с кнопкой возврата ко входу.
  const resetOverlay = document.getElementById("resetOverlay");
  const resetEmailInput = document.getElementById("resetEmailInput");
  const resetSubmitBtn = document.getElementById("resetSubmitBtn");
  const resetError = document.getElementById("resetError");

  function isValidEmail(value){
    // Разметка type="email" уже что-то проверяет сама, но валидность сабмита не должна
    // зависеть от того, поддерживает ли конкретный браузер встроенную проверку.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function openResetModal(){
    authOverlay.classList.remove("show"); // одновременно открыто только одно окно
    document.getElementById("resetFormStep").style.display = "block";
    document.getElementById("resetSuccessStep").style.display = "none";
    resetError.style.display = "none";
    resetEmailInput.value = "";
    resetSubmitBtn.disabled = true;
    resetOverlay.classList.add("show");
  }

  document.getElementById("forgotPasswordBtn").addEventListener("click", openResetModal);
  document.getElementById("resetClose").addEventListener("click", () => resetOverlay.classList.remove("show"));
  resetOverlay.addEventListener("click", (e) => { if(e.target === resetOverlay) resetOverlay.classList.remove("show"); });

  // Кнопка активна, только когда в поле — похожий на email текст, а не с первого символа
  resetEmailInput.addEventListener("input", () => {
    resetSubmitBtn.disabled = !isValidEmail(resetEmailInput.value.trim());
  });

  const RESET_ERROR_MESSAGES = {
    "auth/invalid-email": "Некорректный email — проверьте написание.",
    "auth/user-not-found": "Мы не нашли аккаунт с таким email.",
    "auth/too-many-requests": "Слишком много попыток подряд. Подождите немного и попробуйте снова.",
    "auth/network-request-failed": "Не удалось связаться с сервером — проверьте соединение с интернетом."
  };

  resetSubmitBtn.addEventListener("click", async () => {
    const email = resetEmailInput.value.trim();
    if(!isValidEmail(email)) return; // кнопка и так недоступна без валидного email, это подстраховка
    resetError.style.display = "none";

    if(!firebaseAvailable || !auth){
      resetError.textContent = FIREBASE_UNAVAILABLE_MSG;
      resetError.style.display = "block";
      return;
    }

    const originalLabel = resetSubmitBtn.textContent;
    try {
      resetSubmitBtn.disabled = true;
      resetSubmitBtn.innerHTML = `<span class="btn-spinner"></span>Отправляем…`;
      await sendPasswordResetEmail(auth, email, actionCodeSettings);

      document.getElementById("resetFormStep").style.display = "none";
      document.getElementById("resetSuccessStep").style.display = "block";
    } catch(err) {
      resetError.textContent = RESET_ERROR_MESSAGES[err.code] || err.message;
      resetError.style.display = "block";
    } finally {
      resetSubmitBtn.disabled = !isValidEmail(resetEmailInput.value.trim());
      resetSubmitBtn.textContent = originalLabel;
    }
  });

  document.getElementById("resetBackToLoginBtn").addEventListener("click", () => {
    resetOverlay.classList.remove("show");
    openAuthModal("login");
  });

  // ===== УВЕДОМЛЕНИЕ В TELEGRAM =====
  // Папа получает сообщение о заказе мгновенно в Telegram, а не только видит его
  // в разделе "Заказы" в /admin/, когда туда зайдёт.
  //
  // ВАЖНО, почему здесь нет токена бота. Раньше токен и chat_id были вписаны прямо
  // в этот файл — а он открыт всему интернету (Ctrl+U на сайте, плюс исходники на
  // GitHub). С таким токеном посторонний может писать от имени бота, читать всё, что
  // ему пишут, и вообще увести бота себе. Любой ключ, попавший в код страницы, —
  // это ключ, отданный публике; спрятать его на статическом сайте нельзя в принципе.
  // Поэтому токен переехал в Cloudflare Worker (папка worker/), а браузер обращается
  // к нему и предъявляет токен входа Firebase. Воркер сам проверяет, что человек
  // действительно вошёл и подтвердил почту, и сам собирает текст сообщения.
  //
  // Пока адрес воркера не прописан (RELAY_URL в config.js), отправка тихо пропускается —
  // заказ при этом всё равно сохраняется в Firestore и виден в /admin/, ничего не теряется.
  async function notifyTelegram(order){
    const relay = relayUrl();
    if(!relay || !currentUser) return;
    try {
      const idToken = await currentUser.getIdToken();
      await fetch(`${relay}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          order: {
            name: order.name,
            phone: order.phone,
            comment: order.comment,
            items: order.items
          }
        })
      });
    } catch(err) {
      console.error("Не удалось отправить уведомление в Telegram:", err);
    }
  }

  // ===== ОФОРМЛЕНИЕ ЗАКАЗА =====
  // Заказ пишем в коллекцию Firestore "orders" — папа смотрит и обрабатывает их
  // в отдельном разделе "Заказы" в панели администратора (/admin/), плюс сразу
  // получает уведомление в Telegram (см. notifyTelegram выше).
  document.getElementById("submitOrderBtn").addEventListener("click", async () => {
    if(!currentUser || cart.length === 0) return;
    const btn = document.getElementById("submitOrderBtn");
    const phoneInput = document.getElementById("orderPhone");
    const phone = phoneInput.value.trim();
    const comment = document.getElementById("orderComment").value.trim();

    if(!firebaseAvailable || !db){
      showNotice(FIREBASE_UNAVAILABLE_MSG, { title: "Заказ недоступен", type: "error" });
      return;
    }

    if(!phone){
      phoneInput.classList.add("invalid");
      document.getElementById("orderPhoneError").style.display = "block";
      phoneInput.focus();
      return;
    }
    phoneInput.classList.remove("invalid");
    document.getElementById("orderPhoneError").style.display = "none";

    const missingSize = cart.find(i => isRingItem(i) && (i.sizes || []).some(s => !s));
    if(missingSize){
      showNotice(`Укажите размер для товара ${missingSize.sku}, прежде чем оформить заказ.`, { title: "Не указан размер кольца", type: "error" });
      return;
    }

    const orderData = {
      uid: currentUser.uid,
      email: currentUser.email,
      name: currentUser.displayName || "",
      phone,
      comment,
      items: cart.map(i => ({ sku: i.sku, weight: i.weight, qty: i.qty, sizes: isRingItem(i) ? (i.sizes || []) : null })),
      status: "new",
      createdAt: serverTimestamp()
    };

    try {
      btn.disabled = true;
      btn.textContent = "Отправляю...";
      await addDoc(collection(db, "orders"), orderData);
      notifyTelegram(orderData);

      cart = [];
      saveCart();
      renderCart();
      document.getElementById("orderPhone").value = "";
      document.getElementById("orderComment").value = "";
      cartOverlay.classList.remove("show");
      showNotice("Мы свяжемся с вами по указанному телефону.", { title: "Заказ отправлен!", type: "success" });
    } catch(err) {
      showNotice(err.message, { title: "Не удалось отправить заказ", type: "error" });
    } finally {
      btn.disabled = false;
      btn.textContent = "Отправить заказ";
    }
  });

  // ===== ВЫБОР РАЗМЕРА КОЛЬЦА: компактная сетка вместо длинного нативного <select> =====
  // Один делегированный обработчик на всю корзину — работает даже после
  // renderCart() перерисовывает список (не нужно навешивать заново).
  document.getElementById("cartItemsList").addEventListener("click", (e) => {
    const chip = e.target.closest(".size-chip");
    if(chip){
      const picker = chip.closest(".size-picker");
      changeSize(picker.dataset.sku, Number(picker.dataset.idx), chip.dataset.size);
      renderCart();
      return;
    }
    const trigger = e.target.closest(".size-picker-btn");
    if(trigger){
      const picker = trigger.closest(".size-picker");
      const wasOpen = picker.classList.contains("open");
      document.querySelectorAll(".size-picker.open").forEach(p => p.classList.remove("open"));
      if(!wasOpen){
        picker.classList.add("open");
        positionSizePickerGrid(picker, trigger);
      }
    }
  });
  document.addEventListener("click", (e) => {
    if(!e.target.closest(".size-picker")){
      document.querySelectorAll(".size-picker.open").forEach(p => p.classList.remove("open"));
    }
  });
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape"){
      document.querySelectorAll(".modal-overlay.show").forEach(o => o.classList.remove("show"));
    }
  });

  // ===== ФОКУС-ЛОВУШКА ДЛЯ МОДАЛОК (клавиатурная доступность) =====
  // Работает через MutationObserver за классом "show" — не нужно трогать
  // десяток мест, где корзина/авторизация/лайтбокс/уведомление открываются
  // и закрываются. При открытии: фокус уходит внутрь модалки, Tab/Shift+Tab
  // не выходят за её пределы. При закрытии: фокус возвращается туда, откуда
  // модалку открыли (обычно — на кнопку, по которой кликнули).
  function getFocusable(container){
    return Array.from(container.querySelectorAll(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
  }

  const modalFocusState = new Map();

  function onModalOpened(overlay){
    const state = { returnEl: document.activeElement, keydownHandler: null };
    modalFocusState.set(overlay, state);

    const focusables = getFocusable(overlay);
    if(focusables.length) focusables[0].focus();

    state.keydownHandler = (e) => {
      if(e.key !== "Tab") return;
      const items = getFocusable(overlay);
      if(items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    };
    overlay.addEventListener("keydown", state.keydownHandler);
  }

  function onModalClosed(overlay){
    const state = modalFocusState.get(overlay);
    if(!state) return;
    overlay.removeEventListener("keydown", state.keydownHandler);
    if(state.returnEl && document.contains(state.returnEl)) state.returnEl.focus();
    modalFocusState.delete(overlay);
  }

  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    new MutationObserver(() => {
      if(overlay.classList.contains("show")) onModalOpened(overlay);
      else onModalClosed(overlay);
    }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
  });

  // Кнопка "Повторить попытку" в блоке ошибки загрузки. Раньше это был инлайновый
  // onclick прямо в разметке — такой код запрещает Content-Security-Policy, поэтому
  // обработчик переехал сюда.
  document.getElementById("retryLoadBtn").addEventListener("click", () => window.location.reload());

  updateCartBadge();
  // Каталог — сразу, без ожидания Google/Firebase. Иначе при блокировке gstatic
  // половина клиентов видит «вечную загрузку» или пустую страницу.
  loadCatalog();
  initFirebase()
    .then(() => { bindAuthStateListener(); })
    .catch((err) => {
      console.error("Firebase недоступен — каталог работает без входа/заказов:", err);
      firebaseAvailable = false;
    });
