#!/usr/bin/env bash
# 可选：仅检查 books 镜像能否在本机构建（与 PaaS 无关）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RT=""
command -v podman >/dev/null && RT=podman || true
command -v docker >/dev/null && RT=${RT:-docker}
[[ -n "$RT" ]] || { echo "需要 podman/docker"; exit 1; }
$RT build -t book-scanner-api:buildcheck -f "$ROOT/backend/Dockerfile" "$ROOT/backend"
$RT build -t book-scanner-web:buildcheck -f "$ROOT/frontend/Dockerfile" "$ROOT/frontend"
echo "books 可构建"
