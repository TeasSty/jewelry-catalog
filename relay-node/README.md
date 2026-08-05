# Node-релей (РФ без VPN)

С июня 2025 многие провайдеры в РФ душат **весь** Cloudflare (~16 KB на соединение).
Из-за этого `*.workers.dev` и даже Worker на кастомном домене **не спасают** без VPN:
браузер не дотягивается до прокси, а Google (`*.googleapis.com`) тоже часто закрыт.

Этот сервис — тот же Firebase/Telegram/ImgBB релей, но на **обычном VPS вне Cloudflare**
(Selectel, Timeweb, Beget, VK Cloud, Yandex Cloud VM). Сайт остаётся на GitHub Pages;
данные Firestore **не трогаем**.

## Что нужно от вас (один раз, ~30–60 минут)

1. VPS в РФ, Ubuntu 22.04+, от 1 GB RAM (~150–400 ₽/мес).
2. DNS в [reg.ru](https://www.reg.ru/) (сейчас NS у `voroninkostroma.ru` — `ns1/ns2.reg.ru`):

   | Тип | Имя | Значение |
   | --- | --- | --- |
   | A | `relay` | IP вашего VPS |

   **Не** включайте «прокси Cloudflare» / оранжевое облако — иначе снова CF.

3. На VPS:

```bash
sudo apt update && sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx
# Node 18+: при необходимости nodesource
git clone https://github.com/TeasSty/jewelry-catalog.git
cd jewelry-catalog/relay-node
cp .env.example .env
nano .env   # те же секреты, что у Cloudflare Worker
npm install
npm start   # проверка на :8787
curl -s http://127.0.0.1:8787/health
# {"ok":true,"via":"relay-node"}
```

4. systemd (чтобы не падал после SSH):

```ini
# /etc/systemd/system/voronin-relay.service
[Unit]
Description=Voronin Firebase relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/jewelry-catalog/relay-node
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now voronin-relay
```

5. nginx + TLS (пример):

```nginx
server {
  listen 80;
  server_name relay.voroninkostroma.ru;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 10m;
  }
}
```

```bash
sudo certbot --nginx -d relay.voroninkostroma.ru
```

6. Проверка **без VPN** с телефона/домашнего Wi‑Fi:

```text
https://relay.voroninkostroma.ru/health
→ {"ok":true,"via":"relay-node"}

https://voroninkostroma.ru/admin/  — вход, заказы, товары
```

Клиент сам пробует `relay.voroninkostroma.ru`, затем `workers.dev`, затем прямой Google
(`config.js` → `ensureRelayReady`).

## Секреты

Скопируйте из Cloudflare Worker (`wrangler secret`) в `.env`:

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `IMGBB_API_KEY`
- опционально `FIREBASE_SA_EMAIL`, `FIREBASE_SA_PRIVATE_KEY` (автоочистка корзины)

Worker можно оставить как запасной путь для VPN / заграницы.
