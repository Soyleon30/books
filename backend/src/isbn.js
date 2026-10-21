const crypto = require('crypto');
const isbnWork = require('./isbnWork');
const {
  isPlaceholderUrl,
  fetchCoverCandidate,
  saveCover,
  localCoverPath,
} = require('./coverStore');
const {
  redactUrl,
  clip,
  safeJson,
  logScrape,
  logHttp,
  logSummary,
  runWithContext,
} = require('./scrapeLog');

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

/** 过滤豆瓣/占位图、无效封面 URL */
function cleanCover(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/^http:\/\//i, 'https://');
  // 已是本站封面
  if (u.startsWith('/api/covers/')) return u;
  if (!/^https?:\/\//i.test(u)) return null;
  if (isPlaceholderUrl(u)) return null;
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

/**
 * 下载并评分封面；返回 { url, local, candidate } 或 null
 * 坏图/占位图 → null（调用方应换源）
 */
async function probeCover(url, timeoutMs = 8000, isbn = null) {
  const u = cleanCover(url);
  if (!u) {
    logScrape('probe_cover', {
      in: url,
      cleaned: null,
      result: null,
      reason: 'rejected_by_cleanCover',
    });
    return null;
  }
  if (u.startsWith('/api/covers/')) {
    return { url: u, local: u, candidate: { ok: true, reason: 'already_local' } };
  }
  const t0 = Date.now();
  logHttp({
    phase: 'request',
    tag: 'probe-cover',
    method: 'GET',
    url: redactUrl(u),
    timeout_ms: timeoutMs,
  });
  const cand = await fetchCoverCandidate(u, timeoutMs);
  logHttp({
    phase: cand.ok ? 'response' : 'error',
    tag: 'probe-cover',
    method: 'GET',
    url: redactUrl(u),
    status: cand.ok ? 200 : null,
    ok: !!cand.ok,
    content_type: cand.contentType || null,
    body_len: cand.bytes || 0,
    elapsed_ms: Date.now() - t0,
    probe_ok: !!cand.ok,
    reason: cand.reason,
    score: cand.score,
    dim: cand.w && cand.h ? `${cand.w}x${cand.h}` : null,
  });
  logScrape('probe_cover', {
    in: url,
    cleaned: u,
    ok: !!cand.ok,
    reason: cand.reason,
    bytes: cand.bytes,
    score: cand.score,
    w: cand.w,
    h: cand.h,
    md5: cand.md5,
  });
  if (!cand.ok || !cand.buf) return null;
  let local = null;
  if (isbn) {
    try {
      local = await saveCover(isbn, cand.buf, cand.contentType, u);
    } catch (e) {
      logScrape('cover_saved', { isbn, ok: false, error: e.message || String(e) });
      local = null;
    }
    logScrape('cover_saved', {
      isbn,
      src: redactUrl(u),
      local,
      bytes: cand.bytes,
      score: cand.score,
      reason: cand.reason,
      ok: !!local,
    });
  }
  return { url: local || u, local, remote: u, candidate: cand };
}

/** 从多个候选 URL 里选最好的真封面并落盘 */
async function pickBestCover(urls, isbn) {
  const list = [...new Set((urls || []).map(cleanCover).filter(Boolean))];
  let best = null;
  for (const u of list) {
    const r = await probeCover(u, 8000, isbn);
    if (!r || !r.candidate || !r.candidate.ok) continue;
    if (!best || (r.candidate.score || 0) > (best.candidate.score || 0)) best = r;
  }
  return best;
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
 * debug.sites / debug.run_id：各站明细 + 可从 scrape_logs 表按 run_id 查
 */
async function fetchBookMetaDetailed(isbn) {
  const clean = normalizeIsbn(isbn);
  const runId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return runWithContext({ runId, isbn: clean }, () => _fetchBookMetaDetailedInner(isbn, clean, runId));
}

async function _fetchBookMetaDetailedInner(isbn, clean, runId) {
  const t0 = Date.now();
  logScrape('scrape_start', { isbn_raw: isbn, isbn: clean, run_id: runId });
  logSummary(`======== SCRAPE START run=${runId} isbn=${clean} raw=${isbn} ========`, {
    isbn: clean,
    site: null,
  });

  if (!isValidIsbn(clean)) {
    const debug = { error: 'invalid isbn', sites: [], run_id: runId };
    logSummary(`INVALID isbn=${clean}`, { isbn: clean });
    logScrape('scrape_end', { isbn: clean, ok: false, debug, elapsed_ms: Date.now() - t0, run_id: runId });
    return { meta: null, debug };
  }

  const debug = {
    isbn: clean,
    run_id: runId,
    tried: [],
    ok: [],
    cover_checked: null,
    isbn_work: null,
    sites: [],
  };
  const perSource = {};

  async function tryOne(name, fn) {
    debug.tried.push(name);
    const s0 = Date.now();
    logSummary(`  TRY ${name} ...`, { isbn: clean, site: name });
    try {
      const r = await fn(clean);
      const elapsed = Date.now() - s0;
      perSource[name] = { meta: r, elapsed_ms: elapsed };
      if (r && (r.title || r.cover)) {
        debug.ok.push(name);
        const siteRow = {
          site: name,
          ok: true,
          elapsed_ms: elapsed,
          title: r.title || null,
          authors: r.authors || null,
          cover: r.cover || null,
          publisher: r.publisher || null,
          source: r.source || name,
        };
        debug.sites.push(siteRow);
        logScrape('source_result', {
          isbn: clean,
          site: name,
          ok: true,
          meta: r,
          elapsed_ms: elapsed,
          summary: `OK ${name} title=${r.title || '-'} cover=${r.cover || '-'}`,
        });
        logSummary(
          `  OK   ${name} ${elapsed}ms title=${r.title || '-'} cover=${r.cover || '-'} source=${r.source || name}`,
          { isbn: clean, site: name, ok: true, meta: r, elapsed_ms: elapsed }
        );
        return r;
      }
      debug.tried.push(name + ':empty');
      debug.sites.push({
        site: name,
        ok: false,
        elapsed_ms: elapsed,
        reason: 'empty',
        title: null,
        cover: null,
      });
      logScrape('source_result', {
        isbn: clean,
        site: name,
        ok: false,
        reason: 'empty',
        elapsed_ms: elapsed,
        summary: `EMPTY ${name}`,
      });
      logSummary(`  EMPTY ${name} ${elapsed}ms`, { isbn: clean, site: name, ok: false, elapsed_ms: elapsed });
      return null;
    } catch (e) {
      const elapsed = Date.now() - s0;
      const err = e.message || String(e);
      perSource[name] = { error: err, elapsed_ms: elapsed };
      debug.tried.push(name + ':err:' + err);
      debug.sites.push({ site: name, ok: false, elapsed_ms: elapsed, error: err });
      logScrape('source_result', {
        isbn: clean,
        site: name,
        ok: false,
        error: err,
        elapsed_ms: elapsed,
        summary: `ERR ${name} ${err}`,
      });
      logSummary(`  ERR  ${name} ${elapsed}ms ${err}`, {
        isbn: clean,
        site: name,
        ok: false,
        error: err,
        elapsed_ms: elapsed,
      });
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
    per_source: Object.fromEntries(
      Object.entries(perSource).map(([k, v]) => [
        k,
        {
          elapsed_ms: v.elapsed_ms,
          error: v.error || null,
          title: v.meta && v.meta.title,
          cover: v.meta && v.meta.cover,
          source: v.meta && v.meta.source,
        },
      ])
    ),
    meta,
    summary: `MERGE title=${meta && meta.title} cover=${meta && meta.cover}`,
  });
  logSummary(
    `  MERGE free -> title=${meta && meta.title} cover=${meta && meta.cover} source=${meta && meta.source}`,
    { isbn: clean, meta }
  );

  async function applyIsbnWork(reason) {
    const before = meta ? { ...meta } : null;
    const need =
      !meta ||
      !meta.title ||
      meta.title === '未知书名' ||
      !meta.cover;
    if (!need) {
      logSummary(`  isbn-work skip complete (${reason})`, {
        isbn: clean,
        site: 'isbn-work',
        ok: false,
      });
      debug.sites.push({
        site: 'isbn-work',
        ok: false,
        used: false,
        skipped: 'complete',
        reason,
      });
      return false;
    }
    try {
      const filled = await isbnWork.fillGaps(meta, clean);
      debug.isbn_work = filled.debug;
      if (filled.meta) meta = filled.meta;
      const iwUsed = !!(filled.debug && filled.debug.used);
      const iwSkip = filled.debug && filled.debug.skipped;
      debug.sites.push({
        site: 'isbn-work',
        ok: iwUsed,
        used: iwUsed,
        skipped: iwSkip || null,
        reason,
        title: meta && meta.title,
        cover: meta && meta.cover,
        debug: filled.debug,
      });
      logSummary(
        `  isbn-work used=${iwUsed} skipped=${iwSkip || '-'} reason=${reason} title=${meta && meta.title} cover=${meta && meta.cover}`,
        { isbn: clean, site: 'isbn-work', ok: iwUsed, meta }
      );
      logScrape('isbn_work_fill', {
        isbn: clean,
        site: 'isbn-work',
        before,
        after: meta,
        debug: filled.debug,
        ok: iwUsed,
        meta,
        reason,
        summary: `isbn-work used=${iwUsed} skipped=${iwSkip || '-'} reason=${reason}`,
      });
      return iwUsed;
    } catch (e) {
      debug.isbn_work = { error: e.message || String(e) };
      debug.sites.push({
        site: 'isbn-work',
        ok: false,
        error: e.message || String(e),
        reason,
      });
      logSummary(`  isbn-work ERR ${e.message || e}`, {
        isbn: clean,
        site: 'isbn-work',
        ok: false,
        error: e.message || String(e),
      });
      return false;
    }
  }

  // 收集各免费源封面候选
  const coverCandidates = [];
  for (const p of freeResults) {
    if (p && p.cover) coverCandidates.push(p.cover);
  }

  // 免费源缺书名或缺封面 → isbn.work
  await applyIsbnWork('after_free');
  if (meta && meta.cover) coverCandidates.push(meta.cover);

  // 下载+评分；占位/坏图淘汰；最好的落盘成本站路径
  let coverPick = await pickBestCover(coverCandidates, clean);
  if (!coverPick) {
    logSummary(`  COVER all candidates bad/empty -> isbn.work`, {
      isbn: clean,
      site: 'probe-cover',
      ok: false,
    });
    if (meta) meta.cover = null;
    await applyIsbnWork('after_bad_cover');
    if (meta && meta.cover) {
      coverPick = await probeCover(meta.cover, 8000, clean);
    }
  }

  if (coverPick && coverPick.url) {
    if (meta) meta.cover = coverPick.url;
    else {
      meta = {
        title: '未知书名',
        authors: '未知作者',
        cover: coverPick.url,
        source: 'cover-only',
      };
    }
    debug.cover_checked = coverPick.candidate && coverPick.candidate.reason
      ? coverPick.candidate.reason
      : 'ok';
    debug.cover_local = coverPick.local || null;
    debug.cover_remote = coverPick.remote || null;
    debug.sites.push({
      site: 'cover-store',
      ok: true,
      local: coverPick.local,
      remote: coverPick.remote,
      score: coverPick.candidate && coverPick.candidate.score,
      reason: coverPick.candidate && coverPick.candidate.reason,
      w: coverPick.candidate && coverPick.candidate.w,
      h: coverPick.candidate && coverPick.candidate.h,
      bytes: coverPick.candidate && coverPick.candidate.bytes,
    });
    logScrape('cover_final', {
      isbn: clean,
      site: 'cover-store',
      ok: true,
      out: meta.cover,
      local: coverPick.local,
      remote: coverPick.remote,
      score: coverPick.candidate && coverPick.candidate.score,
      reason: coverPick.candidate && coverPick.candidate.reason,
      summary: `COVER local=${coverPick.local || meta.cover} score=${coverPick.candidate && coverPick.candidate.score}`,
    });
    logSummary(
      `  COVER saved ${meta.cover} score=${coverPick.candidate && coverPick.candidate.score} ${coverPick.candidate && coverPick.candidate.w}x${coverPick.candidate && coverPick.candidate.h}`,
      { isbn: clean, site: 'cover-store', ok: true, meta }
    );
  } else {
    if (meta) meta.cover = localCoverPath(clean) || null;
    debug.cover_checked = 'none';
    debug.sites.push({ site: 'cover-store', ok: false, reason: 'no_good_cover' });
    logScrape('cover_final', {
      isbn: clean,
      site: 'cover-store',
      ok: false,
      out: meta && meta.cover,
      reason: 'no_good_cover',
      summary: 'COVER none (placeholder/bad rejected)',
    });
    logSummary(`  COVER none (占位/坏图已拒绝)`, {
      isbn: clean,
      site: 'cover-store',
      ok: false,
    });
  }

  const elapsed = Date.now() - t0;
  const okFinal = !!(meta && (meta.title || meta.cover));
  logScrape('scrape_end', {
    isbn: clean,
    ok: okFinal,
    meta,
    debug: {
      run_id: runId,
      tried: debug.tried,
      ok: debug.ok,
      cover_checked: debug.cover_checked,
      sites: debug.sites,
    },
    elapsed_ms: elapsed,
    run_id: runId,
    summary: `END ok=${okFinal} title=${meta && meta.title} cover=${meta && meta.cover} ${elapsed}ms`,
  });
  logSummary(
    `======== SCRAPE END run=${runId} isbn=${clean} ok=${okFinal} ` +
      `title=${meta && meta.title} cover=${meta && meta.cover} ${elapsed}ms ========`,
    { isbn: clean, ok: okFinal, meta, elapsed_ms: elapsed }
  );

  return { meta, debug };
}

async function fetchBookMeta(isbn) {
  const { meta } = await fetchBookMetaDetailed(isbn);
  return meta;
}

function extractIsbnFromIds(ids) {
  if (!Array.isArray(ids)) return null;
  for (const it of ids) {
    const t = String((it && (it.type || it)) || '').toLowerCase();
    const v = normalizeIsbn(it && (it.identifier || it.value || it));
    if (!v) continue;
    if (t.includes('isbn_13') || t.includes('isbn13')) return v.length === 13 ? v : null;
    if (t.includes('isbn_10') || t.includes('isbn10')) return v;
    if (t.includes('isbn') && (v.length === 10 || v.length === 13)) return v;
  }
  for (const it of ids) {
    const v = normalizeIsbn(it && (it.identifier || it.value || it));
    if (v && (v.length === 10 || v.length === 13) && isValidIsbn(v)) return v;
  }
  return null;
}

function normTitleKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[《》【】\[\]（）()·・\s:：\-—_'"“”‘’]/g, '')
    .replace(/的/g, '');
}

/** 查询词与候选书名相似度 0~100（偏严，避免短串/散字误匹配） */
function titleSimilarity(query, title) {
  const q = normTitleKey(query);
  const t = normTitleKey(title);
  if (!q || !t) return 0;
  if (q === t) return 100;

  const qLen = q.length;
  const tLen = t.length;
  const minLen = Math.min(qLen, tLen);
  const maxLen = Math.max(qLen, tLen);
  const lenRatio = minLen / maxLen;

  // 一方包含另一方：要求长度接近，避免「三」命中「三体」类短串误伤
  if (t.includes(q) || q.includes(t)) {
    if (minLen < 2) return 0;
    if (lenRatio < 0.45 && minLen < 4) return Math.round(25 + lenRatio * 30);
    if (lenRatio < 0.55 && minLen < 6) return Math.round(45 + lenRatio * 30);
    return Math.round(72 + lenRatio * 28);
  }

  // 连续 bigram / trigram（中文主路径）
  let dig = 0;
  let digHit = 0;
  for (let i = 0; i < qLen - 1; i++) {
    dig += 1;
    if (t.includes(q.slice(i, i + 2))) digHit += 1;
  }
  const digRate = dig ? digHit / dig : 0;

  let tri = 0;
  let triHit = 0;
  for (let i = 0; i < qLen - 2; i++) {
    tri += 1;
    if (t.includes(q.slice(i, i + 3))) triHit += 1;
  }
  const triRate = tri ? triHit / tri : 0;

  // 最长公共子串
  let lcs = 0;
  const qChars = [...q];
  const tChars = [...t];
  const dp = new Array(tChars.length + 1).fill(0);
  for (let i = 0; i < qChars.length; i++) {
    let prev = 0;
    for (let j = 0; j < tChars.length; j++) {
      const tmp = dp[j + 1];
      if (qChars[i] === tChars[j]) {
        dp[j + 1] = prev + 1;
        if (dp[j + 1] > lcs) lcs = dp[j + 1];
      } else {
        dp[j + 1] = 0;
      }
      prev = tmp;
    }
  }
  const lcsRatio = lcs / maxLen;

  // 字符集合覆盖（仅作弱信号，不再单独给中高分）
  const qSet = [...new Set(qChars)];
  let setHit = 0;
  for (const c of qSet) {
    if (t.includes(c)) setHit += 1;
  }
  const cover = qSet.length ? setHit / qSet.length : 0;

  // 主分：连续匹配优先
  if (tri >= 1 && triRate >= 0.6 && lcs >= 3) {
    return Math.round(55 + triRate * 25 + lcsRatio * 15);
  }
  if (dig >= 2 && digRate >= 0.65 && lcs >= 2) {
    return Math.round(42 + digRate * 30 + lcsRatio * 12);
  }
  if (lcs >= 4 && lcsRatio >= 0.45) {
    return Math.round(38 + lcsRatio * 40);
  }
  if (dig >= 2 && digRate >= 0.5 && cover >= 0.7 && qLen >= 4) {
    return Math.round(28 + digRate * 25 + cover * 15);
  }
  // 散字重合不够：压低，避免乱匹配进候选
  if (cover >= 0.85 && qLen >= 4 && digRate >= 0.35) {
    return Math.round(18 + cover * 15);
  }
  return Math.round(Math.min(cover, digRate) * 22);
}

function buildTitleQueryVariants(query) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  const set = new Set([q]);
  // 去书名号
  set.add(q.replace(/[《》]/g, ''));
  // 去常见后缀词再搜一次
  const stripped = q.replace(/(自传|回忆录|全集|选集|文集|小说|故事)$/g, '').trim();
  if (stripped.length >= 2 && stripped !== q) set.add(stripped);
  // 空格拆开取最长中文段
  for (const part of q.split(/\s+/)) {
    if (/[\u4e00-\u9fff]{2,}/.test(part)) set.add(part);
  }
  return [...set].filter((s) => s.length >= 2).slice(0, 4);
}

async function doubanSuggest(q) {
  const url = `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`;
  try {
    const r = await fetchText(url, 6000, 'douban-suggest');
    if (!r || !r.ok || !r.text) return [];
    const data = JSON.parse(r.text);
    if (!Array.isArray(data)) return [];
    return data
      .filter((x) => x && (x.type === 'b' || x.type === 'book' || x.url || x.id))
      .map((x) => ({
        title: pick(x.title),
        authors: pick(x.author_name || x.author),
        cover: cleanCover(x.pic || x.img),
        published: pick(x.year),
        douban_id: x.id != null ? String(x.id) : null,
        url: x.url || (x.id ? `https://book.douban.com/subject/${x.id}/` : null),
        source: 'douban-suggest',
      }))
      .filter((x) => x.title);
  } catch (e) {
    logScrape('title_search', {
      source: 'douban-suggest',
      q,
      ok: false,
      error: e.message || String(e),
    });
    return [];
  }
}

/** 从豆瓣条目页尽量抠 ISBN（有则用于入库） */
async function doubanSubjectIsbn(subjectIdOrUrl) {
  let url = subjectIdOrUrl;
  if (!url) return null;
  if (!/^https?:/i.test(url)) {
    url = `https://book.douban.com/subject/${url}/`;
  }
  try {
    const r = await fetchText(url, 7000, 'douban-subject');
    const html = r && r.text;
    if (!html) return null;
    const m =
      html.match(/ISBN[:：\s]*([0-9Xx\-]{10,17})/i) ||
      html.match(/itemprop="isbn"[^>]*content="([0-9Xx\-]+)"/i) ||
      html.match(/"isbn13"\s*:\s*"([0-9Xx\-]+)"/i) ||
      html.match(/"isbn10"\s*:\s*"([0-9Xx\-]+)"/i);
    if (!m) return null;
    const n = normalizeIsbn(m[1]);
    return isValidIsbn(n) ? n : null;
  } catch (e) {
    logScrape('title_search', {
      source: 'douban-subject',
      ok: false,
      error: e.message || String(e),
    });
    return null;
  }
}

/** 按书名检索；diag 为 matchLog 可选回调 */
async function searchByTitle(query, limit = 8, diag) {
  const q0 = String(query || '').trim().slice(0, 120);
  const dlog = diag && typeof diag.log === 'function' ? diag : null;
  if (q0.length < 2) {
    if (dlog) dlog.log('search_skip', { query_text: q0, reason: 'too_short', ok: false });
    return [];
  }
  const variants = buildTitleQueryVariants(q0);
  if (dlog) {
    dlog.log('search_begin', {
      query_text: q0,
      ok: true,
      request: { query: q0, variants, limit },
      summary: `variants=${variants.join('|')}`,
    });
  }
  const out = [];
  const seen = new Set();
  const siteStats = [];

  const push = (item) => {
    if (!item || !item.title) return;
    const isbn = item.isbn ? normalizeIsbn(item.isbn) : null;
    const key =
      (isbn && isValidIsbn(isbn) ? isbn : '') ||
      item.douban_id ||
      `${item.title}|${item.authors || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    let sim = titleSimilarity(q0, item.title);
    // 作者名仅作微弱加分，禁止把「作者当书名」抬到可自动选
    if (item.authors && sim >= 35) {
      const as = titleSimilarity(q0, item.authors);
      if (as >= 50) sim = Math.min(100, sim + 6);
      else if (as >= 30) sim = Math.min(100, sim + 3);
    }
    // 有封面略加分（不改变排序主序）
    if (item.cover && sim >= 40) sim = Math.min(100, sim + 1);
    out.push({
      title: item.title,
      authors: item.authors || null,
      cover: item.cover || null,
      publisher: item.publisher || null,
      published: item.published || null,
      isbn: isbn && isValidIsbn(isbn) ? isbn : null,
      douban_id: item.douban_id || null,
      source: item.source || null,
      match_score: sim,
    });
  };

  async function googleSearch(q, mode) {
    const qq = mode === 'intitle' ? `intitle:${q}` : q;
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(qq)}&maxResults=${Math.min(limit + 2, 12)}`;
    const t0 = Date.now();
    try {
      const data = await fetchJson(url, 5000, `google-search-${mode}`);
      const items = (data && data.items) || [];
      const before = out.length;
      for (const item of items) {
        const v = item.volumeInfo || {};
        if (!v.title) continue;
        const img =
          (v.imageLinks &&
            (v.imageLinks.thumbnail ||
              v.imageLinks.smallThumbnail ||
              v.imageLinks.medium ||
              v.imageLinks.large)) ||
          null;
        push({
          title: pick(v.title),
          authors: pick((v.authors || []).join(', ')),
          cover: cleanCover(img),
          publisher: pick(v.publisher),
          published: pick(v.publishedDate),
          isbn: extractIsbnFromIds(v.industryIdentifiers),
          source: mode === 'intitle' ? 'google-intitle' : 'google',
        });
      }
      const added = out.length - before;
      siteStats.push({ site: `google:${mode}`, q, ok: true, hits: items.length, added });
      if (dlog) {
        dlog.log('site_call', {
          site: `google:${mode}`,
          query_text: q,
          ok: true,
          elapsed_ms: Date.now() - t0,
          request: { url, q, mode },
          response: {
            totalItems: data && data.totalItems,
            sample: items.slice(0, 3).map((it) => {
              const v = it.volumeInfo || {};
              return { title: v.title, authors: v.authors, ids: v.industryIdentifiers };
            }),
          },
          hits: out.slice(-added).map((x) => ({
            title: x.title,
            isbn: x.isbn,
            score: x.match_score,
            cover: !!x.cover,
          })),
          summary: `google ${mode} hits=${items.length} added=${added}`,
        });
      }
      logScrape('title_search', { source: 'google', mode, q, ok: true, hits: items.length });
    } catch (e) {
      siteStats.push({ site: `google:${mode}`, q, ok: false, error: e.message || String(e) });
      if (dlog) {
        dlog.log('site_call', {
          site: `google:${mode}`,
          query_text: q,
          ok: false,
          elapsed_ms: Date.now() - t0,
          request: { url, q, mode },
          reason: e.message || String(e),
          summary: `google ${mode} FAIL ${e.message || e}`,
        });
      }
      logScrape('title_search', {
        source: 'google',
        mode,
        q,
        ok: false,
        error: e.message || String(e),
      });
    }
  }

  async function openLibrarySearch(q) {
    const t0 = Date.now();
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 12)}`;
    try {
      const data = await fetchJson(url, 5000, 'ol-search');
      const docs = (data && data.docs) || [];
      const before = out.length;
      for (const d of docs) {
        const isbnList = d.isbn || [];
        let isbn = null;
        for (const x of isbnList) {
          const n = normalizeIsbn(x);
          if (isValidIsbn(n) && n.length === 13) {
            isbn = n;
            break;
          }
        }
        if (!isbn) {
          for (const x of isbnList) {
            const n = normalizeIsbn(x);
            if (isValidIsbn(n)) {
              isbn = n;
              break;
            }
          }
        }
        const coverId = d.cover_i;
        push({
          title: pick(d.title),
          authors: pick((d.author_name || []).join(', ')),
          cover: coverId
            ? cleanCover(`https://covers.openlibrary.org/b/id/${coverId}-L.jpg`)
            : isbn
              ? cleanCover(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`)
              : null,
          publisher: pick((d.publisher || [])[0]),
          published: pick(d.first_publish_year && String(d.first_publish_year)),
          isbn,
          source: 'openlibrary',
        });
      }
      const added = out.length - before;
      siteStats.push({ site: 'openlibrary', q, ok: true, hits: docs.length, added });
      if (dlog) {
        dlog.log('site_call', {
          site: 'openlibrary',
          query_text: q,
          ok: true,
          elapsed_ms: Date.now() - t0,
          request: { url, q },
          response: {
            numFound: data && data.numFound,
            sample: docs.slice(0, 3).map((d) => ({
              title: d.title,
              author_name: d.author_name,
              isbn: (d.isbn || []).slice(0, 2),
            })),
          },
          hits: out.slice(-added).map((x) => ({
            title: x.title,
            isbn: x.isbn,
            score: x.match_score,
            cover: !!x.cover,
          })),
          summary: `ol hits=${docs.length} added=${added}`,
        });
      }
      logScrape('title_search', { source: 'openlibrary', q, ok: true, hits: docs.length });
    } catch (e) {
      siteStats.push({ site: 'openlibrary', q, ok: false, error: e.message || String(e) });
      if (dlog) {
        dlog.log('site_call', {
          site: 'openlibrary',
          query_text: q,
          ok: false,
          elapsed_ms: Date.now() - t0,
          reason: e.message || String(e),
          summary: `ol FAIL ${e.message || e}`,
        });
      }
      logScrape('title_search', {
        source: 'openlibrary',
        q,
        ok: false,
        error: e.message || String(e),
      });
    }
  }

  // 1) 豆瓣（中文主源）
  for (const v of variants) {
    const t0 = Date.now();
    const rows = await doubanSuggest(v);
    const before = out.length;
    for (const row of rows) {
      // 豆瓣小图换大图
      if (row.cover) {
        row.cover = cleanCover(
          String(row.cover)
            .replace(/\/s\//g, '/l/')
            .replace(/\/spic\//g, '/lpic/')
            .replace(/\/view\/subject\/s\//, '/view/subject/l/')
        );
      }
      push(row);
    }
    const added = out.length - before;
    siteStats.push({ site: 'douban-suggest', q: v, ok: true, hits: rows.length, added });
    if (dlog) {
      dlog.log('site_call', {
        site: 'douban-suggest',
        query_text: v,
        ok: rows.length > 0,
        elapsed_ms: Date.now() - t0,
        request: {
          url: `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(v)}`,
          q: v,
        },
        response: {
          raw_n: rows.length,
          sample: rows.slice(0, 5).map((x) => ({
            title: x.title,
            authors: x.authors,
            id: x.douban_id,
            cover: x.cover,
          })),
        },
        hits: out.slice(-added).map((x) => ({
          title: x.title,
          isbn: x.isbn,
          score: x.match_score,
          cover: !!x.cover,
        })),
        reason: rows.length ? null : 'empty_suggest',
        summary: `douban suggest q=${v} hits=${rows.length} added=${added}`,
      });
    }
    logScrape('title_search', {
      source: 'douban-suggest',
      q: v,
      ok: true,
      hits: rows.length,
    });
  }

  // 2) 补 ISBN + 封面（高分优先，最多 5）
  const needIsbn = out
    .filter((x) => !x.isbn && (x.douban_id || x.source === 'douban-suggest'))
    .sort((a, b) => (b.match_score || 0) - (a.match_score || 0))
    .slice(0, 5);
  for (const it of needIsbn) {
    const t0 = Date.now();
    const isbn = await doubanSubjectIsbn(it.douban_id || it.url);
    if (isbn) {
      it.isbn = isbn;
      if (!it.cover) {
        it.cover = cleanCover(`https://img3.doubanio.com/view/subject/l/public/s${it.douban_id}.jpg`);
      }
      if (dlog) {
        dlog.log('site_call', {
          site: 'douban-subject',
          query_text: q0,
          ok: true,
          elapsed_ms: Date.now() - t0,
          request: { douban_id: it.douban_id, title: it.title },
          response: { isbn, title: it.title },
          summary: `douban subject isbn=${isbn} title=${it.title}`,
        });
      }
    } else if (dlog) {
      dlog.log('site_call', {
        site: 'douban-subject',
        query_text: q0,
        ok: false,
        elapsed_ms: Date.now() - t0,
        request: { douban_id: it.douban_id, title: it.title },
        reason: 'isbn_not_found_on_page',
        summary: `douban subject no isbn title=${it.title}`,
      });
    }
  }

  // 3) 有 ISBN 无封面：用 OL / 豆瓣图兜底
  for (const it of out) {
    if (it.isbn && !it.cover) {
      it.cover =
        cleanCover(`https://covers.openlibrary.org/b/isbn/${it.isbn}-L.jpg`) ||
        it.cover;
    }
  }

  // 4) Google / OL 补充
  if (out.length < limit) {
    for (const v of variants.slice(0, 2)) {
      await googleSearch(v, 'intitle');
      if (out.length >= limit * 2) break;
    }
  }
  if (out.length < Math.ceil(limit / 2)) {
    await openLibrarySearch(variants[0] || q0);
  }

  for (const it of out) {
    if (it.match_score == null) it.match_score = titleSimilarity(q0, it.title);
  }
  out.sort((a, b) => {
    const ds = (b.match_score || 0) - (a.match_score || 0);
    if (ds) return ds;
    const cover = (b.cover ? 1 : 0) - (a.cover ? 1 : 0);
    if (cover) return cover;
    return (b.isbn ? 1 : 0) - (a.isbn ? 1 : 0);
  });

  // 候选门槛提高：弱相关不进列表，避免「选择版本」一堆乱项
  const filtered = out.filter((x) => (x.match_score || 0) >= 35);
  let finalList = filtered.slice(0, limit);
  // 全灭时放宽一次，仍要求最低相关
  if (!finalList.length) {
    finalList = out
      .filter((x) => (x.match_score || 0) >= 28)
      .slice(0, Math.min(5, limit));
  }

  if (dlog) {
    dlog.log('search_end', {
      query_text: q0,
      ok: finalList.length > 0,
      reason: finalList.length
        ? null
        : siteStats.every((s) => s.ok === false)
          ? 'all_sites_failed'
          : 'no_relevant_hits',
      hits: finalList.map((x) => ({
        title: x.title,
        authors: x.authors,
        isbn: x.isbn,
        score: x.match_score,
        source: x.source,
        cover: !!x.cover,
      })),
      response: { site_stats: siteStats, raw_n: out.length, kept_n: finalList.length },
      summary: finalList.length
        ? `kept=${finalList.length} top=${finalList[0].title}#${finalList[0].match_score}`
        : `no hit; sites=${JSON.stringify(siteStats).slice(0, 200)}`,
    });
  }

  return finalList;
}

/** 为匹配结果落盘封面（有远程 URL + ISBN 时） */
async function ensureMatchCover(item) {
  if (!item) return item;
  if (item.cover && String(item.cover).startsWith('/api/covers/')) return item;
  const isbn = item.isbn ? normalizeIsbn(item.isbn) : null;
  if (!isbn || !isValidIsbn(isbn)) return item;
  // 已有本地
  const local = localCoverPath(isbn);
  if (local && item.cover && String(item.cover).includes(isbn)) {
    item.cover = local;
    return item;
  }
  const urls = [];
  if (item.cover) urls.push(item.cover);
  urls.push(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`);
  if (item.douban_id) {
    urls.push(`https://img3.doubanio.com/view/subject/l/public/s${item.douban_id}.jpg`);
  }
  try {
    const best = await pickBestCover(urls, isbn);
    if (best && best.local) item.cover = best.local;
    else if (best && best.url) item.cover = best.url;
    else if (local) item.cover = local;
  } catch (_) {
    if (local) item.cover = local;
  }
  return item;
}

module.exports = {
  normalizeIsbn,
  isValidIsbn,
  fetchBookMeta,
  fetchBookMetaDetailed,
  searchByTitle,
  titleSimilarity,
  ensureMatchCover,
  cleanCover,
  probeCover,
  pickBestCover,
  isbnWork,
  logScrape,
  logHttp,
};
