#!/usr/bin/env bash
# deploy-lite-paas.sh — 独立一键部署 Lite PaaS
# 无参: 只在 /home 选最新 lite-paas_*.zip 或 lite-paas_*.tar.gz
# 有参: 使用该文件
#   sudo bash deploy-lite-paas.sh
#   sudo bash deploy-lite-paas.sh /home/lite-paas_xxxx.zip
set -eu

PAAS_DIR="${PAAS_DIR:-/home/paas}"
CTR="${CTR_NAME:-lite-paas}"
IMG="${IMG_NAME:-lite-paas:latest}"
PORT="${PORT:-8083}"
LOG="/tmp/deploy-lite-paas-$(date +%Y%m%d_%H%M%S).log"

log()  { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
ok()   { log "OK  $*"; }
fail() { log "FAIL $*"; echo "完整日志: $LOG" >&2; exit 1; }
run()  { log "+ $*"; "$@" >>"$LOG" 2>&1 || fail "命令失败: $*"; }

if [ "$(id -u)" -ne 0 ]; then
  fail "必须 root: sudo bash $0"
fi

echo "======== Lite PaaS 部署 $(date '+%F %T') ========" | tee "$LOG"
log "日志: $LOG"

# ---- 1. 选包（仅 /home）----
PKG=""
if [ "${1:-}" != "" ]; then
  PKG="$1"
  [ -f "$PKG" ] || fail "文件不存在: $PKG"
  log "使用参数: $PKG"
else
  PKG="$(ls -1 /home/lite-paas_*.tar.gz /home/lite-paas_*.zip 2>/dev/null | sort -r | head -1 || true)"
  [ -n "$PKG" ] || fail "/home 下没有 lite-paas_*.zip 或 lite-paas_*.tar.gz"
  log "无参数，/home 最新: $PKG"
fi
PKG="$(cd "$(dirname "$PKG")" && pwd)/$(basename "$PKG")"
log "包大小: $(du -h "$PKG" | awk '{print $1}')  时间: $(date -r "$PKG" '+%F %T' 2>/dev/null || true)"

# ---- 2. 运行时 ----
if command -v podman >/dev/null 2>&1; then
  RT=podman
elif command -v docker >/dev/null 2>&1; then
  RT=docker
else
  fail "需要 podman 或 docker"
fi
log "运行时: $RT ($($RT --version 2>/dev/null | head -1))"
command -v unzip >/dev/null 2>&1 || command -v tar >/dev/null 2>&1 || fail "需要 unzip 或 tar"

# ---- 3. 停旧容器 ----
log "STEP 1/7 清理旧容器 $CTR"
$RT stop "$CTR" >>"$LOG" 2>&1 || true
$RT rm -f "$CTR" >>"$LOG" 2>&1 || true
# 清名字含 lite-paas 的残留
$RT ps -a --format '{{.Names}}' 2>/dev/null | grep lite-paas | while read -r n; do
  [ -n "$n" ] || continue
  log "删除残留: $n"
  $RT stop "$n" >>"$LOG" 2>&1 || true
  $RT rm -f "$n" >>"$LOG" 2>&1 || true
done || true
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop lite-paas >>"$LOG" 2>&1 || true
  systemctl disable lite-paas >>"$LOG" 2>&1 || true
fi
if $RT ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CTR"; then
  fail "容器 $CTR 仍存在，无法继续"
fi
ok "旧容器已清除"

# ---- 4. 备份 env/data，换目录 ----
log "STEP 2/7 重建 $PAAS_DIR"
KEEP="$(mktemp -d)"
[ -f "$PAAS_DIR/.env" ] && cp -a "$PAAS_DIR/.env" "$KEEP/.env" && log "备份 .env"
[ -d "$PAAS_DIR/data" ] && cp -a "$PAAS_DIR/data" "$KEEP/data" && log "备份 data/"
if [ -d "$PAAS_DIR" ]; then
  BAK="${PAAS_DIR}.bak.$(date +%Y%m%d_%H%M%S)"
  mv "$PAAS_DIR" "$BAK"
  log "旧目录 -> $BAK"
fi
mkdir -p "$PAAS_DIR" || fail "无法创建 $PAAS_DIR"
ok "目录已准备"

# ---- 5. 解压 ----
log "STEP 3/7 解压到 $PAAS_DIR"
TMP="$(mktemp -d)"
case "$PKG" in
  *.tar.gz|*.tgz)
    tar -xzf "$PKG" -C "$TMP" >>"$LOG" 2>&1 || fail "tar 解压失败"
    ;;
  *.zip)
    unzip -q -o "$PKG" -d "$TMP" >>"$LOG" 2>&1 || fail "unzip 失败"
    ;;
  *)
    fail "不支持的包格式: $PKG"
    ;;
esac
log "解压内容:"
ls -la "$TMP" | tee -a "$LOG"

if [ -d "$TMP/server" ] && [ -f "$TMP/Dockerfile" ]; then
  cp -a "$TMP"/. "$PAAS_DIR"/
elif [ -d "$TMP/paas/server" ]; then
  cp -a "$TMP/paas"/. "$PAAS_DIR"/
else
  SUB="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1 || true)"
  if [ -n "$SUB" ] && [ -d "$SUB/server" ]; then
    cp -a "$SUB"/. "$PAAS_DIR"/
  else
    cp -a "$TMP"/. "$PAAS_DIR"/
  fi
fi
rm -rf "$TMP"

[ -d "$PAAS_DIR/server" ] || fail "解压后无 $PAAS_DIR/server"
[ -f "$PAAS_DIR/Dockerfile" ] || fail "解压后无 Dockerfile"
[ -f "$PAAS_DIR/server/package.json" ] || fail "解压后无 server/package.json"
[ -f "$PAAS_DIR/server/src/index.js" ] || fail "解压后无 server/src/index.js"
ok "源码结构正确"
log "PaaS 文件: $(find "$PAAS_DIR" -type f | wc -l) 个"

# 恢复 env/data
if [ -f "$KEEP/.env" ]; then
  cp -a "$KEEP/.env" "$PAAS_DIR/.env"
  ok "恢复旧 .env"
elif [ -f "$PAAS_DIR/.env.example" ]; then
  cp -a "$PAAS_DIR/.env.example" "$PAAS_DIR/.env"
  ok "从 .env.example 生成 .env"
else
  fail "无 .env 且无 .env.example"
fi
if [ -d "$KEEP/data" ]; then
  rm -rf "$PAAS_DIR/data"
  cp -a "$KEEP/data" "$PAAS_DIR/data"
  ok "恢复 data/"
fi
rm -rf "$KEEP"
mkdir -p "$PAAS_DIR/data/uploads" "$PAAS_DIR/data/apps"

# 读 env（不 export 整文件里的奇怪字符）
MYSQL_HOST="$(grep -E '^MYSQL_HOST=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
MYSQL_PORT="$(grep -E '^MYSQL_PORT=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
MYSQL_USER="$(grep -E '^MYSQL_USER=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
MYSQL_PASSWORD="$(grep -E '^MYSQL_PASSWORD=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
MYSQL_DATABASE="$(grep -E '^MYSQL_DATABASE=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
BOOKS_MYSQL_HOST="$(grep -E '^BOOKS_MYSQL_HOST=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
BOOKS_MYSQL_PORT="$(grep -E '^BOOKS_MYSQL_PORT=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
BOOKS_MYSQL_USER="$(grep -E '^BOOKS_MYSQL_USER=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
BOOKS_MYSQL_PASSWORD="$(grep -E '^BOOKS_MYSQL_PASSWORD=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
BOOKS_MYSQL_DATABASE="$(grep -E '^BOOKS_MYSQL_DATABASE=' "$PAAS_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r' || true)"

MYSQL_HOST="${MYSQL_HOST:-host.docker.internal}"
MYSQL_PORT="${MYSQL_PORT:-3319}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-MySql@2024}"
MYSQL_DATABASE="${MYSQL_DATABASE:-lite_paas}"
BOOKS_MYSQL_HOST="${BOOKS_MYSQL_HOST:-host.docker.internal}"
BOOKS_MYSQL_PORT="${BOOKS_MYSQL_PORT:-3319}"
BOOKS_MYSQL_USER="${BOOKS_MYSQL_USER:-root}"
BOOKS_MYSQL_PASSWORD="${BOOKS_MYSQL_PASSWORD:-MySql@2024}"
BOOKS_MYSQL_DATABASE="${BOOKS_MYSQL_DATABASE:-books}"

log "MYSQL_HOST=$MYSQL_HOST PORT=$MYSQL_PORT DB=$MYSQL_DATABASE"

# ---- 6. build ----
log "STEP 4/7 删除旧镜像 $IMG"
$RT rmi -f "$IMG" >>"$LOG" 2>&1 || true

log "STEP 5/7 $RT build $IMG"
log "---------- Dockerfile 关键行 ----------"
grep -nE '^(FROM|RUN|COPY|CMD)' "$PAAS_DIR/Dockerfile" | tee -a "$LOG" || true
log "------------------------------------"
log "开始 build，日志【实时】打印（同时写入 $LOG）"
log "阶段提示: 拉FROM镜像 -> apk -> npm install -> 拷贝代码"
log "若长时间无新输出，看最后一行卡在哪一步"

# 可选：先单独 pull，失败立刻知道是镜像源问题
FROM_IMG="$(grep -E '^FROM ' "$PAAS_DIR/Dockerfile" | head -1 | awk '{print $2}')"
if [ -n "$FROM_IMG" ]; then
  log "预拉取基础镜像: $FROM_IMG"
  set +e
  $RT pull "$FROM_IMG" 2>&1 | tee -a "$LOG"
  PULL_RC=${PIPESTATUS[0]}
  set -e
  if [ "${PULL_RC:-1}" -ne 0 ]; then
    log "DaoCloud 拉取失败，尝试 docker.io/library/node:20-alpine（若服务器配了镜像加速会走国内）"
    set +e
    $RT pull docker.io/library/node:20-alpine 2>&1 | tee -a "$LOG"
    PULL_RC2=${PIPESTATUS[0]}
    set -e
    if [ "${PULL_RC2:-1}" -eq 0 ]; then
      log "已拉取 docker.io/library/node:20-alpine，改写 Dockerfile FROM 为该镜像"
      sed -i 's|^FROM .*|FROM docker.io/library/node:20-alpine|' "$PAAS_DIR/Dockerfile"
    else
      fail "基础镜像拉取失败。请配置 podman/docker 镜像加速或手动: $RT pull docker.m.daocloud.io/library/node:20-alpine"
    fi
  else
    ok "基础镜像已就绪: $FROM_IMG"
  fi
fi

set +e
$RT build -t "$IMG" -f "$PAAS_DIR/Dockerfile" "$PAAS_DIR" 2>&1 | tee -a "$LOG"
BUILD_RC=${PIPESTATUS[0]}
set -e

if [ "${BUILD_RC:-1}" -ne 0 ]; then
  log "--- build 失败，最后 80 行 ---"
  tail -n 80 "$LOG" || true
  fail "镜像构建失败 rc=$BUILD_RC 完整日志: $LOG"
fi
IMG_ID="$($RT images -q "$IMG" 2>/dev/null | head -1 || true)"
[ -n "$IMG_ID" ] || fail "构建后无镜像 $IMG"
ok "镜像构建成功 id=$IMG_ID"
$RT images "$IMG" --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' 2>/dev/null | tee -a "$LOG" || true

# ---- 7. run ----
log "STEP 6/7 启动容器"

SOCK=""
if [ -S /run/podman/podman.sock ]; then
  SOCK="/run/podman/podman.sock"
elif [ -S /var/run/docker.sock ]; then
  SOCK="/var/run/docker.sock"
else
  fail "找不到 podman/docker sock，无法让面板 build 业务"
fi
log "挂载 sock: $SOCK -> /var/run/docker.sock"

# 不用反斜杠续行，避免 Windows 传脚本踩坑
set +e
$RT run -d \
  --name "$CTR" \
  --restart=unless-stopped \
  -p "${PORT}:8083" \
  --add-host=host.docker.internal:host-gateway \
  -e PORT=8083 \
  -e "MYSQL_HOST=$MYSQL_HOST" \
  -e "MYSQL_PORT=$MYSQL_PORT" \
  -e "MYSQL_USER=$MYSQL_USER" \
  -e "MYSQL_PASSWORD=$MYSQL_PASSWORD" \
  -e "MYSQL_DATABASE=$MYSQL_DATABASE" \
  -e "BOOKS_MYSQL_HOST=$BOOKS_MYSQL_HOST" \
  -e "BOOKS_MYSQL_PORT=$BOOKS_MYSQL_PORT" \
  -e "BOOKS_MYSQL_USER=$BOOKS_MYSQL_USER" \
  -e "BOOKS_MYSQL_PASSWORD=$BOOKS_MYSQL_PASSWORD" \
  -e "BOOKS_MYSQL_DATABASE=$BOOKS_MYSQL_DATABASE" \
  -e CONTAINER_RUNTIME=docker \
  -e DOCKER_HOST=unix:///var/run/docker.sock \
  -e DATA_DIR=/data \
  -e MAX_UPLOAD_MB=2048 \
  -v "$PAAS_DIR/data:/data" \
  -v "$SOCK:/var/run/docker.sock" \
  "$IMG" >>"$LOG" 2>&1
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "podman/docker run 失败 rc=$RC，见 $LOG"
ok "容器已创建"

# ---- 8. 验证 ----
log "STEP 7/7 验证"
sleep 4

if ! $RT ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CTR"; then
  log "--- 容器日志 ---"
  $RT logs --tail 50 "$CTR" 2>&1 | tee -a "$LOG" || true
  fail "容器未在运行"
fi
ok "容器运行中"
$RT ps --filter "name=$CTR" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1 | tee -a "$LOG"

# 容器内必须有 docker 命令
if $RT exec "$CTR" docker version >>"$LOG" 2>&1; then
  ok "容器内 docker CLI 可用（可部署业务）"
else
  log "--- exec docker version 失败 ---"
  $RT logs --tail 30 "$CTR" 2>&1 | tee -a "$LOG" || true
  fail "容器内没有 docker CLI 或 sock 不通 — 业务部署会 spawn ENOENT"
fi

# HTTP 健康
HEALTH=""
i=0
while [ "$i" -lt 8 ]; do
  i=$((i + 1))
  HEALTH="$(curl -sS -m 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  echo "$HEALTH" | grep -q '"ok"' && break
  log "等待 health $i/8 ..."
  sleep 2
done
log "health: $HEALTH"
echo "$HEALTH" | grep -q '"ok"' || fail "HTTP 健康检查失败: $HEALTH"
ok "HTTP /api/health 通过"
VER="$(echo "$HEALTH" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
[ -n "$VER" ] && log "面板版本: $VER"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "" | tee -a "$LOG"
echo "========================================" | tee -a "$LOG"
echo " 结果: 成功" | tee -a "$LOG"
echo " 包:   $PKG" | tee -a "$LOG"
echo " 目录: $PAAS_DIR" | tee -a "$LOG"
echo " 镜像: $IMG ($IMG_ID)" | tee -a "$LOG"
echo " 面板: http://${IP}:${PORT}" | tee -a "$LOG"
echo " 健康: curl -s http://127.0.0.1:${PORT}/api/health" | tee -a "$LOG"
echo " 日志: $LOG" | tee -a "$LOG"
echo " 容器日志: $RT logs -f $CTR" | tee -a "$LOG"
echo "========================================" | tee -a "$LOG"
exit 0
