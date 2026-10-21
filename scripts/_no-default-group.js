const fs = require('fs');

// ---- db.js ----
{
  const p = 'backend/src/db.js';
  let c = fs.readFileSync(p, 'utf8');

  // 默认馆创建时即 public，无归属群
  c = c.replace(
    `INSERT INTO libraries (name, description) VALUES ('默认图书馆', '系统自动创建')`,
    `INSERT INTO libraries (name, description, visibility, owner_group_id, group_id)
         VALUES ('默认图书馆', '全员可见的默认馆', 'public', NULL, NULL)`
  );
  // second occurrence (empty libs)
  c = c.replace(
    `INSERT INTO libraries (name, description) VALUES ('默认图书馆', '系统自动创建')`,
    `INSERT INTO libraries (name, description, visibility, owner_group_id, group_id)
         VALUES ('默认图书馆', '全员可见的默认馆', 'public', NULL, NULL)`
  );

  // 不再强制建「默认群组」；仅当已有群组时做旧数据迁移
  const oldBlock = `    // 默认群组 + 挂上无 group 的馆
    const [gCount] = await conn.query(\`SELECT COUNT(*) AS c FROM org_groups\`);
    let defaultGroupId = null;
    if (gCount[0].c === 0) {
      const [g] = await conn.query(
        \`INSERT INTO org_groups (name, description) VALUES ('默认群组', '系统自动创建')\`
      );
      defaultGroupId = g.insertId;
    } else {
      const [g] = await conn.query(\`SELECT id FROM org_groups ORDER BY id ASC LIMIT 1\`);
      defaultGroupId = g[0].id;
    }
    // 迁移：旧馆无 owner/visibility 时，归默认群组私有
    await conn.query(
      \`UPDATE libraries SET owner_group_id = COALESCE(owner_group_id, group_id, ?)
       WHERE owner_group_id IS NULL\`,
      [defaultGroupId]
    );
    await conn.query(
      \`UPDATE libraries SET group_id = COALESCE(group_id, owner_group_id) WHERE group_id IS NULL\`
    );
    await conn.query(
      \`UPDATE libraries SET visibility='group' WHERE visibility IS NULL OR visibility=''\`
    );
    // 同步 library_groups：group 可见性写入一行
    await conn.query(\`
      INSERT IGNORE INTO library_groups (library_id, group_id)
      SELECT id, owner_group_id FROM libraries
      WHERE visibility='group' AND owner_group_id IS NOT NULL
    \`);`;

  const newBlock = `    // 默认图书馆：全员可见（public），不依赖默认群组
    await conn.query(
      \`UPDATE libraries
       SET visibility='public', owner_group_id=NULL, group_id=NULL, description=COALESCE(NULLIF(description,''), '全员可见的默认馆')
       WHERE name='默认图书馆'\`
    );
    await conn.query(
      \`DELETE lg FROM library_groups lg
       INNER JOIN libraries l ON l.id=lg.library_id
       WHERE l.name='默认图书馆'\`
    );

    // 群组由管理员按需创建，不再自动建「默认群组」
    // 旧数据：visibility 空 → group；有 owner 的 group 馆同步 library_groups
    await conn.query(
      \`UPDATE libraries SET visibility='group' WHERE (visibility IS NULL OR visibility='') AND name<>'默认图书馆'\`
    );
    await conn.query(
      \`UPDATE libraries SET group_id = owner_group_id WHERE group_id IS NULL AND owner_group_id IS NOT NULL\`
    );
    await conn.query(\`
      INSERT IGNORE INTO library_groups (library_id, group_id)
      SELECT id, owner_group_id FROM libraries
      WHERE visibility='group' AND owner_group_id IS NOT NULL
    \`);`;

  if (c.includes(oldBlock)) {
    c = c.replace(oldBlock, newBlock);
    console.log('db migrate block replaced');
  } else if (!c.includes("name='默认图书馆'")) {
    // try looser insert after default lib seed
    console.warn('exact block not found, trying anchor');
    if (c.includes('// 默认群组 + 挂上无 group 的馆')) {
      const start = c.indexOf('// 默认群组 + 挂上无 group 的馆');
      const end = c.indexOf('try {\n      await conn.query(`\n        ALTER TABLE libraries\n        ADD CONSTRAINT fk_lib_group');
      if (start > 0 && end > start) {
        c = c.slice(0, start) + newBlock + '\n\n    ' + c.slice(end);
        console.log('db block replaced by anchors');
      }
    }
  } else {
    console.log('db already patched or partial');
  }

  // remove orphan auto-join default group
  const orphan = `    // 已有用户若无群组，加入默认群组
    const [orphans] = await conn.query(
      \`SELECT u.id FROM users u
       LEFT JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.user_id IS NULL\`
    );
    for (const o of orphans) {
      await conn.query(
        \`INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)\`,
        [defaultGroupId, o.id]
      );
    }`;
  if (c.includes(orphan)) {
    c = c.replace(orphan, '    // 新用户默认无群组，由管理员分配；公开馆对所有登录用户可见\n');
    console.log('orphans removed');
  } else if (c.includes('已有用户若无群组')) {
    c = c.replace(
      /    \/\/ 已有用户若无群组[\s\S]*?for \(const o of orphans\) \{[\s\S]*?\n    \}/,
      '    // 新用户默认无群组，由管理员分配；公开馆对所有登录用户可见'
    );
    console.log('orphans removed loose');
  }

  // defaultGroupId may still be referenced - check
  if (c.includes('defaultGroupId')) {
    console.warn('defaultGroupId still referenced');
  }

  fs.writeFileSync(p, c);
}

// ---- index.js ----
{
  const p = 'backend/src/index.js';
  let c = fs.readFileSync(p, 'utf8');

  // remove ensureUserInDefaultGroup function usage; keep function as no-op or delete
  c = c.replace(
    `async function ensureUserInDefaultGroup(userId) {
  const [g] = await pool.query(\`SELECT id FROM org_groups ORDER BY id ASC LIMIT 1\`);
  if (!g[0]) return;
  await pool.query(
    \`INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)\`,
    [g[0].id, userId]
  );
}`,
    `/** 新用户不自动进组；公开馆即可访问默认资源 */
async function ensureUserInDefaultGroup(_userId) {
  return;
}`
  );

  // login: don't call ensure
  c = c.replace(
    `    try {
      await ensureUserInDefaultGroup(u.id);
    } catch (ge) {
      console.error('[login] ensure group:', ge.message);
    }
    const sess = await createSession(u.id);`,
    `    const sess = await createSession(u.id);`
  );

  // create user: no auto group
  c = c.replace(
    `    if (groupIds.length) {
      for (const gid of groupIds) {
        await pool.query(
          \`INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)\`,
          [gid, r.insertId]
        );
      }
    } else {
      await ensureUserInDefaultGroup(r.insertId);
    }`,
    `    // 仅当管理员显式指定 group_ids 时加入；否则无群组，待分配
    for (const gid of groupIds) {
      await pool.query(
        \`INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)\`,
        [gid, r.insertId]
      );
    }`
  );

  // libraries list: no groups still see public
  c = c.replace(
    `    } else {
      if (!userGids.length) return res.json({ libraries: [] });
      [rows] = await pool.query(
        \`SELECT l.id, l.group_id, l.owner_group_id, l.visibility, l.name, l.description, l.created_at,
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
         ORDER BY l.created_at ASC\`,
        [userGids, userGids]
      );
    }`,
    `    } else if (!userGids.length) {
      // 无群组：仍可见 public 馆（如默认图书馆）
      [rows] = await pool.query(
        \`SELECT l.id, l.group_id, l.owner_group_id, l.visibility, l.name, l.description, l.created_at,
                g.name AS group_name, og.name AS owner_group_name,
                COUNT(DISTINCT b.id) AS book_count
         FROM libraries l
         LEFT JOIN org_groups g ON g.id=l.group_id
         LEFT JOIN org_groups og ON og.id=l.owner_group_id
         LEFT JOIN books b ON b.library_id = l.id
         WHERE l.visibility='public'
         GROUP BY l.id
         ORDER BY l.created_at ASC\`
      );
    } else {
      [rows] = await pool.query(
        \`SELECT l.id, l.group_id, l.owner_group_id, l.visibility, l.name, l.description, l.created_at,
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
         ORDER BY l.created_at ASC\`,
        [userGids, userGids]
      );
    }`
  );

  fs.writeFileSync(p, c);
  console.log('index.js patched');
}

// ---- auth.js: admin 也不强制进默认组 ----
{
  const p = 'backend/src/auth.js';
  let c = fs.readFileSync(p, 'utf8');
  c = c.replace(
    `  try {
    const [g] = await pool.query(\`SELECT id FROM org_groups ORDER BY id ASC LIMIT 1\`);
    if (g[0]) {
      await pool.query(
        \`INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)\`,
        [g[0].id, r.insertId]
      );
    }
  } catch (_) {}
  console.log(\`[auth] default admin created: \${user} / (see ADMIN_PASSWORD)\`);`,
    `  // 管理员也不自动进组；公开馆即可用
  console.log(\`[auth] default admin created: \${user} / (see ADMIN_PASSWORD)\`);`
  );
  fs.writeFileSync(p, c);
  console.log('auth.js patched');
}

// ---- frontend hint ----
{
  const p = 'frontend/index.html';
  let c = fs.readFileSync(p, 'utf8');
  c = c.replace(
    '创建用户（无自助注册）。初始密码默认 <b>a123456</b>',
    '创建用户（无自助注册）。初始密码默认 <b>a123456</b>。新用户默认无群组，可看公开馆；群组由管理员在「群组」分配'
  );
  c = c.replace(
    '可见性（仅管理员）',
    '可见性（仅管理员；公开=所有登录用户）'
  );
  fs.writeFileSync(p, c);
  console.log('frontend hints ok fffd', (c.match(/\uFFFD/g) || []).length);
}
