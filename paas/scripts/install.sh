#!/usr/bin/env bash
# 在目标机安装并启动 Lite PaaS（宿主机 Node，可直接调 podman/docker）
# 用法: sudo ./scripts/install.sh [/home/paas]
set -euo pipefail

APP_DIR="${1:-/home/paas}"
SERVICE_NAME="lite-paas"
PORT="${PORT:-8083}"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GRN}==>${NC} $*"; }
err() { echo -e "${RED}错误:${NC} $*" >&2; exit 1; }

if [[ ! -d "$APP_DIR/server" ]]; then
  err "未找到 $APP_DIR/server ，请先把 paas 目录放到该路径"
fi

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
  log "已生成 .env ，请编辑 MYSQL_* 后如需可再执行本脚本"
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

if [[ -z "${MYSQL_PASSWORD:-}" ]]; then
  err "请先在 $APP_DIR/.env 填写 MYSQL_PASSWORD"
fi

if ! command -v node >/dev/null 2>&1; then
  err "需要 Node.js 18+（或改用 docker compose 部署面板）"
fi

log "安装依赖（npm 国内源）..."
cd "$APP_DIR/server"
npm config set registry https://registry.npmmirror.com
npm install --omit=dev

# MySQL 建库（若有 mysql 客户端）
if command -v mysql >/dev/null 2>&1; then
  log "确保数据库 ${MYSQL_DATABASE:-lite_paas} 存在..."
  if ! mysql -h"${MYSQL_HOST:-host.docker.internal}" -P"${MYSQL_PORT:-3319}" -u"${MYSQL_USER:-root}" -p"${MYSQL_PASSWORD}" \
    -e "CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE:-lite_paas}\` DEFAULT CHARSET utf8mb4;" 2>/dev/null; then
    echo -e "${YLW}!!${NC} 自动建库失败，请手动: CREATE DATABASE lite_paas DEFAULT CHARSET utf8mb4;"
  fi
fi

mkdir -p "$APP_DIR/data/uploads" "$APP_DIR/data/apps"

NODE_BIN="$(command -v node)"
if [[ -f /etc/systemd/system/${SERVICE_NAME}.service ]] || command -v systemctl >/dev/null 2>&1; then
  log "写入 systemd: ${SERVICE_NAME}.service"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Lite PaaS Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/server
EnvironmentFile=${APP_DIR}/.env
Environment=DATA_DIR=${APP_DIR}/data
Environment=PORT=${PORT}
ExecStart=${NODE_BIN} src/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  sleep 1
  systemctl --no-pager status "${SERVICE_NAME}" || true
  log "已启动: http://0.0.0.0:${PORT}"
else
  log "无 systemd，前台启动..."
  export DATA_DIR="$APP_DIR/data"
  export PORT
  cd "$APP_DIR/server"
  exec node src/index.js
fi
