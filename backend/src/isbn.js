function normalizeIsbn(raw) {
  return String(raw || '')
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();
}

function isValidIsbn(isbn) {
  const s = normalizeIsbn(isbn);
  return s.length === 10 || s.length === 13;
}

async function fetchBookMeta(isbn) {
  const clean = normalizeIsbn(isbn);
  try {
    const res = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${clean}&format=json&jscmd=data`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const info = data[`ISBN:${clean}`];
    if (!info) return null;
    return {
      title: info.title || '未知书名',
      authors: (info.authors || []).map((a) => a.name).join(', ') || '未知作者',
      cover: info.cover?.large || info.cover?.medium || info.cover?.small || null,
      publisher: (info.publishers || []).map((p) => p.name).join(', ') || null,
      published: info.publish_date || null,
    };
  } catch {
    return null;
  }
}

module.exports = { normalizeIsbn, isValidIsbn, fetchBookMeta };
