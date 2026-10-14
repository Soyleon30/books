#!/usr/bin/env bash
# 打包 books 业务镜像（标准 docker/podman save tar，可被通用 PaaS 上传部署）
# 用法: ./scripts/pack.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMG_API="book-scanner-api:latest"
IMG_WEB="book-scanner-web:latest"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
PKG_NAME="${PKG_NAME:-grok_books_deploy}"
STAMP="$(date +%Y%m%d_%H%M%S)"
PKG_DIR="$OUT_DIR/${PKG_NAME}_${STAMP}"
IMAGES_TAR="book-scanner-images.tar"
PKG_TAR="$OUT_DIR/${PKG_NAME}_${STAMP}.tar.gz"

detect_runtime() {
  if command -v podman >/dev/null 2>&1; then echo podman
  elif command -v docker >/dev/null 2>&1; then echo docker
  else echo "错误: 需要 podman 或 docker" >&2; exit 1
  fi
}

RT="$(detect_runtime)"
echo "==> books 打包 → 标准镜像 tar（供通用 PaaS 或 deploy.sh）"
echo "==> $RT | $ROOT"

# 确保能构建（失败就停，保证产物可用）
$RT build -t "$IMG_API" -f "$ROOT/backend/Dockerfile" "$ROOT/backend"
$RT build -t "$IMG_WEB" -f "$ROOT/frontend/Dockerfile" "$ROOT/frontend"

mkdir -p "$PKG_DIR"
$RT save -o "$PKG_DIR/$IMAGES_TAR" "$IMG_API" "$IMG_WEB"
$RT save -o "$PKG_DIR/book-scanner-api.tar" "$IMG_API"
$RT save -o "$PKG_DIR/book-scanner-web.tar" "$IMG_WEB"

# 给通用 PaaS 用的应用说明（可选上传参考，非 PaaS 专用格式）
cat > "$PKG_DIR/APP_INFO.txt" <<EOF
应用名建议: 书本扫描器
部署模式: stack（双容器）或 分两个 single 应用

合并包: $IMAGES_TAR
  - $IMG_API  端口 3000  环境变量 MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE PORT
  - $IMG_WEB  端口 80→主机8080  环境变量 API_UPSTREAM=book-scanner-api:3000
  两容器需同一 network，web 才能访问 api。

也可只上传单镜像:
  book-scanner-api.tar  → 单应用 host 3000:3000
  book-scanner-web.tar  → 单应用 host 8080:80（API_UPSTREAM 填 api 地址）
EOF

cp -a "$ROOT/docker-compose.yml" "$ROOT/scripts/deploy.sh" "$ROOT/.env.example" "$PKG_DIR/"
[[ -f "$ROOT/deploy.sh" ]] && cp -a "$ROOT/deploy.sh" "$PKG_DIR/" || true
chmod +x "$PKG_DIR/deploy.sh" 2>/dev/null || true

cat > "$PKG_DIR/README_DEPLOY.txt" <<'EOF'
方式 A - 通用 PaaS 面板
  1. 面板新建或使用应用
  2. 上传 book-scanner-images.tar（整栈）或单镜像 tar
  3. 配置环境变量后部署

方式 B - 命令行
  cp .env.example .env && vi .env
  sudo ./deploy.sh
EOF

mkdir -p "$OUT_DIR"
tar -czf "$PKG_TAR" -C "$OUT_DIR" "$(basename "$PKG_DIR")"
cp -f "$PKG_DIR/$IMAGES_TAR" "$OUT_DIR/$IMAGES_TAR"
cp -f "$PKG_DIR/book-scanner-api.tar" "$OUT_DIR/" 2>/dev/null || true
cp -f "$PKG_DIR/book-scanner-web.tar" "$OUT_DIR/" 2>/dev/null || true

echo "完成"
echo "  $PKG_TAR"
echo "  $OUT_DIR/$IMAGES_TAR   ← 上传到通用 PaaS"
