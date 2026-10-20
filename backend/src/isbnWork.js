/**
 * data.isbn.work 独立模块（有调用次数限制）
 * - 不嵌入豆瓣/Google/OL 主流程
 * - 未配置 ISBN_WORK_APP_KEY 时全程 no-op
 * - 进程内缓存 + 失败冷却，避免重复扣次
 */

const API =
  process.env.ISBN_WORK_API ||
  'https://data.isbn.work/openApi/getInfoByIsbn';

const CACHE_MS = Number(process.env.ISBN_WORK_CACHE_MS || 7 * 24 * 3600 * 1000);
const FAIL_COOLDOWN_MS = Number(process.env.ISBN_WORK_FAIL_COOLDOWN_MS || 30 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.ISBN_WORK_TIMEOUT_MS || 6000);

const cache = new Map(); // isbn -> { at, meta, err }
let cooldownUntil = 0;
let lastError = null;

function getAppKey() {
  return String(process.env.ISBN_WORK_APP_KEY || process.env.ISBN_APP_KEY || '').trim();
}

function isEnabled() {
  return !!getAppKey();
}

function pick(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (s === '未知书名' || s === '未知作者' || s === 'null' || s === 'undefined') continue;
    return s;
  }
  return null;
}

function cleanCover(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/^http:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(u)) return null;
  const low = u.toLowerCase();
  if (
    low.includes('book-default') ||
    low.includes('default_cover') ||
    low.includes('placeholder') ||
    low.includes('no-cover')
  ) {
    return null;
  }
  return u;
}

function parsePictures(raw) {
  if (!raw) return null;
  if (Array.isArray(raw) && raw[0]) return String(raw[0]).trim();
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^https?:\/\//i.test(s)) return s;
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr[0]) return String(arr[0]).trim();
    } catch (_) {}
  }
  return null;
}

function mapPayload(d) {
  if (!d || typeof d !== 'object') return null;
  const title = pick(d.bookName, d.title, d.name);
  if (!title) return null;
  return {
    title,
    authors: pick(d.author, d.authors, d.writer),
    cover: cleanCover(
      parsePictures(d.pictures) || d.bookPic || d.pic || d.cover || d.img
    ),
    publisher: pick(d.press, d.publisher),
    published: pick(d.pressDate, d.pubdate, d.publish),
    source: 'isbn-work',
  };
}

/**
 * 仅查缓存，不发网络请求
 */
function peek(isbn) {
  const key = String(isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) return null;
  return hit.meta || null;
}

/**
 * 是否值得调用：主源已完整则 false（省额度）
 */
function shouldFill(baseMeta) {
  if (!isEnabled()) return false;
  if (Date.now() < cooldownUntil) return false;
  if (!baseMeta) return true;
  const noTitle = !baseMeta.title || baseMeta.title === '未知书名';
  const noCover = !baseMeta.cover;
  return noTitle || noCover;
}

/**
 * 直接按 ISBN 查询（会扣额度，除非命中缓存）
 * @returns {{ meta, debug }}
 */
async function lookup(isbn) {
  const debug = {
    provider: 'isbn-work',
    enabled: isEnabled(),
    from_cache: false,
    skipped: null,
    error: null,
  };

  if (!isEnabled()) {
    debug.skipped = 'no_app_key';
    return { meta: null, debug };
  }

  const key = String(isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (key.length !== 10 && key.length !== 13) {
    debug.error = 'invalid_isbn';
    return { meta: null, debug };
  }

  const now = Date.now();
  if (now < cooldownUntil) {
    debug.skipped = 'cooldown';
    debug.error = lastError;
    return { meta: null, debug };
  }

  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) {
    debug.from_cache = true;
    return { meta: hit.meta || null, debug };
  }

  const appKey = getAppKey();
  const url =
    `${API}?isbn=${encodeURIComponent(key)}&appKey=${encodeURIComponent(appKey)}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'book-scanner/1.0',
      },
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      lastError = 'bad_json';
      debug.error = lastError;
      cooldownUntil = now + 5 * 60 * 1000;
      return { meta: null, debug };
    }

    if (!data || data.success === false || Number(data.code) === 1) {
      const msg = String((data && (data.msg || data.message)) || 'api_fail');
      lastError = msg;
      debug.error = msg;
      if (/appkey|额度|次数|limit|quota|invalid|无效/i.test(msg)) {
        cooldownUntil = now + FAIL_COOLDOWN_MS;
      }
      cache.set(key, { at: now, meta: null, err: msg });
      return { meta: null, debug };
    }

    const meta = mapPayload(data.data || data.result || data);
    cache.set(key, { at: now, meta });
    return { meta, debug };
  } catch (e) {
    lastError = e.message || String(e);
    debug.error = lastError;
    cooldownUntil = now + 5 * 60 * 1000;
    return { meta: null, debug };
  }
}

/**
 * 用 isbn.work 补全主源结果（缺书名或缺封面时才请求）
 * 不修改传入对象以外的主流程源逻辑
 */
async function fillGaps(baseMeta, isbn) {
  const debug = { provider: 'isbn-work-fill', used: false };
  if (!shouldFill(baseMeta)) {
    debug.skipped = baseMeta
      ? isEnabled()
        ? Date.now() < cooldownUntil
          ? 'cooldown'
          : 'complete'
        : 'no_app_key'
      : 'no_app_key';
    return { meta: baseMeta || null, debug };
  }

  // 仅缺封面时先看缓存
  const cached = peek(isbn);
  let iw = cached;
  let lookDebug = { from_cache: !!cached };
  if (!iw) {
    const r = await lookup(isbn);
    iw = r.meta;
    lookDebug = r.debug;
  } else {
    lookDebug.from_cache = true;
  }

  debug.lookup = lookDebug;
  if (!iw) {
    return { meta: baseMeta || null, debug };
  }

  debug.used = true;
  if (!baseMeta) {
    return {
      meta: {
        title: iw.title || '未知书名',
        authors: iw.authors || '未知作者',
        cover: iw.cover || null,
        publisher: iw.publisher || null,
        published: iw.published || null,
        source: 'isbn-work',
      },
      debug,
    };
  }

  const merged = {
    title:
      !baseMeta.title || baseMeta.title === '未知书名'
        ? iw.title || baseMeta.title
        : baseMeta.title,
    authors:
      !baseMeta.authors || baseMeta.authors === '未知作者'
        ? iw.authors || baseMeta.authors
        : baseMeta.authors,
    cover: baseMeta.cover || iw.cover || null,
    publisher: baseMeta.publisher || iw.publisher || null,
    published: baseMeta.published || iw.published || null,
    source: baseMeta.cover && baseMeta.title && baseMeta.title !== '未知书名'
      ? baseMeta.source
      : [baseMeta.source, 'isbn-work'].filter(Boolean).join('+'),
  };
  return { meta: merged, debug };
}

function status() {
  return {
    enabled: isEnabled(),
    cooldown_remaining_ms: Math.max(0, cooldownUntil - Date.now()),
    cache_size: cache.size,
    last_error: lastError,
  };
}

module.exports = {
  isEnabled,
  peek,
  shouldFill,
  lookup,
  fillGaps,
  status,
  getAppKey,
};
