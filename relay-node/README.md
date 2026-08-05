# Node-релей (РФ без VPN)

С июня 2025 многие провайдеры в РФ душат **весь** Cloudflare (~16 KB на соединение).
Из-за этого `*.workers.dev` и даже Worker на кастомном домене **не спасают** без VPN:
браузер не дотягивается до прокси, а Google (`*.googleapis.com`) тоже часто закрыт.

Этот сервис — тот же Firebase/Telegram/ImgBB релей, что у Cloudflare Worker, но на
**обычном VPS вне Cloudflare**. Сайт остаётся на GitHub Pages; данные Firestore **не трогаем**.

Клиент сам пробует по порядку (`config.js` → `ensureRelayReady`):

1. `https://relay.voroninkostroma.ru` — этот Node-релей на VPS  
2. `workers.dev` — запасной путь (VPN / заграница)  
3. прямой Google (если сеть уже открыта)

---

## Часть A — что сделать вручную (без программиста)

Нужны **три вещи**, потом можно отдать установку агенту.

### 1. Купить самый дешёвый VPS — **Beget**

Рекомендация одна: [Beget Cloud VPS](https://beget.com/ru/cloud/marketplace/ubuntu-22-04)
(~16 ₽/день ≈ 480 ₽/мес с IP). Timeweb Cloud / Selectel дороже и для этой задачи не нужны.

**Клики:**

1. Откройте: https://beget.com/ru/cloud/marketplace/ubuntu-22-04  
   (или https://beget.com/ru/vps → образ **Ubuntu 22.04**).
2. Войдите / зарегистрируйтесь.
3. Конфиг (минимум — этого хватит):
   - **ОС:** Ubuntu 22.04  
   - **Регион:** Россия (Москва или СПб)  
   - **CPU:** 1 ядро  
   - **RAM:** 1 ГБ  
   - **Диск:** 10 ГБ NVMe  
   - **Публичный IPv4:** включить (обязательно)
4. Нажмите **Создать VPS** / оплатите (посуточно — можно начать с пары сотен рублей на балансе).
5. Дождитесь «Сервер готов» (обычно минуты).

**Скопируйте и сохраните в блокнот:**

| Что | Где в панели Beget |
| --- | --- |
| **IP-адрес** | Карточка сервера → «IP» / «Сеть» |
| **root-пароль** | Карточка сервера → «Доступ» / письмо на почту при создании |

Без IP и пароля дальше нельзя.

### 2. DNS в reg.ru (A-запись)

Домен `voroninkostroma.ru` уже на NS `ns1/ns2.reg.ru`.

1. Войдите в [reg.ru](https://www.reg.ru/) → домен **voroninkostroma.ru** → **DNS-серверы и зона**.
2. Добавьте запись:

   | Тип | Имя (хост) | Значение |
   | --- | --- | --- |
   | **A** | `relay` | *IP вашего VPS из шага 1* |

3. Сохраните. Обычно 5–30 минут, иногда до пары часов.

**Не** включайте «прокси Cloudflare» / оранжевое облако — иначе снова CF.

Проверка позже: `https://relay.voroninkostroma.ru/health` должен ответить JSON
(после установки на сервере).

### 3. Что прислать агенту (чтобы доделали установку)

В чат Cursor одним сообщением:

```text
VPS готов.
IP: 1.2.3.4
root-пароль: ………
DNS A relay → этот IP уже добавлен в reg.ru (да/нет).
```

Дальше агент по SSH поставит Node, nginx, HTTPS и секреты.
Если умеете SSH сами — см. **Часть B** ниже.

---

## Часть B — установка на VPS (агент или вы по SSH)

### Требования

- Ubuntu 22.04+, 1 GB RAM, публичный IPv4  
- DNS `relay.voroninkostroma.ru` → IP VPS  
- Секреты те же, что у Cloudflare Worker (см. «Секреты»)

### Быстрый старт

```bash
sudo apt update && sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx
# Node 18+: при необходимости nodesource
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/TeasSty/jewelry-catalog.git
cd jewelry-catalog/relay-node
cp .env.example .env
nano .env   # те же секреты, что у Cloudflare Worker
npm install
npm start   # проверка на :8787
curl -s http://127.0.0.1:8787/health
# {"ok":true,"via":"relay-node"}
```

### systemd (чтобы не падал после SSH)

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
EnvironmentFile=/opt/jewelry-catalog/relay-node/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now voronin-relay
```

### nginx + TLS

```nginx
# /etc/nginx/sites-available/relay
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
sudo ln -sf /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/relay
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d relay.voroninkostroma.ru
```

### Проверка **без VPN** (телефон / домашний Wi‑Fi)

```text
https://relay.voroninkostroma.ru/health
→ {"ok":true,"via":"relay-node"}

https://voroninkostroma.ru/admin/  — вход, заказы, товары
```

---

## Секреты

Скопируйте из Cloudflare Worker (`wrangler secret`) в `.env` на VPS
(см. `.env.example`):

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `IMGBB_API_KEY`
- опционально `FIREBASE_SA_EMAIL`, `FIREBASE_SA_PRIVATE_KEY` (автоочистка корзины)

Worker можно оставить как запасной путь для VPN / заграницы.
`.env` **не** коммитить.
