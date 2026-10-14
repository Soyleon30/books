const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'host.docker.internal',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'lite_paas',
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

function defaultBookScannerStack() {
  return {
    network: 'book-scanner-net',
    services: [
      {
        key: 'api',
        name: 'API',
        image: 'book-scanner-api:latest',
        container_name: 'book-scanner-api',
        host_port: 3000,
        container_port: 3000,
        env_keys: ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'PORT'],
      },
      {
        key: 'web',
        name: '前端',
        image: 'book-scanner-web:latest',
        container_name: 'book-scanner-web',
        host_port: 8080,
        container_port: 80,
        env: {
          API_UPSTREAM: 'book-scanner-api:3000',
        },
      },
    ],
  };
}

async function initDb() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS apps (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        slug VARCHAR(64) NOT NULL,
        description VARCHAR(512) DEFAULT NULL,
        image_name VARCHAR(256) NOT NULL,
        container_name VARCHAR(128) NOT NULL,
        host_port INT UNSIGNED NOT NULL,
        container_port INT UNSIGNED NOT NULL DEFAULT 80,
        env_json TEXT NULL,
        deploy_mode VARCHAR(32) NOT NULL DEFAULT 'single',
        stack_json MEDIUMTEXT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'created',
        last_error TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_slug (slug),
        UNIQUE KEY uk_name (name),
        UNIQUE KEY uk_container (container_name),
        UNIQUE KEY uk_host_port (host_port)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    if (!(await columnExists(conn, 'apps', 'deploy_mode'))) {
      await conn.query(
        `ALTER TABLE apps ADD COLUMN deploy_mode VARCHAR(32) NOT NULL DEFAULT 'single' AFTER env_json`
      );
    }
    if (!(await columnExists(conn, 'apps', 'stack_json'))) {
      await conn.query(`ALTER TABLE apps ADD COLUMN stack_json MEDIUMTEXT NULL AFTER deploy_mode`);
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS releases (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        app_id BIGINT UNSIGNED NOT NULL,
        version VARCHAR(64) NOT NULL,
        image_tag VARCHAR(256) NOT NULL,
        tar_path VARCHAR(1024) DEFAULT NULL,
        tar_size BIGINT UNSIGNED DEFAULT 0,
        note VARCHAR(512) DEFAULT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'uploaded',
        deploy_log MEDIUMTEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_app (app_id),
        CONSTRAINT fk_rel_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS deploy_jobs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        app_id BIGINT UNSIGNED NOT NULL,
        release_id BIGINT UNSIGNED NULL,
        action VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        log_text MEDIUMTEXT NULL,
        started_at TIMESTAMP NULL,
        finished_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_app_job (app_id),
        CONSTRAINT fk_job_app FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM apps`);
    if (rows[0].c === 0) {
      const stack = defaultBookScannerStack();
      const defaultEnv = {
        MYSQL_HOST: process.env.BOOKS_MYSQL_HOST || process.env.MYSQL_HOST || '8.157.18.157',
        MYSQL_PORT: process.env.BOOKS_MYSQL_PORT || '3319',
        MYSQL_USER: process.env.BOOKS_MYSQL_USER || process.env.MYSQL_USER || 'root',
        MYSQL_PASSWORD: process.env.BOOKS_MYSQL_PASSWORD || '',
        MYSQL_DATABASE: process.env.BOOKS_MYSQL_DATABASE || 'books',
        PORT: '3000',
      };
      await conn.query(
        `INSERT INTO apps (name, slug, description, image_name, container_name, host_port, container_port, env_json, deploy_mode, stack_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          '书本扫描器',
          'book-scanner',
          '整栈：前端 8080 + API 3000（上传 pack.sh 生成的 book-scanner-images.tar）',
          'book-scanner-web',
          'book-scanner-stack',
          8080,
          80,
          JSON.stringify(defaultEnv),
          'stack',
          JSON.stringify(stack),
          'created',
        ]
      );
    } else {
      // 升级旧预置：若存在 book-scanner 且仍是 single，改为 stack
      const [old] = await conn.query(`SELECT id, deploy_mode, stack_json FROM apps WHERE slug='book-scanner' LIMIT 1`);
      if (old[0] && (!old[0].deploy_mode || old[0].deploy_mode === 'single' || !old[0].stack_json)) {
        await conn.query(
          `UPDATE apps SET deploy_mode='stack', stack_json=?, description=?, container_name='book-scanner-stack' WHERE id=?`,
          [
            JSON.stringify(defaultBookScannerStack()),
            '整栈：前端 8080 + API 3000（上传 pack.sh 生成的 book-scanner-images.tar）',
            old[0].id,
          ]
        );
      }
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDb, defaultBookScannerStack };
