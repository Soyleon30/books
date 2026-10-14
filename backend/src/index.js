require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initDb } = require('./db');
const { normalizeIsbn, isValidIsbn, fetchBookMeta, fetchBookMetaDetailed } = require('./isbn');
const {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  destroyUserSessions,
  authRequired,
  adminRequired,
  writeRequired,
  normalizeRole,
  ensureDefaultAdmin,
} = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(authRequired);


function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || '';
}

async function writeAudit(req, { action, target_type, target_id, detail, user }) {
  try {
    const u = user || (req && req.user) || null;
    const d =
      detail == null
        ? null
        : typeof detail === 'string'
          ? detail
          : JSON.stringify(detail);
    await pool.query(
      `INSERT INTO audit_logs
        (user_id, username, role, action, target_type, target_id, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        u && u.id != null ? u.id : null,
        u && u.username ? u.username : null,
        u && u.role ? u.role : null,
        String(action || 'unknown').slice(0, 64),
        target_type ? String(target_type).slice(0, 32) : null,
        target_id != null ? String(target_id).slice(0, 64) : null,
        d ? String(d).slice(0, 4000) : null,
        req ? String(clientIp(req)).slice(0, 64) : null,
        req && req.headers
          ? String(req.headers['user-agent'] || '').slice(0, 512)
          : null,
      ]
    );
  } catch (e) {
    console.error('[audit]', e.message || e);
  }
}

const BOOK_COLS =
  'id, library_id, isbn, title, authors, cover, publisher, published, created_at';

function parseLibraryId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function getLibrary(id) {
  const [rows] = await pool.query(
    `SELECT id, group_id, owner_group_id, visibility, name, description, created_at
     FROM libraries WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function getLibraryVisibleGroupIds(libraryId) {
  const [rows] = await pool.query(
    `SELECT group_id FROM library_groups WHERE library_id=?`,
    [libraryId]
  );
  return rows.map((r) => r.group_id);
}

async function setLibraryVisibleGroups(libraryId, groupIds) {
  await pool.query(`DELETE FROM library_groups WHERE library_id=?`, [libraryId]);
  const ids = [...new Set((groupIds || []).map(Number).filter((n) => n > 0))];
  for (const gid of ids) {
    await pool.query(
      `INSERT IGNORE INTO library_groups (library_id, group_id) VALUES (?, ?)`,
      [libraryId, gid]
    );
  }
  return ids;
}

async function getUserGroupIds(user) {
  if (!user) return [];
  if (user.role === 'admin') {
    const [rows] = await pool.query(`SELECT id FROM org_groups`);
    return rows.map((r) => r.id);
  }
  const [rows] = await pool.query(
    `SELECT group_id AS id FROM group_members WHERE user_id = ?`,
    [user.id]
  );
  return rows.map((r) => r.id);
}

/**
 * 可见性：
 * - public: 所有登录用户
 * - group: 仅 owner_group_id 成员
 * - custom: library_groups 中的群组成员
 * admin 始终可见全部
 */
async function canAccessLibrary(user, libraryId) {
  const lib = await getLibrary(libraryId);
  if (!lib) return { ok: false, lib: null, reason: 'not_found' };
  if (user.role === 'admin') return { ok: true, lib };

  const vis = lib.visibility || 'group';
  if (vis === 'public') return { ok: true, lib };

  const userGids = await getUserGroupIds(user);
  if (!userGids.length) return { ok: false, lib, reason: 'forbidden' };

  if (vis === 'group') {
    const og = lib.owner_group_id || lib.group_id;
    if (og && userGids.includes(Number(og))) return { ok: true, lib };
    return { ok: false, lib, reason: 'forbidden' };
  }

  // custom
  const [m] = await pool.query(
    `SELECT 1 FROM library_groups lg
     WHERE lg.library_id=? AND lg.group_id IN (?)
     LIMIT 1`,
    [libraryId, userGids]
  );
  if (m.length) return { ok: true, lib };
  return { ok: false, lib, reason: 'forbidden' };
}

/** 新用户不自动进组；公开馆即可访问默认资源 */
async function ensureUserInDefaultGroup(_userId) {
  return;
}

function normalizeVisibility(raw) {
  const v = String(raw || 'group').trim().toLowerCase();
  if (v === 'public' || v === 'all') return 'public';
  if (v === 'custom' || v === 'shared') return 'custom';
  return 'group';
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    theme: row.theme || 'sage',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeTheme(raw) {
  const t = String(raw || 'sage').trim().toLowerCase();
  const ok = ["sage","mist","clay","ink","pine","lilac"];
  return ok.includes(t) ? t : 'sage';
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true, auth: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ---------- auth ----------
app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  try {
    // 确保 users 表存在（极端情况 init 未完成）
    const [tables] = await pool.query(
      `SELECT TABLE_NAME AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'`
    );
    if (!tables.length) {
      return res.status(503).json({
        error: '用户表未初始化，请重启 API 容器后再试',
      });
    }

    const [rows] = await pool.query(
      `SELECT id, username, password_hash, display_name, role, status, theme, created_at
       FROM users WHERE username = ? LIMIT 1`,
      [username]
    );
    const u = rows[0];
    if (!u) {
      // 空库：尝试创建默认管理员后提示重试
      const [cnt] = await pool.query(`SELECT COUNT(*) AS c FROM users`);
      if (Number(cnt[0].c) === 0) {
        await ensureDefaultAdmin();
        return res.status(401).json({
          error: '已初始化默认管理员，请用 admin / a123456 再登录一次',
        });
      }
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (!verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (u.status !== 'active') {
      return res.status(403).json({ error: '账号已禁用' });
    }
    const sess = await createSession(u.id);
    await writeAudit(req, {
      action: 'login',
      target_type: 'user',
      target_id: u.id,
      detail: { username: u.username, role: u.role },
      user: { id: u.id, username: u.username, role: u.role },
    });
    res.json({
      message: '登录成功',
      token: sess.token,
      expires_at: sess.expires_at,
      user: publicUser(u),
    });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: '登录失败: ' + (e.message || String(e)) });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    await destroySession(req.token);
    await writeAudit(req, { action: 'logout', target_type: 'user', target_id: req.user && req.user.id });
    res.json({ message: '已退出' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  res.json({ user: req.user });
});

/** 用户自行修改密码（需旧密码） */
app.post('/api/auth/change-password', async (req, res) => {
  const oldPassword = String(req.body.old_password || req.body.oldPassword || '');
  const newPassword = String(req.body.new_password || req.body.newPassword || '');
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请填写旧密码和新密码' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  if (oldPassword === newPassword) {
    return res.status(400).json({ error: '新密码不能与旧密码相同' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT id, password_hash FROM users WHERE id = ? LIMIT 1`,
      [req.user.id]
    );
    const u = rows[0];
    if (!u || !verifyPassword(oldPassword, u.password_hash)) {
      return res.status(400).json({ error: '旧密码不正确' });
    }
    await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [
      hashPassword(newPassword),
      req.user.id,
    ]);
    // 使其它会话失效，保留当前 token
    await pool.query(`DELETE FROM sessions WHERE user_id = ? AND token <> ?`, [
      req.user.id,
      req.token,
    ]);
    await writeAudit(req, { action: 'change_password', target_type: 'user', target_id: req.user.id });
    res.json({ message: '密码已修改' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.put('/api/auth/preferences', async (req, res) => {
  const theme = normalizeTheme(req.body.theme);
  try {
    await pool.query(`UPDATE users SET theme = ? WHERE id = ?`, [theme, req.user.id]);
    const [rows] = await pool.query(
      `SELECT id, username, display_name, role, status, theme, created_at, updated_at FROM users WHERE id=? LIMIT 1`,
      [req.user.id]
    );
    await writeAudit(req, {
      action: 'prefs_theme',
      target_type: 'user',
      target_id: req.user.id,
      detail: { theme },
    });
    res.json({ message: '已保存', user: publicUser(rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- users (admin only, no self-register) ----------
app.get('/api/users', adminRequired, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, display_name, role, status, theme, created_at, updated_at
       FROM users ORDER BY id ASC`
    );
    const users = [];
    for (const row of rows) {
      const [gids] = await pool.query(
        `SELECT group_id FROM group_members WHERE user_id=?`,
        [row.id]
      );
      users.push({
        ...publicUser(row),
        group_ids: gids.map((g) => g.group_id),
      });
    }
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users', adminRequired, async (req, res) => {
  const username = String(req.body.username || '').trim();
  // 未传密码时默认初始密码 a123456
  const password = String(req.body.password || process.env.DEFAULT_USER_PASSWORD || 'a123456');
  const displayName = String(req.body.display_name || '').trim() || null;
  const role = normalizeRole(req.body.role);
  if (!username || username.length < 2) {
    return res.status(400).json({ error: '用户名至少 2 位' });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5.-]{2,64}$/.test(username)) {
    return res.status(400).json({ error: '用户名含非法字符' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  try {
    const [r] = await pool.query(
      `INSERT INTO users (username, password_hash, display_name, role, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [username, hashPassword(password), displayName, role]
    );
    const groupIds = Array.isArray(req.body.group_ids)
      ? req.body.group_ids.map(Number).filter((n) => n > 0)
      : [];
    // 仅管理员显式指定 group_ids 时加入；否则无群组，待分配
    for (const gid of groupIds) {
      await pool.query(
        `INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`,
        [gid, r.insertId]
      );
    }
    const [rows] = await pool.query(
      `SELECT id, username, display_name, role, status, theme, created_at, updated_at
       FROM users WHERE id=?`,
      [r.insertId]
    );
    await writeAudit(req, { action: 'user_create', target_type: 'user', target_id: r.insertId, detail: { username, role } });
    res.status(201).json({ message: '用户已创建', user: publicUser(rows[0]) });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '用户名已存在' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效用户ID' });
  try {
    const [rows] = await pool.query(`SELECT * FROM users WHERE id=? LIMIT 1`, [id]);
    const u = rows[0];
    if (!u) return res.status(404).json({ error: '用户不存在' });

    const displayName =
      req.body.display_name !== undefined
        ? String(req.body.display_name || '').trim() || null
        : u.display_name;
    let role = u.role;
    if (req.body.role !== undefined) {
      role = normalizeRole(req.body.role);
    }
    let status = u.status;
    if (req.body.status !== undefined) {
      status = String(req.body.status) === 'disabled' ? 'disabled' : 'active';
    }
    // 不能禁用/降级最后一个 admin
    if (u.role === 'admin' && (role !== 'admin' || status !== 'active')) {
      const [c] = await pool.query(
        `SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active' AND id<>?`,
        [id]
      );
      if (c[0].c < 1) {
        return res.status(400).json({ error: '不能禁用或降级唯一的管理员' });
      }
    }

    const fields = ['display_name=?', 'role=?', 'status=?'];
    const params = [displayName, role, status];
    if (req.body.password) {
      const password = String(req.body.password);
      if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
      fields.push('password_hash=?');
      params.push(hashPassword(password));
    }
    params.push(id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, params);
    if (Array.isArray(req.body.group_ids)) {
      const groupIds = req.body.group_ids.map(Number).filter((n) => n > 0);
      await pool.query(`DELETE FROM group_members WHERE user_id=?`, [id]);
      for (const gid of groupIds) {
        await pool.query(
          `INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`,
          [gid, id]
        );
      }
    }
    if (req.body.password || status === 'disabled') {
      await destroyUserSessions(id);
    }
    const [updated] = await pool.query(
      `SELECT id, username, display_name, role, status, theme, created_at, updated_at
       FROM users WHERE id=?`,
      [id]
    );
    const [gids] = await pool.query(
      `SELECT group_id FROM group_members WHERE user_id=?`,
      [id]
    );
    res.json({
      message: '已更新',
      user: { ...publicUser(updated[0]), group_ids: gids.map((g) => g.group_id) },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效用户ID' });
  if (req.user && Number(req.user.id) === id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  try {
    const [rows] = await pool.query(`SELECT * FROM users WHERE id=? LIMIT 1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: '用户不存在' });
    if (rows[0].role === 'admin') {
      const [c] = await pool.query(
        `SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active' AND id<>?`,
        [id]
      );
      if (c[0].c < 1) return res.status(400).json({ error: '不能删除唯一的管理员' });
    }
    await pool.query(`DELETE FROM users WHERE id=?`, [id]);
    await writeAudit(req, { action: 'user_delete', target_type: 'user', target_id: id });
    res.json({ message: '已删除' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- groups ----------
app.get('/api/groups', async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      [rows] = await pool.query(
        `SELECT g.id, g.name, g.description, g.created_at,
                (SELECT COUNT(*) FROM libraries l WHERE l.group_id=g.id) AS library_count,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
         FROM org_groups g ORDER BY g.id ASC`
      );
    } else {
      [rows] = await pool.query(
        `SELECT g.id, g.name, g.description, g.created_at,
                (SELECT COUNT(*) FROM libraries l WHERE l.group_id=g.id) AS library_count,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
         FROM org_groups g
         INNER JOIN group_members m ON m.group_id=g.id AND m.user_id=?
         ORDER BY g.id ASC`,
        [req.user.id]
      );
    }
    res.json({ groups: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/groups', adminRequired, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  if (!name) return res.status(400).json({ error: '群组名称不能为空' });
  try {
    const [r] = await pool.query(
      `INSERT INTO org_groups (name, description) VALUES (?, ?)`,
      [name, description]
    );
    const [rows] = await pool.query(`SELECT * FROM org_groups WHERE id=?`, [r.insertId]);
    await writeAudit(req, { action: 'group_create', target_type: 'group', target_id: r.insertId, detail: { name } });
    res.status(201).json({ message: '群组已创建', group: rows[0] });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '群组名已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/groups/:id', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '无效群组ID' });
  const name = String(req.body.name || '').trim();
  const description =
    req.body.description === undefined
      ? undefined
      : String(req.body.description || '').trim() || null;
  if (!name) return res.status(400).json({ error: '群组名称不能为空' });
  try {
    if (description !== undefined) {
      await pool.query(`UPDATE org_groups SET name=?, description=? WHERE id=?`, [
        name,
        description,
        id,
      ]);
    } else {
      await pool.query(`UPDATE org_groups SET name=? WHERE id=?`, [name, id]);
    }
    const [rows] = await pool.query(`SELECT * FROM org_groups WHERE id=?`, [id]);
    if (!rows[0]) return res.status(404).json({ error: '群组不存在' });
    res.json({ message: '已更新', group: rows[0] });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '群组名已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/groups/:id', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '无效群组ID' });
  try {
    const [c] = await pool.query(`SELECT COUNT(*) AS c FROM org_groups`);
    if (c[0].c <= 1) return res.status(400).json({ error: '不能删除唯一的群组' });
    await pool.query(`UPDATE libraries SET group_id=NULL WHERE group_id=?`, [id]);
    const [r] = await pool.query(`DELETE FROM org_groups WHERE id=?`, [id]);
    if (!r.affectedRows) return res.status(404).json({ error: '群组不存在' });
    await writeAudit(req, { action: 'group_delete', target_type: 'group', target_id: id });
    res.json({ message: '已删除' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/groups/:id/members', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.role, u.status
       FROM group_members gm
       JOIN users u ON u.id=gm.user_id
       WHERE gm.group_id=?
       ORDER BY u.id`,
      [id]
    );
    res.json({ members: rows.map(publicUser) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/groups/:id/members', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  const userIds = Array.isArray(req.body.user_ids)
    ? req.body.user_ids.map(Number).filter((n) => n > 0)
    : [];
  try {
    const [g] = await pool.query(`SELECT id FROM org_groups WHERE id=?`, [id]);
    if (!g[0]) return res.status(404).json({ error: '群组不存在' });
    await pool.query(`DELETE FROM group_members WHERE group_id=?`, [id]);
    for (const uid of userIds) {
      await pool.query(
        `INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`,
        [id, uid]
      );
    }
    await writeAudit(req, { action: 'group_members', target_type: 'group', target_id: id, detail: { user_ids: userIds } });
    res.json({ message: '成员已更新', count: userIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/groups/:id/libraries', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效群组ID' });
  try {
    const [g] = await pool.query(`SELECT id, name FROM org_groups WHERE id=? LIMIT 1`, [id]);
    if (!g[0]) return res.status(404).json({ error: '群组不存在' });
    const [rows] = await pool.query(
      `SELECT l.id, l.name, l.visibility, l.owner_group_id, l.group_id,
              (l.owner_group_id = ? OR l.group_id = ?) AS assigned,
              (SELECT COUNT(*) FROM books b WHERE b.library_id=l.id) AS book_count
       FROM libraries l
       ORDER BY l.id ASC`,
      [id, id]
    );
    res.json({
      group: g[0],
      libraries: rows.map((r) => ({
        id: r.id,
        name: r.name,
        visibility: r.visibility,
        owner_group_id: r.owner_group_id,
        group_id: r.group_id,
        book_count: Number(r.book_count || 0),
        assigned: !!(r.assigned === 1 || r.assigned === true || Number(r.assigned) === 1),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 设置「归属本群组」的图书馆列表（owner_group_id / group_id）
 * - 勾选的馆：归属本群；visibility=group 时同步 library_groups
 * - 取消勾选且原归属本群的馆：owner/group 清空（不删馆）
 * 仅管理员
 */
app.put('/api/groups/:id/libraries', adminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效群组ID' });
  const libraryIds = Array.isArray(req.body.library_ids)
    ? [...new Set(req.body.library_ids.map(Number).filter((n) => n > 0))]
    : [];
  try {
    const [g] = await pool.query(`SELECT id, name FROM org_groups WHERE id=? LIMIT 1`, [id]);
    if (!g[0]) return res.status(404).json({ error: '群组不存在' });

    const [allLibs] = await pool.query(
      `SELECT id, owner_group_id, group_id, visibility FROM libraries`
    );
    const want = new Set(libraryIds);
    let assigned = 0;
    let cleared = 0;

    for (const lib of allLibs) {
      const was =
        Number(lib.owner_group_id) === id || Number(lib.group_id) === id;
      const now = want.has(Number(lib.id));
      if (now) {
        await pool.query(
          `UPDATE libraries SET owner_group_id=?, group_id=? WHERE id=?`,
          [id, id, lib.id]
        );
        const vis = lib.visibility || 'group';
        if (vis === 'group') {
          await setLibraryVisibleGroups(lib.id, [id]);
        } else if (vis === 'custom') {
          // 保证本群在可见列表中
          const cur = await getLibraryVisibleGroupIds(lib.id);
          if (!cur.includes(id)) {
            await setLibraryVisibleGroups(lib.id, [...cur, id]);
          }
        }
        assigned += 1;
      } else if (was) {
        await pool.query(
          `UPDATE libraries SET owner_group_id=NULL, group_id=NULL WHERE id=?`,
          [lib.id]
        );
        // 从 library_groups 去掉本群
        await pool.query(
          `DELETE FROM library_groups WHERE library_id=? AND group_id=?`,
          [lib.id, id]
        );
        cleared += 1;
      }
    }

    await writeAudit(req, {
      action: 'group_libraries',
      target_type: 'group',
      target_id: id,
      detail: { library_ids: libraryIds, assigned, cleared },
    });
    res.json({
      message: '归属馆已更新',
      group_id: id,
      library_ids: libraryIds,
      assigned,
      cleared,
    });
  } catch (e) {
    console.error('[group libraries]', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- libraries ----------
app.get('/api/libraries', async (req, res) => {
  try {
    const userGids = await getUserGroupIds(req.user);
    let rows;
    if (req.user.role === 'admin') {
      [rows] = await pool.query(
        `SELECT l.id, l.group_id, l.owner_group_id, l.visibility, l.name, l.description, l.created_at,
                g.name AS group_name, og.name AS owner_group_name,
                COUNT(DISTINCT b.id) AS book_count
         FROM libraries l
         LEFT JOIN org_groups g ON g.id=l.group_id
         LEFT JOIN org_groups og ON og.id=l.owner_group_id
         LEFT JOIN books b ON b.library_id = l.id
         GROUP BY l.id
         ORDER BY l.created_at ASC`
      );
    } else if (!userGids.length) {
      // 无群组：仍可见 public 馆（默认图书馆等）
      [rows] = await pool.query(
        `SELECT l.id, l.group_id, l.owner_group_id, l.visibility, l.name, l.description, l.created_at,
                g.name AS group_name, og.name AS owner_group_name,
                COUNT(DISTINCT b.id) AS book_count
         FROM libraries l
         LEFT JOIN org_groups g ON g.id=l.group_id
         LEFT JOIN org_groups og ON og.id=l.owner_group_id
         LEFT JOIN books b ON b.library_id = l.id
         WHERE l.visibility='public'
         GROUP BY l.id
         ORDER BY l.created_at ASC`
      );
    } else {
      [rows] = await pool.query(
        `SELECT l.id, l.group_id, l.owner_group_id, l.visibility, l.name, l.description, l.created_at,
                g.name AS group_name, og.name AS owner_group_name,
                COUNT(DISTINCT b.id) AS book_count
         FROM libraries l
         LEFT JOIN org_groups g ON g.id=l.group_id
         LEFT JOIN org_groups og ON og.id=l.owner_group_id
         LEFT JOIN books b ON b.library_id = l.id
         LEFT JOIN library_groups lg ON lg.library_id=l.id
         WHERE l.visibility='public'
            OR (l.visibility='group' AND l.owner_group_id IN (?))
            OR (l.visibility='custom' AND lg.group_id IN (?))
         GROUP BY l.id
         ORDER BY l.created_at ASC`,
        [userGids, userGids]
      );
    }
    // 附加 visible_group_ids
    for (const row of rows) {
      row.visible_group_ids = await getLibraryVisibleGroupIds(row.id);
      if (row.visibility === 'group' && row.owner_group_id && !row.visible_group_ids.length) {
        row.visible_group_ids = [row.owner_group_id];
      }
    }
    res.json({ libraries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/libraries', writeRequired, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  let visibility = normalizeVisibility(req.body.visibility);
  let ownerGroupId =
    req.body.owner_group_id != null
      ? Number(req.body.owner_group_id)
      : req.body.group_id != null
        ? Number(req.body.group_id)
        : null;
  let visibleGroupIds = Array.isArray(req.body.visible_group_ids)
    ? req.body.visible_group_ids.map(Number).filter((n) => n > 0)
    : Array.isArray(req.body.group_ids)
      ? req.body.group_ids.map(Number).filter((n) => n > 0)
      : [];

  if (!name) return res.status(400).json({ error: '图书馆名称不能为空' });
  if (name.length > 128) return res.status(400).json({ error: '名称过长' });

  // 非管理员不能建 public
  if (req.user.role !== 'admin' && visibility === 'public') {
    visibility = 'group';
  }

  try {
    const userGids = await getUserGroupIds(req.user);
    if (!ownerGroupId) ownerGroupId = userGids[0] || null;
    if (req.user.role !== 'admin') {
      if (!ownerGroupId || !userGids.includes(ownerGroupId)) {
        return res.status(403).json({ error: '只能在自己所属群组下创建图书馆' });
      }
      // 普通用户创建的馆：仅本群组可见
      visibility = 'group';
      visibleGroupIds = [ownerGroupId];
    } else if (visibility === 'group') {
      if (!ownerGroupId) {
        return res.status(400).json({ error: '请指定所属群组 owner_group_id' });
      }
      visibleGroupIds = [ownerGroupId];
    } else if (visibility === 'custom') {
      if (!visibleGroupIds.length) {
        return res.status(400).json({ error: 'custom 可见性请指定 visible_group_ids' });
      }
      if (!ownerGroupId) ownerGroupId = visibleGroupIds[0];
    } else if (visibility === 'public') {
      // 全员可见，owner 可空或指定
      visibleGroupIds = [];
    }

    const [result] = await pool.query(
      `INSERT INTO libraries (group_id, owner_group_id, visibility, name, description)
       VALUES (?, ?, ?, ?, ?)`,
      [ownerGroupId, ownerGroupId, visibility, name, description]
    );
    const libId = result.insertId;
    if (visibility === 'group' && ownerGroupId) {
      await setLibraryVisibleGroups(libId, [ownerGroupId]);
    } else if (visibility === 'custom') {
      await setLibraryVisibleGroups(libId, visibleGroupIds);
    } else {
      await setLibraryVisibleGroups(libId, []);
    }
    const lib = await getLibrary(libId);
    lib.visible_group_ids = await getLibraryVisibleGroupIds(libId);
    await writeAudit(req, { action: 'library_create', target_type: 'library', target_id: libId, detail: { name, visibility } });
    res.status(201).json({ message: '创建成功', library: lib });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '同名图书馆已存在' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/libraries/:id', writeRequired, async (req, res) => {
  const id = parseLibraryId(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图书馆ID' });
  const access = await canAccessLibrary(req.user, id);
  if (!access.ok) {
    return res.status(access.reason === 'not_found' ? 404 : 403).json({
      error: access.reason === 'not_found' ? '图书馆不存在' : '无权操作该馆',
    });
  }
  // 改可见性仅管理员
  if (
    (req.body.visibility !== undefined || req.body.visible_group_ids !== undefined) &&
    req.user.role !== 'admin'
  ) {
    return res.status(403).json({ error: '仅管理员可调整图书馆可见范围' });
  }

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
    if (req.body.visibility !== undefined && req.user.role === 'admin') {
      const vis = normalizeVisibility(req.body.visibility);
      fields.push('visibility = ?');
      params.push(vis);
    }
    if (req.body.owner_group_id !== undefined && req.user.role === 'admin') {
      const og = req.body.owner_group_id ? Number(req.body.owner_group_id) : null;
      fields.push('owner_group_id = ?');
      params.push(og);
      fields.push('group_id = ?');
      params.push(og);
    }
    params.push(id);
    const [result] = await pool.query(
      `UPDATE libraries SET ${fields.join(', ')} WHERE id = ?`,
      params
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '图书馆不存在' });
    }

    if (req.user.role === 'admin') {
      const lib = await getLibrary(id);
      const vis = lib.visibility || 'group';
      if (req.body.visible_group_ids !== undefined || req.body.visibility !== undefined) {
        if (vis === 'public') {
          await setLibraryVisibleGroups(id, []);
        } else if (vis === 'group') {
          const og = lib.owner_group_id || lib.group_id;
          await setLibraryVisibleGroups(id, og ? [og] : []);
        } else if (vis === 'custom') {
          const ids = Array.isArray(req.body.visible_group_ids)
            ? req.body.visible_group_ids.map(Number).filter((n) => n > 0)
            : await getLibraryVisibleGroupIds(id);
          await setLibraryVisibleGroups(id, ids);
        }
      }
    }

    const lib = await getLibrary(id);
    lib.visible_group_ids = await getLibraryVisibleGroupIds(id);
    res.json({ message: '已更新', library: lib });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '同名图书馆已存在' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/libraries/:id', adminRequired, async (req, res) => {
  const id = parseLibraryId(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图书馆ID' });
  try {
    const lib = await getLibrary(id);
    if (!lib) return res.status(404).json({ error: '图书馆不存在' });
    const [result] = await pool.query('DELETE FROM libraries WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '图书馆不存在' });
    }
    await writeAudit(req, { action: 'library_delete', target_type: 'library', target_id: id, detail: { name: lib.name } });
    res.json({ message: '已删除（馆内图书一并删除）' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 将源馆图书迁到目标馆（不删馆，需管理员手动删）
 * 目标馆已有相同 ISBN：保留目标、去掉源侧重复（计 skipped）
 * 仅管理员
 */
app.post('/api/libraries/:id/migrate', adminRequired, async (req, res) => {
  const sourceId = parseLibraryId(req.params.id);
  const targetId = parseLibraryId(req.body.target_library_id || req.body.target_id);
  if (!sourceId || !targetId) {
    return res.status(400).json({ error: '请指定源馆与目标馆' });
  }
  if (sourceId === targetId) {
    return res.status(400).json({ error: '源馆与目标馆不能相同' });
  }
  try {
    const source = await getLibrary(sourceId);
    const target = await getLibrary(targetId);
    if (!source) return res.status(404).json({ error: '源图书馆不存在' });
    if (!target) return res.status(404).json({ error: '目标图书馆不存在' });

    const [srcBooks] = await pool.query(
      `SELECT id, isbn FROM books WHERE library_id=?`,
      [sourceId]
    );
    let moved = 0;
    let skipped = 0;
    for (const b of srcBooks) {
      const [exist] = await pool.query(
        `SELECT id FROM books WHERE library_id=? AND isbn=? LIMIT 1`,
        [targetId, b.isbn]
      );
      if (exist[0]) {
        await pool.query(`DELETE FROM books WHERE id=?`, [b.id]);
        skipped += 1;
      } else {
        await pool.query(`UPDATE books SET library_id=? WHERE id=?`, [targetId, b.id]);
        moved += 1;
      }
    }

    const [cnt] = await pool.query(
      `SELECT COUNT(*) AS c FROM books WHERE library_id=?`,
      [targetId]
    );
    const [srcLeft] = await pool.query(
      `SELECT COUNT(*) AS c FROM books WHERE library_id=?`,
      [sourceId]
    );
    await writeAudit(req, {
      action: 'library_migrate',
      target_type: 'library',
      target_id: sourceId,
      detail: { target_id: targetId, moved, skipped, source_name: source.name, target_name: target.name },
    });
    res.json({
      message: '迁移完成（源馆保留，如需删除请手动操作）',
      source_id: sourceId,
      source_name: source.name,
      target_id: targetId,
      target_name: target.name,
      moved,
      skipped,
      target_book_count: Number(cnt[0].c),
      source_book_count: Number(srcLeft[0].c),
    });
  } catch (e) {
    console.error('[migrate]', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});


// ---------- audit logs (admin) ----------
app.get('/api/audit-logs', adminRequired, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(10, Number(req.query.page_size || 50)));
    const offset = (page - 1) * pageSize;
    const action = String(req.query.action || '').trim();
    const username = String(req.query.username || '').trim();
    const q = String(req.query.q || '').trim();
    const where = [];
    const params = [];
    if (action) {
      where.push('action = ?');
      params.push(action);
    }
    if (username) {
      where.push('username LIKE ?');
      params.push('%' + username + '%');
    }
    if (q) {
      where.push('(detail LIKE ? OR target_id LIKE ? OR action LIKE ? OR username LIKE ?)');
      const like = '%' + q + '%';
      params.push(like, like, like, like);
    }
    const wh = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM audit_logs ${wh}`,
      params
    );
    const total = Number(cntRows[0].c);
    const [rows] = await pool.query(
      `SELECT id, user_id, username, role, action, target_type, target_id, detail, ip, user_agent, created_at
       FROM audit_logs ${wh}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({
      logs: rows,
      page,
      page_size: pageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audit-logs/actions', adminRequired, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT action FROM audit_logs ORDER BY action ASC`
    );
    res.json({ actions: rows.map((r) => r.action) });
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
    const access = await canAccessLibrary(req.user, libraryId);
    if (!access.ok) {
      return res.status(access.reason === 'not_found' ? 404 : 403).json({
        error: access.reason === 'not_found' ? '图书馆不存在' : '无权访问该馆',
      });
    }
    const [rows] = await pool.query(
      `SELECT ${BOOK_COLS} FROM books WHERE library_id = ? AND isbn = ? LIMIT 1`,
      [libraryId, isbn]
    );
    if (rows.length) {
      return res.json({ exists: true, book: rows[0], library_id: libraryId });
    }
    const { meta, debug } = await fetchBookMetaDetailed(isbn);
    return res.json({
      exists: false,
      meta: meta || null,
      scrape_debug: debug,
      isbn,
      library_id: libraryId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 对已入库图书重新刮削并更新 title/authors/cover 等 */
app.post('/api/books/scrape', writeRequired, async (req, res) => {
  const isbn = normalizeIsbn(req.body.isbn);
  const libraryId = parseLibraryId(req.body.library_id);
  const force = req.body.force !== false; // 默认强制覆盖未知；true 时也覆盖已有
  if (!isValidIsbn(isbn)) return res.status(400).json({ error: 'ISBN格式无效' });
  if (!libraryId) return res.status(400).json({ error: '请先选择图书馆' });

  try {
    const [rows] = await pool.query(
      `SELECT ${BOOK_COLS} FROM books WHERE library_id = ? AND isbn = ? LIMIT 1`,
      [libraryId, isbn]
    );
    if (!rows.length) return res.status(404).json({ error: '馆内无此书，请先入库' });
    const book = rows[0];

    const { meta, debug } = await fetchBookMetaDetailed(isbn);
    if (!meta || (meta.title === '未知书名' && !meta.cover)) {
      return res.status(404).json({
        error: '未刮取到书目（服务器可能无法访问外网，或源站无此 ISBN）',
        scrape_debug: debug,
        book,
      });
    }

    const isUnknown = (t) => !t || t === '未知书名' || t === '未知作者';
    const title =
      force || isUnknown(book.title) ? meta.title || book.title : book.title;
    const authors =
      force || isUnknown(book.authors) ? meta.authors || book.authors : book.authors;
    const cover = force || !book.cover ? meta.cover || book.cover : book.cover;
    const publisher =
      force || !book.publisher ? meta.publisher || book.publisher : book.publisher;
    const published =
      force || !book.published ? meta.published || book.published : book.published;

    await pool.query(
      `UPDATE books SET title=?, authors=?, cover=?, publisher=?, published=?
       WHERE library_id=? AND isbn=?`,
      [title, authors, cover, publisher, published, libraryId, isbn]
    );

    const [updated] = await pool.query(
      `SELECT ${BOOK_COLS} FROM books WHERE library_id = ? AND isbn = ? LIMIT 1`,
      [libraryId, isbn]
    );
    await writeAudit(req, { action: 'book_scrape', target_type: 'book', target_id: isbn, detail: { library_id: libraryId } });
    res.json({
      message: '刮削完成',
      book: updated[0],
      meta,
      scrape_debug: debug,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 批量刮削当前馆「未知书名」或无封面的书 */
app.post('/api/books/scrape-missing', writeRequired, async (req, res) => {
  const libraryId = parseLibraryId(req.body.library_id);
  const limit = Math.min(Number(req.body.limit) || 20, 50);
  if (!libraryId) return res.status(400).json({ error: '请先选择图书馆' });

  try {
    const [rows] = await pool.query(
      `SELECT ${BOOK_COLS} FROM books
       WHERE library_id=? AND (title='未知书名' OR title='' OR authors='未知作者' OR cover IS NULL OR cover='')
       ORDER BY id DESC LIMIT ?`,
      [libraryId, limit]
    );
    const results = [];
    for (const book of rows) {
      const { meta, debug } = await fetchBookMetaDetailed(book.isbn);
      if (!meta || meta.title === '未知书名') {
        results.push({ isbn: book.isbn, ok: false, debug });
        continue;
      }
      await pool.query(
        `UPDATE books SET title=?, authors=?, cover=?, publisher=?, published=?
         WHERE id=?`,
        [
          meta.title || book.title,
          meta.authors || book.authors,
          meta.cover || book.cover,
          meta.publisher || book.publisher,
          meta.published || book.published,
          book.id,
        ]
      );
      results.push({ isbn: book.isbn, ok: true, title: meta.title, source: meta.source });
    }
    res.json({ message: '批量刮削结束', total: rows.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/books', writeRequired, async (req, res) => {
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
    const access = await canAccessLibrary(req.user, libraryId);
    if (!access.ok) {
      return res.status(access.reason === 'not_found' ? 404 : 403).json({
        error: access.reason === 'not_found' ? '图书馆不存在' : '无权写入该馆',
      });
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
    await writeAudit(req, { action: 'book_add', target_type: 'book', target_id: isbn || (book && book.isbn), detail: { library_id: libraryId, title: (book && book.title) || title } });
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
    const access = await canAccessLibrary(req.user, libraryId);
    if (!access.ok) {
      return res.status(access.reason === 'not_found' ? 404 : 403).json({
        error: access.reason === 'not_found' ? '图书馆不存在' : '无权访问该馆',
      });
    }
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

/** 批量按 ISBN 入库（前端多图识别后调用） */
app.post('/api/books/batch', writeRequired, async (req, res) => {
  const libraryId = parseLibraryId(req.body.library_id);
  const items = Array.isArray(req.body.items)
    ? req.body.items
    : Array.isArray(req.body.isbns)
      ? req.body.isbns.map((x) => (typeof x === 'string' ? { isbn: x } : x))
      : [];
  if (!libraryId) return res.status(400).json({ error: '请先选择图书馆' });
  if (!items.length) return res.status(400).json({ error: '没有待入库 ISBN' });

  const access = await canAccessLibrary(req.user, libraryId);
  if (!access.ok) {
    return res.status(access.reason === 'not_found' ? 404 : 403).json({
      error: access.reason === 'not_found' ? '图书馆不存在' : '无权写入该馆',
    });
  }

  const results = [];
  for (const it of items.slice(0, 100)) {
    const isbn = normalizeIsbn(it.isbn || it);
    if (!isValidIsbn(isbn)) {
      results.push({ isbn: String(it.isbn || it), ok: false, error: 'ISBN无效' });
      continue;
    }
    try {
      const [existing] = await pool.query(
        `SELECT id FROM books WHERE library_id=? AND isbn=? LIMIT 1`,
        [libraryId, isbn]
      );
      if (existing.length) {
        results.push({ isbn, ok: false, error: '已存在', skipped: true });
        continue;
      }
      let title = (it.title || '').trim();
      let authors = (it.authors || '').trim();
      let cover = it.cover || null;
      let publisher = it.publisher || null;
      let published = it.published || null;
      if (!title || title === '未知书名') {
        const meta = await fetchBookMeta(isbn);
        if (meta) {
          title = meta.title || '未知书名';
          authors = authors || meta.authors || '未知作者';
          cover = cover || meta.cover;
          publisher = publisher || meta.publisher;
          published = published || meta.published;
        }
      }
      title = title || '未知书名';
      authors = authors || '未知作者';
      const [r] = await pool.query(
        `INSERT INTO books (library_id, isbn, title, authors, cover, publisher, published)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [libraryId, isbn, title, authors, cover, publisher, published]
      );
      results.push({ isbn, ok: true, id: r.insertId, title });
    } catch (e) {
      results.push({ isbn, ok: false, error: e.message });
    }
  }
  await writeAudit(req, { action: 'book_batch', target_type: 'library', target_id: libraryId, detail: { total: Array.isArray(req.body.items) ? req.body.items.length : (req.body.isbns || []).length } });
    res.json({
    message: '批量入库完成',
    total: results.length,
    ok: results.filter((x) => x.ok).length,
    results,
  });
});

app.delete('/api/books/:isbn', writeRequired, async (req, res) => {
  const isbn = normalizeIsbn(req.params.isbn);
  const libraryId = parseLibraryId(req.query.library_id || req.body?.library_id);
  if (!libraryId) {
    return res.status(400).json({ error: '请先选择图书馆' });
  }
  try {
    const access = await canAccessLibrary(req.user, libraryId);
    if (!access.ok) {
      return res.status(access.reason === 'not_found' ? 404 : 403).json({
        error: access.reason === 'not_found' ? '图书馆不存在' : '无权操作该馆',
      });
    }
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
  await ensureDefaultAdmin();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`book-scanner-api listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
