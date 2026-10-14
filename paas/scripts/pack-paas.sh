#!/usr/bin/env bash
# 打包通用 Lite PaaS 面板（与任何业务应用无关）
# 用法: ./paas/scripts/pack-paas.sh
# 可选: PACK_PAAS_IMAGE=1  额外导出 lite-paas 容器镜像 tar
set -euo pipefail

PAAS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PAAS_ROOT/.." && pwd)"
OUT="${OUT_DIR:-${OUT:-$REPO_ROOT/dist}}"
STAMP="$(date +%Y%m%d_%H%M%S)"
NAME="lite-paas_${STAMP}"
STAGE="$OUT/$NAME"

log() { echo "==> $*"; }
err() { echo "错误: $*" >&2; exit 1; }

log "打包通用 PaaS（不绑定任何业务应用）"
log "源: $PAAS_ROOT  出: $OUT"

rm -rf "$STAGE"
mkdir -p "$STAGE"

if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude node_modules \
    --exclude data \
    --exclude '.env' \
    --exclude '*.tar' \
    --exclude '*.tar.gz' \
    "$PAAS_ROOT/" "$STAGE/"
else
  mkdir -p "$STAGE/server" "$STAGE/scripts"
  cp -a "$PAAS_ROOT/server/package.json" "$STAGE/server/"
  cp -a "$PAAS_ROOT/server/src" "$STAGE/server/"
  cp -a "$PAAS_ROOT/server/public" "$STAGE/server/"
  [[ -f "$PAAS_ROOT/server/package-lock.json" ]] && cp -a "$PAAS_ROOT/server/package-lock.json" "$STAGE/server/" || true
  cp -a "$PAAS_ROOT/scripts" "$STAGE/"
  cp -a "$PAAS_ROOT/.env.example" "$PAAS_ROOT/Dockerfile" "$PAAS_ROOT/docker-compose.yml" "$STAGE/"
  [[ -f "$PAAS_ROOT/README.md" ]] && cp -a "$PAAS_ROOT/README.md" "$STAGE/"
fi

chmod +x "$STAGE/scripts/"*.sh 2>/dev/null || true

cat > "$STAGE/README_INSTALL.txt" <<'EOF'
Lite PaaS = 通用应用部署面板
- 上传任意 docker/podman save 的镜像 .tar
- 一键 load + run，看日志

安装到 /home/paas:
  unzip -o lite-paas_*.zip -d /tmp/paas-unpack
  sudo mkdir -p /home/paas
  sudo cp -a /tmp/paas-unpack/. /home/paas/
  cd /home/paas
  cp .env.example .env && vi .env        # 元数据 MySQL
  sudo ./scripts/install.sh /home/paas

业务应用各自 pack 源码/镜像，上传到本面板部署即可。
EOF

mkdir -p "$OUT"
TAR_GZ="$OUT/${NAME}.tar.gz"
tar -czf "$TAR_GZ" -C "$OUT" "$NAME"
log "PaaS 包: $TAR_GZ"

if [[ "${PACK_PAAS_IMAGE:-0}" == "1" ]]; then
  RT=""
  if command -v podman >/dev/null 2>&1; then RT=podman
  elif command -v docker >/dev/null 2>&1; then RT=docker
  else err "PACK_PAAS_IMAGE=1 需要 podman/docker"
  fi
  $RT build -t lite-paas:latest -f "$PAAS_ROOT/Dockerfile" "$PAAS_ROOT"
  $RT save -o "$OUT/lite-paas-image.tar" lite-paas:latest
  log "PaaS 镜像: $OUT/lite-paas-image.tar"
fi

echo "完成。业务应用请各自 pack，上传镜像 tar 到面板部署。"
