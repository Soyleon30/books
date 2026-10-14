const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function whichRuntimeBin(name) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function detectRuntime() {
  const forced = (process.env.CONTAINER_RUNTIME || '').trim().toLowerCase();
  // 容器内通常只有 docker-cli + 挂载的 sock，没有 podman 二进制
  if (forced === 'docker' && whichRuntimeBin('docker')) return 'docker';
  if (forced === 'podman' && whichRuntimeBin('podman')) return 'podman';
  if (forced === 'podman' && whichRuntimeBin('docker')) {
    // 强制 podman 但不存在时降级 docker-cli（连同一 sock）
    return 'docker';
  }
  if (whichRuntimeBin('docker')) return 'docker';
  if (whichRuntimeBin('podman')) return 'podman';
  return null;
}

function runEnv() {
  const env = { ...process.env };
  // 保证 docker CLI 能找到 sock
  if (!env.DOCKER_HOST) {
    if (fs.existsSync('/var/run/docker.sock')) {
      env.DOCKER_HOST = 'unix:///var/run/docker.sock';
    } else if (fs.existsSync('/run/podman/podman.sock')) {
      env.DOCKER_HOST = 'unix:///run/podman/podman.sock';
    }
  }
  return env;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn(cmd, args, {
      env: { ...runEnv(), ...(opts.env || {}) },
      cwd: opts.cwd || process.cwd(),
      shell: false,
    });
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => {
      resolve({
        code: 127,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: String(e.message || e),
      });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

function appendLog(buf, line) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  buf.push(`[${t}] ${line}`);
}

async function rt(args, log) {
  const runtime = detectRuntime();
  if (!runtime) {
    appendLog(log, 'ERROR: 未找到 podman 或 docker');
    return { code: 127, stdout: '', stderr: 'no runtime' };
  }
  appendLog(log, `$ ${runtime} ${args.join(' ')}`);
  const r = await run(runtime, args);
  if (r.stdout.trim()) appendLog(log, r.stdout.trim());
  if (r.stderr.trim()) appendLog(log, r.stderr.trim());
  appendLog(log, `exit=${r.code}`);
  return r;
}

function normalizeCtrName(n) {
  return String(n || '')
    .trim()
    .replace(/^\//, '');
}

async function containerExists(name, log) {
  const r = await rt(['ps', '-a', '--format', '{{.Names}}'], log);
  const want = normalizeCtrName(name);
  const names = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => normalizeCtrName(s))
    .filter(Boolean);
  return names.includes(want);
}

/** 启动前必须强制删掉同名容器（列表检测在 podman sock 上不可靠） */
async function stopAndRemove(name, log) {
  const n = normalizeCtrName(name);
  appendLog(log, `强制清理同名容器: ${n}`);
  // 不先判断 exists：docker/podman 经 sock 时 ps 与 create 可见性可能不一致
  await rt(['stop', n], log);
  await rt(['rm', '-f', n], log);
  // 再扫一遍名字包含的残留
  const r = await rt(['ps', '-a', '--format', '{{.Names}}'], log);
  const left = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => normalizeCtrName(s))
    .filter((s) => s === n || s.endsWith('/' + n));
  for (const x of left) {
    appendLog(log, `再删残留: ${x}`);
    await rt(['rm', '-f', x], log);
  }
}

async function removeImage(imageRef, log) {
  const r = await rt(['images', '-q', imageRef], log);
  if (!(r.stdout || '').trim()) {
    appendLog(log, `镜像不存在: ${imageRef}`);
    return;
  }
  await rt(['rmi', '-f', imageRef], log);
}

async function loadImageTar(tarPath, log) {
  if (!fs.existsSync(tarPath)) {
    appendLog(log, `ERROR: tar 不存在 ${tarPath}`);
    return { code: 1, stdout: '', stderr: 'missing tar' };
  }
  return rt(['load', '-i', tarPath], log);
}

function parseLoadedImages(stdout) {
  const text = String(stdout || '');
  const out = [];
  const re = /Loaded image(?:\(s\))?:\s*(.+)/gi;
  let m;
  while ((m = re.exec(text))) {
    out.push(m[1].trim().split(/\s+/)[0]);
  }
  return out;
}

async function ensureNetwork(networkName, log) {
  if (!networkName) return;
  const r = await rt(['network', 'ls', '--format', '{{.Name}}'], log);
  const names = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.includes(networkName)) {
    appendLog(log, `网络已存在: ${networkName}`);
    return;
  }
  await rt(['network', 'create', networkName], log);
}

async function runContainer({
  name,
  image,
  hostPort,
  containerPort,
  env = {},
  network,
  extraHosts = [],
  restart = 'unless-stopped',
  log,
}) {
  // 每次 run 前强制清同名，避免 "name already in use"
  await stopAndRemove(name, log);

  const args = ['run', '-d', '--name', name, '--restart', restart];
  if (network) args.push('--network', network);
  if (hostPort && containerPort) {
    args.push('-p', `${hostPort}:${containerPort}`);
  }
  for (const h of extraHosts || []) {
    args.push('--add-host', h);
  }
  // 兼容访问宿主机
  const runtime = detectRuntime();
  if (runtime === 'podman') {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  } else if (runtime === 'docker') {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null) continue;
    args.push('-e', `${k}=${v}`);
  }
  args.push(image);
  return rt(args, log);
}

async function containerLogs(name, tail = 200) {
  const runtime = detectRuntime();
  if (!runtime) return { code: 127, stdout: '', stderr: 'no runtime' };
  return run(runtime, ['logs', '--tail', String(tail), name]);
}

async function containerStatus(name) {
  const runtime = detectRuntime();
  if (!runtime) return null;
  const r = await run(runtime, [
    'ps',
    '-a',
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}',
  ]);
  const line = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => {
      const n = s.split('\t')[0] || '';
      return n === name;
    });
  if (!line) return { exists: false };
  const parts = line.split('\t');
  return {
    exists: true,
    name: parts[0] || name,
    status: parts[1] || '',
    image: parts[2] || '',
    ports: parts[3] || '',
    raw: line,
  };
}

async function deployFromTar({
  tarPath,
  imageName,
  imageTag,
  containerName,
  hostPort,
  containerPort,
  env,
  network,
  extraHosts,
}) {
  const log = [];
  const imageRef = imageTag.includes(':') ? imageTag : `${imageName}:${imageTag || 'latest'}`;
  appendLog(log, `开始部署 image=${imageRef} container=${containerName} port=${hostPort}:${containerPort}`);

  const runtime = detectRuntime();
  if (!runtime) {
    appendLog(log, 'ERROR: 未找到 podman/docker');
    return { ok: false, log: log.join('\n'), imageRef };
  }
  appendLog(log, `运行时: ${runtime}`);

  await stopAndRemove(containerName, log);
  if (network) await ensureNetwork(network, log);

  const load = await loadImageTar(tarPath, log);
  if (load.code !== 0) {
    appendLog(log, 'ERROR: 镜像加载失败');
    return { ok: false, log: log.join('\n'), imageRef };
  }
  const loadedList = parseLoadedImages(load.stdout + '\n' + load.stderr);
  const loaded = loadedList[0] || null;
  const finalImage = loaded || imageRef;
  appendLog(log, `使用镜像: ${finalImage}`);

  if (loaded && loaded !== imageRef) {
    await rt(['tag', loaded, imageRef], log);
  }

  const runImage = loaded ? imageRef : finalImage;
  const runResult = await runContainer({
    name: containerName,
    image: runImage,
    hostPort,
    containerPort,
    env,
    network,
    extraHosts,
    log,
  });

  if (runResult.code !== 0) {
    appendLog(log, 'ERROR: 容器启动失败');
    return { ok: false, log: log.join('\n'), imageRef: runImage };
  }

  const st = await containerStatus(containerName);
  appendLog(log, `状态: ${st && st.status ? st.status : 'unknown'}`);
  appendLog(log, '部署完成');
  return { ok: true, log: log.join('\n'), imageRef: runImage, status: st };
}

/**
 * 整栈部署：一个 tar 含多个镜像，按 services 顺序启动，共享 network
 * services: [{ name, image, container_name, host_port, container_port, env }]
 */
async function deployStackFromTar({
  tarPath,
  network,
  services,
  sharedEnv = {},
}) {
  const log = [];
  const runtime = detectRuntime();
  if (!runtime) {
    appendLog(log, 'ERROR: 未找到 podman/docker');
    return { ok: false, log: log.join('\n') };
  }
  appendLog(log, `运行时: ${runtime}`);
  appendLog(log, `整栈部署 services=${(services || []).length} network=${network || '-'}`);

  if (!services || !services.length) {
    appendLog(log, 'ERROR: 无 services 定义');
    return { ok: false, log: log.join('\n') };
  }

  // 先停旧容器（逆序）
  for (const s of [...services].reverse()) {
    await stopAndRemove(s.container_name, log);
  }

  if (network) await ensureNetwork(network, log);

  const load = await loadImageTar(tarPath, log);
  if (load.code !== 0) {
    appendLog(log, 'ERROR: 镜像加载失败');
    return { ok: false, log: log.join('\n') };
  }
  const loadedList = parseLoadedImages(load.stdout + '\n' + load.stderr);
  appendLog(log, `已加载镜像: ${loadedList.join(', ') || '(未解析到名称，将用清单中的 image)'}`);

  for (const s of services) {
    const imageRef = s.image.includes(':') ? s.image : `${s.image}:latest`;
    // 若 load 出的名字不同，尝试 tag 到期望名
    if (loadedList.length && !loadedList.includes(imageRef)) {
      const base = imageRef.split(':')[0];
      const match = loadedList.find((x) => x === imageRef || x.startsWith(base + ':'));
      if (match && match !== imageRef) {
        await rt(['tag', match, imageRef], log);
      }
    }

    const env = { ...(sharedEnv || {}), ...(s.env || {}) };
    appendLog(log, `启动 ${s.container_name} <= ${imageRef} ${s.host_port}:${s.container_port}`);
    const runResult = await runContainer({
      name: s.container_name,
      image: imageRef,
      hostPort: s.host_port,
      containerPort: s.container_port,
      env,
      network,
      log,
    });
    if (runResult.code !== 0) {
      appendLog(log, `ERROR: 启动失败 ${s.container_name}`);
      return { ok: false, log: log.join('\n') };
    }
  }

  for (const s of services) {
    const st = await containerStatus(s.container_name);
    appendLog(log, `${s.container_name}: ${st && st.status ? st.status : 'unknown'}`);
  }
  appendLog(log, '整栈部署完成');
  return { ok: true, log: log.join('\n') };
}

async function stopStack(services, log) {
  const buf = log || [];
  for (const s of [...(services || [])].reverse()) {
    await stopAndRemove(s.container_name, buf);
  }
  return { ok: true, log: buf.join('\n') };
}

async function undeploy(containerName, imageRef) {
  const log = [];
  await stopAndRemove(containerName, log);
  if (imageRef) await removeImage(imageRef, log);
  appendLog(log, '已卸载');
  return { ok: true, log: log.join('\n') };
}

/**
 * 解压源码包到 destDir（支持 .zip / .tar / .tar.gz / .tgz）
 */
async function extractArchive(archivePath, destDir, log) {
  fs.mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  appendLog(log, `解压 ${archivePath} -> ${destDir}`);

  // 优先 tar（Linux 友好；Windows 打的 zip 子目录经常丢）
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    const r = await run('tar', ['-xf', archivePath, '-C', destDir]);
    if (r.stdout.trim()) appendLog(log, r.stdout.trim());
    if (r.stderr.trim()) appendLog(log, r.stderr.trim());
    if (r.code !== 0) {
      appendLog(log, 'ERROR: 解压 tar 失败');
      return { ok: false, code: r.code };
    }
    listExtracted(destDir, log);
    return { ok: true, code: 0 };
  }

  if (lower.endsWith('.zip')) {
    // 先 python/zipfile 兼容 Windows 反斜杠 zip；再 unzip；再 tar
    const py = await run('python3', [
      '-c',
      `import zipfile,sys,os
z=zipfile.ZipFile(sys.argv[1])
for n in z.namelist():
  t=n.replace("\\\\","/")
  if t.endswith("/"): continue
  dest=os.path.join(sys.argv[2],t)
  os.makedirs(os.path.dirname(dest),exist_ok=True)
  with z.open(n) as s, open(dest,"wb") as o: o.write(s.read())
print("ok",len(z.namelist()))`,
      archivePath,
      destDir,
    ]);
    if (py.code === 0) {
      if (py.stdout.trim()) appendLog(log, py.stdout.trim());
      listExtracted(destDir, log);
      return { ok: true, code: 0 };
    }
    appendLog(log, `python 解压不可用，尝试 unzip (${py.stderr || py.stdout || ''})`);

    const r = await run('unzip', ['-q', '-o', archivePath, '-d', destDir]);
    if (r.stdout.trim()) appendLog(log, r.stdout.trim());
    if (r.stderr.trim()) appendLog(log, r.stderr.trim());
    if (r.code === 0) {
      listExtracted(destDir, log);
      return { ok: true, code: 0 };
    }
    const r2 = await run('tar', ['-xf', archivePath, '-C', destDir]);
    if (r2.code === 0) {
      listExtracted(destDir, log);
      return { ok: true, code: 0 };
    }
    appendLog(log, 'ERROR: 解压 zip 失败');
    return { ok: false, code: r.code || 1 };
  }

  appendLog(log, 'ERROR: 不支持的包格式');
  return { ok: false, code: 1 };
}

function listExtracted(destDir, log) {
  try {
    const walk = (d, depth, acc) => {
      if (depth > 3) return;
      for (const n of fs.readdirSync(d)) {
        if (n.startsWith('.')) continue;
        const p = path.join(d, n);
        const rel = path.relative(destDir, p);
        const st = fs.statSync(p);
        acc.push(st.isDirectory() ? rel + '/' : rel);
        if (st.isDirectory()) walk(p, depth + 1, acc);
      }
    };
    const acc = [];
    walk(destDir, 0, acc);
    appendLog(log, `解压后文件(截断): ${acc.slice(0, 40).join(', ')}`);
  } catch (e) {
    appendLog(log, `列举解压目录失败: ${e.message}`);
  }
}

/** 定位含 paas.json 或 backend 的根目录 */
function resolveSourceRoot(destDir) {
  const tryDir = (d) => {
    if (!d || !fs.existsSync(d)) return null;
    if (
      fs.existsSync(path.join(d, 'paas.json')) ||
      fs.existsSync(path.join(d, 'backend', 'Dockerfile')) ||
      fs.existsSync(path.join(d, 'frontend', 'Dockerfile'))
    ) {
      return d;
    }
    return null;
  };

  let hit = tryDir(destDir);
  if (hit) return hit;

  // 广搜两层
  try {
    for (const n of fs.readdirSync(destDir)) {
      const p = path.join(destDir, n);
      if (!fs.statSync(p).isDirectory()) continue;
      hit = tryDir(p);
      if (hit) return hit;
      for (const n2 of fs.readdirSync(p)) {
        const p2 = path.join(p, n2);
        if (fs.statSync(p2).isDirectory()) {
          hit = tryDir(p2);
          if (hit) return hit;
        }
      }
    }
  } catch (_) {}
  return destDir;
}

function readPaasJson(sourceRoot) {
  const p = path.join(sourceRoot, 'paas.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function buildImage({ contextDir, dockerfile, imageTag, log }) {
  const df = dockerfile || 'Dockerfile';
  const dfPath = path.isAbsolute(df) ? df : path.join(contextDir, df);
  if (!fs.existsSync(contextDir)) {
    appendLog(log, `ERROR: build context 不存在: ${contextDir}`);
    return { code: 1 };
  }
  if (!fs.existsSync(dfPath)) {
    appendLog(log, `ERROR: Dockerfile 不存在: ${dfPath}`);
    return { code: 1 };
  }
  appendLog(log, `构建镜像 ${imageTag}`);
  return rt(
    ['build', '-t', imageTag, '-f', dfPath, contextDir],
    log
  );
}

/**
 * 源码部署（通用）：解压 → 读 paas.json 或用传入 services → build → run
 * services: [{ context, dockerfile, image, container_name, host_port, container_port, env }]
 */
async function deployFromSource({
  archivePath,
  workDir,
  network,
  services,
  sharedEnv = {},
}) {
  const log = [];
  const runtime = detectRuntime();
  if (!runtime) {
    appendLog(log, 'ERROR: 未找到 podman/docker（PaaS 所在机器需要能 build）');
    return { ok: false, log: log.join('\n') };
  }
  appendLog(log, `运行时: ${runtime}`);
  appendLog(log, '模式: 源码上传 → 服务器 build → 部署');

  const extractDir = path.join(workDir, 'src');
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  const ex = await extractArchive(archivePath, extractDir, log);
  if (!ex.ok) return { ok: false, log: log.join('\n') };

  const sourceRoot = resolveSourceRoot(extractDir);
  appendLog(log, `源码根目录: ${sourceRoot}`);

  let svcList = (services || []).map((s) => ({ ...s }));
  let net = network;
  const meta = readPaasJson(sourceRoot);
  if (meta) {
    appendLog(log, `读取 paas.json: ${meta.name || meta.slug || 'ok'} v${meta.version || '-'}`);
    if (meta.network) net = meta.network;
    if (meta.services && meta.services.length) {
      // paas.json 优先提供 context/dockerfile/image/ports；调用方可覆盖 env/ports
      const byKey = {};
      for (const s of svcList) {
        if (s.key) byKey[s.key] = s;
      }
      svcList = meta.services.map((s) => {
        const over = byKey[s.key] || {};
        return {
          ...s,
          ...over,
          // 关键字段以 paas.json 为准（DB 旧 stack 常缺 context）
          context: s.context || over.context || '.',
          dockerfile: s.dockerfile || over.dockerfile || 'Dockerfile',
          image: s.image || over.image,
          container_name: s.container_name || over.container_name,
          host_port: s.host_port != null ? s.host_port : over.host_port,
          container_port: s.container_port != null ? s.container_port : over.container_port,
          env_keys: s.env_keys || over.env_keys,
          env: { ...(s.env || {}), ...(over.env || {}) },
        };
      });
    }
  }

  if (!svcList.length) {
    // 自动识别 books 双服务布局
    const hasBe = fs.existsSync(path.join(sourceRoot, 'backend', 'Dockerfile'));
    const hasFe = fs.existsSync(path.join(sourceRoot, 'frontend', 'Dockerfile'));
    if (hasBe && hasFe) {
      appendLog(log, '自动识别 backend+frontend 双服务');
      svcList = [
        {
          key: 'api',
          context: 'backend',
          dockerfile: 'Dockerfile',
          image: 'book-scanner-api:latest',
          container_name: 'book-scanner-api',
          host_port: 3000,
          container_port: 3000,
          env: {},
        },
        {
          key: 'web',
          context: 'frontend',
          dockerfile: 'Dockerfile',
          image: 'book-scanner-web:latest',
          container_name: 'book-scanner-web',
          host_port: 8080,
          container_port: 80,
          env: { API_UPSTREAM: 'book-scanner-api:3000' },
        },
      ];
      if (!net) net = 'book-scanner-net';
    } else if (fs.existsSync(path.join(sourceRoot, 'Dockerfile'))) {
      svcList = [
        {
          key: 'app',
          context: '.',
          dockerfile: 'Dockerfile',
          image: 'paas-app:latest',
          container_name: 'paas-app',
          host_port: 8080,
          container_port: 80,
          env: {},
        },
      ];
    } else {
      appendLog(log, 'ERROR: 无 paas.json 且无法识别 Dockerfile 布局');
      return { ok: false, log: log.join('\n') };
    }
  }

  // 补全 context：旧 DB stack 只有 image/container，无 context
  for (const s of svcList) {
    if (!s.context || s.context === '.') {
      if (s.key === 'api' || /api/i.test(s.image || '') || /api/i.test(s.container_name || '')) {
        if (fs.existsSync(path.join(sourceRoot, 'backend', 'Dockerfile'))) s.context = 'backend';
      } else if (s.key === 'web' || /web|front/i.test(s.image || '') || /web/i.test(s.container_name || '')) {
        if (fs.existsSync(path.join(sourceRoot, 'frontend', 'Dockerfile'))) s.context = 'frontend';
      }
    }
    if (!s.dockerfile) s.dockerfile = 'Dockerfile';
  }

  // 注入 sharedEnv 到带 env_keys 的服务
  for (const s of svcList) {
    s.env = { ...(sharedEnv || {}), ...(s.env || {}) };
    if (Array.isArray(s.env_keys)) {
      for (const k of s.env_keys) {
        if (sharedEnv[k] !== undefined && sharedEnv[k] !== null && sharedEnv[k] !== '') {
          s.env[k] = String(sharedEnv[k]);
        }
      }
    }
  }

  for (const s of [...svcList].reverse()) {
    await stopAndRemove(s.container_name, log);
  }
  if (net) await ensureNetwork(net, log);

  for (const s of svcList) {
    const imageRef = s.image.includes(':') ? s.image : `${s.image}:latest`;
    const ctx = path.resolve(sourceRoot, s.context || '.');
    appendLog(log, `build context=${s.context || '.'} dockerfile=${s.dockerfile || 'Dockerfile'} -> ${imageRef}`);
    const build = await buildImage({
      contextDir: ctx,
      dockerfile: s.dockerfile || 'Dockerfile',
      imageTag: imageRef,
      log,
    });
    if (build.code !== 0) {
      appendLog(log, `ERROR: 构建失败 ${imageRef}`);
      return { ok: false, log: log.join('\n'), paasJson: meta };
    }
  }

  for (const s of svcList) {
    const imageRef = s.image.includes(':') ? s.image : `${s.image}:latest`;
    appendLog(log, `启动 ${s.container_name} <= ${imageRef} ${s.host_port}:${s.container_port}`);
    const runResult = await runContainer({
      name: s.container_name,
      image: imageRef,
      hostPort: s.host_port,
      containerPort: s.container_port,
      env: s.env || {},
      network: net,
      log,
    });
    if (runResult.code !== 0) {
      appendLog(log, `ERROR: 启动失败 ${s.container_name}`);
      return { ok: false, log: log.join('\n'), paasJson: meta };
    }
  }

  for (const s of svcList) {
    const st = await containerStatus(s.container_name);
    appendLog(log, `${s.container_name}: ${st && st.status ? st.status : 'unknown'}`);
  }
  appendLog(log, '源码构建部署完成');
  return { ok: true, log: log.join('\n'), paasJson: meta, services: svcList, network: net };
}

function isSourceArchive(filePath) {
  const n = String(filePath || '').toLowerCase();
  if (n.endsWith('.zip')) return true;
  // 镜像 tar 通常很大且 load 才有用；源码 tar.gz 也支持
  // 用文件名启发：含 source / 或调用方指定
  if (n.includes('source') && (n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.tar'))) {
    return true;
  }
  return false;
}

module.exports = {
  detectRuntime,
  deployFromTar,
  deployStackFromTar,
  deployFromSource,
  extractArchive,
  resolveSourceRoot,
  readPaasJson,
  isSourceArchive,
  stopStack,
  undeploy,
  containerLogs,
  containerStatus,
  stopAndRemove,
  ensureNetwork,
  run,
  rt,
};
