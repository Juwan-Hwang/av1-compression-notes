# AV1 视频压缩 Telegram Bot

基于 GitHub Actions 的 AV1 视频压缩 Telegram Bot。用户发送视频给 Bot，Bot 在 GitHub Actions runner 上用 SVT-AV1 压缩后自动发回。

## 架构

```
用户发视频 → Telegram Bot Webhook → Cloudflare Worker
                                          ↓
                                   GitHub API: workflow_dispatch
                                          ↓
                                   GitHub Actions (ubuntu-latest)
                                          ↓
                                   Pyrogram 下载视频 (MTProto, ≤2GB)
                                          ↓
                                   ffmpeg 压缩 (SVT-AV1 preset 2 CRF 36)
                                          ↓
                                   Pyrogram 上传视频 (MTProto, ≤2GB)
                                          ↓
                                   用户收到压缩后的视频
```

## 成本

| 组件 | 免费额度 | 一部 7 分钟视频的消耗 |
|------|---------|-------------------|
| GitHub Actions | 2000 min/月 (public repo 无限) | ~15-50 min (preset 2, 取决于视频时长) |
| Cloudflare Workers | 100k req/天 | 1-2 req |
| Telegram Bot API | 免费 | 免费 |

> **注意**：GitHub ToS 不鼓励在 Actions 上运行大规模计算任务。public repo 的 Actions 额度不受 2000 min 限制，但长期高频使用仍可能被限制。建议低频使用。

## 部署步骤

### 1. 创建 Telegram Bot

```
在 Telegram 中找 @BotFather：
/newbot → 取名 → 获得 Bot Token
```

### 2. 获取 API ID 和 API Hash

访问 https://my.telegram.org → API development tools → 创建应用 → 获得 `api_id` 和 `api_hash`。

### 3. 配置 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 值 |
|--------|-----|
| `API_ID` | Telegram API ID |
| `API_HASH` | Telegram API Hash |
| `BOT_TOKEN` | Bot Token |

可选 Variables（Settings → Secrets and variables → Variables）：

| Variable | 默认值 | 说明 |
|----------|--------|------|
| `PRESET` | `2` | SVT-AV1 preset (最优画质，GA 2核较慢) |
| `CRF` | `36` | CRF 值 |

### 4. 部署 Cloudflare Worker

```bash
npm install -g wrangler
cd bot
wrangler login
```

创建 `wrangler.toml`：

```toml
name = "av1-compression-bot"
main = "worker.js"
compatibility_date = "2024-01-01"
```

创建 KV 命名空间（存储白名单、用户设置等）：

```bash
wrangler kv:namespace create SETTINGS
# 把返回的 id 填入 wrangler.toml
```

`wrangler.toml` 示例：

```toml
name = "av1-compression-bot"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "SETTINGS"
id = "<上一步返回的 id>"
```

设置 Worker secrets：

```bash
wrangler secret put BOT_TOKEN
wrangler secret put GH_TOKEN        # GitHub PAT (repo + workflow scope)
wrangler secret put GH_REPO         # 如 Juwan-Hwang/av1-compression-notes
wrangler secret put GH_WORKFLOW     # compress.yml
wrangler secret put ADMIN_ID        # 你的 Telegram 用户 ID（数字）
```

部署：

```bash
wrangler deploy
```

### 5. 设置 Telegram Webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<WORKER_URL>/webhook"
```

### 6. 测试

在 Telegram 中给你的 Bot 发送一个视频文件，等待压缩完成后收到回复。

## 权限系统

Bot 内置完整的用户权限管理，部署后只有管理员和白名单用户可以压缩视频。

### 角色说明

| 角色 | 权限 |
|------|------|
| 管理员 (`ADMIN_ID`) | 全部权限，审批申请，管理白名单/封禁列表 |
| 白名单用户 | 可以压缩视频 |
| 新用户 | 发视频会提示写申请，管理员审批后加入白名单 |
| 封禁用户 | 无法使用 Bot，无法提交申请 |

### 使用流程

1. 新用户发视频给 Bot → Bot 提示「请发一段文字说明你的用途」
2. 用户发送申请文字 → 管理员收到通知（含批准/拒绝/封禁按钮）
3. 管理员点击批准 → 用户加入白名单，收到通知，即可使用

### 管理命令

发送 `/admin` 打开管理面板：
- 📋 待审批：查看并审批 pending 申请
- 👥 白名单：查看白名单用户，踢出/封禁
- 🚫 封禁列表：查看并解封

### 安全措施

- `ADMIN_ID` 从环境变量读取，不硬编码在代码中
- 所有管理操作回调验证操作者身份（`cb.from.id === ADMIN_ID`）
- 封禁列表防止被拒用户重复申请
- 用户输入 HTML 转义防止注入
- 管理员不可被踢出或封禁
- 用户 ID 统一为 `number` 类型，避免类型混淆

## 文件结构

```
├── .github/workflows/
│   └── compress.yml          # GitHub Actions workflow
├── bot/
│   ├── compress.py           # Pyrogram 下载+压缩+上传
│   ├── worker.js             # Cloudflare Worker webhook
│   ├── requirements.txt      # Python 依赖
│   └── wrangler.toml.example  # Cloudflare 配置模板
└── README.md                 # 本文件
```

## 预期性能 (GitHub Actions 2核, preset 2)

| 视频时长 | 预计编码时间 | 备注 |
|---------|------------|------|
| 1 min | ~2 min | |
| 7 min | ~25 min | 基准场景 |
| 15 min | ~55 min | |
| 30 min | ~110 min | 接近 GA 6h 超时上限 |

> GA runner 只有 2 核 CPU，preset 2 编码速度约 5-7 fps。超过 30 分钟的视频可能触发 6 小时超时。
