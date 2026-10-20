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
    local = saveCover(isbn, cand.buf, cand.contentType, u);
    logScrape('cover_saved', {
      isbn,
      src: redactUrl(u),
      local,
      bytes: cand.bytes,
      score: cand.score,
      reason: cand.reason,
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

module.exports = {
  normalizeIsbn,
  isValidIsbn,
  fetchBookMeta,
  fetchBookMetaDetailed,
  cleanCover,
  probeCover,
  pickBestCover,
  isbnWork,
  logScrape,
  logHttp,
};
