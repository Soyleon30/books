const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS || 7 * 24 * 3600 * 1000);
const SALT_ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), SALT_ROUNDS);
}

function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    return bcrypt.compareSync(String(plain), String(hash));
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, userId, expires]
  );
  return { token, expires_at: expires.toISOString() };
}

async function destroySession(token) {
  if (!token) return;
  await pool.query(`DELETE FROM sessions WHERE token = ?`, [token]);
}

async function destroyUserSessions(userId) {
  await pool.query(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

async function getUserByToken(token) {
  if (!token) return null;
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? LIMIT 1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status !== 'active') return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(token);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
  };
}

function extractToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim();
  }
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return '';
}

function publicPath(req) {
  // 兼容挂载路径差异：/api/auth/login 或 /auth/login
  const p = String(req.path || req.url || '').split('?')[0];
  if (req.method === 'GET' && (p === '/api/health' || p === '/health' || p.endsWith('/health'))) {
    return true;
  }
  if (req.method === 'POST' && (p === '/api/auth/login' || p === '/auth/login' || p.endsWith('/auth/login'))) {
    return true;
  }
  return false;
}

function authRequired(req, res, next) {
  if (publicPath(req)) return next();
  const token = extractToken(req);
  getUserByToken(token)
    .then((user) => {
      if (!user) {
        return res.status(401).json({ error: '未登录或登录已过期' });
      }
      req.user = user;
      req.token = token;
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

/** 可写：admin / user；viewer 只读 */
function writeRequired(req, res, next) {
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'user') return next();
  return res.status(403).json({ error: '只读账号，无写入权限' });
}

function normalizeRole(raw) {
  const r = String(raw || 'user').trim().toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'viewer' || r === 'readonly' || r === 'read') return 'viewer';
  return 'user';
}

async function ensureDefaultAdmin() {
  const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM users`);
  if (rows[0].c > 0) return;
  const user = process.env.ADMIN_USERNAME || 'admin';
  const pass = process.env.ADMIN_PASSWORD || 'a123456';
  const [r] = await pool.query(
    `INSERT INTO users (username, password_hash, display_name, role, status)
     VALUES (?, ?, ?, 'admin', 'active')`,
    [user, hashPassword(pass), '管理员']
  );
  try {
    const [g] = await pool.query(`SELECT id FROM org_groups ORDER BY id ASC LIMIT 1`);
    if (g[0]) {
      await pool.query(
        `INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`,
        [g[0].id, r.insertId]
      );
    }
  } catch (_) {}
  console.log(`[auth] default admin created: ${user} / (see ADMIN_PASSWORD)`);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  destroyUserSessions,
  getUserByToken,
  extractToken,
  authRequired,
  adminRequired,
  writeRequired,
  normalizeRole,
  ensureDefaultAdmin,
};
