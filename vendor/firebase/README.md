# Vendored Firebase JS SDK

Копии `firebase-app.js` / `firebase-auth.js` / `firebase-firestore.js` с
`https://www.gstatic.com/firebasejs/<version>/`.

Зачем: у части сетей в РФ `gstatic.com` и `*.googleapis.com` недоступны без VPN.
SDK отдаём сами с GitHub Pages; Auth/Firestore API идут через reverse-proxy в
Cloudflare Worker (`/__/firebase/...`, см. `worker/index.js`).

Импорты auth/firestore переписаны с абсолютного gstatic на `./firebase-app.js`.
Не редактируйте файлы вручную — при обновлении версии скачайте заново и
повторите замену импорта.
