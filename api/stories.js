// Vercel serverless function: GET /api/stories?username=<username>
// Возвращает: { items: [{ type: 'image'|'video', url: string, thumb?: string }] }
//
// Конфиг через переменные окружения (Vercel Project → Settings → Environment Variables):
//   RAPIDAPI_KEY            — обязательный, ваш X-RapidAPI-Key
//   RAPIDAPI_HOST           — host нового провайдера из Code Snippets
//   STORIES_PATH            — путь endpoint БЕЗ query string, напр. "/user/stories"
//   STORIES_USERNAME_PARAM  — имя query-параметра, для нового API: "username_or_id"
//   STORIES_URL_EMBED_SAFE  — необязательный, "true" или "false"
//
// Примеры:
//   RAPIDAPI_HOST=...из Code Snippets...
//   STORIES_PATH=...путь из Code Snippets без ?username_or_id=...
//   STORIES_USERNAME_PARAM=username_or_id
//
// Для отладки:
//   /api/stories?username=mrbeast&debug=1

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const raw = String(req.query.username || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_.]{1,30}$/.test(raw)) {
    return res.status(400).json({ error: 'Некорректный username' });
  }

  const KEY = process.env.RAPIDAPI_KEY;
  const HOST = process.env.RAPIDAPI_HOST;
  const PATH = process.env.STORIES_PATH;
  const USERNAME_PARAM = process.env.STORIES_USERNAME_PARAM || 'username_or_id';
  const URL_EMBED_SAFE = process.env.STORIES_URL_EMBED_SAFE;

  if (!KEY) {
    return res.status(500).json({ error: 'API ключ не настроен. Добавьте RAPIDAPI_KEY в env переменные Vercel.' });
  }

  if (!HOST) {
    return res.status(500).json({ error: 'Не задан RAPIDAPI_HOST.' });
  }

  if (!PATH) {
    return res.status(500).json({ error: 'Не задан STORIES_PATH.' });
  }

  let url;

  // Поддержка старой схемы, если вдруг path всё ещё с {username}
  if (PATH.includes('{username}')) {
    url = `https://${HOST}${PATH.replace('{username}', encodeURIComponent(raw))}`;
  } else {
    const u = new URL(`https://${HOST}${PATH}`);
    u.searchParams.set(USERNAME_PARAM, raw);

    if (URL_EMBED_SAFE === 'true' || URL_EMBED_SAFE === 'false') {
      u.searchParams.set('url_embed_safe', URL_EMBED_SAFE);
    }

    url = u.toString();
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
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!r.ok) {
      console.error('Provider error', { status: r.status, body: text.slice(0, 1000), url });
      return res.status(502).json({
        error: `Сервис данных вернул ${r.status}. Попробуйте позже.`,
        provider_status: r.status,
        ...(req.query.debug === '1' ? { provider_raw: data, provider_url: url } : {}),
      });
    }

    const items = normalize(data);
    const providerError = extractProviderError(data);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

    return res.status(200).json({
      username: raw,
      items,
      ...(providerError && items.length === 0 ? { provider_error: providerError } : {}),
      ...(req.query.debug === '1' ? { provider_raw: data, provider_url: url } : {}),
    });
  } catch (err) {
    console.error('Fetch failed', err);
    return res.status(500).json({
      error: 'Сетевая ошибка. Попробуйте позже.',
      ...(req.query.debug === '1' ? { details: err.message } : {}),
    });
  }
}

function extractProviderError(data) {
  if (!data || typeof data !== 'object') return null;

  return (
    data.error ||
    data.message ||
    data.detail ||
    data.data?.error ||
    data.data?.message ||
    data.result?.error ||
    data.result?.message ||
    null
  );
}

// Приводим разные форматы провайдеров к единому виду:
// { items: [{ type: 'image'|'video', url, thumb? }] }
function normalize(data) {
  if (!data || typeof data !== 'object') return [];

  const candidates =
    (Array.isArray(data) && data) ||
    data.items ||
    data.stories ||
    data.data?.items ||
    data.data?.stories ||
    data.reels_media?.[0]?.items ||
    data.data?.reels_media?.[0]?.items ||
    data.result?.items ||
    data.result?.stories ||
    data.result?.reels_media?.[0]?.items ||
    [];

  if (!Array.isArray(candidates)) return [];

  return candidates.map((it) => {
    const isVideo = !!(
      it.video_url ||
      it.video ||
      it.is_video ||
      it.media_type === 2 ||
      (Array.isArray(it.video_versions) && it.video_versions.length)
    );

    let url =
      it.video_url ||
      it.video ||
      it.url ||
      it.media_url ||
      it.display_url ||
      it.image_url;

    let thumb =
      it.thumbnail_url ||
      it.thumbnail ||
      it.image_url ||
      it.display_url ||
      it.preview_url;

    if (!url && it.image_versions2?.candidates?.length) {
      url = it.image_versions2.candidates[0].url;
    }

    if (isVideo && !url && it.video_versions?.length) {
      url = it.video_versions[0].url;
    }

    if (!thumb && it.image_versions2?.candidates?.length) {
      thumb = it.image_versions2.candidates[0].url;
    }

    if (isVideo && !thumb && it.image_versions2?.candidates?.length) {
      thumb = it.image_versions2.candidates[0].url;
    }

    return url ? { type: isVideo ? 'video' : 'image', url, thumb } : null;
  }).filter(Boolean);
}
