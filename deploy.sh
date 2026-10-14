#!/usr/bin/env bash
# 服务器入口：默认部署到 /home/grok_books
# 若当前目录已是部署包（含 images tar + compose），直接清理并启动
exec "$(cd "$(dirname "$0")" && pwd)/scripts/deploy.sh" "${1:-/home/grok_books}"
