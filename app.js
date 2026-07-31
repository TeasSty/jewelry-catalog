  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
  import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
  import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, sendEmailVerification, updateProfile, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
  import { firebaseConfig, relayUrl } from "./config.js";

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const auth = getAuth(app);

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
      createdAt: toMillis(data.createdAt)
    };
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
            renderGrid();
            scrollToCatalogTop();
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
          renderGrid();
          scrollToCatalogTop();
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
            
            renderGrid();
            scrollToCatalogTop();
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

          renderGrid();
          scrollToCatalogTop();
          closeSidebarMobile();
        });
      }
    });
  }

  function getFiltered(){
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

  // При смене категории список мог быть проскроллен вниз — возвращаем к началу каталога,
  // иначе новая категория открывается "с середины". При смене одной страницы (пагинация)
  // это делает сам обработчик пагинации отдельно.
  function scrollToCatalogTop(){
    document.getElementById("catalog").scrollIntoView({behavior:"smooth", block:"start"});
  }

  function renderGrid(){
    const filtered = getFiltered();
    const grid = document.getElementById("productGrid");
    const empty = document.getElementById("emptyState");
    const resultCount = document.getElementById("resultCount");

    resultCount.textContent = filtered.length + (filtered.length === 1 ? " товар" : " товаров");

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
    grid.innerHTML = pageItems.map(item => `
      <div class="card">
        <div class="card-img" data-img="${escapeHtml(item.img)}">
          <img src="${escapeHtml(item.img)}" alt="${escapeHtml(item.sku)}" loading="lazy">
        </div>
        <div class="card-body">
          <div class="card-sku">${escapeHtml(item.sku)}</div>
          <div class="card-bottom-row">
            <div class="card-weight">${escapeHtml(item.weight)} гр.</div>
            <div class="card-control" data-sku="${escapeHtml(item.sku)}">${cartControlHtml(item.sku)}</div>
          </div>
        </div>
      </div>
    `).join("");

    renderPagination(totalPages);
  }

  // Иконка "добавить" или степпер количества внутри карточки — в зависимости от того,
  // сколько этого товара уже в корзине сейчас
  function cartControlHtml(sku){
    const qty = getCartQty(sku);
    // Артикул экранируем, хотя рядом (в renderGrid) он уже экранирован: эта функция
    // вызывается ещё и из refreshCardControl, где на входе артикул "как есть" из корзины.
    const safeSku = escapeHtml(sku);
    if(qty > 0){
      return `
        <div class="card-qty">
          <button type="button" data-action="dec" data-sku="${safeSku}">−</button>
          <span>${escapeHtml(qty)}</span>
          <button type="button" data-action="inc" data-sku="${safeSku}">+</button>
        </div>`;
    }
    return `
      <button class="add-cart-btn" data-sku="${safeSku}" type="button" aria-label="В корзину" title="В корзину">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="9.5" y1="10.5" x2="14.5" y2="10.5"/></svg>
      </button>`;
  }

  function refreshCardControl(sku){
    // Артикул подставляется в CSS-селектор, поэтому кавычка или скобка в нём уронила бы
    // querySelectorAll с исключением (корзина переставала бы обновляться). Сравниваем
    // значения напрямую — селектор строить из данных вообще не нужно.
    document.querySelectorAll(".card-control").forEach(el => {
      if(el.dataset.sku === sku) el.innerHTML = cartControlHtml(sku);
    });
  }

  function getCartQty(sku){
    const it = cart.find(i => i.sku === sku);
    return it ? it.qty : 0;
  }

  // Товары текущей страницы — нужны, чтобы клик по иконке "в корзину" знал вес/фото товара.
  // Обработчик один, назначен на #productGrid один раз (см. ниже), а не при каждом рендере.
  let currentPageItems = [];

  document.getElementById("productGrid").addEventListener("click", (e) => {
    const addBtn = e.target.closest(".add-cart-btn");
    if(addBtn){
      const item = currentPageItems.find(i => i.sku === addBtn.dataset.sku);
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
          renderGrid();
          document.getElementById("catalog").scrollIntoView({behavior:"smooth", block:"start"});
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

      renderGrid();
      scrollToCatalogTop();
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

      renderGrid();
      scrollToCatalogTop();
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

    renderCategories();
    renderGrid();
  }

  const burgerBtn = document.getElementById("burgerBtn");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");

  function openSidebarMobile(){
    sidebar.classList.add("open");
    overlay.classList.add("show");
    burgerBtn.classList.add("open");
  }
  function closeSidebarMobile(){
    if(window.innerWidth > 900) return;
    sidebar.classList.remove("open");
    overlay.classList.remove("show");
    burgerBtn.classList.remove("open");
  }

  burgerBtn.addEventListener("click", () => {
    if(sidebar.classList.contains("open")){
      closeSidebarMobile();
    } else {
      openSidebarMobile();
    }
  });
  overlay.addEventListener("click", closeSidebarMobile);

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

  function loadCart(){
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
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
  // (у "Православные" в подкатегориях есть ещё и подвески, им размер не нужен).
  const RING_SIZES = Array.from({ length: 21 }, (_, i) => 14 + i * 0.5); // 14, 14.5, 15, ..., 24
  function isRingItem(item){
    if(item.category === "koltsa" || item.category === "obruch") return true;
    if(item.category === "pravoslavie" && item.subcategory === "кольца") return true;
    return false;
  }

  // Если взяли, скажем, 3 одинаковых кольца — это может быть 3 разных размера
  // (на троих разных людей), поэтому у колец не один размер на позицию, а массив
  // sizes — по одному значению на каждую единицу товара. ensureSizes держит длину
  // массива синхронной с qty при любом изменении количества.
  function ensureSizes(item){
    if(!isRingItem(item)) return;
    if(!Array.isArray(item.sizes)) item.sizes = item.size ? [item.size] : [];
    while(item.sizes.length < item.qty) item.sizes.push(null);
    while(item.sizes.length > item.qty) item.sizes.pop();
  }

  function addToCart(item){
    if(!item) return;
    const existing = cart.find(i => i.sku === item.sku);
    if(existing) existing.qty += 1;
    else cart.push({ sku: item.sku, img: item.img, weight: item.weight, qty: 1, category: item.category, subcategory: item.subcategory, sizes: [] });
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
              <button type="button" class="size-picker-btn">${sz ? sz : "Выбрать"}</button>
              <div class="size-picker-grid">
                ${RING_SIZES.map(s => `<button type="button" class="size-chip${sz === s ? " active" : ""}" data-size="${s}">${s}</button>`).join("")}
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

  // ===== УВЕЛИЧЕННОЕ ФОТО =====
  const lightboxOverlay = document.getElementById("lightboxOverlay");
  function openLightbox(src, alt){
    if(!src) return;
    const img = document.getElementById("lightboxImg");
    img.src = src;
    img.alt = alt || "";
    lightboxOverlay.classList.add("show");
  }
  document.getElementById("lightboxClose").addEventListener("click", () => lightboxOverlay.classList.remove("show"));
  lightboxOverlay.addEventListener("click", (e) => { if(e.target === lightboxOverlay) lightboxOverlay.classList.remove("show"); });

  // ===== АККАУНТ ПОКУПАТЕЛЯ (Firebase Auth) =====
  let currentUser = null;
  const authOverlay = document.getElementById("authOverlay");
  let authMode = "login";

  onAuthStateChanged(auth, (user) => {
    // Сессия могла остаться с прошлого раза (Firebase хранит вход между визитами) —
    // если почта так и не подтверждена, не считаем человека вошедшим.
    if(user && !user.emailVerified){
      signOut(auth);
      return;
    }
    currentUser = user;
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
      openAuthModal("login");
    }
  });
  document.getElementById("accountLogoutBtn").addEventListener("click", () => {
    signOut(auth);
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
    openAuthModal("login");
  });

  function openAuthModal(mode){
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
        await sendEmailVerification(cred.user);
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

  document.getElementById("forgotPasswordBtn").addEventListener("click", async () => {
    const email = document.getElementById("authEmailInput").value.trim();
    const errEl = document.getElementById("authError");
    errEl.style.display = "none";

    if(!email){
      errEl.textContent = "Введите email, на который зарегистрирован аккаунт";
      errEl.style.display = "block";
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      showNotice(`На ${email} отправлена ссылка для восстановления пароля.`, { title: "Письмо отправлено", type: "success" });
    } catch(err) {
      errEl.textContent = AUTH_ERROR_MESSAGES[err.code] || err.message;
      errEl.style.display = "block";
    }
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
        // position:fixed — считаем координаты сами, иначе прокручиваемая корзина обрежет попап
        const rect = trigger.getBoundingClientRect();
        const grid = picker.querySelector(".size-picker-grid");
        const gridWidth = 184;
        grid.style.top = (rect.bottom + 6) + "px";
        grid.style.left = Math.max(8, rect.right - gridWidth) + "px";
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
  loadCatalog();
