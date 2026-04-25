# StoryIncognito

Анонимный просмотр и скачивание Instagram Stories. Стек: статический HTML + Tailwind (через CDN) + serverless функция на Vercel.

## Структура

```
storyincognito/
├── index.html              # / — RU главная под "просмотр историй анонимно"
├── download/index.html     # /download/ — RU посадочная под "скачать сторис"
├── ua/index.html           # /ua/ — UA главная
├── ua/zavantazhyty/        # /ua/zavantazhyty/ — UA посадочная под "завантажити"
├── privacy/index.html      # /privacy/
├── terms/index.html        # /terms/
├── about/index.html        # /about/
├── api/stories.js          # Serverless функция: GET /api/stories?username=X
├── vercel.json             # Конфиг Vercel
├── package.json            # Метаданные пакета (Node 18+)
├── sitemap.xml
├── robots.txt
└── favicon.svg
```

## Переменные окружения (нужны для работы API)

В Vercel → Project → Settings → Environment Variables:

| Переменная | Значение | Обязательно |
|---|---|---|
| `RAPIDAPI_KEY` | Ваш X-RapidAPI-Key с rapidapi.com | да |
| `RAPIDAPI_HOST` | `instagram-scraper-stable-api.p.rapidapi.com` | нет (это default) |
| `STORIES_PATH` | `/v1/stories/{username}` | нет (это default) |

`STORIES_PATH` — точный путь endpoint вашего провайдера. Плейсхолдер `{username}` обязателен. После того как развернёте сайт, посмотрите на странице самого API на RapidAPI, какой именно endpoint у "Get user stories" — и подставьте его сюда. Можно поменять без редеплоя — Vercel применит env vars при следующем запросе.

После добавления env vars нажмите **Redeploy** в Deployments (иначе функция не подхватит новые значения).
