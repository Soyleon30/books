require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initDb } = require('./db');
const { normalizeIsbn, isValidIsbn, fetchBookMeta } = require('./isbn');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const BOOK_COLS =
  'id, library_id, isbn, title, authors, cover, publisher, published, created_at';

function parseLibraryId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function getLibrary(id) {
  const [rows] = await pool.query(
    'SELECT id, name, description, created_at FROM libraries WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ---------- libraries ----------
app.get('/api/libraries', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.id, l.name, l.description, l.created_at,
              COUNT(b.id) AS book_count
       FROM libraries l
       LEFT JOIN books b ON b.library_id = l.id
       GROUP BY l.id
       ORDER BY l.created_at ASC`
    );
    res.json({ libraries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/libraries', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  if (!name) return res.status(400).json({ error: '图书馆名称不能为空' });
  if (name.length > 128) return res.status(400).json({ error: '名称过长' });

  try {
    const [result] = await pool.query(
      'INSERT INTO libraries (name, description) VALUES (?, ?)',
      [name, description]
    );
    const lib = await getLibrary(result.insertId);
    res.status(201).json({ message: '创建成功', library: lib });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '同名图书馆已存在' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/libraries/:id', async (req, res) => {
  const id = parseLibraryId(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图书馆ID' });
  const name = String(req.body.name || '').trim();
  const description =
    req.body.description === undefined
      ? undefined
      : String(req.body.description || '').trim() || null;
  if (!name) return res.status(400).json({ error: '图书馆名称不能为空' });

  try {
    const fields = ['name = ?'];
    const params = [name];
    if (description !== undefined) {
      fields.push('description = ?');
      params.push(description);
    }
    params.push(id);
    const [result] = await pool.query(
      `UPDATE libraries SET ${fields.join(', ')} WHERE id = ?`,
      params
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '图书馆不存在' });
    }
    res.json({ message: '已更新', library: await getLibrary(id) });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '同名图书馆已存在' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/libraries/:id', async (req, res) => {
  const id = parseLibraryId(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图书馆ID' });
  try {
    const [result] = await pool.query('DELETE FROM libraries WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '图书馆不存在' });
    }
    res.json({ message: '已删除（馆内图书一并删除）' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- books (scoped by library) ----------
app.get('/api/books/check/:isbn', async (req, res) => {
  const isbn = normalizeIsbn(req.params.isbn);
  const libraryId = parseLibraryId(req.query.library_id);
  if (!isValidIsbn(isbn)) {
    return res.status(400).json({ error: 'ISBN格式无效' });
  }
  if (!libraryId) {
    return res.status(400).json({ error: '请先选择图书馆' });
  }
  try {
    if (!(await getLibrary(libraryId))) {
      return res.status(404).json({ error: '图书馆不存在' });
    }
    const [rows] = await pool.query(
      `SELECT ${BOOK_COLS} FROM books WHERE library_id = ? AND isbn = ? LIMIT 1`,
      [libraryId, isbn]
    );
    if (rows.length) {
      return res.json({ exists: true, book: rows[0], library_id: libraryId });
    }
    const meta = await fetchBookMeta(isbn);
    return res.json({ exists: false, meta: meta || null, isbn, library_id: libraryId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/books', async (req, res) => {
  const isbn = normalizeIsbn(req.body.isbn);
  const libraryId = parseLibraryId(req.body.library_id);
  if (!isValidIsbn(isbn)) {
    return res.status(400).json({ error: 'ISBN格式无效' });
  }
  if (!libraryId) {
    return res.status(400).json({ error: '请先选择图书馆' });
  }

  let title = (req.body.title || '').trim();
  let authors = (req.body.authors || '').trim();
  let cover = req.body.cover || null;
  let publisher = req.body.publisher || null;
  let published = req.body.published || null;

  try {
    if (!(await getLibrary(libraryId))) {
      return res.status(404).json({ error: '图书馆不存在' });
    }

    const [existing] = await pool.query(
      `SELECT ${BOOK_COLS} FROM books WHERE library_id = ? AND isbn = ? LIMIT 1`,
      [libraryId, isbn]
    );
    if (existing.length) {
      return res.status(409).json({
        error: '该馆已有此书，未重复录入',
        exists: true,
        book: existing[0],
      });
    }

    if (!title || title === '未知书名') {
      const meta = await fetchBookMeta(isbn);
      if (meta) {
        title = meta.title || title || '未知书名';
        authors = authors || meta.authors || '未知作者';
        cover = cover || meta.cover;
        publisher = publisher || meta.publisher;
        published = published || meta.published;
      }
    }

    title = title || '未知书名';
    authors = authors || '未知作者';

    const [result] = await pool.query(
      `INSERT INTO books (library_id, isbn, title, authors, cover, publisher, published)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [libraryId, isbn, title, authors, cover, publisher, published]
    );

    const [rows] = await pool.query(
      `SELECT ${BOOK_COLS} FROM books WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ message: '添加成功', book: rows[0] });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      const [rows] = await pool.query(
        `SELECT ${BOOK_COLS} FROM books WHERE library_id = ? AND isbn = ? LIMIT 1`,
        [libraryId, isbn]
      );
      return res.status(409).json({
        error: '该馆已有此书，未重复录入',
        exists: true,
        book: rows[0] || null,
      });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/books', async (req, res) => {
  const libraryId = parseLibraryId(req.query.library_id);
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  if (!libraryId) {
    return res.status(400).json({ error: '请先选择图书馆' });
  }

  try {
    let rows;
    if (q) {
      const like = `%${q}%`;
      [rows] = await pool.query(
        `SELECT ${BOOK_COLS}
         FROM books
         WHERE library_id = ?
           AND (title LIKE ? OR authors LIKE ? OR isbn LIKE ?)
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [libraryId, like, like, like, limit, offset]
      );
    } else {
      [rows] = await pool.query(
        `SELECT ${BOOK_COLS}
         FROM books
         WHERE library_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [libraryId, limit, offset]
      );
    }
    res.json({ books: rows, total: rows.length, library_id: libraryId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/books/:isbn', async (req, res) => {
  const isbn = normalizeIsbn(req.params.isbn);
  const libraryId = parseLibraryId(req.query.library_id || req.body?.library_id);
  if (!libraryId) {
    return res.status(400).json({ error: '请先选择图书馆' });
  }
  try {
    const [result] = await pool.query(
      'DELETE FROM books WHERE library_id = ? AND isbn = ?',
      [libraryId, isbn]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '未找到该图书' });
    }
    res.json({ message: '已删除' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function main() {
  await initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`book-scanner-api listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
