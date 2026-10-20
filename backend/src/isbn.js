const isbnWork = require('./isbnWork');

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

async function fetchText(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'text/html,application/json,*/*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: 'https://book.douban.com/',
    },
    redirect: 'follow',
  });
  if (!res.ok) return { ok: false, status: res.status, text: '' };
  const text = await res.text();
  return { ok: true, status: res.status, text, url: res.url };
}

async function fetchJson(url, timeoutMs = 8000) {
  const r = await fetchText(url, timeoutMs);
  if (!r.ok || !r.text) return null;
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

async function probeCover(url, timeoutMs = 4000) {
  const u = cleanCover(url);
  if (!u) return null;
  try {
    const res = await fetch(u, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/*,*/*',
        Referer: 'https://book.douban.com/',
      },
    });
    if (!res.ok) return null;
    const ct = String(res.headers.get('content-type') || '');
    if (ct && !ct.includes('image') && !ct.includes('octet-stream')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1500) return null;
    return u;
  } catch {
    return null;
  }
}

async function fromOpenLibrary(isbn) {
  try {
    const data = await fetchJson(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
      3500
    );
    const info = data && data[`ISBN:${isbn}`];
    if (!info || !info.title) return null;
    return {
      title: pick(info.title),
      authors: pick((info.authors || []).map((a) => a.name).join(', ')),
      cover: cleanCover(
        info.cover && (info.cover.large || info.cover.medium || info.cover.small)
      ),
      publisher: pick((info.publishers || []).map((p) => p.name).join(', ')),
      published: pick(info.publish_date),
      source: 'openlibrary',
    };
  } catch {
    return null;
  }
}

async function fromGoogleBooks(isbn) {
  try {
    const data = await fetchJson(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=3`,
      3500
    );
    const items = (data && data.items) || [];
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
      return {
        title: pick(v.title),
        authors: pick((v.authors || []).join(', ')),
        cover: cleanCover(img),
        publisher: pick(v.publisher),
        published: pick(v.publishedDate),
        source: 'google',
      };
    }
    return null;
  } catch {
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

  for (const key of keys) {
    try {
      const data = await fetchJson(
        `https://api.douban.com/v2/book/isbn/${isbn}?apikey=${encodeURIComponent(key)}`,
        5000
      );
      if (data && data.title) {
        return {
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
      }
    } catch {
      /* next */
    }
  }

  try {
    const page = await fetchText(`https://book.douban.com/isbn/${isbn}/`, 8000);
    if (!page.ok || !page.text) return null;
    const html = page.text;
    if (html.includes('没有找到') || html.includes('页面不存在')) return null;

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
    if (!t && !mainCover) return null;
    return {
      title: t,
      authors: pick(authors),
      cover: mainCover,
      publisher: pick(publisher && publisher.trim()),
      published: pick(pubdate && pubdate.trim()),
      source: 'douban-html',
    };
  } catch {
    return null;
  }
}

async function fromCustomApi(isbn) {
  const tpl = process.env.BOOK_META_API || '';
  if (!tpl) return null;
  try {
    const url = tpl.replace(/\{isbn\}/gi, isbn).replace(/\$\{isbn\}/gi, isbn);
    const data = await fetchJson(url, 8000);
    if (!data) return null;
    const d = data.data || data.result || data.book || data;
    const title = pick(d.title, d.bookName, d.name, data.title);
    if (!title) return null;
    return {
      title,
      authors: pick(d.author, d.authors, d.writer, data.author),
      cover: cleanCover(d.cover || d.image || d.pic || d.img || d.bookPic),
      publisher: pick(d.publisher, d.press),
      published: pick(d.pubdate, d.publish, d.published),
      source: 'custom',
    };
  } catch {
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
  if (!isValidIsbn(clean)) {
    return { meta: null, debug: { error: 'invalid isbn' } };
  }

  const debug = { isbn: clean, tried: [], ok: [], cover_checked: null, isbn_work: null };

  async function tryOne(name, fn) {
    debug.tried.push(name);
    try {
      const r = await fn(clean);
      if (r && (r.title || r.cover)) {
        debug.ok.push(name);
        return r;
      }
      debug.tried.push(name + ':empty');
      return null;
    } catch (e) {
      debug.tried.push(name + ':err:' + (e.message || e));
      return null;
    }
  }

  // —— 主流程：与 isbn.work 完全分离 ——
  const freeResults = await Promise.all([
    tryOne('douban', fromDouban),
    tryOne('custom', fromCustomApi),
    tryOne('google', fromGoogleBooks),
    tryOne('openlibrary', fromOpenLibrary),
  ]);
  let meta = mergeMeta(freeResults);

  // —— 独立补缺：仅缺书名/封面且配置了 key 时 ——
  try {
    const filled = await isbnWork.fillGaps(meta, clean);
    debug.isbn_work = filled.debug;
    if (filled.meta) meta = filled.meta;
  } catch (e) {
    debug.isbn_work = { error: e.message || String(e) };
  }

  if (meta && meta.cover) {
    const okCover = await probeCover(meta.cover);
    debug.cover_checked = okCover ? 'ok' : 'bad';
    meta.cover = okCover;
  }

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
};
