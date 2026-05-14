// Vercel Cron: ежедневный отчёт по storyincognito.com в Telegram.
// Запускается по расписанию из vercel.json (поле "crons").
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   TELEGRAM_BOT_TOKEN  — токен бота из @BotFather (обязательно)
//   TELEGRAM_CHAT_ID    — chat_id получателя (обязательно)
//   CRON_SECRET         — генерится Vercel-ом автоматически (обязательно)
//   RAPIDAPI_KEY        — уже есть (используется для проверки квоты)
//   RAPIDAPI_HOST       — уже есть
//   STORIES_PATH        — уже есть
//   AHREFS_API_TOKEN    — опционально, для SEO-блока (получить в кабинете Ahrefs)

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Vercel Cron шлёт запрос с заголовком Authorization: Bearer <CRON_SECRET>
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const lines = [];
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Kiev',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  lines.push(`<b>📊 Утренний отчёт storyincognito.com</b>`);
  lines.push(`<i>${dateStr}</i>`);
  lines.push('');

  // 1. Статус сайта
  lines.push(`<b>🌐 Сайт</b>`);
  await checkSite(lines);

  // 2. API /stories
  lines.push('');
  lines.push(`<b>🔌 API /stories</b>`);
  await checkApi(lines);

  // 3. RapidAPI квота
  lines.push('');
  lines.push(`<b>📡 RapidAPI</b>`);
  await checkRapidApiQuota(lines);

  // 4. Ahrefs (SEO) — если есть токен
  if (process.env.AHREFS_API_TOKEN) {
    lines.push('');
    lines.push(`<b>📈 Ahrefs / SEO</b>`);
    await checkAhrefs(lines);
  } else {
    lines.push('');
    lines.push(`<i>📈 SEO-данные подключим, когда добавишь AHREFS_API_TOKEN в env vars.</i>`);
  }

  const text = lines.join('\n');

  // Отправка в Telegram
  try {
    const tgRes = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }
    );
    const tgBody = await tgRes.text();
    if (!tgRes.ok) {
      console.error('Telegram error', tgRes.status, tgBody);
      return res.status(500).json({ error: 'telegram failed', status: tgRes.status, body: tgBody });
    }
  } catch (e) {
    console.error('Telegram fetch error', e);
    return res.status(500).json({ error: String(e) });
  }

  return res.status(200).json({ ok: true, sentAt: now.toISOString() });
}

// — helpers —

async function checkSite(lines) {
  const targets = [
    { url: 'https://storyincognito.com/', label: 'Главная RU' },
    { url: 'https://storyincognito.com/ua/', label: 'Главная UA' },
  ];
  for (const t of targets) {
    try {
      const start = Date.now();
      const r = await fetch(t.url, { method: 'GET', redirect: 'follow' });
      const ms = Date.now() - start;
      const icon = r.ok ? '✅' : '⚠️';
      lines.push(`${icon} ${t.label}: ${r.status} (${ms}ms)`);
    } catch (e) {
      lines.push(`❌ ${t.label}: ${e.message || 'fetch failed'}`);
    }
  }
}

async function checkApi(lines) {
  // Тестовый username, который точно существует
  const testUser = 'instagram';
  try {
    const start = Date.now();
    const r = await fetch(
      `https://storyincognito.com/api/stories?username=${testUser}`,
      { method: 'GET' }
    );
    const ms = Date.now() - start;
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      const count = Array.isArray(body.items) ? body.items.length : 0;
      lines.push(`✅ работает: ${r.status} (${ms}ms), items=${count}`);
    } else {
      lines.push(`⚠️ ${r.status}: ${body.error || 'неизвестная ошибка'}`);
    }
  } catch (e) {
    lines.push(`❌ ${e.message || 'fetch failed'}`);
  }
}

async function checkRapidApiQuota(lines) {
  const KEY = process.env.RAPIDAPI_KEY;
  const HOST = process.env.RAPIDAPI_HOST;
  const PATH = process.env.STORIES_PATH || '/userstories/';
  const PARAM = process.env.STORIES_USERNAME_PARAM || 'username_or_id';

  if (!KEY || !HOST) {
    lines.push(`⚠️ env vars не настроены`);
    return;
  }

  // Лёгкий запрос, чтобы получить rate-limit headers
  const url = PATH.includes('{username}')
    ? `https://${HOST}${PATH.replace('{username}', 'instagram')}`
    : `https://${HOST}${PATH}?${PARAM}=instagram`;

  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': HOST,
      },
    });

    // RapidAPI использует разные имена headers — собираем всё подряд
    const used =
      r.headers.get('x-ratelimit-requests-used') ||
      r.headers.get('x-ratelimit-used') ||
      r.headers.get('x-ratelimit-requests-remaining') === null
        ? null
        : r.headers.get('x-ratelimit-requests-remaining');

    const limit =
      r.headers.get('x-ratelimit-requests-limit') ||
      r.headers.get('x-ratelimit-limit');

    const remaining = r.headers.get('x-ratelimit-requests-remaining');
    const reset = r.headers.get('x-ratelimit-requests-reset');

    if (limit || remaining || used) {
      const parts = [];
      if (used && limit) parts.push(`использовано ${used}/${limit}`);
      else if (remaining && limit) parts.push(`осталось ${remaining}/${limit}`);
      else if (remaining) parts.push(`осталось ${remaining}`);
      if (reset) {
        const sec = parseInt(reset, 10);
        if (!isNaN(sec) && sec < 60 * 60 * 24 * 60) {
          const days = Math.round(sec / (60 * 60 * 24));
          parts.push(`сброс через ~${days} д`);
        }
      }
      lines.push(`✅ ${parts.join(', ') || 'квота получена'}`);
    } else {
      lines.push(`ℹ️ rate-limit headers недоступны, статус ${r.status}`);
    }
  } catch (e) {
    lines.push(`❌ ${e.message || 'fetch failed'}`);
  }
}

async function checkAhrefs(lines) {
  const TOKEN = process.env.AHREFS_API_TOKEN;
  const target = 'storyincognito.com';

  // Domain Rating + organic keywords + organic traffic
  try {
    const r = await fetch(
      `https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${target}&date=${todayISO()}&protocol=both&mode=domain`,
      { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } }
    );
    if (r.ok) {
      const j = await r.json();
      const dr = j.domain_rating?.domain_rating ?? '?';
      lines.push(`Domain Rating: ${dr}`);
    } else {
      lines.push(`⚠️ Ahrefs DR: ${r.status}`);
    }
  } catch (e) {
    lines.push(`❌ Ahrefs DR: ${e.message}`);
  }

  try {
    const r = await fetch(
      `https://api.ahrefs.com/v3/site-explorer/metrics?target=${target}&date=${todayISO()}&protocol=both&mode=domain&country=ua`,
      { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } }
    );
    if (r.ok) {
      const j = await r.json();
      const m = j.metrics || {};
      lines.push(`Org. трафик: ${m.org_traffic ?? '?'}, ключей: ${m.org_keywords ?? '?'}`);
    } else {
      lines.push(`⚠️ Ahrefs metrics: ${r.status}`);
    }
  } catch (e) {
    lines.push(`❌ Ahrefs metrics: ${e.message}`);
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
