# 票務監控 Bot — 開發筆記

> 上次更新：2026-04-13

---

## 架構

```
LINE Bot (Messaging API)
    ↓ webhook
Cloudflare Worker (ticket-monitor)
    ├── Cron 每 5 分鐘自動監控
    ├── Cloudflare KV (TICKET_STATE) — 狀態追蹤，避免重複通知
    └── GitHub API — 讀寫 urls.txt / users.txt
```

- **Repo:** https://github.com/tom-riddle-sr/ticketTracking
- **Worker URL:** https://ticket-monitor.lotidev3980.workers.dev/
- **Worker 程式碼:** `worker/index.js`
- **部署指令:** `cd worker && npx wrangler deploy`

---

## Cloudflare Worker 環境變數（Secrets）

| 名稱 | 說明 |
|------|------|
| `LINE_CHANNEL_SECRET` | LINE Bot channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot access token |
| `GITHUB_TOKEN` | GitHub Personal Access Token（讀寫 repo） |
| `GITHUB_REPO` | `tom-riddle-sr/ticketTracking` |

KV Namespace: `TICKET_STATE`（id: `36d112c492bb4c35922efce58831e889`）

---

## 檔案格式

**urls.txt** — 每行一個監控項目
```
userId|url|活動名稱
```

**users.txt** — 已註冊的 LINE user ID
```
U7c13dca6defae4ae7047455e8ed7f10c
```

---

## Bot 指令

| 指令 | 說明 |
|------|------|
| 貼網址 | 加入監控（自動抓活動名稱） |
| `/list` | 查看自己的監控清單（含編號和活動名） |
| `/check` | 立即檢查所有網址，回覆有票/沒票狀態 |
| `/remove <網址>` | 移除監控 |
| `/debug <網址>` | 查看 Worker 實際從該網址抓到什麼（除錯用） |

---

## 支援平台與偵測方式

| 平台 | Domain | 偵測方式 |
|------|--------|---------|
| 拓元 | tixcraft.com | `/ticket/area/` 頁：抓剩餘票數；`/activity/detail/` 頁：找「立即購票」按鈕 |
| KKTIX | kktix.com / kktix.cc | JSON-LD `availability: InStock`，fallback「立即購票」按鈕 |
| 年代 | ticket.com.tw | 找「立即訂購」按鈕（頁面上有部分售完文字，不影響判斷） |
| 寬宏 | kham.com.tw | 關鍵字：「立即購票」、「我要購票」 |
| OPENTIX | opentix.life | JSON-LD `availability: InStock`，fallback 關鍵字 |
| 其他 | 任意 | 通用關鍵字比對 |

---

## 通知機制

- Cron 每 5 分鐘跑一次
- **只有「沒票 → 有票」狀態改變才發通知**（用 KV 記錄上次狀態）
- `/check` 是手動觸發，直接回覆當下所有網址的狀態
- 通知只發給該網址的擁有者（各用戶清單獨立）

---

## 已知問題 / 待處理

- [ ] LINE 免費方案每月 200 則 push 訊息額度，**月初重置後才能繼續使用**（上次於 2026-04-13 額度用完）
- [ ] tixcraft.com 主站（非子網域）有時回 403，可能擋 Cloudflare IP
- [ ] 年代 (eraticket.com.tw) 從某些網路環境連不上，用 ticket.com.tw 的 URL 比較穩定
- [ ] OPENTIX 是 Vue SPA，靜態 HTML 不一定有票況，JSON-LD 是目前最可靠的判斷

---

## 下個月繼續時的 Checklist

1. 確認 LINE push 訊息額度已重置（[LINE Developers Console](https://developers.line.biz/console/)）
2. 確認 GitHub Token 未過期（測試：傳 `/list` 看有無回應）
3. 確認 Cloudflare Worker 仍在跑（[Dashboard](https://dash.cloudflare.com)）
4. 傳 `/check` 測試各平台偵測是否正常
