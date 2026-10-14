#!/usr/bin/env bash
# 在服务器执行：清理旧应用与镜像，加载镜像包并启动
# 用法: ./deploy.sh [/home/grok_books]
set -euo pipefail

APP_DIR="${1:-/home/grok_books}"
IMG_API="book-scanner-api:latest"
IMG_WEB="book-scanner-web:latest"
CTR_API="book-scanner-api"
CTR_WEB="book-scanner-web"
IMAGES_TAR="book-scanner-images.tar"
COMPOSE_PROJECT="grok_books"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
NC='\033[0m'
log()  { echo -e "${GRN}==>${NC} $*"; }
warn() { echo -e "${YLW}!!${NC} $*"; }
err()  { echo -e "${RED}错误:${NC} $*" >&2; exit 1; }

detect_runtime() {
  if command -v podman >/dev/null 2>&1; then
    echo podman
  elif command -v docker >/dev/null 2>&1; then
    echo docker
  else
    err "未找到 podman 或 docker"
  fi
}

# compose 命令：优先 podman compose / docker compose，其次 docker-compose / podman-compose
detect_compose() {
  local rt="$1"
  if [[ "$rt" == "podman" ]]; then
    if podman compose version >/dev/null 2>&1; then
      echo "podman compose"
      return
    fi
    if command -v podman-compose >/dev/null 2>&1; then
      echo "podman-compose"
      return
    fi
  fi
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return
  fi
  if command -v podman-compose >/dev/null 2>&1; then
    echo "podman-compose"
    return
  fi
  err "未找到 compose（podman compose / docker compose / podman-compose）"
}

rm_container() {
  local rt="$1" name="$2"
  if $rt ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    log "停止并删除容器: $name"
    $rt stop "$name" >/dev/null 2>&1 || true
    $rt rm -f "$name" >/dev/null 2>&1 || true
  fi
}

rm_image() {
  local rt="$1" img="$2"
  if $rt image exists "$img" 2>/dev/null || $rt images -q "$img" 2>/dev/null | grep -q .; then
    log "删除镜像: $img"
    $rt rmi -f "$img" >/dev/null 2>&1 || true
  fi
}

# ---------- main ----------
RT="$(detect_runtime)"
COMPOSE_CMD="$(detect_compose "$RT")"

log "运行时: $RT"
log "Compose: $COMPOSE_CMD"
log "部署目录: $APP_DIR"

if [[ ! -d "$APP_DIR" ]]; then
  err "目录不存在: $APP_DIR （请先上传解压部署包）"
fi
cd "$APP_DIR"

if [[ ! -f docker-compose.yml ]]; then
  err "缺少 docker-compose.yml"
fi

if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    warn "未找到 .env，从 .env.example 复制"
    cp .env.example .env
    warn "请编辑 $APP_DIR/.env 填写 MYSQL_PASSWORD 后重新执行"
  else
    err "缺少 .env 与 .env.example"
  fi
fi

# 检查密码是否仍是占位
if grep -q 'your_mysql_password' .env 2>/dev/null; then
  warn "检测到 .env 中 MYSQL_PASSWORD 仍是占位符，请先修改后再部署"
  err "请编辑 $APP_DIR/.env"
fi

log "1/5 停止旧 compose 服务..."
# shellcheck disable=SC2086
$COMPOSE_CMD -p "$COMPOSE_PROJECT" -f docker-compose.yml down --remove-orphans 2>/dev/null || true
# 兼容旧项目名
# shellcheck disable=SC2086
$COMPOSE_CMD -f docker-compose.yml down --remove-orphans 2>/dev/null || true

log "2/5 清理旧容器..."
rm_container "$RT" "$CTR_API"
rm_container "$RT" "$CTR_WEB"
# 再扫一遍名称匹配
while read -r n; do
  [[ -n "$n" ]] || continue
  log "删除残留容器: $n"
  $RT stop "$n" >/dev/null 2>&1 || true
  $RT rm -f "$n" >/dev/null 2>&1 || true
done < <($RT ps -a --format '{{.Names}}' 2>/dev/null | grep -E 'book-scanner|grok_books' || true)

log "3/5 清理旧镜像..."
rm_image "$RT" "$IMG_API"
rm_image "$RT" "$IMG_WEB"
# 清理 dangling
$RT image prune -f >/dev/null 2>&1 || true

log "4/5 加载镜像包..."
if [[ -f "$IMAGES_TAR" ]]; then
  log "从 $IMAGES_TAR 导入..."
  $RT load -i "$IMAGES_TAR"
else
  warn "未找到 $IMAGES_TAR，尝试本地 build（需有 backend/ frontend 源码）"
  if [[ -d backend && -d frontend ]]; then
    $RT build -t "$IMG_API" -f backend/Dockerfile backend
    $RT build -t "$IMG_WEB" -f frontend/Dockerfile frontend
  else
    err "无镜像包且无源码，无法部署"
  fi
fi

# 确认镜像存在
if ! $RT images -q "$IMG_API" | grep -q .; then
  err "镜像不存在: $IMG_API"
fi
if ! $RT images -q "$IMG_WEB" | grep -q .; then
  err "镜像不存在: $IMG_WEB"
fi

log "5/5 启动服务..."
# shellcheck disable=SC2086
$COMPOSE_CMD -p "$COMPOSE_PROJECT" -f docker-compose.yml up -d --no-build --force-recreate

echo ""
log "部署完成"
$RT ps --filter "name=book-scanner" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null \
  || $RT ps | grep book-scanner || true

# 读端口
WEB_PORT="$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2- || true)"
API_PORT="$(grep -E '^API_PORT=' .env 2>/dev/null | cut -d= -f2- || true)"
WEB_PORT="${WEB_PORT:-8080}"
API_PORT="${API_PORT:-3000}"

echo ""
echo "  前端: http://<服务器IP>:${WEB_PORT}"
echo "  API : http://<服务器IP>:${API_PORT}/api/health"
echo ""
echo "日志: $COMPOSE_CMD -p $COMPOSE_PROJECT -f $APP_DIR/docker-compose.yml logs -f"
