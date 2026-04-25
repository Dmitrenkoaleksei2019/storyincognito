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

  if (!KEY) {
    return res.status(500).json({ error: 'API ключ не настроен. Добавьте RAPIDAPI_KEY в env переменные Vercel.' });
  }

  const url = `https://${HOST}${PATH.replace('{username}', encodeURIComponent(raw))}`;

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
function normalize(data) {
  if (!data || typeof data !== 'object') return [];

  // Часто встречающиеся поля
  const candidates =
    (Array.isArray(data) && data) ||
    data.items ||
    data.stories ||
    data.data?.items ||
    data.data?.stories ||
    data.result?.items ||
    [];

  if (!Array.isArray(candidates)) return [];

  return candidates.map(it => {
    const isVideo = !!(it.video_url || it.video || it.is_video || it.media_type === 2);
    let url = it.video_url || it.video || it.url || it.media_url;
    let thumb = it.thumbnail_url || it.thumbnail || it.image_url || it.display_url || it.preview_url;
    // Иногда массив image_versions2.candidates
    if (!url && it.image_versions2?.candidates?.length) {
      url = it.image_versions2.candidates[0].url;
    }
    if (isVideo && !url && it.video_versions?.length) {
      url = it.video_versions[0].url;
    }
    if (!thumb && it.image_versions2?.candidates?.length) {
      thumb = it.image_versions2.candidates[0].url;
    }
    return url ? { type: isVideo ? 'video' : 'image', url, thumb } : null;
  }).filter(Boolean);
}
