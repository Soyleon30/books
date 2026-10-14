#!/usr/bin/env bash
# 本机打 books 源码包（不需要 Docker）
# 用法: ./scripts/pack-source.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${OUT_DIR:-$ROOT/dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
NAME="books-source_${STAMP}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE" "$OUT"
cp -a backend frontend paas.json docker-compose.yml .env.example "$STAGE/"
rm -rf "$STAGE"/backend/node_modules "$STAGE"/frontend/node_modules 2>/dev/null || true
find "$STAGE" -name .env -delete 2>/dev/null || true

ZIP="$OUT/${NAME}.zip"
TAR="$OUT/${NAME}.tar.gz"
rm -f "$ZIP" "$TAR"
( cd "$STAGE" && tar -czf "$TAR" . )
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && zip -qr "$ZIP" . )
  echo "源码包: $ZIP"
fi
echo "源码包: $TAR"
echo "上传到通用 PaaS → 服务器自动 build 部署（本机无需 Docker）"
