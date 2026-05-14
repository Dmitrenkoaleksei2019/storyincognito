// Vercel serverless function: POST /api/portrait
// Body: { username?: string, manualList?: string[], lang?: 'ua'|'en' }
// Returns: { portrait: string, count: number }
//
// Что делает:
// 1. Получает username — тянет список подписок через RapidAPI (instagram-scraper-20251 или другой)
//    ИЛИ берёт manualList — список ников, скопированных юзером вручную.
// 2. Отправляет список в Claude API (Anthropic) с промптом на фановый психологический портрет.
// 3. Возвращает текст портрета.
//
// Env vars (Vercel Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY       — обязательный, ключ с console.anthropic.com (sk-ant-…)
//   ANTHROPIC_MODEL         — опционально, по умолчанию "claude-sonnet-4-5" (можно "claude-haiku-4-5" для экономии)
//   RAPIDAPI_KEY            — уже есть (используется и для /api/stories)
//   RAPIDAPI_HOST           — уже есть, например instagram-scraper-20251.p.rapidapi.com
//   FOLLOWING_PATH          — путь к endpoint подписок. Варианты (Max — найди работающий в playground RapidAPI):
//                               /userfollowing/
//                               /following/
//                               /user/following/
//                               /v1/following/{username}
//   FOLLOWING_USERNAME_PARAM — query-параметр для username, обычно "username_or_id" или "username"
//                              (для пути с {username} оставь пустым)
//
// Rate-limit: 3 запроса/час и 30/день с одного IP. In-memory, переживает только тёплый инстанс.

// ─────────────────────────────────────────────────────────────────────────────
// In-memory rate limiter (per-instance — не идеален, но работает для нашего объёма)
const rateStore = new Map(); // ip → { hour: [ts...], day: [ts...] }
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_LIMIT = 3;
const DAY_LIMIT = 30;
const GLOBAL_DAILY_CAP = 500; // защита от ботнета — общий лимит на инстанс
let globalDailyCount = 0;
let globalResetAt = Date.now() + DAY_MS;

function checkRate(ip) {
  const now = Date.now();
  if (now > globalResetAt) { globalDailyCount = 0; globalResetAt = now + DAY_MS; }
  if (globalDailyCount >= GLOBAL_DAILY_CAP) {
    return { ok: false, reason: 'global' };
  }

  const entry = rateStore.get(ip) || { hour: [], day: [] };
  entry.hour = entry.hour.filter(t => now - t < HOUR_MS);
  entry.day  = entry.day.filter(t => now - t < DAY_MS);

  if (entry.hour.length >= HOUR_LIMIT) return { ok: false, reason: 'hour' };
  if (entry.day.length  >= DAY_LIMIT)  return { ok: false, reason: 'day' };

  entry.hour.push(now);
  entry.day.push(now);
  rateStore.set(ip, entry);
  globalDailyCount += 1;
  return { ok: true };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Промпт на фановый портрет
function buildPrompt(usernames, lang) {
  const list = usernames.slice(0, 400).join(', '); // ограничиваем размер input
  const count = usernames.length;

  if (lang === 'en') {
    return {
      system:
        'You are a witty culture analyst. From a list of Instagram accounts someone follows, you ' +
        'reconstruct a vivid, playful psychological portrait of the person — age range, likely city, ' +
        'profession or industry, lifestyle, hobbies, beliefs, contradictions. Use light humor and ' +
        'irony, but stay kind. Never be cruel or stereotype protected attributes harshly. End with a ' +
        'short summary verdict. Return plain text in Markdown (use **bold** for key points). 350–500 words.',
      user:
        `Here is a list of ${count} Instagram accounts that one person follows. Build a fun ` +
        `psychological portrait of this user — who they probably are, where they live, what they do, ` +
        `what they care about, what their contradictions are. Be specific and observational, lean ` +
        `into concrete clues from the list.\n\nAccounts:\n${list}`,
    };
  }

  // ua (default)
  return {
    system:
      'Ти — спостережливий культурний аналітик з гострим почуттям гумору. На основі списку Instagram-' +
      'акаунтів, на які підписана людина, ти збираєш живий, грайливий психологічний портрет: вік, ' +
      'імовірне місто, професія чи сфера, спосіб життя, хобі, переконання, протиріччя. Використовуй ' +
      'легкий гумор та іронію, але без жорстокості. Не стереотипізуй захищені характеристики (раса, ' +
      'релігія, орієнтація). Завершуй коротким "вердиктом". Формат — звичайний текст з Markdown ' +
      '(використовуй **жирне** для ключових тез). Обсяг — 350–500 слів. Мова відповіді — українська.',
    user:
      `Ось список з ${count} Instagram-акаунтів, на які підписана одна людина. Збери фановий ` +
      `психологічний портрет цієї людини — хто вона ймовірно, де живе, чим займається, що для неї ` +
      `важливо, які в неї протиріччя. Будь конкретним: спирайся на конкретні підказки зі списку.\n\n` +
      `Акаунти:\n${list}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Получаем список подписок через RapidAPI с пагинацией.
// Максимум — MAX_PAGES страниц × 50 ников = до MAX_USERNAMES.
// Это защита от случая «у юзера 5000 подписок» — мы НЕ хотим тянуть всё,
// потому что (а) дорого по квоте, (б) качество портрета на 200-400 ников выше.
const MAX_PAGES = 8;          // 8 × 50 = 400 ников максимум
const MAX_USERNAMES = 400;

async function fetchFollowing(username) {
  const KEY  = process.env.RAPIDAPI_KEY;
  const HOST = process.env.RAPIDAPI_HOST;
  const PATH = process.env.FOLLOWING_PATH || '/userfollowing/';
  const PARAM = process.env.FOLLOWING_USERNAME_PARAM || 'username_or_id';

  if (!KEY || !HOST) throw new Error('RapidAPI not configured (RAPIDAPI_KEY / RAPIDAPI_HOST)');

  const seen = new Set();
  let paginationToken = null;
  let lastStatus = 200;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams();
    params.set(PARAM, username);
    params.set('count', '50');
    if (paginationToken) params.set('pagination_token', paginationToken);

    let url;
    if (PATH.includes('{username}')) {
      // Path-style: вставляем username в путь, остальное — в query
      const base = `https://${HOST}${PATH.replace('{username}', encodeURIComponent(username))}`;
      const sep = base.includes('?') ? '&' : '?';
      const q = new URLSearchParams();
      q.set('count', '50');
      if (paginationToken) q.set('pagination_token', paginationToken);
      url = `${base}${sep}${q.toString()}`;
    } else {
      const sep = PATH.includes('?') ? '&' : '?';
      url = `https://${HOST}${PATH}${sep}${params.toString()}`;
    }

    const r = await fetch(url, {
      headers: {
        'x-rapidapi-key': KEY,
        'x-rapidapi-host': HOST,
        'accept': 'application/json',
      },
    });
    lastStatus = r.status;
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      console.error('RapidAPI following error', { page, status: r.status, body: text.slice(0, 400) });
      // Если первая страница упала — это ошибка. Если упала после нескольких успешных — возвращаем что есть.
      if (page === 0) {
        const err = new Error(`Provider ${r.status}`);
        err.providerStatus = r.status;
        throw err;
      }
      break;
    }

    const batch = extractUsernames(data);
    for (const u of batch) {
      if (seen.size >= MAX_USERNAMES) break;
      seen.add(u);
    }
    if (seen.size >= MAX_USERNAMES) break;

    paginationToken = extractPaginationToken(data);
    if (!paginationToken) break;
  }

  return Array.from(seen);
}

// Достаём токен пагинации из разных форматов ответа
function extractPaginationToken(data) {
  if (!data || typeof data !== 'object') return null;
  return (
    data.pagination_token ||
    data.next_max_id ||
    data.next_cursor ||
    data.cursor ||
    data.data?.pagination_token ||
    data.data?.next_max_id ||
    data.result?.pagination_token ||
    data.response?.pagination_token ||
    null
  );
}

// Достаём ники из произвольной структуры
function extractUsernames(data) {
  if (!data || typeof data !== 'object') return [];
  const candidates =
    (Array.isArray(data) && data) ||
    data.users || data.following || data.items ||
    data.data?.users || data.data?.following || data.data?.items ||
    data.result?.users || data.result?.following ||
    data.response?.users || data.response?.data?.users ||
    [];
  if (!Array.isArray(candidates)) return [];
  const out = [];
  for (const it of candidates) {
    if (!it) continue;
    const u = it.username || it.user?.username || it.handle || it.screen_name;
    if (u) out.push(String(u).toLowerCase());
  }
  return Array.from(new Set(out));
}

// ─────────────────────────────────────────────────────────────────────────────
// Зов Anthropic API
async function callClaude(systemPrompt, userPrompt) {
  const KEY = process.env.ANTHROPIC_API_KEY;
  const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  if (!KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!r.ok) {
    console.error('Anthropic error', { status: r.status, body: text.slice(0, 400) });
    const err = new Error(`Anthropic ${r.status}`);
    err.providerStatus = r.status;
    throw err;
  }

  // Сшиваем content-blocks типа [{type:'text', text:'...'}]
  const blocks = Array.isArray(data.content) ? data.content : [];
  return blocks.map(b => b.text || '').join('\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Парсим вставленный вручную список
function parseManualList(raw) {
  if (typeof raw !== 'string') return [];
  // Разбиваем по любым разделителям, чистим @, дубли, мусор
  const parts = raw.split(/[\s,;\n\r]+/);
  const out = [];
  for (let p of parts) {
    p = p.trim().replace(/^@+/, '').toLowerCase();
    if (/^[a-z0-9_.]{1,30}$/.test(p)) out.push(p);
  }
  return Array.from(new Set(out));
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  const ip = clientIp(req);
  const rl = checkRate(ip);
  if (!rl.ok) {
    const msg = rl.reason === 'hour'
      ? 'Занадто багато запитів. Спробуй за годину.'
      : rl.reason === 'day'
      ? 'Денний ліміт вичерпано (30 портретів/день з однієї IP).'
      : 'Сервіс тимчасово перевантажено. Спробуй пізніше.';
    return res.status(429).json({ error: msg });
  }

  // Парсим body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const lang = body.lang === 'en' ? 'en' : 'ua';

  let usernames = [];
  if (Array.isArray(body.manualList) && body.manualList.length) {
    usernames = parseManualList(body.manualList.join('\n'));
  } else if (typeof body.manualText === 'string' && body.manualText.trim()) {
    usernames = parseManualList(body.manualText);
  } else if (typeof body.username === 'string' && body.username.trim()) {
    const u = body.username.trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_.]{1,30}$/.test(u)) {
      return res.status(400).json({ error: 'Некоректний username' });
    }
    try {
      usernames = await fetchFollowing(u);
    } catch (e) {
      const status = e.providerStatus === 404 ? 404 : 502;
      const msg = status === 404
        ? 'Не знайшли підписки. Профіль приватний або не існує. Спробуй вставити список вручну.'
        : 'Не вдалося отримати підписки через API. Спробуй вставити список вручну.';
      return res.status(status).json({ error: msg });
    }
  } else {
    return res.status(400).json({ error: 'Передай username або вставлений список.' });
  }

  if (!usernames.length) {
    return res.status(400).json({ error: 'Список порожній. Перевір введені дані.' });
  }
  if (usernames.length < 10) {
    return res.status(400).json({
      error: lang === 'en'
        ? 'Need at least 10 accounts to build a meaningful portrait.'
        : 'Потрібно щонайменше 10 акаунтів для змістовного портрета.',
    });
  }

  // Зов Claude
  const { system, user } = buildPrompt(usernames, lang);
  let portrait;
  try {
    portrait = await callClaude(system, user);
  } catch (e) {
    return res.status(502).json({
      error: lang === 'en'
        ? 'AI service unavailable. Try again in a minute.'
        : 'AI-сервіс тимчасово недоступний. Спробуй за хвилину.',
    });
  }

  if (!portrait) {
    return res.status(502).json({ error: 'Пустий відповідь від AI. Спробуй ще раз.' });
  }

  return res.status(200).json({
    portrait,
    count: usernames.length,
    sample: usernames.slice(0, 5),
  });
}
