require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool, initDb } = require('./db');
const runtime = require('./runtime');

const PORT = Number(process.env.PORT || 8083);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const APPS_DIR = path.join(DATA_DIR, 'apps');

for (const d of [DATA_DIR, UPLOAD_DIR, APPS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || 'image.tar').replace(/[^\w.\-]+/g, '_');
    cb(null, `${Date.now()}_${uuidv4().slice(0, 8)}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const n = (file.originalname || '').toLowerCase();
    if (
      n.endsWith('.zip') ||
      n.endsWith('.tar') ||
      n.endsWith('.tar.gz') ||
      n.endsWith('.tgz')
    ) {
      cb(null, true);
    } else {
      cb(new Error('支持 books-source_*.tar.gz / .zip / 镜像 .tar'));
    }
  },
});

function slugify(s) {
  return (
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `app-${Date.now()}`
  );
}

function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch (_) {
    return {};
  }
}

async function getApp(id) {
  const [rows] = await pool.query('SELECT * FROM apps WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function getRelease(id) {
  const [rows] = await pool.query('SELECT * FROM releases WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function createJob(appId, releaseId, action) {
  const [r] = await pool.query(
    `INSERT INTO deploy_jobs (app_id, release_id, action, status, log_text, started_at)
     VALUES (?, ?, ?, 'running', '', NOW())`,
    [appId, releaseId, action]
  );
  return r.insertId;
}

async function finishJob(jobId, status, logText) {
  await pool.query(`UPDATE deploy_jobs SET status = ?, log_text = ?, finished_at = NOW() WHERE id = ?`, [
    status,
    logText,
    jobId,
  ]);
}

function buildStackServices(appRow) {
  const stack = safeJson(appRow.stack_json);
  const env = safeJson(appRow.env_json);
  const services = (stack.services || []).map((s) => {
    const svcEnv = { ...(s.env || {}) };
    if (Array.isArray(s.env_keys)) {
      for (const k of s.env_keys) {
        if (env[k] !== undefined && env[k] !== null && env[k] !== '') {
          svcEnv[k] = String(env[k]);
        }
      }
    }
    // API 默认 PORT
    if (s.key === 'api' && !svcEnv.PORT) svcEnv.PORT = '3000';
    // web 默认指到 api 容器名
    if (s.key === 'web' && !svcEnv.API_UPSTREAM) {
      const api = (stack.services || []).find((x) => x.key === 'api');
      svcEnv.API_UPSTREAM = api
        ? `${api.container_name}:${api.container_port || 3000}`
        : 'book-scanner-api:3000';
    }
    return {
      key: s.key,
      name: s.name || s.key,
      image: s.image,
      container_name: s.container_name,
      host_port: Number(s.host_port),
      container_port: Number(s.container_port),
      // 源码 build 必需；旧 stack_json 可能缺这些字段
      context: s.context || (s.key === 'api' ? 'backend' : s.key === 'web' ? 'frontend' : '.'),
      dockerfile: s.dockerfile || 'Dockerfile',
      env_keys: Array.isArray(s.env_keys) ? s.env_keys : undefined,
      env: svcEnv,
    };
  });
  return {
    network: stack.network || `${appRow.slug}-net`,
    services,
  };
}

function defaultDeployEnv() {
  return {
    MYSQL_HOST: process.env.BOOKS_MYSQL_HOST || process.env.MYSQL_HOST || 'host.docker.internal',
    MYSQL_PORT: String(process.env.BOOKS_MYSQL_PORT || process.env.MYSQL_PORT || '3319'),
    MYSQL_USER: process.env.BOOKS_MYSQL_USER || process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD:
      process.env.BOOKS_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || 'MySql@2024',
    MYSQL_DATABASE: process.env.BOOKS_MYSQL_DATABASE || 'books',
    PORT: '3000',
  };
}

function isEmptyEnv(env) {
  return !env || typeof env !== 'object' || Object.keys(env).length === 0 || !env.MYSQL_PASSWORD;
}

/** 空 {} 则写默认 env 进库，保证面板永远不是 {} */
async function ensureAppEnvInDb(row) {
  let env = safeJson(row.env_json);
  if (!isEmptyEnv(env)) return env;
  env = { ...defaultDeployEnv(), ...env };
  if (!env.MYSQL_PASSWORD) env.MYSQL_PASSWORD = defaultDeployEnv().MYSQL_PASSWORD;
  if (!env.MYSQL_HOST || env.MYSQL_HOST === '127.0.0.1' || env.MYSQL_HOST === 'localhost') {
    env.MYSQL_HOST = defaultDeployEnv().MYSQL_HOST;
  }
  try {
    await pool.query(`UPDATE apps SET env_json=? WHERE id=?`, [JSON.stringify(env), row.id]);
    row.env_json = JSON.stringify(env);
  } catch (_) {}
  return env;
}

async function enrichApp(row) {
  const mode = row.deploy_mode || 'single';
  const env = await ensureAppEnvInDb(row);
  let container = { exists: false };
  let containers = [];
  if (mode === 'stack') {
    const { services } = buildStackServices({ ...row, env_json: JSON.stringify(env) });
    for (const s of services) {
      const st = await runtime.containerStatus(s.container_name);
      containers.push({ ...s, container: st });
    }
    const running = containers.filter((c) => c.container && c.container.exists).length;
    container = {
      exists: running > 0,
      status: running ? `${running}/${containers.length} running` : '未运行',
      services: containers,
    };
  } else {
    container = await runtime.containerStatus(row.container_name);
  }
  return {
    ...row,
    env,
    stack: safeJson(row.stack_json),
    deploy_mode: mode,
    container,
  };
}

// ---------- health ----------
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    let version = '1.2.0';
    try {
      version = require('../package.json').version || version;
    } catch (_) {}
    res.json({
      ok: true,
      db: true,
      runtime: runtime.detectRuntime(),
      port: PORT,
      version,
      features: ['source-zip', 'image-tar', 'stack'],
    });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

app.get('/api/runtime', (_req, res) => {
  res.json({ runtime: runtime.detectRuntime() });
});

// ---------- apps ----------
app.get('/api/apps', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*,
        (SELECT r.id FROM releases r WHERE r.app_id = a.id ORDER BY r.id DESC LIMIT 1) AS latest_release_id,
        (SELECT r.version FROM releases r WHERE r.app_id = a.id ORDER BY r.id DESC LIMIT 1) AS latest_version,
        (SELECT r.image_tag FROM releases r WHERE r.app_id = a.id ORDER BY r.id DESC LIMIT 1) AS latest_image_tag
       FROM apps a ORDER BY a.id ASC`
    );
    const list = [];
    for (const row of rows) {
      list.push(await enrichApp(row));
    }
    res.json({ apps: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/apps', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    let slug = String(req.body.slug || '').trim() || slugify(name);
    slug = slugify(slug);
    const description = String(req.body.description || '').trim() || null;
    const deployMode = String(req.body.deploy_mode || 'single').trim() === 'stack' ? 'stack' : 'single';
    const imageName = String(req.body.image_name || slug).trim() || slug;
    const containerName = String(req.body.container_name || `paas-${slug}`).trim();
    const hostPort = Number(req.body.host_port);
    const containerPort = Number(req.body.container_port || 80);
    const env = req.body.env && typeof req.body.env === 'object' ? req.body.env : {};
    const stack =
      deployMode === 'stack' && req.body.stack && typeof req.body.stack === 'object'
        ? req.body.stack
        : null;

    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      return res.status(400).json({ error: 'host_port 无效' });
    }
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      return res.status(400).json({ error: 'container_port 无效' });
    }

    const [r] = await pool.query(
      `INSERT INTO apps (name, slug, description, image_name, container_name, host_port, container_port, env_json, deploy_mode, stack_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created')`,
      [
        name,
        slug,
        description,
        imageName,
        containerName,
        hostPort,
        containerPort,
        JSON.stringify(env),
        deployMode,
        stack ? JSON.stringify(stack) : null,
      ]
    );
    const row = await getApp(r.insertId);
    res.status(201).json({ app: await enrichApp(row) });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '名称/端口/容器名冲突' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/apps/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await getApp(id);
    if (!row) return res.status(404).json({ error: '应用不存在' });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : row.name;
    const description =
      req.body.description !== undefined
        ? String(req.body.description || '').trim() || null
        : row.description;
    const imageName =
      req.body.image_name !== undefined ? String(req.body.image_name).trim() : row.image_name;
    const hostPort = req.body.host_port !== undefined ? Number(req.body.host_port) : row.host_port;
    const containerPort =
      req.body.container_port !== undefined ? Number(req.body.container_port) : row.container_port;
    let env =
      req.body.env !== undefined
        ? typeof req.body.env === 'object'
          ? req.body.env
          : safeJson(row.env_json)
        : safeJson(row.env_json);
    // 禁止存成空 {}
    if (!env || typeof env !== 'object' || Object.keys(env).length === 0) {
      env = defaultDeployEnv();
    }
    if (!env.MYSQL_PASSWORD) {
      env = { ...defaultDeployEnv(), ...env };
    }
    const deployMode =
      req.body.deploy_mode !== undefined
        ? String(req.body.deploy_mode) === 'stack'
          ? 'stack'
          : 'single'
        : row.deploy_mode || 'single';
    const stack =
      req.body.stack !== undefined
        ? typeof req.body.stack === 'object'
          ? req.body.stack
          : safeJson(row.stack_json)
        : safeJson(row.stack_json);

    await pool.query(
      `UPDATE apps SET name=?, description=?, image_name=?, host_port=?, container_port=?, env_json=?, deploy_mode=?, stack_json=? WHERE id=?`,
      [
        name,
        description,
        imageName,
        hostPort,
        containerPort,
        JSON.stringify(env),
        deployMode,
        Object.keys(stack || {}).length ? JSON.stringify(stack) : row.stack_json,
        id,
      ]
    );
    const updated = await getApp(id);
    res.json({ app: await enrichApp(updated) });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '端口或名称冲突' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/apps/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await getApp(id);
    if (!row) return res.status(404).json({ error: '应用不存在' });
    const jobId = await createJob(id, null, 'delete');
    let logText = '';
    if ((row.deploy_mode || 'single') === 'stack') {
      const { services } = buildStackServices(row);
      const result = await runtime.stopStack(services, []);
      logText = result.log;
    } else {
      const result = await runtime.undeploy(row.container_name, null);
      logText = result.log;
    }
    await finishJob(jobId, 'ok', logText);
    const [rels] = await pool.query('SELECT tar_path FROM releases WHERE app_id = ?', [id]);
    for (const r of rels) {
      if (r.tar_path && fs.existsSync(r.tar_path)) {
        try {
          fs.unlinkSync(r.tar_path);
        } catch (_) {}
      }
    }
    await pool.query('DELETE FROM apps WHERE id = ?', [id]);
    res.json({ message: '已删除', log: logText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- releases / upload ----------
app.get('/api/apps/:id/releases', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT id, app_id, version, image_tag, tar_size, note, status, created_at
       FROM releases WHERE app_id = ? ORDER BY id DESC LIMIT 50`,
      [id]
    );
    res.json({ releases: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function detectPackageKind(filePath, originalName) {
  const n = String(originalName || filePath || '').toLowerCase();
  if (n.endsWith('.zip')) return 'source';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'source';
  if (n.includes('source') && n.endsWith('.tar')) return 'source';
  if (n.includes('books-source')) return 'source';
  if (n.endsWith('.tar')) return 'image';
  return 'source';
}

app.post('/api/apps/:id/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || '上传失败' });
    try {
      const id = Number(req.params.id);
      const row = await getApp(id);
      if (!row) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: '应用不存在' });
      }
      if (!req.file) return res.status(400).json({ error: '请选择源码 zip 或镜像 tar' });

      const version = String(
        req.body.version || new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      );
      const kind = String(req.body.package_kind || detectPackageKind(req.file.path, req.file.originalname));
      const defaultTag =
        kind === 'source'
          ? 'source-build:latest'
          : (row.deploy_mode || 'single') === 'stack'
            ? 'stack:latest'
            : `${row.image_name}:latest`;
      const imageTag = String(req.body.image_tag || defaultTag).trim();
      const note =
        String(req.body.note || '').trim() ||
        (kind === 'source' ? '源码包（服务器 build）' : '镜像包（load）');

      const appDir = path.join(APPS_DIR, row.slug);
      fs.mkdirSync(appDir, { recursive: true });
      const dest = path.join(appDir, path.basename(req.file.path));
      fs.renameSync(req.file.path, dest);

      // 上传源码 zip 后立刻写 env（从 paas.json 或默认），禁止一直 {}
      let envWritten = null;
      if (kind === 'source') {
        envWritten = await fillEnvFromSourceZip(row, dest);
      } else {
        envWritten = await ensureAppEnvInDb(row);
      }

      const noteFull = `[kind=${kind}] ${note}`;

      const [r] = await pool.query(
        `INSERT INTO releases (app_id, version, image_tag, tar_path, tar_size, note, status)
         VALUES (?, ?, ?, ?, ?, ?, 'uploaded')`,
        [id, version, imageTag, dest, req.file.size || 0, noteFull]
      );
      const rel = await getRelease(r.insertId);
      const appFresh = await getApp(id);
      res.status(201).json({
        release: rel,
        package_kind: kind,
        env: envWritten || safeJson(appFresh && appFresh.env_json),
        app: await enrichApp(appFresh || row),
        message:
          kind === 'source'
            ? '源码上传成功，环境变量已写入，可直接部署'
            : '镜像上传成功',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

function releaseKind(rel) {
  const note = String((rel && rel.note) || '');
  const m = note.match(/\[kind=(\w+)\]/);
  if (m) return m[1];
  return detectPackageKind(rel && rel.tar_path, rel && rel.tar_path);
}

/** 从源码 zip 读 paas.json.env_example，合并默认后写入 apps.env_json */
async function fillEnvFromSourceZip(row, zipPath) {
  const defaults = defaultDeployEnv();
  let fromPaas = {};
  const tmp = path.join(APPS_DIR, row.slug, `_envpeek_${Date.now()}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const ex = await runtime.extractArchive(zipPath, tmp, []);
    if (ex && ex.ok) {
      const root = runtime.resolveSourceRoot(tmp);
      const meta = runtime.readPaasJson(root);
      if (meta && meta.env_example && typeof meta.env_example === 'object') {
        fromPaas = meta.env_example;
      }
      if (meta && meta.deploy_mode === 'stack' && meta.services) {
        try {
          await pool.query(
            `UPDATE apps SET deploy_mode='stack', stack_json=COALESCE(stack_json, ?) WHERE id=?`,
            [
              JSON.stringify({
                network: meta.network || `${row.slug}-net`,
                services: meta.services,
              }),
              row.id,
            ]
          );
        } catch (_) {}
      }
    }
  } catch (_) {
    // 解压失败仍写默认
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  }

  const existing = safeJson(row.env_json);
  // 默认 + zip 里的 example + 已有非空字段；强制 host 不是 127
  const env = {
    ...defaults,
    ...fromPaas,
    ...existing,
  };
  if (!env.MYSQL_PASSWORD) env.MYSQL_PASSWORD = defaults.MYSQL_PASSWORD;
  if (
    !env.MYSQL_HOST ||
    env.MYSQL_HOST === '127.0.0.1' ||
    env.MYSQL_HOST === 'localhost' ||
    env.MYSQL_HOST === '8.157.18.157'
  ) {
    env.MYSQL_HOST = defaults.MYSQL_HOST;
  }
  if (!env.MYSQL_PORT) env.MYSQL_PORT = defaults.MYSQL_PORT;
  if (!env.MYSQL_USER) env.MYSQL_USER = defaults.MYSQL_USER;
  if (!env.MYSQL_DATABASE) env.MYSQL_DATABASE = defaults.MYSQL_DATABASE;
  if (!env.PORT) env.PORT = '3000';

  await pool.query(`UPDATE apps SET env_json=? WHERE id=?`, [JSON.stringify(env), row.id]);
  row.env_json = JSON.stringify(env);
  return env;
}

/** 部署前：{} 或缺密码 → 强制补全并写回数据库 */
async function resolveDeployEnv(row) {
  return ensureAppEnvInDb(row);
}

async function runDeploy(row, rel, jobId) {
  const releaseId = rel.id;
  const env = await resolveDeployEnv(row);
  const kind = releaseKind(rel);
  let result;

  // stack 服务 env 依赖 row.env_json，补全后再 build
  row.env_json = JSON.stringify(env);

  if (kind === 'source') {
    const workDir = path.join(APPS_DIR, row.slug, `build_${releaseId}`);
    fs.mkdirSync(workDir, { recursive: true });
    const built = (row.deploy_mode || 'single') === 'stack' ? buildStackServices(row) : null;
    result = await runtime.deployFromSource({
      archivePath: rel.tar_path,
      workDir,
      network: (built && built.network) || env.NETWORK || `${row.slug}-net`,
      services: built ? built.services : null,
      sharedEnv: env,
    });
  } else if ((row.deploy_mode || 'single') === 'stack') {
    const built = buildStackServices(row);
    result = await runtime.deployStackFromTar({
      tarPath: rel.tar_path,
      network: built.network,
      services: built.services,
      sharedEnv: env,
    });
  } else {
    result = await runtime.deployFromTar({
      tarPath: rel.tar_path,
      imageName: row.image_name,
      imageTag: rel.image_tag || `${row.image_name}:latest`,
      containerName: row.container_name,
      hostPort: row.host_port,
      containerPort: row.container_port,
      env,
      network: env.NETWORK || null,
    });
  }

  await finishJob(jobId, result.ok ? 'ok' : 'failed', result.log);
  await pool.query(`UPDATE apps SET status=?, last_error=? WHERE id=?`, [
    result.ok ? 'running' : 'failed',
    result.ok ? null : '部署失败，见日志',
    row.id,
  ]);
  await pool.query(`UPDATE releases SET status=?, deploy_log=? WHERE id=?`, [
    result.ok ? 'deployed' : 'failed',
    result.log,
    releaseId,
  ]);
  return result;
}

// ---------- deploy / stop / restart ----------
app.post('/api/apps/:id/deploy', async (req, res) => {
  const id = Number(req.params.id);
  let jobId = null;
  try {
    const row = await getApp(id);
    if (!row) return res.status(404).json({ error: '应用不存在' });

    let releaseId = req.body.release_id ? Number(req.body.release_id) : null;
    let rel = null;
    if (releaseId) {
      rel = await getRelease(releaseId);
      if (!rel || Number(rel.app_id) !== id) return res.status(400).json({ error: 'release 无效' });
    } else {
      const [rows] = await pool.query(`SELECT * FROM releases WHERE app_id = ? ORDER BY id DESC LIMIT 1`, [
        id,
      ]);
      rel = rows[0] || null;
      if (!rel) return res.status(400).json({ error: '请先上传镜像包' });
      releaseId = rel.id;
    }

    jobId = await createJob(id, releaseId, 'deploy');
    await pool.query(`UPDATE apps SET status='deploying', last_error=NULL WHERE id=?`, [id]);
    await pool.query(`UPDATE releases SET status='deploying' WHERE id=?`, [releaseId]);

    res.json({ message: '部署已开始', job_id: jobId, release_id: releaseId });

    try {
      await runDeploy(row, rel, jobId);
    } catch (e) {
      await finishJob(jobId, 'failed', String(e.message || e));
      await pool.query(`UPDATE apps SET status='failed', last_error=? WHERE id=?`, [e.message, id]);
    }
  } catch (e) {
    if (jobId) await finishJob(jobId, 'failed', String(e.message || e));
    try {
      await pool.query(`UPDATE apps SET status='failed', last_error=? WHERE id=?`, [e.message, id]);
    } catch (_) {}
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.post('/api/apps/:id/stop', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await getApp(id);
    if (!row) return res.status(404).json({ error: '应用不存在' });
    const jobId = await createJob(id, null, 'stop');
    let text = '';
    if ((row.deploy_mode || 'single') === 'stack') {
      const { services } = buildStackServices(row);
      const result = await runtime.stopStack(services, []);
      text = result.log;
    } else {
      const log = [];
      await runtime.stopAndRemove(row.container_name, log);
      text = log.join('\n');
    }
    await finishJob(jobId, 'ok', text);
    await pool.query(`UPDATE apps SET status='stopped' WHERE id=?`, [id]);
    res.json({ message: '已停止', job_id: jobId, log: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/apps/:id/restart', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await getApp(id);
    if (!row) return res.status(404).json({ error: '应用不存在' });
    const [rows] = await pool.query(
      `SELECT * FROM releases WHERE app_id = ? AND status IN ('deployed','uploaded','failed') ORDER BY id DESC LIMIT 1`,
      [id]
    );
    if (!rows[0]) return res.status(400).json({ error: '无可用版本，请先上传并部署' });
    const releaseId = rows[0].id;
    const jobId = await createJob(id, releaseId, 'restart');
    res.json({ message: '重启部署已开始', job_id: jobId, release_id: releaseId });
    try {
      await runDeploy(row, rows[0], jobId);
    } catch (e) {
      await finishJob(jobId, 'failed', String(e.message || e));
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// 快捷：查看栈内容器日志（?service=api|web）
app.get('/api/apps/:id/logs', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tail = Math.min(Number(req.query.tail) || 200, 2000);
    const row = await getApp(id);
    if (!row) return res.status(404).json({ error: '应用不存在' });

    if ((row.deploy_mode || 'single') === 'stack') {
      const { services } = buildStackServices(row);
      const want = String(req.query.service || '').trim();
      const targets = want ? services.filter((s) => s.key === want || s.container_name === want) : services;
      const parts = [];
      for (const s of targets) {
        const r = await runtime.containerLogs(s.container_name, tail);
        const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
        parts.push(
          `===== ${s.container_name} =====\n` +
            (text || (r.code !== 0 ? `无法读取 (exit=${r.code})\n${r.stderr}` : '(空)'))
        );
      }
      return res.json({
        container: targets.map((s) => s.container_name).join(','),
        exists: true,
        log: parts.join('\n\n') || '(空)',
      });
    }

    const r = await runtime.containerLogs(row.container_name, tail);
    const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
    res.json({
      container: row.container_name,
      exists: r.code === 0,
      log: text || (r.code !== 0 ? `无法读取日志 (exit=${r.code})\n${r.stderr}` : '(空)'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/apps/:id/jobs', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT id, app_id, release_id, action, status,
              LEFT(log_text, 200) AS log_preview,
              started_at, finished_at, created_at
       FROM deploy_jobs WHERE app_id = ? ORDER BY id DESC LIMIT 30`,
      [id]
    );
    res.json({ jobs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(`SELECT * FROM deploy_jobs WHERE id = ? LIMIT 1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: '任务不存在' });
    res.json({ job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/releases/:id/log', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rel = await getRelease(id);
    if (!rel) return res.status(404).json({ error: '不存在' });
    res.json({ log: rel.deploy_log || '(无部署日志)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function main() {
  await initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`lite-paas listening on :${PORT}`);
    console.log(`runtime: ${runtime.detectRuntime() || 'none'}`);
    console.log(`data: ${DATA_DIR}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
