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

## 部署（服务器上）

1. 上传整个项目目录到服务器  
2. 配置环境变量：

```bash
cp .env.example .env
# 编辑 .env，填入 MYSQL_PASSWORD 等
```

3. 启动：

```bash
docker compose up -d --build
```

4. 访问：

- 前端：`http://服务器IP:8080`
- API 健康检查：`http://服务器IP:3000/api/health`

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

## 摄像头注意

浏览器扫码需要 **HTTPS** 或 **localhost**。公网 HTTP 可能无法开摄像头，可用「手动输入 ISBN」。

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
