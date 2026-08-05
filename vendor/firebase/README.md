# Vendored Firebase JS SDK

Копии с `https://www.gstatic.com/firebasejs/<version>/`:
- `firebase-app.js`
- `firebase-auth.js`
- `firebase-firestore-lite.js` (REST; используется сайтом и /admin/)
- `firebase-firestore.js` (полный SDK с WebChannel — оставлен как запасной, в рантайме не грузится)

Зачем: у части сетей в РФ `gstatic.com` и `*.googleapis.com` недоступны без VPN.
SDK отдаём сами с GitHub Pages; Auth/Firestore API идут через reverse-proxy в
Cloudflare Worker (`/__/firebase/...`, см. `worker/index.js`).

Почему lite, а не полный Firestore SDK: полный ходит в Google через WebChannel
(`.../Listen/channel`). Через Worker это ненадёжно — Auth работает, а getDocs
(заказы/товары в админке) может вернуть пусто. Lite использует только REST
`/v1/...`, который прокси пересылает прозрачно.

Импорты auth/firestore* переписаны с абсолютного gstatic на `./firebase-app.js`.
Не редактируйте файлы вручную — при обновлении версии скачайте заново и
повторите замену импорта.
