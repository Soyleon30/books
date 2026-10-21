const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'host.docker.internal',
  port: Number(process.env.MYSQL_PORT || 3319),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'MySql@2024',
  database: process.env.MYSQL_DATABASE || 'books',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].c > 0;
}

async function initDb() {
  const conn = await pool.getConnection();
  try {
    // MySQL 保留字 groups → 使用 org_groups；旧库若已有 groups 则改名
    try {
      const [t] = await conn.query(
        `SELECT TABLE_NAME AS n FROM information_schema.TABLES
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('groups','org_groups')`
      );
      const names = t.map((x) => x.n);
      if (names.includes('groups') && !names.includes('org_groups')) {
        await conn.query('RENAME TABLE `groups` TO org_groups');
      }
    } catch (_) {}

    await conn.query(`
      CREATE TABLE IF NOT EXISTS org_groups (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        description VARCHAR(512) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_group_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS libraries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        group_id BIGINT UNSIGNED NULL,
        owner_group_id BIGINT UNSIGNED NULL,
        visibility VARCHAR(16) NOT NULL DEFAULT 'group',
        name VARCHAR(128) NOT NULL,
        description VARCHAR(512) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_name (name),
        KEY idx_lib_group (group_id),
        KEY idx_lib_owner_group (owner_group_id),
        KEY idx_lib_vis (visibility)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    if (!(await columnExists(conn, 'libraries', 'group_id'))) {
      await conn.query(`ALTER TABLE libraries ADD COLUMN group_id BIGINT UNSIGNED NULL`);
      await conn.query(`ALTER TABLE libraries ADD KEY idx_lib_group (group_id)`);
    }
    if (!(await columnExists(conn, 'libraries', 'owner_group_id'))) {
      await conn.query(`ALTER TABLE libraries ADD COLUMN owner_group_id BIGINT UNSIGNED NULL`);
      await conn.query(`ALTER TABLE libraries ADD KEY idx_lib_owner_group (owner_group_id)`);
    }
    if (!(await columnExists(conn, 'libraries', 'visibility'))) {
      await conn.query(
        `ALTER TABLE libraries ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'group'`
      );
      await conn.query(`ALTER TABLE libraries ADD KEY idx_lib_vis (visibility)`);
    }

    // 图书馆 ↔ 群组 可见性（custom 时用；public 全员；group 用 owner_group_id）
    await conn.query(`
      CREATE TABLE IF NOT EXISTS library_groups (
        library_id BIGINT UNSIGNED NOT NULL,
        group_id BIGINT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (library_id, group_id),
        KEY idx_lg_group (group_id),
        CONSTRAINT fk_lg_lib FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE,
        CONSTRAINT fk_lg_group FOREIGN KEY (group_id) REFERENCES org_groups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS books (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        library_id BIGINT UNSIGNED NOT NULL,
        isbn VARCHAR(32) NOT NULL,
        title VARCHAR(512) NOT NULL DEFAULT '未知书名',
        authors VARCHAR(512) NOT NULL DEFAULT '未知作者',
        cover VARCHAR(1024) DEFAULT NULL,
        publisher VARCHAR(256) DEFAULT NULL,
        published VARCHAR(64) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_library_isbn (library_id, isbn),
        KEY idx_library (library_id),
        CONSTRAINT fk_books_library FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 锁定：批量刮削跳过；前端不显示刮削按钮
    try {
      if (!(await columnExists(conn, 'books', 'locked'))) {
        await conn.query(
          `ALTER TABLE books ADD COLUMN locked TINYINT(1) NOT NULL DEFAULT 0 AFTER published`
        );
      }
      try {
        await conn.query(`ALTER TABLE books ADD KEY idx_books_locked (library_id, locked)`);
      } catch (_) {}
    } catch (e) {
      console.error('[initDb] books.locked:', e.message || e);
    }

    const hasLibraryId = await columnExists(conn, 'books', 'library_id');
    if (!hasLibraryId) {
      const [libs] = await conn.query(
        `INSERT INTO libraries (name, description, visibility, owner_group_id, group_id)
         VALUES ('默认图书馆', '全员可见的默认馆', 'public', NULL, NULL)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`
      );
      let defaultId = libs.insertId;
      if (!defaultId) {
        const [rows] = await conn.query(`SELECT id FROM libraries WHERE name = '默认图书馆' LIMIT 1`);
        defaultId = rows[0].id;
      }
      await conn.query(`ALTER TABLE books ADD COLUMN library_id BIGINT UNSIGNED NULL`);
      await conn.query(`UPDATE books SET library_id = ? WHERE library_id IS NULL`, [defaultId]);
      try {
        await conn.query(`ALTER TABLE books DROP INDEX uk_isbn`);
      } catch (_) {}
      await conn.query(`ALTER TABLE books MODIFY library_id BIGINT UNSIGNED NOT NULL`);
      try {
        await conn.query(`ALTER TABLE books ADD UNIQUE KEY uk_library_isbn (library_id, isbn)`);
      } catch (_) {}
      try {
        await conn.query(
          `ALTER TABLE books ADD CONSTRAINT fk_books_library FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE`
        );
      } catch (_) {}
    }

    const [countRows] = await conn.query(`SELECT COUNT(*) AS c FROM libraries`);
    if (countRows[0].c === 0) {
      await conn.query(
        `INSERT INTO libraries (name, description, visibility, owner_group_id, group_id)
         VALUES ('默认图书馆', '全员可见的默认馆', 'public', NULL, NULL)`
      );
    }

    // 默认馆：全员可见，不依赖群组（无「默认群组」兜底）
    await conn.query(
      `UPDATE libraries
       SET visibility='public', owner_group_id=NULL, group_id=NULL,
           description=COALESCE(NULLIF(description,''), '全员可见的默认馆')
       WHERE name='默认图书馆'`
    );
    await conn.query(
      `DELETE lg FROM library_groups lg
       INNER JOIN libraries l ON l.id=lg.library_id
       WHERE l.name='默认图书馆'`
    );

    // 旧数据：无 visibility 的非默认馆 → private（仅创建者）
    await conn.query(
      `UPDATE libraries SET visibility='private'
       WHERE (visibility IS NULL OR visibility='') AND name<>'默认图书馆'`
    );
    // 一次性：曾默认写成 group 的个人馆 → private（有标记则跳过，避免覆盖管理员已设的共享）
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_flags (
        flag_key VARCHAR(64) NOT NULL PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [flagRows] = await conn.query(
      `SELECT flag_key FROM schema_flags WHERE flag_key='lib_private_owner_v1' LIMIT 1`
    );
    if (!flagRows.length) {
      await conn.query(
        `UPDATE libraries SET visibility='private'
         WHERE name<>'默认图书馆'
           AND visibility IN ('group','custom')
           AND created_by IS NOT NULL`
      );
      await conn.query(
        `DELETE lg FROM library_groups lg
         INNER JOIN libraries l ON l.id=lg.library_id
         WHERE l.visibility='private'`
      );
      await conn.query(
        `INSERT INTO schema_flags (flag_key) VALUES ('lib_private_owner_v1')`
      );
    }
    await conn.query(
      `UPDATE libraries SET group_id = owner_group_id
       WHERE group_id IS NULL AND owner_group_id IS NOT NULL
         AND visibility IN ('group','custom')`
    );
    await conn.query(`
      INSERT IGNORE INTO library_groups (library_id, group_id)
      SELECT id, owner_group_id FROM libraries
      WHERE visibility='group' AND owner_group_id IS NOT NULL
    `);

    try {
      await conn.query(`
        ALTER TABLE libraries
        ADD CONSTRAINT fk_lib_group FOREIGN KEY (group_id) REFERENCES org_groups(id) ON DELETE SET NULL
      `);
    } catch (_) {}
    try {
      await conn.query(`
        ALTER TABLE libraries
        ADD CONSTRAINT fk_lib_owner_group FOREIGN KEY (owner_group_id) REFERENCES org_groups(id) ON DELETE SET NULL
      `);
    } catch (_) {}

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(128) DEFAULT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'user',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_username (username),
        KEY idx_role (role)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);



    if (!(await columnExists(conn, 'org_groups', 'created_by'))) {
      try {
        await conn.query(`ALTER TABLE org_groups ADD COLUMN created_by BIGINT UNSIGNED NULL`);
        await conn.query(`ALTER TABLE org_groups ADD KEY idx_og_creator (created_by)`);
      } catch (_) {}
    }
    if (!(await columnExists(conn, 'libraries', 'created_by'))) {
      try {
        await conn.query(`ALTER TABLE libraries ADD COLUMN created_by BIGINT UNSIGNED NULL`);
        await conn.query(`ALTER TABLE libraries ADD KEY idx_lib_creator (created_by)`);
      } catch (_) {}
    }
    if (!(await columnExists(conn, 'users', 'theme'))) {
      await conn.query(
        `ALTER TABLE users ADD COLUMN theme VARCHAR(32) NOT NULL DEFAULT 'sage'`
      );
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        token VARCHAR(128) NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_token (token),
        KEY idx_user (user_id),
        KEY idx_exp (expires_at),
        CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id),
        KEY idx_gm_user (user_id),
        CONSTRAINT fk_gm_group FOREIGN KEY (group_id) REFERENCES org_groups(id) ON DELETE CASCADE,
        CONSTRAINT fk_gm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);


    await conn.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NULL,
        username VARCHAR(64) NULL,
        role VARCHAR(16) NULL,
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(32) NULL,
        target_id VARCHAR(64) NULL,
        detail TEXT NULL,
        ip VARCHAR(64) NULL,
        user_agent VARCHAR(512) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_audit_created (created_at),
        KEY idx_audit_user (user_id),
        KEY idx_audit_action (action)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 封面二进制（不依赖容器磁盘，PaaS 无 volume 也能显示）
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS book_covers (
          isbn VARCHAR(32) NOT NULL PRIMARY KEY,
          mime VARCHAR(64) NOT NULL DEFAULT 'image/jpeg',
          bytes INT UNSIGNED NOT NULL DEFAULT 0,
          data LONGBLOB NOT NULL,
          source_url VARCHAR(1024) NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    } catch (e) {
      console.error('[initDb] book_covers table:', e.message || e);
    }

    // 刮削全程日志（失败不阻断启动）
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS scrape_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          run_id VARCHAR(36) NOT NULL,
          isbn VARCHAR(20) NULL,
          event VARCHAR(64) NOT NULL,
          site VARCHAR(64) NULL,
          phase VARCHAR(32) NULL,
          ok TINYINT(1) NULL,
          http_status INT NULL,
          url VARCHAR(1024) NULL,
          request_json MEDIUMTEXT NULL,
          response_json MEDIUMTEXT NULL,
          response_body MEDIUMTEXT NULL,
          meta_json TEXT NULL,
          error_text VARCHAR(1024) NULL,
          elapsed_ms INT NULL,
          summary VARCHAR(512) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_scrape_run (run_id),
          KEY idx_scrape_isbn (isbn),
          KEY idx_scrape_created (created_at),
          KEY idx_scrape_event (event),
          KEY idx_scrape_site (site)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    } catch (e) {
      console.error('[initDb] scrape_logs table:', e.message || e);
    }

    // 书脊/书名匹配诊断（谁调了哪家接口、返回什么、为何未命中）
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS match_logs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          run_id VARCHAR(36) NOT NULL,
          user_id BIGINT UNSIGNED NULL,
          username VARCHAR(64) NULL,
          library_id BIGINT UNSIGNED NULL,
          query_text VARCHAR(256) NULL,
          event VARCHAR(64) NOT NULL,
          site VARCHAR(64) NULL,
          ok TINYINT(1) NULL,
          http_status INT NULL,
          request_json MEDIUMTEXT NULL,
          response_json MEDIUMTEXT NULL,
          hits_json MEDIUMTEXT NULL,
          pick_json TEXT NULL,
          reason VARCHAR(1024) NULL,
          elapsed_ms INT NULL,
          summary VARCHAR(512) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_match_run (run_id),
          KEY idx_match_created (created_at),
          KEY idx_match_event (event),
          KEY idx_match_site (site),
          KEY idx_match_query (query_text),
          KEY idx_match_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    } catch (e) {
      console.error('[initDb] match_logs table:', e.message || e);
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDb };
