# 图书条码扫描入库

扫描 ISBN 条码 → 写入远程 MySQL → 支持搜索；已存在则提示且不重复入库。

## 结构

```
backend/     Node.js + Express API
frontend/    扫码 + 搜索页面 (Nginx)
docker-compose.yml
```

## MySQL 要求

- 地址：`8.157.18.157:3319`（可用 `.env` 修改）
- 需事先创建库（表会自动建）：

```sql
CREATE DATABASE IF NOT EXISTS books DEFAULT CHARSET utf8mb4;
```

- 账号需允许从你的 Docker 主机 IP 远程连接。

## 部署（推荐：镜像打包 + 一键脚本，兼容 Podman）

默认部署目录：`/home/grok_books`

### A. 两套独立产物

| 组件 | 脚本 | 产物 |
|------|------|------|
| **通用 PaaS** | `./paas/scripts/pack-paas.sh` | `lite-paas_*.tar.gz` 面板 |
| **books 业务** | `./scripts/pack.sh` | `book-scanner-images.tar` 等 |

PaaS 是通用部署面板；books 只是能产出标准镜像 tar、可被面板部署的一个应用。

```bash
./paas/scripts/pack-paas.sh   # 只打面板
./scripts/pack.sh             # 只打 books 镜像
```

### B1. 装通用 PaaS，再部署 books

```bash
# 装面板到 /home/paas
sudo mkdir -p /home/paas
unzip -o lite-paas_*.zip -d /tmp/paas-unpack
sudo cp -a /tmp/paas-unpack/. /home/paas/
cd /home/paas && cp .env.example .env && vi .env
sudo ./scripts/install.sh /home/paas
# :8083 上传 books-source_*.zip → 部署
```

### B2. 不用面板，命令行部署 books

```bash
sudo tar -xzf grok_books_deploy_*.tar.gz -C /home/grok_books --strip-components=1
cd /home/grok_books && cp .env.example .env && vi .env && sudo ./deploy.sh
```

### 源码直接部署（可选）

```bash
cp .env.example .env && vi .env
# docker 或 podman
docker compose up -d --build
# 或
podman compose up -d --build
```

访问：

- 前端：`http://服务器IP:8080`
- API：`http://服务器IP:3000/api/health`

## 功能说明

| 功能 | 说明 |
|------|------|
| 多图书馆 | 创建/改名/删除/切换；扫码前必须选中当前馆 |
| 扫码入库 | 摄像头扫 ISBN，**按馆**查重后确认写入 |
| 手动 ISBN | 无摄像头时可用 |
| 已存在提示 | 仅当**同一馆**已有该 ISBN 时提示，不重复录入 |
| 搜索 | 在当前馆内按书名 / 作者 / ISBN 搜索 |
| 元数据 | 优先 Open Library 补全书名封面 |

同一 ISBN 可出现在不同图书馆中；同一馆内 ISBN 唯一。

## Lite PaaS（可选管理面板 :8083）

目录 `paas/`：网页里选应用、上传镜像 tar、一键部署、看日志。元数据用目标机 MySQL。

```bash
# 目标机
sudo mkdir -p /home/paas
# 上传并解压到 /home/paas
cd /home/paas && cp .env.example .env && vi .env
sudo chmod +x scripts/install.sh && sudo ./scripts/install.sh /home/paas
# 打开 http://IP:8083
```

详见 [paas/README.md](paas/README.md)。

## 扫码说明（手机 Safari）

- 图书 ISBN 是 **EAN-13 一维条码**，需**横放**对准框中间，约 15–25cm，光线充足
- 本版已启用 EAN_13 / UPC / Code128 等格式 + BarcodeDetector
- 扫不上可用「拍照条码图片识别」或「手动输入 ISBN」
- 更新后请强制刷新页面（清缓存）

公网 HTTP 下部分浏览器限制摄像头；你当前 Safari 能开摄像头即可。

## API

- `GET /api/health`
- `GET /api/libraries` — 列表（含 book_count）
- `POST /api/libraries` — `{ name, description? }`
- `PUT /api/libraries/:id` — 改名
- `DELETE /api/libraries/:id` — 删馆（级联删书）
- `GET /api/books/check/:isbn?library_id=` — 该馆是否已有 + 在线元数据
- `POST /api/books` — `{ library_id, isbn, title?, authors?, cover? }`
- `GET /api/books?library_id=&q=`
- `DELETE /api/books/:isbn?library_id=`
