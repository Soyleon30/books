/**
 * 封面：下载到本地 data/covers，库里存 /api/covers/xxx.jpg
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COVER_DIR = path.join(__dirname, '..', 'data', 'covers');

function ensureCoverDir() {
  try {
    if (!fs.existsSync(COVER_DIR)) fs.mkdirSync(COVER_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error('[coverStore] mkdir failed', COVER_DIR, e.message || e);
    return false;
  }
}
ensureCoverDir();

const MIN_BYTES = 5000;
const MIN_W = 100;
const MIN_H = 120;

/** 已知占位/空壳图 MD5（可继续追加） */
const BAD_MD5 = new Set([
  // 空/极小
]);

function jpegSize(buf) {
  if (!buf || buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) break;
    if (marker >= 0xc0 && marker <= 0xc3) {
      const h = (buf[i + 5] << 8) | buf[i + 6];
      const w = (buf[i + 7] << 8) | buf[i + 8];
      return { w, h };
    }
    i += 2 + len;
  }
  return null;
}

function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { w, h };
}

function imageSize(buf, ct) {
  const c = String(ct || '').toLowerCase();
  if (c.includes('png') || (buf[0] === 0x89 && buf[1] === 0x50)) return pngSize(buf);
  if (c.includes('jpeg') || c.includes('jpg') || (buf[0] === 0xff && buf[1] === 0xd8))
    return jpegSize(buf);
  return jpegSize(buf) || pngSize(buf);
}

/** 抽样看是否接近纯色（占位灰图常见） */
function isNearlyUniform(buf, sample = 64) {
  if (!buf || buf.length < 200) return true;
  const step = Math.max(1, Math.floor(buf.length / sample));
  let min = 255;
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < buf.length && n < sample; i += step) {
    const v = buf[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  const range = max - min;
  // JPEG 压缩后仍可能有一定波动；范围极小更像空图
  return n > 10 && range < 12;
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  const low = String(url).toLowerCase();
  return (
    low.includes('book-default') ||
    low.includes('default-lpic') ||
    low.includes('default_cover') ||
    low.includes('default-cover') ||
    low.includes('no-cover') ||
    low.includes('nocover') ||
    low.includes('placeholder') ||
    low.includes('no_picture') ||
    low.includes('nopic') ||
    low.includes('cover-default') ||
    (low.endsWith('.gif') && (low.includes('default') || low.includes('shire'))) ||
    /\/s0\d{0,2}\.jpg/i.test(low) // 极个别空 id
  );
}

/**
 * 评估图片缓冲是否像真封面
 * @returns {{ ok, score, reason, w, h, bytes, md5 }}
 */
function scoreCoverBuffer(buf, { contentType = '', url = '' } = {}) {
  const bytes = buf ? buf.length : 0;
  const md5 = buf ? crypto.createHash('md5').update(buf).digest('hex') : '';
  if (!buf || bytes < 100) return { ok: false, score: 0, reason: 'empty', w: 0, h: 0, bytes, md5 };
  if (BAD_MD5.has(md5)) return { ok: false, score: 0, reason: 'known_bad_md5', w: 0, h: 0, bytes, md5 };
  if (isPlaceholderUrl(url))
    return { ok: false, score: 0, reason: 'placeholder_url', w: 0, h: 0, bytes, md5 };

  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('gif'))
    return { ok: false, score: 0, reason: 'gif', w: 0, h: 0, bytes, md5 };
  if (bytes < MIN_BYTES)
    return { ok: false, score: 0, reason: `too_small:${bytes}`, w: 0, h: 0, bytes, md5 };

  const dim = imageSize(buf, ct) || { w: 0, h: 0 };
  const w = dim.w || 0;
  const h = dim.h || 0;
  if (w && h) {
    if (w < MIN_W || h < MIN_H)
      return { ok: false, score: 0, reason: `tiny_dim:${w}x${h}`, w, h, bytes, md5 };
    const ratio = h / w;
    // 书封面通常竖长；过方/过扁可疑
    if (ratio < 0.7 || ratio > 2.2)
      return { ok: false, score: 0, reason: `bad_ratio:${ratio.toFixed(2)}`, w, h, bytes, md5 };
  }

  // 纯色/近纯色（很多占位图）
  if (isNearlyUniform(buf))
    return { ok: false, score: 0, reason: 'near_uniform_placeholder', w, h, bytes, md5 };

  // 打分：更大、更高更像真封面
  let score = Math.min(100, Math.floor(bytes / 2000));
  if (w && h) score += Math.min(40, Math.floor((w * h) / 8000));
  if (bytes > 30000) score += 15;
  if (bytes > 80000) score += 10;
  return { ok: true, score, reason: 'ok', w, h, bytes, md5 };
}

function extFromCt(ct, url) {
  const c = String(ct || '').toLowerCase();
  if (c.includes('png')) return '.png';
  if (c.includes('webp')) return '.webp';
  if (c.includes('gif')) return '.gif';
  if (c.includes('jpeg') || c.includes('jpg')) return '.jpg';
  const m = String(url || '').match(/\.(jpe?g|png|webp|gif)(\?|$)/i);
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  return '.jpg';
}

/**
 * 下载并评分；失败返回 null
 */
async function fetchCoverCandidate(url, timeoutMs = 8000) {
  if (!url || isPlaceholderUrl(url)) {
    return { ok: false, url, reason: 'placeholder_url' };
  }
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'image/*,*/*',
    Referer: 'https://book.douban.com/',
  };
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, url, reason: `http_${res.status}` };
    const ct = String(res.headers.get('content-type') || '');
    const buf = Buffer.from(await res.arrayBuffer());
    const scored = scoreCoverBuffer(buf, { contentType: ct, url });
    return {
      ...scored,
      url,
      contentType: ct,
      buf: scored.ok ? buf : null,
    };
  } catch (e) {
    return { ok: false, url, reason: e.message || String(e) };
  }
}

function getPool() {
  try {
    return require('./db').pool;
  } catch (_) {
    return null;
  }
}

function mimeFromCt(ct, url) {
  const c = String(ct || '').toLowerCase();
  if (c.includes('png')) return 'image/png';
  if (c.includes('webp')) return 'image/webp';
  if (c.includes('gif')) return 'image/gif';
  if (c.includes('jpeg') || c.includes('jpg')) return 'image/jpeg';
  const ext = extFromCt(ct, url);
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

/**
 * 优先写入 MySQL book_covers；同时尝试写本地缓存。
 * 返回对外路径 /api/covers/{isbn}
 */
async function saveCover(isbn, buf, contentType, srcUrl) {
  const key = String(isbn || '')
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();
  if (!key || !buf || !buf.length) return null;
  const mime = mimeFromCt(contentType, srcUrl);
  const publicPath = `/api/covers/${key}`;

  // 1) DB（主存储，PaaS 无 volume 也能用）
  const pool = getPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO book_covers (isbn, mime, bytes, data, source_url)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE mime=VALUES(mime), bytes=VALUES(bytes), data=VALUES(data),
           source_url=VALUES(source_url), updated_at=CURRENT_TIMESTAMP`,
        [key, mime, buf.length, buf, srcUrl ? String(srcUrl).slice(0, 1024) : null]
      );
    } catch (e) {
      console.error('[coverStore] db save failed', e.message || e);
      // 继续尝试磁盘
    }
  }

  // 2) 本地缓存（可选）
  if (ensureCoverDir()) {
    const ext = extFromCt(contentType, srcUrl);
    const name = `${key}${ext}`;
    const full = path.join(COVER_DIR, name);
    try {
      fs.writeFileSync(full, buf);
      for (const e of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
        if (e === ext) continue;
        const other = path.join(COVER_DIR, `${key}${e}`);
        if (fs.existsSync(other)) {
          try {
            fs.unlinkSync(other);
          } catch (_) {}
        }
      }
    } catch (e) {
      console.error('[coverStore] disk save failed', e.message || e);
    }
  }

  return publicPath;
}

function localCoverPath(isbn) {
  const key = String(isbn || '')
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();
  if (!key) return null;
  return `/api/covers/${key}`;
}

function resolveCoverFile(name) {
  const base = path.basename(String(name || ''));
  // 兼容旧路径 xxx.jpg 与新路径纯 isbn
  const m = base.match(/^([0-9Xx]{10,13})(?:\.(jpe?g|png|webp|gif))?$/i);
  if (!m) return null;
  const key = m[1].toUpperCase();
  for (const e of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
    const full = path.join(COVER_DIR, `${key}${e}`);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

async function loadCoverFromDb(isbn) {
  const key = String(isbn || '')
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();
  if (!key) return null;
  const pool = getPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.query(
      `SELECT mime, data, bytes FROM book_covers WHERE isbn = ? LIMIT 1`,
      [key]
    );
    if (!rows.length || !rows[0].data) return null;
    return { mime: rows[0].mime || 'image/jpeg', data: rows[0].data, bytes: rows[0].bytes };
  } catch (e) {
    console.error('[coverStore] db load failed', e.message || e);
    return null;
  }
}

module.exports = {
  COVER_DIR,
  isPlaceholderUrl,
  scoreCoverBuffer,
  fetchCoverCandidate,
  saveCover,
  localCoverPath,
  resolveCoverFile,
  loadCoverFromDb,
  MIN_BYTES,
};
