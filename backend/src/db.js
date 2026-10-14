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
    await conn.query(`
      CREATE TABLE IF NOT EXISTS libraries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        description VARCHAR(512) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_name (name)
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

    // 兼容旧表：若已有 books 且无 library_id，则迁移
    const hasLibraryId = await columnExists(conn, 'books', 'library_id');
    if (!hasLibraryId) {
      const [libs] = await conn.query(
        `INSERT INTO libraries (name, description) VALUES ('默认图书馆', '系统自动创建')
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
        `INSERT INTO libraries (name, description) VALUES ('默认图书馆', '系统自动创建')`
      );
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDb };
