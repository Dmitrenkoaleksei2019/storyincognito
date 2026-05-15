// Vercel serverless function: GET /api/stories?username=<username>
// Возвращает: { items: [{ type: 'image'|'video', url: string, thumb?: string }] }
//
// Конфиг через переменные окружения (Vercel Project → Settings → Environment Variables):
//   RAPIDAPI_KEY   — обязательный, ваш X-RapidAPI-Key
//   RAPIDAPI_HOST  — host провайдера, напр. "instagram-scraper-stable-api.p.rapidapi.com"
//   STORIES_PATH   — путь endpoint, напр. "/v1/stories/{username}"
//                    или "/stories?username={username}" — плейсхолдер {username} обязателен
//
// Логи в Vercel → Project → Logs показывают, что именно мы запросили и что вернул провайдер.

export default async function handler(req, res) {
  // CORS — на случай если фронт отдельно
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const raw = String(req.query.username || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_.]{1,30}$/.test(raw)) {
    return res.status(400).json({ error: 'Некорректный username' });
  }

  const KEY = process.env.RAPIDAPI_KEY;
  const HOST = process.env.RAPIDAPI_HOST || 'instagram-scraper-stable-api.p.rapidapi.com';
  const PATH = process.env.STORIES_PATH || '/v1/stories/{username}';
  const USERNAME_PARAM = process.env.STORIES_USERNAME_PARAM || 'username_or_id';

  if (!KEY) {
    return res.status(500).json({ error: 'API ключ не настроен. Добавьте RAPIDAPI_KEY в env переменные Vercel.' });
  }

  // Собираем URL: поддерживаем path-style (PATH с {username}) и query-style (через STORIES_USERNAME_PARAM).
  // Скрапер instagram-scraper-20251 требует ?username_or_id=...&count=50
  let url;
  if (PATH.includes('{username}')) {
    url = `https://${HOST}${PATH.replace('{username}', encodeURIComponent(raw))}`;
    // Добавляем count=50 если в пути ещё нет
    if (!/[?&]count=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'count=50';
    }
  } else {
    const sep = PATH.includes('?') ? '&' : '?';
    url = `https://${HOST}${PATH}${sep}${USERNAME_PARAM}=${encodeURIComponent(raw)}&count=50`;
  }

  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': HOST,
        'accept': 'application/json',
      },
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      console.error('Provider error', { status: r.status, body: text.slice(0, 500) });
      return res.status(502).json({
        error: `Сервис данных вернул ${r.status}. Попробуйте позже.`,
        debug: process.env.NODE_ENV === 'development' ? data : undefined,
      });
    }

    const items = normalize(data);

    // Дебаг-режим: ?debug=1 — возвращает сырой ответ провайдера для диагностики
    if (req.query.debug === '1') {
      return res.status(200).json({
        username: raw,
        items,
        debug: {
          request_url: url,
          env_path: PATH,
          env_username_param: USERNAME_PARAM,
          env_host: HOST,
          provider_status: r.status,
          provider_response: data,
          items_count: items.length,
        },
      });
    }

    // Кешируем 60 секунд на CDN — снижаем нагрузку на RapidAPI и расход квоты
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ username: raw, items });
  } catch (err) {
    console.error('Fetch failed', err);
    return res.status(500).json({ error: 'Сетевая ошибка. Попробуйте позже.' });
  }
}

// Приводим разные форматы провайдеров к единому виду:
//   { items: [{ type: 'image'|'video', url, thumb? }] }
//
// Скрапер instagram-scraper-20251 в 2026 поменял формат:
//   - изображения теперь в image_versions.items[].url (раньше image_versions2.candidates)
//   - is_video, media_format ("image"|"video"), media_type (1=image, 2=video) — все могут присутствовать
function normalize(data) {
  if (!data || typeof data !== 'object') return [];

  const candidates =
    (Array.isArray(data) && data) ||
    data.items ||
    data.stories ||
    data.data?.items ||
    data.data?.stories ||
    data.result?.items ||
    data.result?.stories ||
    [];

  if (!Array.isArray(candidates)) return [];

  return candidates.map(it => {
    if (!it || typeof it !== 'object') return null;

    // Определяем тип контента — пробуем все варианты от нового к старому
    const isVideo = !!(
      it.is_video ||
      it.media_format === 'video' ||
      it.media_type === 2 ||
      it.video_url ||
      it.video
    );

    // URL основного контента
    let url = it.video_url || it.video || it.url || it.media_url;

    // Если это видео — копаем video_versions (массив объектов с url)
    if (isVideo && !url) {
      const vv = it.video_versions;
      if (Array.isArray(vv) && vv.length) {
        url = vv[0]?.url;
      } else if (vv && Array.isArray(vv.items) && vv.items.length) {
        // Новый формат: video_versions.items[]
        url = vv.items[0]?.url;
      }
    }

    // Если это картинка (или у видео нет video_url) — берём из image_versions
    if (!url) {
      // НОВЫЙ формат 2026: image_versions.items[].url
      const iv = it.image_versions;
      if (iv && Array.isArray(iv.items) && iv.items.length) {
        // Берём самое большое разрешение (обычно items[0] — самый большой)
        url = iv.items[0]?.url;
      } else if (it.image_versions2?.candidates?.length) {
        // ЛЕГАСИ формат
        url = it.image_versions2.candidates[0].url;
      }
    }

    // Превью — отдельное поле или то же изображение
    let thumb = it.thumbnail_url || it.thumbnail || it.image_url || it.display_url || it.preview_url;
    if (!thumb) {
      const iv = it.image_versions;
      if (iv && Array.isArray(iv.items) && iv.items.length) {
        thumb = iv.items[iv.items.length - 1]?.url; // самый маленький — для превью
      } else if (it.image_versions2?.candidates?.length) {
        thumb = it.image_versions2.candidates[0].url;
      }
    }

    return url ? { type: isVideo ? 'video' : 'image', url, thumb } : null;
  }).filter(Boolean);
}
