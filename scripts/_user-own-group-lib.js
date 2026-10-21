const fs = require('fs');

// ---- db: created_by on org_groups ----
{
  const p = 'backend/src/db.js';
  let c = fs.readFileSync(p, 'utf8');
  if (!c.includes("columnExists(conn, 'org_groups', 'created_by')")) {
    const block = `
    if (!(await columnExists(conn, 'org_groups', 'created_by'))) {
      try {
        await conn.query(\`ALTER TABLE org_groups ADD COLUMN created_by BIGINT UNSIGNED NULL\`);
        await conn.query(\`ALTER TABLE org_groups ADD KEY idx_og_creator (created_by)\`);
      } catch (_) {}
    }
    if (!(await columnExists(conn, 'libraries', 'created_by'))) {
      try {
        await conn.query(\`ALTER TABLE libraries ADD COLUMN created_by BIGINT UNSIGNED NULL\`);
        await conn.query(\`ALTER TABLE libraries ADD KEY idx_lib_creator (created_by)\`);
      } catch (_) {}
    }
`;
    if (!c.includes("columnExists(conn, 'users', 'theme')")) {
      throw new Error('theme anchor missing');
    }
    c = c.replace(
      "    if (!(await columnExists(conn, 'users', 'theme'))) {",
      block + "    if (!(await columnExists(conn, 'users', 'theme'))) {"
    );
    fs.writeFileSync(p, c);
    console.log('db created_by ok');
  } else console.log('db skip');
}

// ---- index.js ----
{
  const p = 'backend/src/index.js';
  let c = fs.readFileSync(p, 'utf8');

  // enrich groups list with created_by
  c = c.replace(
    `SELECT g.id, g.name, g.description, g.created_at,
                (SELECT COUNT(*) FROM libraries l WHERE l.group_id=g.id) AS library_count,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
         FROM org_groups g ORDER BY g.id ASC`,
    `SELECT g.id, g.name, g.description, g.created_by, g.created_at,
                (SELECT COUNT(*) FROM libraries l WHERE l.group_id=g.id OR l.owner_group_id=g.id) AS library_count,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
         FROM org_groups g ORDER BY g.id ASC`
  );
  c = c.replace(
    `SELECT g.id, g.name, g.description, g.created_at,
                (SELECT COUNT(*) FROM libraries l WHERE l.group_id=g.id) AS library_count,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
         FROM org_groups g
         INNER JOIN group_members m ON m.group_id=g.id AND m.user_id=?
         ORDER BY g.id ASC`,
    `SELECT g.id, g.name, g.description, g.created_by, g.created_at,
                (SELECT COUNT(*) FROM libraries l WHERE l.group_id=g.id OR l.owner_group_id=g.id) AS library_count,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
         FROM org_groups g
         INNER JOIN group_members m ON m.group_id=g.id AND m.user_id=?
         ORDER BY g.id ASC`
  );

  // POST groups: writeRequired, user can create 1 and auto-join
  const oldPost = `app.post('/api/groups', adminRequired, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  if (!name) return res.status(400).json({ error: '群组名称不能为空' });
  try {
    const [r] = await pool.query(
      \`INSERT INTO org_groups (name, description) VALUES (?, ?)\`,
      [name, description]
    );
    const [rows] = await pool.query(\`SELECT * FROM org_groups WHERE id=?\`, [r.insertId]);
    await writeAudit(req, { action: 'group_create', target_type: 'group', target_id: r.insertId, detail: { name } });
    res.status(201).json({ message: '群组已创建', group: rows[0] });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '群组名已存在' });
    res.status(500).json({ error: e.message });
  }
});`;

  const newPost = `app.post('/api/groups', writeRequired, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  if (!name) return res.status(400).json({ error: '群组名称不能为空' });
  if (name.length > 128) return res.status(400).json({ error: '名称过长' });
  try {
    // 普通 user 仅可自建 1 个群组
    if (req.user.role !== 'admin') {
      const [owned] = await pool.query(
        \`SELECT COUNT(*) AS c FROM org_groups WHERE created_by=?\`,
        [req.user.id]
      );
      if (Number(owned[0].c) >= 1) {
        return res.status(403).json({ error: '普通用户只能创建一个群组' });
      }
    }
    const [r] = await pool.query(
      \`INSERT INTO org_groups (name, description, created_by) VALUES (?, ?, ?)\`,
      [name, description, req.user.id]
    );
    // 创建者自动加入
    await pool.query(
      \`INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)\`,
      [r.insertId, req.user.id]
    );
    const [rows] = await pool.query(\`SELECT * FROM org_groups WHERE id=?\`, [r.insertId]);
    await writeAudit(req, {
      action: 'group_create',
      target_type: 'group',
      target_id: r.insertId,
      detail: { name, by: req.user.role },
    });
    res.status(201).json({ message: '群组已创建', group: rows[0] });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '群组名已存在' });
    res.status(500).json({ error: e.message });
  }
});`;

  if (!c.includes(oldPost)) {
    // looser
    if (c.includes("app.post('/api/groups', adminRequired")) {
      c = c.replace("app.post('/api/groups', adminRequired, async (req, res) => {", "app.post('/api/groups', writeRequired, async (req, res) => {");
      c = c.replace(
        `const [r] = await pool.query(
      \`INSERT INTO org_groups (name, description) VALUES (?, ?)\`,
      [name, description]
    );
    const [rows] = await pool.query(\`SELECT * FROM org_groups WHERE id=?\`, [r.insertId]);
    await writeAudit(req, { action: 'group_create', target_type: 'group', target_id: r.insertId, detail: { name } });
    res.status(201).json({ message: '群组已创建', group: rows[0] });`,
        `if (req.user.role !== 'admin') {
      const [owned] = await pool.query(
        \`SELECT COUNT(*) AS c FROM org_groups WHERE created_by=?\`,
        [req.user.id]
      );
      if (Number(owned[0].c) >= 1) {
        return res.status(403).json({ error: '普通用户只能创建一个群组' });
      }
    }
    if (name.length > 128) return res.status(400).json({ error: '名称过长' });
    const [r] = await pool.query(
      \`INSERT INTO org_groups (name, description, created_by) VALUES (?, ?, ?)\`,
      [name, description, req.user.id]
    );
    await pool.query(
      \`INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)\`,
      [r.insertId, req.user.id]
    );
    const [rows] = await pool.query(\`SELECT * FROM org_groups WHERE id=?\`, [r.insertId]);
    await writeAudit(req, { action: 'group_create', target_type: 'group', target_id: r.insertId, detail: { name, by: req.user.role } });
    res.status(201).json({ message: '群组已创建', group: rows[0] });`
      );
      console.log('groups post patched loose');
    } else throw new Error('groups post not found');
  } else {
    c = c.replace(oldPost, newPost);
    console.log('groups post replaced');
  }

  // library create: user limit 1 self-created
  c = c.replace(
    `if (req.user.role !== 'admin') {
      // 普通 user：只能建「归属自己所在群组」的私有馆；可见性/跨组由管理员分配
      if (!userGids.length) {
        return res.status(403).json({
          error: '您尚未加入任何群组，请联系管理员分配后再创建图书馆',
        });
      }
      // 若指定了群组必须属于自己；否则取第一个所属群组
      if (ownerGroupId) {
        if (!userGids.includes(ownerGroupId)) {
          return res.status(403).json({ error: '只能在自己所属群组下创建图书馆' });
        }
      } else {
        ownerGroupId = userGids[0];
      }
      visibility = 'group';
      visibleGroupIds = [ownerGroupId];
    } else {`,
    `if (req.user.role !== 'admin') {
      // 普通 user：可自建 1 个馆，自动归属自己所在群组
      const [ownedLibs] = await pool.query(
        \`SELECT COUNT(*) AS c FROM libraries WHERE created_by=?\`,
        [req.user.id]
      );
      if (Number(ownedLibs[0].c) >= 1) {
        return res.status(403).json({ error: '普通用户只能创建一个图书馆' });
      }
      if (!userGids.length) {
        return res.status(403).json({
          error: '请先创建或加入一个群组，再建图书馆（馆将自动归属该群组）',
        });
      }
      if (ownerGroupId) {
        if (!userGids.includes(ownerGroupId)) {
          return res.status(403).json({ error: '只能在自己所属群组下创建图书馆' });
        }
      } else {
        ownerGroupId = userGids[0];
      }
      visibility = 'group';
      visibleGroupIds = [ownerGroupId];
    } else {`
  );

  c = c.replace(
    `const [result] = await pool.query(
      \`INSERT INTO libraries (group_id, owner_group_id, visibility, name, description)
       VALUES (?, ?, ?, ?, ?)\`,
      [ownerGroupId, ownerGroupId, visibility, name, description]
    );`,
    `const [result] = await pool.query(
      \`INSERT INTO libraries (group_id, owner_group_id, visibility, name, description, created_by)
       VALUES (?, ?, ?, ?, ?, ?)\`,
      [ownerGroupId, ownerGroupId, visibility, name, description, req.user.id]
    );`
  );

  // me + group_ids
  c = c.replace(
    `app.get('/api/auth/me', async (req, res) => {
  res.json({ user: req.user });
});`,
    `app.get('/api/auth/me', async (req, res) => {
  try {
    const gids = await getUserGroupIds(req.user);
    res.json({ user: { ...req.user, group_ids: gids } });
  } catch (e) {
    res.json({ user: req.user });
  }
});`
  );

  fs.writeFileSync(p, c);
  console.log('index ok');
}

// ---- frontend ----
{
  const p = 'frontend/index.html';
  let c = fs.readFileSync(p, 'utf8');

  // p2 hint for user
  if (!c.includes('id="lib-user-hint"')) {
    c = c.replace(
      `<div id="p2" class="pane hide">
    <input id="n" type="text" placeholder="新图书馆名称">`,
      `<div id="p2" class="pane hide">
    <p id="lib-user-hint" class="hide" style="font-size:12px;color:var(--muted);margin:0 0 10px">普通用户可自建 <b>1</b> 个图书馆，自动归属您的群组。公开/跨组由管理员配置。</p>
    <input id="n" type="text" placeholder="新图书馆名称">`
    );
  }

  // p4: allow user
  c = c.replace(
    `<div id="p4" class="pane hide">
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px">管理员管理群组：成员、归属馆</p>
    <input id="gn" type="text" placeholder="新群组名称">
    <input id="gd" type="text" placeholder="备注">
    <button type="button" class="btn btn-main" onclick="createGroup()">创建群组</button>
    <div id="groups" style="margin-top:14px"></div>
  </div>`,
    `<div id="p4" class="pane hide">
    <p id="group-hint" style="font-size:13px;color:var(--muted);margin:0 0 10px">群组管理</p>
    <div id="group-create-box">
      <input id="gn" type="text" placeholder="新群组名称">
      <input id="gd" type="text" placeholder="备注">
      <button type="button" class="btn btn-main" onclick="createGroup()">创建群组</button>
    </div>
    <div id="groups" style="margin-top:14px"></div>
  </div>`
  );

  // applyRoleUi: user sees t4 groups
  c = c.replace(
    `if (isAdmin()) {
        if (t4) t4.classList.remove('hide');
        if (t5) t5.classList.remove('hide');
        if (libVis) libVis.classList.remove('hide');
      } else {
        if (t5) t5.classList.add('hide');
        t4.classList.add('hide');
        if (libVis) libVis.classList.add('hide');
      }`,
    `if (isAdmin()) {
        if (t4) t4.classList.remove('hide');
        if (t5) t5.classList.remove('hide');
        if (libVis) libVis.classList.remove('hide');
      } else {
        if (t5) t5.classList.add('hide');
        // user 可进群组页自建 1 个群组
        if (t4) t4.classList.remove('hide');
        if (libVis) libVis.classList.add('hide');
      }
      const libHint = document.getElementById('lib-user-hint');
      if (libHint) libHint.classList.toggle('hide', isAdmin() || isViewer());
      const gh = document.getElementById('group-hint');
      if (gh) {
        gh.textContent = isAdmin()
          ? '管理员：成员、归属馆；也可建群'
          : '普通用户可自建 1 个群组（自动加入），再建馆将归属该组';
      }`
  );

  // showTab: user can open tab 4
  c = c.replace(
    'if (!isAdmin() && (n === 4 || n === 5)) n = 1;',
    'if (!isAdmin() && n === 5) n = 1;'
  );

  // renderGroupsAdmin → also for user (limited actions)
  c = c.replace(
    `function renderGroupsAdmin() {
    const box = document.getElementById('groups');
    if (!box || !isAdmin()) return;
    if (!allGroups.length) {
      box.innerHTML = '<div class="muted">暂无群组</div>';
      return;
    }
    box.innerHTML = '';
    allGroups.forEach((g) => {
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML =
        '<div style="flex:1"><b>' +
        esc(g.name) +
        '</b><div style="font-size:12px;color:var(--muted)">' +
        (g.library_count || 0) +
        ' 馆 · ' +
        (g.member_count || 0) +
        ' 人</div><div style="font-size:12px;color:var(--muted)">' +
        esc(g.description || '') +
        '</div></div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px">' +
        '<button type="button" data-a="mem" style="border:0;background:0;color:var(--primary)">成员</button>' +
        '<button type="button" data-a="libs" style="border:0;background:0;color:var(--accent-2)">归属馆</button>' +
        '<button type="button" data-a="del" style="border:0;background:0;color:var(--err-text)">删除</button></div>';
      div.querySelector('[data-a=mem]').onclick = () => editGroupMembers(g);
      div.querySelector('[data-a=libs]').onclick = () => editGroupLibraries(g);
      div.querySelector('[data-a=del]').onclick = async () => {
        if (!confirm('删除群组「' + g.name + '」？')) return;
        try {
          await api('/groups/' + g.id, { method: 'DELETE' });
          toast('已删除');
          loadGroups();
        } catch (e) {
          toast(e.message, true);
        }
      };
      box.appendChild(div);
    });
  }`,
    `function renderGroupsAdmin() {
    const box = document.getElementById('groups');
    if (!box) return;
    if (!canWrite()) {
      box.innerHTML = '<div class="muted">只读账号无群组管理</div>';
      return;
    }
    // 普通用户：已有自建群则隐藏创建区
    const createBox = document.getElementById('group-create-box');
    if (createBox && !isAdmin()) {
      const mine = (allGroups || []).filter(
        (g) => me && Number(g.created_by) === Number(me.id)
      );
      createBox.classList.toggle('hide', mine.length >= 1);
    }
    if (!allGroups.length) {
      box.innerHTML = '<div class="muted">暂无群组' + (isAdmin() ? '' : '，可在上方创建一个') + '</div>';
      return;
    }
    box.innerHTML = '';
    allGroups.forEach((g) => {
      const div = document.createElement('div');
      div.className = 'card';
      const mine = me && Number(g.created_by) === Number(me.id);
      div.innerHTML =
        '<div style="flex:1"><b>' +
        esc(g.name) +
        (mine ? ' ·我创建' : '') +
        '</b><div style="font-size:12px;color:var(--muted)">' +
        (g.library_count || 0) +
        ' 馆 · ' +
        (g.member_count || 0) +
        ' 人</div><div style="font-size:12px;color:var(--muted)">' +
        esc(g.description || '') +
        '</div></div>' +
        (isAdmin()
          ? '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px">' +
            '<button type="button" data-a="mem" style="border:0;background:0;color:var(--primary)">成员</button>' +
            '<button type="button" data-a="libs" style="border:0;background:0;color:var(--accent-2)">归属馆</button>' +
            '<button type="button" data-a="del" style="border:0;background:0;color:var(--err-text)">删除</button></div>'
          : '<div style="font-size:12px;color:var(--muted);align-self:center">已加入</div>');
      if (isAdmin()) {
        div.querySelector('[data-a=mem]').onclick = () => editGroupMembers(g);
        div.querySelector('[data-a=libs]').onclick = () => editGroupLibraries(g);
        div.querySelector('[data-a=del]').onclick = async () => {
          if (!confirm('删除群组「' + g.name + '」？')) return;
          try {
            await api('/groups/' + g.id, { method: 'DELETE' });
            toast('已删除');
            loadGroups();
          } catch (e) {
            toast(e.message, true);
          }
        };
      }
      box.appendChild(div);
    });
  }`
  );

  c = c.replace(
    `async function createGroup() {
    if (!isAdmin()) return;
    const name = document.getElementById('gn').value.trim();
    const description = document.getElementById('gd').value.trim();
    if (!name) return toast('填群组名', true);
    try {
      await api('/groups', { method: 'POST', body: JSON.stringify({ name, description }) });
      document.getElementById('gn').value = '';
      document.getElementById('gd').value = '';
      toast('群组已创建');
      loadGroups();
    } catch (e) {
      toast(e.message, true);
    }
  }`,
    `async function createGroup() {
    if (!canWrite()) return toast('无权限', true);
    const name = document.getElementById('gn').value.trim();
    const description = document.getElementById('gd').value.trim();
    if (!name) return toast('填群组名', true);
    try {
      await api('/groups', { method: 'POST', body: JSON.stringify({ name, description }) });
      document.getElementById('gn').value = '';
      document.getElementById('gd').value = '';
      toast(isAdmin() ? '群组已创建' : '群组已创建，您已自动加入');
      loadGroups();
    } catch (e) {
      toast(e.message, true);
    }
  }`
  );

  c = c.replace(
    `async function createLib() {
    if (!canWrite()) return toast('只读账号无此权限', true);
    const name = document.getElementById('n').value.trim();
    const description = document.getElementById('d').value.trim();
    if (!name) return toast('填名称', true);
    const body = { name, description };
    if (isAdmin()) {
      const vis = document.getElementById('lib-vis').value || 'group';
      body.visibility = vis;
      const gids = selectedLibGroupIds();
      if (vis === 'group') {
        body.owner_group_id = gids[0] || null;
        body.visible_group_ids = gids[0] ? [gids[0]] : [];
      } else if (vis === 'custom') {
        body.visible_group_ids = gids;
        body.owner_group_id = gids[0] || null;
      } else {
        body.visibility = 'public';
        body.visible_group_ids = [];
      }
    }
    try {
      const d = await api('/libraries', { method: 'POST', body: JSON.stringify(body) });
      libId = Number(d.library.id);
      localStorage.setItem(LS, String(libId));
      document.getElementById('n').value = '';
      document.getElementById('d').value = '';
      toast('已创建');
      await loadLibs();
    } catch (e) {
      toast(e.message, true);
    }
  }`,
    `async function createLib() {
    if (!canWrite()) return toast('只读账号无此权限', true);
    const name = document.getElementById('n').value.trim();
    const description = document.getElementById('d').value.trim();
    if (!name) return toast('填名称', true);
    const body = { name, description };
    if (isAdmin()) {
      const vis = document.getElementById('lib-vis').value || 'group';
      body.visibility = vis;
      const gids = selectedLibGroupIds();
      if (vis === 'group') {
        body.owner_group_id = gids[0] || null;
        body.visible_group_ids = gids[0] ? [gids[0]] : [];
      } else if (vis === 'custom') {
        body.visible_group_ids = gids;
        body.owner_group_id = gids[0] || null;
      } else {
        body.visibility = 'public';
        body.visible_group_ids = [];
      }
    }
    // user：不传可见性，后端自动归属其群组
    try {
      const d = await api('/libraries', { method: 'POST', body: JSON.stringify(body) });
      libId = Number(d.library.id);
      localStorage.setItem(LS, String(libId));
      document.getElementById('n').value = '';
      document.getElementById('d').value = '';
      toast(isAdmin() ? '已创建' : '已创建，已归属您的群组');
      await loadLibs();
    } catch (e) {
      toast(e.message, true);
    }
  }`
  );

  // loadGroups for user on boot when show tab
  c = c.replace(
    'if (isAdmin()) loadGroups();',
    'if (canWrite()) loadGroups();'
  );

  fs.writeFileSync(p, c);
  console.log('frontend fffd', (c.match(/\uFFFD/g) || []).length);
}
