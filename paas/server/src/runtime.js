const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function detectRuntime() {
  const forced = (process.env.CONTAINER_RUNTIME || '').trim().toLowerCase();
  if (forced === 'podman' || forced === 'docker') return forced;
  try {
    require('child_process').execFileSync('podman', ['--version'], { stdio: 'ignore' });
    return 'podman';
  } catch (_) {}
  try {
    require('child_process').execFileSync('docker', ['--version'], { stdio: 'ignore' });
    return 'docker';
  } catch (_) {}
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(opts.env || {}) },
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

async function containerExists(name, log) {
  const r = await rt(['ps', '-a', '--format', '{{.Names}}'], log);
  const names = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return names.includes(name);
}

async function stopAndRemove(name, log) {
  if (!(await containerExists(name, log))) {
    appendLog(log, `容器不存在: ${name}`);
    return;
  }
  await rt(['stop', name], log);
  await rt(['rm', '-f', name], log);
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

  if (lower.endsWith('.zip')) {
    const r = await run('unzip', ['-q', '-o', archivePath, '-d', destDir]);
    if (r.stdout.trim()) appendLog(log, r.stdout.trim());
    if (r.stderr.trim()) appendLog(log, r.stderr.trim());
    if (r.code !== 0) {
      // 尝试 busybox unzip / 7z
      const r2 = await run('bsdtar', ['-xf', archivePath, '-C', destDir]);
      if (r2.code !== 0) {
        appendLog(log, 'ERROR: 解压 zip 失败，请安装 unzip');
        return { ok: false, code: r.code };
      }
    }
    return { ok: true, code: 0 };
  }

  // tar / tar.gz / tgz
  const args = ['-xf', archivePath, '-C', destDir];
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    // GNU tar 自动识别 gzip
  }
  const r = await run('tar', args);
  if (r.stdout.trim()) appendLog(log, r.stdout.trim());
  if (r.stderr.trim()) appendLog(log, r.stderr.trim());
  if (r.code !== 0) {
    appendLog(log, 'ERROR: 解压 tar 失败');
    return { ok: false, code: r.code };
  }
  return { ok: true, code: 0 };
}

/** 若解压后只有一层目录，进入该目录 */
function resolveSourceRoot(destDir) {
  const entries = fs.readdirSync(destDir).filter((n) => !n.startsWith('.'));
  if (entries.length === 1) {
    const p = path.join(destDir, entries[0]);
    if (fs.statSync(p).isDirectory()) {
      // 有 paas.json 或 Dockerfile 在子目录
      if (
        fs.existsSync(path.join(p, 'paas.json')) ||
        fs.existsSync(path.join(p, 'Dockerfile')) ||
        fs.existsSync(path.join(p, 'backend')) ||
        fs.existsSync(path.join(p, 'frontend'))
      ) {
        return p;
      }
    }
  }
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

  let svcList = services || [];
  let net = network;
  const meta = readPaasJson(sourceRoot);
  if (meta) {
    appendLog(log, `读取 paas.json: ${meta.name || meta.slug || 'ok'}`);
    if (meta.network) net = meta.network;
    if (meta.services && meta.services.length) {
      // 合并：paas.json 提供 context/dockerfile/image/ports；调用方 services 可覆盖 env
      const envByKey = {};
      for (const s of svcList) {
        if (s.key) envByKey[s.key] = s.env || {};
      }
      svcList = meta.services.map((s) => ({
        ...s,
        env: { ...(s.env || {}), ...(envByKey[s.key] || {}) },
      }));
    }
  }

  if (!svcList.length) {
    // 单服务默认：根目录 Dockerfile
    if (fs.existsSync(path.join(sourceRoot, 'Dockerfile'))) {
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
      appendLog(log, 'ERROR: 无 paas.json 且根目录无 Dockerfile，无法构建');
      return { ok: false, log: log.join('\n') };
    }
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
