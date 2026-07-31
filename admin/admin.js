  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
  import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
  import {
    getFirestore,
    collection,
    doc,
    getDoc,
    setDoc,
    deleteDoc,
    getDocs,
    query,
    orderBy,
    limit,
    updateDoc,
    serverTimestamp
  } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
  import { firebaseConfig, relayUrl } from "../config.js";

  // Панель не должна открываться внутри чужого <iframe>: иначе посторонний сайт может
  // накрыть её прозрачным слоем и подловить клик по "Удалить" (кликджекинг). Полноценно
  // это лечится заголовком frame-ancestors, но GitHub Pages свои заголовки ставить не даёт,
  // поэтому вырываемся из фрейма сами, до отрисовки чего-либо.
  if (window.top !== window.self) {
    document.documentElement.innerHTML = "";
    window.top.location = window.self.location;
    throw new Error("Панель администратора не работает во фрейме");
  }

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const CATEGORY_NAMES = {
    koltsa: "Кольца", obruch: "Обручальные", sergi: "Серьги", garnitury: "Гарнитуры",
    podveski: "Подвески", kolie: "Колье", braslety: "Браслеты", piercing: "Пирсинг",
    tsepi: "Цепи/Браслеты (ручная работа)", lozhki: "Ложки", broshi: "Броши",
    pravoslavie: "Православные", vostok: "Восток", raznoe: "Разное"
  };

  // Должно совпадать с подкатегориями в index.html — иначе фильтры на сайте и выбор в админке расходятся
  const subcatMap = {
    obruch: ["Гладкие", "С алмазной гранью"],
    sergi: ["Шары", "Конго", "Продевки", "Детские"],
    garnitury: ["С алмазной гранью", "Со вставками"],
    podveski: ["Зодиак"],
    pravoslavie: ["Кольца", "Подвески"]
  };

  // ===== Вкладки: Заказы (по умолчанию) / Редактор товаров =====
  document.querySelectorAll(".admin-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".admin-panel").forEach(p => {
        p.style.display = p.dataset.panel === tab.dataset.tab ? "block" : "none";
      });
    });
  });

  // Текущее фото товара при редактировании — как оно РЕАЛЬНО хранится в базе (может быть
  // просто "items3139.jpg" без "images/" — так писали старые товары с исходного сайта).
  // Пустая строка — фото не выбрано/не установлено.
  let currentImageValue = "";

  // То же самое, что resolveImagePath в app.js, плюс blob: — он нужен только здесь, для
  // превью выбранного файла до его отправки (URL.createObjectURL). Остальные схемы
  // (data:, голый http:, чужой домен) отбрасываем так же, как на сайте: значение уходит
  // в атрибут src, и пропускать туда произвольную схему из базы незачем.
  function resolveImagePathForPreview(raw) {
    const path = String(raw || "").trim();
    if (!path) return "";
    if (/^https:\/\//i.test(path) || path.startsWith("blob:")) return path;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return "";
    const clean = path.replace(/^\/+/, "");
    const rel = clean.startsWith("images/") ? clean : "images/" + clean;
    // Панель живёт в /admin/, а папка с фото — в корне сайта, рядом с index.html.
    // Относительный "images/x.jpg" браузер отсчитывает от текущей страницы и ищет
    // /admin/images/x.jpg — то есть фото просто не находились (404) ни в превью
    // товара, ни в карточках заказов. "../" поднимает на уровень выше и одинаково
    // работает и когда сайт лежит в корне домена, и когда он в подкаталоге
    // (абсолютный "/images/..." во втором случае сломался бы).
    return "../" + rel;
  }

  function setImagePreview(rawValue) {
    const img = document.getElementById("imagePreview");
    const empty = document.getElementById("imagePreviewEmpty");
    const url = resolveImagePathForPreview(rawValue);
    if (url) {
      img.src = url;
      img.style.display = "block";
      empty.style.display = "none";
    } else {
      img.style.display = "none";
      empty.style.display = "block";
    }
  }

  // Показываем превью сразу после выбора файла, не дожидаясь загрузки на сервер
  document.getElementById("imageFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) setImagePreview(URL.createObjectURL(file));
  });

  // Фото хранятся на ImgBB (Firebase Storage требует платный план Blaze, а он недоступен).
  // Ключ ImgBB раньше лежал прямо в этом файле — то есть был виден каждому, кто открыл
  // исходники страницы или репозиторий, и позволял постороннему заливать что угодно
  // в аккаунт. Теперь файл уходит в Cloudflare Worker (папка worker/): ключ лежит там
  // секретом, а воркер сам проверяет по документу admins/<uid>, что загружает админ.
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

  async function uploadImage(file) {
    const relay = relayUrl();
    if (!relay) {
      throw new Error(
        "Загрузка фото не настроена: пропишите адрес воркера в RELAY_URL (config.js). " +
        "См. SECURITY.md, раздел «Как поднять воркер»."
      );
    }
    // Те же проверки делает и воркер — здесь они только чтобы не гонять зря
    // мегабайты по сети и сразу показать понятную ошибку.
    if (!/^image\//.test(file.type || "")) throw new Error("Выбранный файл — не изображение");
    if (file.size > MAX_UPLOAD_BYTES) throw new Error("Файл больше 8 МБ — сожмите фото");

    const idToken = await auth.currentUser.getIdToken();
    const formData = new FormData();
    formData.append("idToken", idToken);
    formData.append("image", file);

    const res = await fetch(`${relay}/upload`, { method: "POST", body: formData });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      throw new Error("Не удалось загрузить фото: " + ((data && data.error) || res.status));
    }
    return data.url;
  }

  // Переключение подкатегорий
  document.getElementById("category").addEventListener("change", (e) => {
    const cat = e.target.value;
    const subSelect = document.getElementById("subcategory");
    subSelect.innerHTML = '<option value="">Без подкатегории</option>';

    // Object.hasOwn, а не просто subcatMap[cat]: иначе значение вроде "constructor"
    // достало бы что-то из прототипа Object вместо списка подкатегорий.
    if(Object.hasOwn(subcatMap, cat)) {
      subcatMap[cat].forEach(sub => {
        subSelect.innerHTML += `<option value="${escapeHtml(sub)}">${escapeHtml(sub)}</option>`;
      });
    }
    updateSizesFieldVisibility();
  });

  // ===== Поле "Доступные размеры" — только для колец из "Гарнитуры" (артикул ка-/кл-) =====
  // У серёг (са-/сл-) и у всех остальных товаров размеров нет вообще, поле для них скрыто.
  // Пусто в поле = сайт использует обычный диапазон 14-24, как для любого другого кольца.
  // Должно совпадать с GARNITURY_RING_PREFIXES в app.js — иначе размер, заданный здесь,
  // не будет показан на сайте (или наоборот).
  const GARNITURY_RING_PREFIXES = ["ка", "кл", "кбн"];
  const GARNITURY_SIZED_SUBCATS = ["с алмазной гранью", "со вставками"];

  function isSizesFieldRelevant() {
    const category = document.getElementById("category").value;
    const subcategory = document.getElementById("subcategory").value.toLowerCase();
    const sku = document.getElementById("sku").value.trim().toLowerCase();
    if (category !== "garnitury" || !GARNITURY_SIZED_SUBCATS.includes(subcategory)) return false;
    const m = sku.match(/^([а-я]+)-/);
    return !!m && GARNITURY_RING_PREFIXES.includes(m[1]);
  }

  function updateSizesFieldVisibility() {
    document.getElementById("sizesGroup").style.display = isSizesFieldRelevant() ? "block" : "none";
  }

  document.getElementById("subcategory").addEventListener("change", updateSizesFieldVisibility);
  document.getElementById("sku").addEventListener("input", updateSizesFieldVisibility);

  // "16, 17.5, 18" -> [16, 17.5, 18]; мусор и пустые куски отбрасываются молча —
  // это подсказка для покупателя, а не поле, от которого зависят деньги или доступ.
  function parseSizesInput(value) {
    return String(value || "")
      .split(",")
      .map(s => parseFloat(s.replace(",", ".").trim()))
      .filter(n => !isNaN(n) && n > 0);
  }

  // Отслеживание сессии авторизации.
  //
  // Вход в аккаунт и права администратора — разные вещи. Аккаунт на сайте может завести
  // любой покупатель, поэтому одного onAuthStateChanged мало: раньше панель показывалась
  // всем вошедшим. Записи и удаления всё равно отбивали правила Firestore, но посторонний
  // видел интерфейс, список товаров и кнопки — так быть не должно. Настоящий признак
  // администратора — документ admins/<uid>: писать в коллекцию admins нельзя ниоткуда,
  // она заполняется руками через консоль Firebase.
  //
  // Это проверка «для интерфейса». Даже если её обойти в браузере, ничего не изменится:
  // те же условия продублированы в firestore.rules и в воркере — там их не обойти.
  //
  // ВАЖНО про ретраи. Правила разрешают читать ровно admins/<свой uid> любому вошедшему —
  // то есть настоящий "permission-denied" на этом пути практически невозможен. Раньше
  // здесь ЛЮБАЯ ошибка (обрыв сети, кратковременная недоступность Firestore, и особенно
  // гонка сразу после входа — ID-токен ещё не успел примениться к следующему запросу)
  // трактовалась как "документа нет" и разлогинивала настоящего администратора без
  // всякой его вины. Отличаем: временный сбой — не выходим из аккаунта и пробуем ещё раз;
  // окончательный ответ "прав нет" — только когда чтение прошло успешно и документа
  // действительно не существует.
  async function checkAdminStatus(user, attempt = 1) {
    try {
      const snap = await getDoc(doc(db, "admins", user.uid));
      return { isAdmin: snap.exists() };
    } catch (err) {
      console.error(`Проверка прав не удалась (попытка ${attempt}):`, err);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        return checkAdminStatus(user, attempt + 1);
      }
      return { isAdmin: false, transientError: true };
    }
  }

  function showAuthScreen(message) {
    const authStatus = document.getElementById("authStatus");
    document.getElementById("authContainer").style.display = "block";
    document.getElementById("adminInterface").style.display = "none";
    authStatus.innerText = message || "";
    authStatus.style.display = message ? "block" : "none";
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      showAuthScreen("");
      return;
    }

    const result = await checkAdminStatus(user);
    if (!result.isAdmin) {
      if (result.transientError) {
        // Не разлогиниваем: сессия остаётся валидной, просто не удалось прямо сейчас
        // подтвердить права. Обновление страницы (когда сеть отойдёт) повторит проверку
        // заново, не требуя вводить пароль ещё раз.
        showAuthScreen("Не удалось проверить права администратора — проблема с сетью или Firestore. Обновите страницу через минуту.");
        return;
      }
      await signOut(auth);
      showAuthScreen("У этого аккаунта нет прав администратора.");
      return;
    }

    document.getElementById("authStatus").style.display = "none";
    document.getElementById("authContainer").style.display = "none";
    document.getElementById("adminInterface").style.display = "block";
    allProductsCache = null; // на случай повторного входа в этой же вкладке
    refreshProductsList();
    loadOrders();
  });

  // Вход / Выход
  document.getElementById("loginBtn").addEventListener("click", async () => {
    const email = document.getElementById("authEmail").value.trim();
    const pass = document.getElementById("authPassword").value.trim();
    const authStatus = document.getElementById("authStatus");

    try {
      authStatus.style.display = "none";
      await signInWithEmailAndPassword(auth, email, pass);
    } catch(err) {
      authStatus.innerText = "Ошибка авторизации: " + err.message;
      authStatus.style.display = "block";
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

  // Обработка отправки формы
  document.getElementById("productForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const submitBtn = document.getElementById("submitBtn");
    const statusMsg = document.getElementById("statusMessage");

    const sku = document.getElementById("sku").value.trim();
    const weight = document.getElementById("weight").value.trim();
    const category = document.getElementById("category").value;
    const subcategory = document.getElementById("subcategory").value;
    const file = document.getElementById("imageFile").files[0];

    statusMsg.style.display = "none";

    // 1. Проверка пустого SKU на клиенте
    if (!sku) {
      statusMsg.className = "status error";
      statusMsg.innerText = "Ошибка: Артикул (SKU) не может быть пустым!";
      statusMsg.style.display = "block";
      return;
    }

    try {
      submitBtn.disabled = true;

      // Если выбран новый файл — загружаем его и берём итоговую ссылку.
      // Если нет — оставляем то фото, что уже было у товара (при редактировании).
      let imageValue = currentImageValue;
      if (file) {
        submitBtn.innerText = "Загружаю фото...";
        imageValue = await uploadImage(file);
        submitBtn.innerText = "Сохраняю...";
      }

      const docRef = doc(db, "products", sku);
      const docSnap = await getDoc(docRef);

      // Схема должна совпадать с тем, что читает index.html: поле image, вес числом, category слагом
      const updateData = {
        sku: sku,
        name: sku,
        weight: weight === "" ? "" : (parseFloat(weight.replace(",", ".")) || 0),
        category: category,
        subcategory: subcategory || null,
        image: imageValue,
        updatedAt: serverTimestamp() // Фиксируем дату изменения всегда
      };

      // Поле пишем только когда оно вообще применимо (кольцо ка-/кл- из "Гарнитуры") — для
      // остальных товаров ключ sizes в документ не попадает. Пустой ввод здесь означает
      // "вернуться к обычному диапазону 14-24" — пишем именно [], а не пропускаем ключ,
      // иначе merge:true оставил бы старый список нетронутым и очистить его было бы нельзя.
      if (isSizesFieldRelevant()) {
        updateData.sizes = parseSizesInput(document.getElementById("sizes").value);
      }

      if (!docSnap.exists()) {
        // Если товар новый, прокидываем время создания
        updateData.createdAt = serverTimestamp();
      }

      // Безопасное сохранение без перезаписи createdAt для старых товаров
      await setDoc(docRef, updateData, { merge: true });

      statusMsg.className = "status success";
      statusMsg.innerText = `Товар ${sku} успешно сохранен/обновлен!`;
      statusMsg.style.display = "block";
      allProductsCache = null; // кэш устарел после записи
      refreshProductsList();

      // Очищаем форму для следующей записи
      document.getElementById("sku").value = "";
      document.getElementById("weight").value = "";
      document.getElementById("imageFile").value = "";
      document.getElementById("sizes").value = "";
      currentImageValue = "";
      setImagePreview("");
      updateSizesFieldVisibility();

    } catch (error) {
      console.error(error);
      statusMsg.className = "status error";
      statusMsg.innerText = "Ошибка: " + error.message;
      statusMsg.style.display = "block";
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerText = "Сохранить в Firestore";
    }
  });

  // Общий рендер строки таблицы товаров — используется и "последними 10", и результатами поиска
  function productRowHtml(item) {
    const image = item.image || item.img || "";
    const sizes = Array.isArray(item.sizes) ? item.sizes.join(", ") : "";
    return `
      <tr id="row-${escapeHtml(item.sku)}"
          data-sku="${escapeHtml(item.sku)}"
          data-weight="${escapeHtml(item.weight ?? "")}"
          data-category="${escapeHtml(item.category || "")}"
          data-subcategory="${escapeHtml(item.subcategory || "")}"
          data-sizes="${escapeHtml(sizes)}"
          data-img="${escapeHtml(image)}">
        <td><strong>${escapeHtml(item.sku)}</strong></td>
        <td>${escapeHtml(CATEGORY_NAMES[item.category] || item.category || "")} <span style="font-size:11px;color:var(--text-dim);">${item.subcategory ? ' / ' + escapeHtml(item.subcategory) : ''}</span></td>
        <td>${item.weight ? escapeHtml(item.weight) + ' гр.' : '—'}</td>
        <td><span style="font-size: 11px; color: var(--text-dim);">${escapeHtml(image) || "—"}</span></td>
        <td>
          <button class="edit-btn" style="width:auto;">Редактировать</button>
          <button class="delete-btn" style="width:auto;" data-sku="${escapeHtml(item.sku)}">Удалить</button>
        </td>
      </tr>
    `;
  }

  // Общие обработчики кнопок Редактировать/Удалить для любой таблицы, отрисованной через productRowHtml
  function attachRowHandlers(tbody, onDeleted) {
    tbody.querySelectorAll(".edit-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const row = e.target.closest("tr");

        const sku = row.dataset.sku;
        const weight = row.dataset.weight;
        const category = row.dataset.category;
        const subcategory = row.dataset.subcategory;
        const sizes = row.dataset.sizes;
        const img = row.dataset.img;

        document.getElementById("sku").value = sku;
        document.getElementById("weight").value = weight;
        document.getElementById("category").value = category;

        const event = new Event('change');
        document.getElementById("category").dispatchEvent(event);

        document.getElementById("subcategory").value = subcategory;
        document.getElementById("sizes").value = sizes || "";
        updateSizesFieldVisibility();

        // Показываем текущее фото товара; выбирать новое нужно только если хотим его заменить
        currentImageValue = img || "";
        document.getElementById("imageFile").value = "";
        setImagePreview(currentImageValue);

        // Редактирование товара живёт во вкладке "Редактор товаров" — переключаемся туда
        document.querySelector('.admin-tab[data-tab="editor"]').click();
        document.getElementById("productForm").scrollIntoView({ behavior: "smooth", block: "center" });
        document.getElementById("weight").focus();
      });
    });

    tbody.querySelectorAll(".delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const skuToDelete = e.target.dataset.sku;
        if (confirm(`Вы уверены, что хотите безвозвратно удалить товар ${skuToDelete}?`)) {
          try {
            await deleteDoc(doc(db, "products", skuToDelete));
            if (onDeleted) onDeleted(skuToDelete);
          } catch (err) {
            alert("Ошибка при удалении: " + err.message);
          }
        }
      });
    });
  }

  // Экранирование HTML перед вставкой через innerHTML. Поля заказа (имя, телефон,
  // комментарий, артикулы в items) заполняет покупатель на сайте — без экранирования
  // это была бы hранимая XSS: скрипт из комментария заказа выполнился бы в браузере
  // папы прямо здесь, в админке, с его правами на запись в Firestore.
  function escapeHtml(value){
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  // Приводит артикул к виду для нечёткого поиска: без регистра, без дефисов/пробелов/точек,
  // без ведущих нулей в числах — чтобы "93", "093", "кл93" и "КЛ-93" находили один и тот же товар.
  function normalizeForSearch(str){
    return String(str || "")
      .toLowerCase()
      .replace(/[\s\-_./\\]+/g, "")
      .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
  }

  // Единый список товаров. Firestore не умеет искать "содержит подстроку", поэтому один раз
  // за сессию загружаем весь каталог в память и дальше и список, и поиск работают из него —
  // оба всегда по возрастанию артикула. Кэш инвалидируется после записи/удаления/очистки дублей,
  // чтобы следующий показ не был устаревшим.
  let allProductsCache = null;
  let currentSearchTerm = "";

  async function loadAllProducts(force) {
    if (allProductsCache && !force) return allProductsCache;
    const snapshot = await getDocs(collection(db, "products"));
    allProductsCache = snapshot.docs.map(d => d.data());
    allProductsCache.forEach(item => { item.skuNorm = normalizeForSearch(item.sku); });
    allProductsCache.sort((a, b) => (a.sku || "").localeCompare(b.sku || "", "ru", { numeric: true }));
    return allProductsCache;
  }

  const LIST_DISPLAY_LIMIT = 20;

  async function refreshProductsList() {
    const tbody = document.getElementById("productsTable");
    const statusEl = document.getElementById("adminSearchStatus");
    const term = currentSearchTerm;

    statusEl.innerText = allProductsCache ? "" : "Загрузка каталога...";
    const all = await loadAllProducts(false);

    const matches = term ? all.filter(item => item.skuNorm.includes(term)) : all;
    const shown = matches.slice(0, LIST_DISPLAY_LIMIT);

    if (matches.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);">Ничего не найдено</td></tr>`;
    } else {
      tbody.innerHTML = shown.map(productRowHtml).join("");
      attachRowHandlers(tbody, (deletedSku) => {
        allProductsCache = allProductsCache.filter(it => it.sku !== deletedSku);
        refreshProductsList();
      });
    }

    statusEl.innerText = matches.length > LIST_DISPLAY_LIMIT
      ? `Показано ${LIST_DISPLAY_LIMIT} из ${matches.length}${term ? " — уточните запрос" : ""}`
      : `Показано: ${matches.length}`;
  }

  // readonly до фокуса/клика — Chrome не подставляет сохранённые email/пароли
  // в readonly-поля, а обычному вводу это не мешает (см. index.html)
  const adminSearchInputEl = document.getElementById("adminSearchInput");
  const enableAdminSearchInput = () => adminSearchInputEl.removeAttribute("readonly");
  adminSearchInputEl.addEventListener("focus", enableAdminSearchInput);
  adminSearchInputEl.addEventListener("mousedown", enableAdminSearchInput);
  adminSearchInputEl.addEventListener("touchstart", enableAdminSearchInput);

  adminSearchInputEl.addEventListener("input", (e) => {
    currentSearchTerm = normalizeForSearch(e.target.value);
    refreshProductsList();
  });

  // ===== ЗАКАЗЫ =====
  // Покупатели оформляют заказ на сайте (index.html), он попадает сюда — в коллекцию "orders".
  const ORDER_STATUS_LABELS = { new: "Новый", processing: "В обработке", done: "Выполнен" };

  // Товар заказа хранит только { sku, weight, qty, sizes } — без фото и названия
  // (см. app.js, submitOrderBtn). Фото и категорию ("название") подтягиваем по артикулу
  // из уже загруженного каталога (allProductsCache). Если товар с тех пор удалили или
  // переименовали — карточка всё равно корректно откроется, просто без фото и названия.
  function findProductBySku(sku) {
    return (allProductsCache || []).find(p => p.sku === sku);
  }

  // "18" -> "размер 18"; "18, 19" (два разных размера у нескольких единиц) -> "размеры 18, 19";
  // нет размера вообще (серьги, обычный товар без sizes) -> пустая строка, ничего не показываем.
  function orderItemSizeLabel(sizes) {
    const present = (sizes || []).filter(s => s != null && s !== "");
    if (present.length === 0) return "";
    const unique = [...new Set(present)];
    return (unique.length === 1 ? "размер " : "размеры ") + unique.map(s => escapeHtml(s)).join(", ");
  }

  function orderItemCardHtml(item) {
    const product = findProductBySku(item.sku);
    const image = product ? resolveImagePathForPreview(product.image || product.img || "") : "";
    const name = product ? (CATEGORY_NAMES[product.category] || "") : "";
    const sizeLabel = orderItemSizeLabel(item.sizes);
    const line = `${escapeHtml(item.sku)}${sizeLabel ? " | " + sizeLabel : ""} | ×${escapeHtml(item.qty)}`;

    return `
      <div class="order-item-card">
        ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.sku)}">` : ""}
        <div class="order-item-info">
          ${name ? `<div class="order-item-name">${escapeHtml(name)}</div>` : ""}
          <div class="order-item-line">${line}</div>
        </div>
      </div>`;
  }

  function orderRowHtml(id, order) {
    const date = order.createdAt && typeof order.createdAt.toDate === "function"
      ? order.createdAt.toDate().toLocaleString("ru")
      : "—";
    const itemsHtml = (order.items || []).map(orderItemCardHtml).join("");
    const status = order.status || "new";

    return `
      <tr>
        <td style="white-space:nowrap;">${date}</td>
        <td>${escapeHtml(order.name || order.email) || "—"}</td>
        <td>${escapeHtml(order.phone) || "—"}</td>
        <td style="max-width:280px;">
          <div class="order-items-grid">${itemsHtml || "—"}</div>
          ${order.comment ? `<div style="font-size:11px;color:var(--text-dim);margin-top:6px;">${escapeHtml(order.comment)}</div>` : ""}
        </td>
        <td>
          <select class="order-status-select" data-id="${escapeHtml(id)}" style="padding:6px 8px;font-size:12px;border-radius:7px;">
            ${Object.entries(ORDER_STATUS_LABELS).map(([value, label]) =>
              `<option value="${value}" ${status === value ? "selected" : ""}>${label}</option>`
            ).join("")}
          </select>
        </td>
      </tr>
    `;
  }

  function attachOrderHandlers(tbody) {
    tbody.querySelectorAll(".order-status-select").forEach(sel => {
      sel.addEventListener("change", async () => {
        sel.disabled = true;
        try {
          await updateDoc(doc(db, "orders", sel.dataset.id), { status: sel.value });
        } catch (err) {
          alert("Не удалось обновить статус: " + err.message);
        } finally {
          sel.disabled = false;
        }
      });
    });
  }

  async function loadOrders() {
    const tbody = document.getElementById("ordersTable");
    const statusEl = document.getElementById("ordersStatus");
    statusEl.textContent = "Загрузка заказов...";

    try {
      // Нужен для фото/названия в карточках товаров заказа (см. orderItemCardHtml) —
      // если каталог уже загружен для вкладки "Редактор товаров", второй раз не читается.
      await loadAllProducts(false);

      const q = query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(50));
      const snap = await getDocs(q);

      if (snap.empty) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);">Заказов пока нет</td></tr>`;
        statusEl.textContent = "";
        return;
      }

      tbody.innerHTML = snap.docs.map(d => orderRowHtml(d.id, d.data())).join("");
      attachOrderHandlers(tbody);
      statusEl.textContent = `Показано: ${snap.docs.length}`;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--red);">Ошибка загрузки: ${escapeHtml(err.message)}</td></tr>`;
      statusEl.textContent = "";
    }
  }
