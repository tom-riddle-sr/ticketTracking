# 🎟 票務監控 Bot

透過 LINE Bot 監控票務網站，一有票立刻通知你。

## 功能

- 傳票務網址給 Bot → 自動加入監控
- 每 5 分鐘自動檢查一次票況
- 有票立刻推播 LINE 通知給所有用戶
- 支援多人使用，加好友即自動加入通知名單

## 使用方式

加 Bot 好友後，直接傳指令：

| 指令 | 說明 |
|------|------|
| 貼上票務網址 | 加入監控 |
| `/list` | 查看目前監控中的網址 |
| `/check` | 立即檢查一次票況 |
| `/remove <網址>` | 移除監控 |

## 支援網站

- [Tixcraft 拓元售票](https://tixcraft.com)（精確解析剩餘票數）
- [KKTIX](https://kktix.com)（偵測票券狀態）
- 其他票務網站（通用關鍵字偵測）

## 技術架構

```
LINE Bot (Messaging API)
    ↕ webhook
Cloudflare Worker
    ├── 接收 LINE 訊息，管理監控網址
    ├── Cron Trigger 每 5 分鐘執行
    └── 有票時推播 LINE 通知給所有用戶
        ↕ GitHub API
GitHub Repository
    ├── urls.txt  監控中的票務網址
    └── users.txt 訂閱通知的用戶 ID
```

## 自架說明

### 需要準備

- LINE Developers 帳號（建立 Messaging API Channel）
- Cloudflare 帳號（部署 Worker）
- GitHub 帳號（儲存設定）

### 環境變數

在 Cloudflare Worker 設定以下 Secrets：

| 名稱 | 說明 |
|------|------|
| `LINE_CHANNEL_SECRET` | LINE Channel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel Access Token |
| `GITHUB_TOKEN` | GitHub Personal Access Token（需要 repo 權限）|
| `GITHUB_REPO` | GitHub repo 路徑，例如 `yourname/ticketTracking` |

### 部署步驟

1. Fork 這個 repo
2. 在 [LINE Developers](https://developers.line.biz) 建立 Messaging API Channel
3. 在 [Cloudflare Workers](https://workers.cloudflare.com) 建立 Worker
4. 將 `worker/index.js` 的程式碼貼入 Worker
5. 設定 Cron Trigger：`*/5 * * * *`
6. 設定環境變數（見上表）
7. 將 Worker URL 填入 LINE Webhook URL
8. 加 Bot 好友，開始使用

## 通知範例

```
🎟 有票了！

🎵 盧廣仲 HeartBreakFast 傷心早餐店演唱會 2026
📍 台北流行音樂中心 表演廳
📅 2026/07/11 (Sat.) 19:26

一樓特A區輪椅席1990 2 seat(s) remaining

🔗 https://tixcraft.com/...
```
