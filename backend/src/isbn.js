const fs = require('fs');
const path = require('path');
const isbnWork = require('./isbnWork');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const scrapeLog = fs.createWriteStream(path.join(logDir, 'scrape.log'), {
  flags: 'a',
  encoding: 'utf8',
});
const requestLog = fs.createWriteStream(path.join(logDir, 'requests.log'), {
  flags: 'a',
  encoding: 'utf8',
});

const BODY_MAX = Number(process.env.SCRAPE_LOG_BODY_MAX || 8000);

function redactUrl(url) {
  return String(url || '')
    .replace(/([?&](?:appKey|apikey|api_key|key)=)[^&]*/gi, '$1***')
    .replace(/(appKey|apikey|api_key)=([^&\s]+)/gi, '$1=***');
}

function clip(s, max = BODY_MAX) {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max) + `…[truncated ${t.length - max} chars, total ${t.length}]`;
}

function safeJson(obj, max = BODY_MAX) {
  try {
    return clip(JSON.stringify(obj, null, 0), max);
  } catch {
    return String(obj);
  }
}

function writeLine(stream, obj) {
  try {
    stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`);
  } catch (_) {}
}

/** 刮削总日志：动作 + 入参 + 出参 */
function logScrape(event, payload = {}) {
  writeLine(scrapeLog, { event, ...payload });
  if (process.env.SCRAPE_LOG_CONSOLE === '1') {
    console.log(`[scrape] ${event}`, safeJson(payload, 500));
  }
}

/** HTTP 请求/响应明细 */
function logHttp(entry) {
  writeLine(requestLog, entry);
  writeLine(scrapeLog, { event: 'http', ...entry });
}

function normalizeIsbn(raw) {
  return String(raw || '')
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();
}

function isValidIsbn(isbn) {
  const s = normalizeIsbn(isbn);
  return s.length === 10 || s.length === 13;
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

/** 过滤豆瓣/占位图、无效封面 */
function cleanCover(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/^http:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(u)) return null;
  const low = u.toLowerCase();
  if (
    low.includes('book-default') ||
    low.includes('default-lpic') ||
    low.includes('default_cover') ||
    low.includes('no-cover') ||
    low.includes('nocover') ||
    low.includes('placeholder') ||
    (low.endsWith('.gif') && low.includes('default'))
  ) {
    return null;
  }
  u = u.replace(/\/view\/subject\/s\//, '/view/subject/l/');
  u = u.replace(/\/spic\//, '/lpic/');
  return u;
}

async function fetchText(url, timeoutMs = 8000, tag = 'fetch') {
  const t0 = Date.now();
  const reqHeaders = {
    Accept: 'text/html,application/json,*/*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://book.douban.com/',
  };
  logHttp({
    phase: 'request',
    tag,
    method: 'GET',
    url: redactUrl(url),
    timeout_ms: timeoutMs,
    headers: reqHeaders,
  });
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: reqHeaders,
      redirect: 'follow',
    });
    const text = res.ok ? await res.text() : await res.text().catch(() => '');
    const finalUrl = res.url || url;
    const ct = String(res.headers.get('content-type') || '');
    logHttp({
      phase: 'response',
      tag,
      method: 'GET',
      url: redactUrl(url),
      final_url: redactUrl(finalUrl),
      status: res.status,
      ok: res.ok,
      content_type: ct,
      elapsed_ms: Date.now() - t0,
      body_len: text ? text.length : 0,
      body: clip(text),
    });
    if (!res.ok) return { ok: false, status: res.status, text: text || '', url: finalUrl };
    return { ok: true, status: res.status, text, url: finalUrl };
  } catch (e) {
    logHttp({
      phase: 'error',
      tag,
      method: 'GET',
      url: redactUrl(url),
      elapsed_ms: Date.now() - t0,
      error: e.message || String(e),
      code: e.code || null,
    });
    throw e;
  }
}

async function fetchJson(url, timeoutMs = 8000, tag = 'fetch-json') {
  const r = await fetchText(url, timeoutMs, tag);
  if (!r.ok || !r.text) {
    logScrape('json_parse_skip', {
      tag,
      url: redactUrl(url),
      status: r.status,
      reason: !r.ok ? 'http_not_ok' : 'empty_body',
    });
    return null;
  }
  try {
    const data = JSON.parse(r.text);
    logScrape('json_parsed', {
      tag,
      url: redactUrl(url),
      status: r.status,
      keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : typeof data,
      data: safeJson(data),
    });
    return data;
  } catch (e) {
    logScrape('json_parse_fail', {
      tag,
      url: redactUrl(url),
      status: r.status,
      error: e.message || String(e),
      body_head: clip(r.text, 500),
    });
    return null;
  }
}

async function probeCover(url, timeoutMs = 4000) {
  const u = cleanCover(url);
  if (!u) {
    logScrape('probe_cover', { in: url, cleaned: null, result: 'rejected_by_cleanCover' });
    return null;
  }
  const t0 = Date.now();
  const reqHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'image/*,*/*',
    Referer: 'https://book.douban.com/',
  };
  logHttp({
    phase: 'request',
    tag: 'probe-cover',
    method: 'GET',
    url: redactUrl(u),
    timeout_ms: timeoutMs,
    headers: reqHeaders,
  });
  try {
    const res = await fetch(u, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: reqHeaders,
    });
    const ct = String(res.headers.get('content-type') || '');
    let bufLen = 0;
    let ok = false;
    let reason = null;
    if (!res.ok) {
      reason = `http_${res.status}`;
    } else if (ct && !ct.includes('image') && !ct.includes('octet-stream')) {
      reason = `bad_content_type:${ct}`;
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      bufLen = buf.length;
      if (buf.length < 1500) reason = `too_small:${buf.length}`;
      else ok = true;
    }
    logHttp({
      phase: 'response',
      tag: 'probe-cover',
      method: 'GET',
      url: redactUrl(u),
      status: res.status,
      ok: res.ok,
      content_type: ct,
      body_len: bufLen,
      elapsed_ms: Date.now() - t0,
      probe_ok: ok,
      reason,
    });
    logScrape('probe_cover', {
      in: url,
      cleaned: u,
      status: res.status,
      content_type: ct,
      bytes: bufLen,
      result: ok ? u : null,
      reason,
    });
    return ok ? u : null;
  } catch (e) {
    logHttp({
      phase: 'error',
      tag: 'probe-cover',
      method: 'GET',
      url: redactUrl(u),
      elapsed_ms: Date.now() - t0,
      error: e.message || String(e),
    });
    logScrape('probe_cover', {
      in: url,
      cleaned: u,
      result: null,
      error: e.message || String(e),
    });
    return null;
  }
}

async function fromOpenLibrary(isbn) {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  try {
    const data = await fetchJson(url, 3500, 'openlibrary');
    const info = data && data[`ISBN:${isbn}`];
    if (!info || !info.title) {
      logScrape('source_result', {
        source: 'openlibrary',
        isbn,
        ok: false,
        reason: !data ? 'no_data' : !info ? 'isbn_not_in_response' : 'no_title',
        raw_keys: data && typeof data === 'object' ? Object.keys(data) : [],
      });
      return null;
    }
    const meta = {
      title: pick(info.title),
      authors: pick((info.authors || []).map((a) => a.name).join(', ')),
      cover: cleanCover(
        info.cover && (info.cover.large || info.cover.medium || info.cover.small)
      ),
      publisher: pick((info.publishers || []).map((p) => p.name).join(', ')),
      published: pick(info.publish_date),
      source: 'openlibrary',
    };
    logScrape('source_result', {
      source: 'openlibrary',
      isbn,
      ok: true,
      meta,
      raw_cover: info.cover || null,
    });
    return meta;
  } catch (e) {
    logScrape('source_result', {
      source: 'openlibrary',
      isbn,
      ok: false,
      error: e.message || String(e),
    });
    return null;
  }
}

async function fromGoogleBooks(isbn) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=3`;
  try {
    const data = await fetchJson(url, 3500, 'google');
    const items = (data && data.items) || [];
    if (!items.length) {
      logScrape('source_result', {
        source: 'google',
        isbn,
        ok: false,
        reason: 'no_items',
        totalItems: data && data.totalItems,
        raw: safeJson(data, 2000),
      });
      return null;
    }
    for (const item of items) {
      const v = item.volumeInfo;
      if (!v || !v.title) continue;
      const img =
        (v.imageLinks &&
          (v.imageLinks.large ||
            v.imageLinks.medium ||
            v.imageLinks.thumbnail ||
            v.imageLinks.smallThumbnail)) ||
        null;
      const meta = {
        title: pick(v.title),
        authors: pick((v.authors || []).join(', ')),
        cover: cleanCover(img),
        publisher: pick(v.publisher),
        published: pick(v.publishedDate),
        source: 'google',
      };
      logScrape('source_result', {
        source: 'google',
        isbn,
        ok: true,
        meta,
        raw_imageLinks: v.imageLinks || null,
        volume_id: item.id || null,
      });
      return meta;
    }
    logScrape('source_result', {
      source: 'google',
      isbn,
      ok: false,
      reason: 'items_without_title',
      item_count: items.length,
    });
    return null;
  } catch (e) {
    logScrape('source_result', {
      source: 'google',
      isbn,
      ok: false,
      error: e.message || String(e),
    });
    return null;
  }
}

/** 豆瓣：旧 v2 + 页面 meta（中文书主力，与 isbn.work 无关） */
async function fromDouban(isbn) {
  const keys = [
    process.env.DOUBAN_API_KEY || '',
    '0ac44ae9383380c6b4a750069ef05747',
    '0df993c66c0c636e29ecbb5344252a4a',
  ].filter(Boolean);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const url = `https://api.douban.com/v2/book/isbn/${isbn}?apikey=${encodeURIComponent(key)}`;
    try {
      const data = await fetchJson(url, 5000, `douban-api#${i}`);
      if (data && data.title) {
        const meta = {
          title: pick(data.title),
          authors: pick((data.author || []).join(', '), (data.author || []).join(' / ')),
          cover: cleanCover(
            (data.images && (data.images.large || data.images.medium || data.images.small)) ||
              data.image
          ),
          publisher: pick(data.publisher),
          published: pick(data.pubdate),
          source: 'douban-api',
        };
        logScrape('source_result', {
          source: 'douban-api',
          isbn,
          ok: true,
          key_index: i,
          meta,
          raw_images: data.images || null,
          raw_image: data.image || null,
        });
        return meta;
      }
      logScrape('source_result', {
        source: 'douban-api',
        isbn,
        ok: false,
        key_index: i,
        reason: !data ? 'no_data' : 'no_title',
        raw: safeJson(data, 2000),
      });
    } catch (e) {
      logScrape('source_result', {
        source: 'douban-api',
        isbn,
        ok: false,
        key_index: i,
        error: e.message || String(e),
      });
    }
  }

  try {
    const pageUrl = `https://book.douban.com/isbn/${isbn}/`;
    const page = await fetchText(pageUrl, 8000, 'douban-html');
    if (!page.ok || !page.text) {
      logScrape('source_result', {
        source: 'douban-html',
        isbn,
        ok: false,
        reason: 'page_not_ok',
        status: page.status,
      });
      return null;
    }
    const html = page.text;
    if (html.includes('没有找到') || html.includes('页面不存在')) {
      logScrape('source_result', {
        source: 'douban-html',
        isbn,
        ok: false,
        reason: 'not_found_page',
        final_url: redactUrl(page.url),
      });
      return null;
    }

    const ogTitle = (html.match(/property="og:title"\s+content="([^"]+)"/i) || [])[1];
    const ogImage = (html.match(/property="og:image"\s+content="([^"]+)"/i) || [])[1];
    const title =
      ogTitle ||
      (html.match(/<span\s+property="v:itemreviewed">([^<]+)</i) || [])[1] ||
      (html.match(/<title>([^<]+)/i) || [])[1];

    const subjectCovers = [
      ...html.matchAll(/https:\/\/img\d\.doubanio\.com\/view\/subject\/[ls]\/public\/s\d+\.jpg/gi),
    ].map((m) => m[0]);
    const mainCover =
      cleanCover(subjectCovers.find((u) => /\/l\/public\//.test(u))) ||
      cleanCover(subjectCovers[0]) ||
      cleanCover(ogImage);

    let authors = null;
    const authorBlock = html.match(/作者<\/span>[\s\S]*?<a[^>]*>([^<]+)</);
    if (authorBlock) authors = authorBlock[1];
    const authorLinks = [...html.matchAll(/rel="v:author"[^>]*>([^<]+)</g)].map((m) => m[1]);
    if (authorLinks.length) authors = authorLinks.join(', ');
    const publisher = (html.match(/出版社:<\/span>\s*<a[^>]*>([^<]+)</) ||
      html.match(/出版社:<\/span>\s*([^<\n]+)/) ||
      [])[1];
    const pubdate = (html.match(/出版年:<\/span>\s*([^<\n]+)/) || [])[1];

    const t = pick(
      title && title.replace(/\(豆瓣\)/g, '').replace(/图书/g, '').trim(),
      ogTitle
    );
    if (!t && !mainCover) {
      logScrape('source_result', {
        source: 'douban-html',
        isbn,
        ok: false,
        reason: 'no_title_no_cover',
        ogTitle,
        ogImage,
        subjectCovers,
        final_url: redactUrl(page.url),
      });
      return null;
    }
    const meta = {
      title: t,
      authors: pick(authors),
      cover: mainCover,
      publisher: pick(publisher && publisher.trim()),
      published: pick(pubdate && pubdate.trim()),
      source: 'douban-html',
    };
    logScrape('source_result', {
      source: 'douban-html',
      isbn,
      ok: true,
      meta,
      parse: {
        ogTitle,
        ogImage,
        subjectCovers,
        authors_raw: authors,
        publisher_raw: publisher,
        pubdate_raw: pubdate,
        final_url: redactUrl(page.url),
      },
    });
    return meta;
  } catch (e) {
    logScrape('source_result', {
      source: 'douban-html',
      isbn,
      ok: false,
      error: e.message || String(e),
    });
    return null;
  }
}

async function fromCustomApi(isbn) {
  const tpl = process.env.BOOK_META_API || '';
  if (!tpl) {
    logScrape('source_result', {
      source: 'custom',
      isbn,
      ok: false,
      reason: 'BOOK_META_API_not_set',
    });
    return null;
  }
  try {
    const url = tpl.replace(/\{isbn\}/gi, isbn).replace(/\$\{isbn\}/gi, isbn);
    const data = await fetchJson(url, 8000, 'custom');
    if (!data) {
      logScrape('source_result', { source: 'custom', isbn, ok: false, reason: 'no_data', url: redactUrl(url) });
      return null;
    }
    const d = data.data || data.result || data.book || data;
    const title = pick(d.title, d.bookName, d.name, data.title);
    if (!title) {
      logScrape('source_result', {
        source: 'custom',
        isbn,
        ok: false,
        reason: 'no_title',
        raw: safeJson(data, 3000),
      });
      return null;
    }
    const meta = {
      title,
      authors: pick(d.author, d.authors, d.writer, data.author),
      cover: cleanCover(d.cover || d.image || d.pic || d.img || d.bookPic),
      publisher: pick(d.publisher, d.press),
      published: pick(d.pubdate, d.publish, d.published),
      source: 'custom',
    };
    logScrape('source_result', { source: 'custom', isbn, ok: true, meta, raw: safeJson(data, 3000) });
    return meta;
  } catch (e) {
    logScrape('source_result', {
      source: 'custom',
      isbn,
      ok: false,
      error: e.message || String(e),
    });
    return null;
  }
}

function mergeMeta(parts) {
  const out = {
    title: null,
    authors: null,
    cover: null,
    publisher: null,
    published: null,
    source: null,
  };
  const sources = [];
  for (const p of parts) {
    if (!p) continue;
    out.title = out.title || p.title;
    out.authors = out.authors || p.authors;
    out.cover = out.cover || cleanCover(p.cover);
    out.publisher = out.publisher || p.publisher;
    out.published = out.published || p.published;
    if (p.source) sources.push(p.source);
  }
  if (!out.title && !out.cover && !out.authors) return null;
  out.title = out.title || '未知书名';
  out.authors = out.authors || '未知作者';
  out.source = sources.join('+') || 'merged';
  return out;
}

/**
 * 主刮削：仅免费源（豆瓣 / 自定义 / Google / OL）
 * isbn.work 在其后单独补缺，互不影响
 * @returns {{ meta, debug }}
 */
async function fetchBookMetaDetailed(isbn) {
  const clean = normalizeIsbn(isbn);
  const t0 = Date.now();
  logScrape('scrape_start', { isbn_raw: isbn, isbn: clean });

  if (!isValidIsbn(clean)) {
    const debug = { error: 'invalid isbn' };
    logScrape('scrape_end', { isbn: clean, ok: false, debug, elapsed_ms: Date.now() - t0 });
    return { meta: null, debug };
  }

  const debug = { isbn: clean, tried: [], ok: [], cover_checked: null, isbn_work: null };
  const perSource = {};

  async function tryOne(name, fn) {
    debug.tried.push(name);
    const s0 = Date.now();
    try {
      const r = await fn(clean);
      perSource[name] = { meta: r, elapsed_ms: Date.now() - s0 };
      if (r && (r.title || r.cover)) {
        debug.ok.push(name);
        return r;
      }
      debug.tried.push(name + ':empty');
      return null;
    } catch (e) {
      perSource[name] = { error: e.message || String(e), elapsed_ms: Date.now() - s0 };
      debug.tried.push(name + ':err:' + (e.message || e));
      return null;
    }
  }

  const freeResults = await Promise.all([
    tryOne('douban', fromDouban),
    tryOne('custom', fromCustomApi),
    tryOne('google', fromGoogleBooks),
    tryOne('openlibrary', fromOpenLibrary),
  ]);
  let meta = mergeMeta(freeResults);
  logScrape('merge_free', {
    isbn: clean,
    parts: freeResults.map((p) => (p ? { source: p.source, title: p.title, cover: p.cover } : null)),
    merged: meta,
    per_source: perSource,
  });

  try {
    const before = meta ? { ...meta } : null;
    const filled = await isbnWork.fillGaps(meta, clean);
    debug.isbn_work = filled.debug;
    if (filled.meta) meta = filled.meta;
    logScrape('isbn_work_fill', {
      isbn: clean,
      before,
      after: meta,
      debug: filled.debug,
    });
  } catch (e) {
    debug.isbn_work = { error: e.message || String(e) };
    logScrape('isbn_work_fill', { isbn: clean, error: e.message || String(e) });
  }

  if (meta && meta.cover) {
    const coverIn = meta.cover;
    const okCover = await probeCover(meta.cover);
    debug.cover_checked = okCover ? 'ok' : 'bad';
    meta.cover = okCover;
    logScrape('cover_final', { isbn: clean, in: coverIn, out: okCover, checked: debug.cover_checked });
  } else {
    logScrape('cover_final', { isbn: clean, in: null, out: null, checked: 'skip_no_cover' });
  }

  logScrape('scrape_end', {
    isbn: clean,
    ok: !!(meta && (meta.title || meta.cover)),
    meta,
    debug,
    elapsed_ms: Date.now() - t0,
  });

  return { meta, debug };
}

async function fetchBookMeta(isbn) {
  const { meta } = await fetchBookMetaDetailed(isbn);
  return meta;
}

module.exports = {
  normalizeIsbn,
  isValidIsbn,
  fetchBookMeta,
  fetchBookMetaDetailed,
  cleanCover,
  probeCover,
  isbnWork,
  logScrape,
  logHttp,
};
