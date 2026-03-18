# PixelFort 🏰

Tower Defense мультиплеер до 4 игроков.

## Деплой на Railway (бесплатно, 5 минут)

### Шаг 1 — Залей код на GitHub
1. Зайди на github.com → New repository → название `pixelfort` → Create
2. Загрузи все файлы:
   - `server.js`
   - `package.json`
   - папку `public/` с `index.html` внутри

### Шаг 2 — Задеплой на Railway
1. Зайди на **railway.app** → Sign in with GitHub
2. New Project → Deploy from GitHub repo → выбери `pixelfort`
3. Railway сам найдёт `package.json` и запустит `npm start`
4. Через 1-2 минуты появится ссылка вида `pixelfort-production-xxxx.up.railway.app`

### Шаг 3 — Играй!
- Открой ссылку Railway → это и есть игра
- Кинь ссылку другу → он открывает, создаёт комнату → ты заходишь
- Хост нажимает "Начать игру"

## Локальный запуск (для теста)
```
npm install
npm start
```
Открой http://localhost:3000
