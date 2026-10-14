# Lite PaaS（通用应用部署面板）

通用构建/部署机面板：**任意应用** → 上传镜像 tar → 一键部署 → 日志。

不绑定 books 或其它业务；books 只是其中一个可上传的应用。

## 它是什么

| 能力 | 说明 |
|------|------|
| 多应用 | 新建应用、端口、环境变量、镜像名 |
| 上传 | 标准 `docker save` / `podman save` 的 `.tar` |
| 部署 | stop 旧容器 → load → run |
| 整栈 stack | 可选：一 tar 多镜像、共享 network（适合前后端） |
| 单容器 single | 一 tar 一容器 |
| 日志 | 容器日志 / 部署任务 |

## 打包本面板（与业务无关）

```bash
./paas/scripts/pack-paas.sh
# → dist/lite-paas_*.tar.gz
```

## 安装

```bash
# 上传 lite-paas_*.zip 后
sudo mkdir -p /home/paas
cd /tmp && unzip -o lite-paas_*.zip -d paas-unpack
sudo rm -rf /home/paas/*
sudo mv /tmp/paas-unpack/* /home/paas/   # 或整目录调整到 /home/paas
cd /home/paas
cp .env.example .env && vi .env   # 仅 PaaS 元数据 MySQL
sudo chmod +x scripts/install.sh
sudo ./scripts/install.sh /home/paas
# http://IP:8083
```

```sql
CREATE DATABASE IF NOT EXISTS lite_paas DEFAULT CHARSET utf8mb4;
```

## 部署任意业务（含 books）

1. 业务方自己构建并 `save` 出 tar（books 用仓库里 `./scripts/pack.sh`）
2. 打开面板 → 新建应用或选已有应用
3. 上传 tar → 填环境变量 → 部署

books 示例产物：`book-scanner-images.tar`（api+web），按面板「图书管理」预置或自建应用上传即可。

## API

- `GET /api/health` · `GET/POST /api/apps`
- `POST /api/apps/:id/upload` · `deploy` · `stop` · `restart`
- `GET /api/apps/:id/logs`
