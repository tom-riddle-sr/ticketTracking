/**
 * Cloudflare Worker — LINE Bot webhook + Cron ticket monitor
 *
 * ENV vars:
 *   LINE_CHANNEL_SECRET
 *   LINE_CHANNEL_ACCESS_TOKEN
 *   GITHUB_TOKEN
 *   GITHUB_REPO  (e.g. "yourname/ticketTracking")
 *
 * urls.txt format: userId|url|活動名稱  (# = comment, title optional for compat)
 * users.txt format: one userId per line (# = comment)
 */

const URLS_FILE = "urls.txt"
const USERS_FILE = "users.txt"

// ── LINE helpers ─────────────────────────────────────────────────────────────

async function verifySignature(body, signature, secret) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body))
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return b64 === signature
}

async function reply(replyToken, text, token) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  })
}

async function pushToUser(userId, text, token) {
  const resp = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  })
  if (!resp.ok) {
    const err = await resp.text()
    console.error(`LINE push failed for ${userId} (${resp.status}): ${err}`)
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function getFile(env, path) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ticket-monitor-bot",
        "Cache-Control": "no-cache",
      },
      cf: { cacheEverything: false },
    }
  )
  const data = await resp.json()
  if (data.message === "Not Found") return { content: "", sha: null }
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))))
  return { content, sha: data.sha }
}

async function updateFile(env, path, content, sha) {
  const body = {
    message: `chore: update ${path}`,
    content: btoa(unescape(encodeURIComponent(content))),
  }
  if (sha) body.sha = sha
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "ticket-monitor-bot",
      },
      body: JSON.stringify(body),
    }
  )
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`GitHub updateFile failed (${resp.status}): ${err}`)
  }
  return resp
}

async function registerUser(env, userId) {
  try {
    const { content, sha } = await getFile(env, USERS_FILE)
    if (content.includes(userId)) return false
    const newContent = content.trimEnd() + "\n" + userId + "\n"
    await updateFile(env, USERS_FILE, newContent, sha)
    return true
  } catch (e) {
    console.error("registerUser failed:", e.message)
    return false
  }
}

// ── urls.txt helpers (format: userId|url|title) ───────────────────────────────

function parseLine(line) {
  // Returns { uid, url, title } or null
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  const firstBar = trimmed.indexOf("|")
  if (firstBar === -1) return null
  const uid = trimmed.slice(0, firstBar).trim()
  const rest = trimmed.slice(firstBar + 1)
  const secondBar = rest.indexOf("|")
  const url = (secondBar === -1 ? rest : rest.slice(0, secondBar)).trim()
  const title = secondBar === -1 ? "" : rest.slice(secondBar + 1).trim()
  if (!uid || !url) return null
  return { uid, url, title }
}

function getUserEntries(content, userId) {
  // Returns [{url, title}] for this user
  return content.split("\n")
    .map(parseLine)
    .filter(e => e && e.uid === userId)
    .map(({ url, title }) => ({ url, title }))
}

function parseUrlsByUser(content) {
  // Returns Map<userId, {url, title}[]>
  const map = new Map()
  for (const line of content.split("\n")) {
    const entry = parseLine(line)
    if (!entry) continue
    if (!map.has(entry.uid)) map.set(entry.uid, [])
    map.get(entry.uid).push({ url: entry.url, title: entry.title })
  }
  return map
}

// ── Title fetcher ─────────────────────────────────────────────────────────────

async function fetchEventTitle(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      },
    })
    const html = await resp.text()
    // tixcraft dataLayer title
    const tlMatch = html.match(/"eventTitle1"\s*:\s*"([^"]+)"/)
    if (tlMatch) return tlMatch[1]
    // <title> tag, strip common site suffixes
    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    if (titleMatch) {
      return titleMatch[1]
        .replace(/\s*\|\s*KKTIX\s*$/i, "")
        .replace(/\s*\|\s*iNDIEVOX\s*$/i, "")
        .replace(/\s*[-–|]\s*tixcraft\.com\s*$/i, "")
        .replace(/\s*[-–|]\s*年代售票\s*$/i, "")
        .replace(/\s*[-–|]\s*寬宏藝術.*$/i, "")
        .replace(/\s*\|\s*OPENTIX.*$/i, "")
        .trim()
    }
  } catch (e) {
    console.error("fetchEventTitle failed:", e.message)
  }
  return ""
}

// ── Ticket checkers ───────────────────────────────────────────────────────────

async function checkTixcraft(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
  })
  const html = await resp.text()

  const titleMatch = html.match(/"eventTitle1"\s*:\s*"([^"]+)"/)
  const venueMatch = html.match(/"venue"\s*:\s*"([^"]+)"/)
  const dateMatch = html.match(/"eventDate"\s*:\s*"([^"]+)"/)
  const titleTagMatch = html.match(/<title>([^<]+)<\/title>/)
  const eventTitle = titleMatch ? titleMatch[1] : (titleTagMatch ? titleTagMatch[1].trim() : "")
  const venue = venueMatch ? venueMatch[1] : ""
  const eventDate = dateMatch ? dateMatch[1] : ""

  // Ticket area page: look for remaining seats in select_form list
  if (url.includes("/ticket/area/")) {
    const available = []
    const liMatches = html.matchAll(/<li[^>]*class="[^"]*select_form[^"]*"[^>]*>([\s\S]*?)<\/li>/g)
    for (const match of liMatches) {
      const text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      if (text.includes("remaining") || text.includes("剩餘")) {
        available.push(text)
      }
    }
    return { available, eventTitle, venue, eventDate }
  }

  // Activity detail page: check if any session has 立即購票 button
  const hasBuyButton = html.includes("立即購票")
  const available = hasBuyButton ? ["有場次開放購票"] : []
  return { available, eventTitle, venue, eventDate }
}

function checkJsonLdAvailability(html) {
  const inStock =
    html.includes('"availability":"InStock"') ||
    html.includes('"availability": "InStock"') ||
    html.includes('"availability":"https://schema.org/InStock"') ||
    html.includes('"availability": "https://schema.org/InStock"')
  const soldOut =
    html.includes('"availability":"SoldOut"') ||
    html.includes('"availability":"OutOfStock"') ||
    html.includes('"availability":"https://schema.org/SoldOut"') ||
    html.includes('"availability":"https://schema.org/OutOfStock"')
  return { inStock, soldOut }
}

async function checkKktix(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
  })
  const html = await resp.text()
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  const eventTitle = titleMatch ? titleMatch[1].replace(/\s*\|\s*KKTIX/i, "").trim() : ""

  const { inStock, soldOut } = checkJsonLdAvailability(html)

  // JSON-LD 有明確 InStock：有票
  if (inStock && !soldOut) {
    return { available: ["有票可購買"], eventTitle, venue: "", eventDate: "" }
  }
  // JSON-LD 有明確 SoldOut：售完
  if (soldOut) {
    return { available: [], eventTitle, venue: "", eventDate: "" }
  }
  // JSON-LD 沒有 availability 資訊：fallback 看「立即購票」按鈕
  const hasBuyButton = html.includes("立即購票")
  const hasExplicitSoldout = COMMON_SOLDOUT.some(k => html.includes(k))
  if (hasBuyButton && !hasExplicitSoldout) {
    return { available: ["有票可購買"], eventTitle, venue: "", eventDate: "" }
  }
  return { available: [], eventTitle, venue: "", eventDate: "" }
}

// 共用：關鍵字比對
async function checkByKeywords(url, availableKws, soldoutKws) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
  })
  const html = await resp.text()
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  const eventTitle = titleMatch ? titleMatch[1].trim() : ""
  const lowerText = text.toLowerCase()
  const hasSoldout = soldoutKws.some(k => lowerText.includes(k.toLowerCase()))
  const hasAvailable = availableKws.some(k => lowerText.includes(k.toLowerCase()))
  if (hasAvailable && !hasSoldout) {
    return { available: ["有票可購買"], eventTitle, venue: "", eventDate: "" }
  }
  return { available: [], eventTitle, venue: "", eventDate: "" }
}

const COMMON_SOLDOUT = ["售完", "完售", "已售完", "售罄", "暫停販售", "停止販售", "no tickets available", "sold out"]
const COMMON_AVAILABLE = ["立即購票", "我要購票", "remaining", "剩餘", "有票", "buy now", "add to cart", "加入購物車"]

// 年代 ticket.com.tw / eraticket.com.tw（用「立即訂購」）
async function checkEraticket(url) {
  return checkByKeywords(url, [...COMMON_AVAILABLE, "立即訂購"], COMMON_SOLDOUT)
}

// 寬宏 kham.com.tw
async function checkKham(url) {
  return checkByKeywords(url, COMMON_AVAILABLE, COMMON_SOLDOUT)
}

// OPENTIX opentix.life（有 JSON-LD，優先用 JSON-LD）
async function checkOpentix(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
  })
  const html = await resp.text()
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  const eventTitle = titleMatch ? titleMatch[1].replace(/\s*\|\s*OPENTIX.*/i, "").trim() : ""

  const { inStock, soldOut } = checkJsonLdAvailability(html)
  if (inStock && !soldOut) {
    return { available: ["有票可購買"], eventTitle, venue: "", eventDate: "" }
  }
  if (soldOut) {
    return { available: [], eventTitle, venue: "", eventDate: "" }
  }
  // fallback：關鍵字
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
  const lowerText = text.toLowerCase()
  const hasSoldout = COMMON_SOLDOUT.some(k => lowerText.includes(k.toLowerCase()))
  const hasAvailable = COMMON_AVAILABLE.some(k => lowerText.includes(k.toLowerCase()))
  if (hasAvailable && !hasSoldout) {
    return { available: ["有票可購買"], eventTitle, venue: "", eventDate: "" }
  }
  return { available: [], eventTitle, venue: "", eventDate: "" }
}

// 通用（其他網站）
async function checkGeneric(url) {
  return checkByKeywords(url, COMMON_AVAILABLE, COMMON_SOLDOUT)
}

async function checkUrl(url) {
  if (url.includes("tixcraft.com")) return checkTixcraft(url)
  if (url.includes("kktix.com") || url.includes("kktix.cc")) return checkKktix(url)
  if (url.includes("eraticket.com.tw") || url.includes("ticket.com.tw")) return checkEraticket(url)
  if (url.includes("kham.com.tw")) return checkKham(url)
  if (url.includes("opentix.life")) return checkOpentix(url)
  return checkGeneric(url)
}

// ── Cron: monitor all URLs, notify each user their own results ────────────────

async function runMonitor(env) {
  const { content } = await getFile(env, URLS_FILE)
  const urlsByUser = parseUrlsByUser(content)

  for (const [userId, entries] of urlsByUser) {
    for (const { url, title: storedTitle } of entries) {
      try {
        const { available, eventTitle, venue, eventDate } = await checkUrl(url)
        if (available.length > 0) {
          const displayTitle = storedTitle || eventTitle
          const lines = ["🎟 有票了！"]
          if (displayTitle) lines.push(`🎵 ${displayTitle}`)
          if (venue) lines.push(`📍 ${venue}`)
          if (eventDate) lines.push(`📅 ${eventDate}`)
          lines.push(`\n${available.join("\n")}`)
          lines.push(`\n🔗 ${url}`)
          await pushToUser(userId, lines.join("\n"), env.LINE_CHANNEL_ACCESS_TOKEN)
        }
      } catch (e) {
        console.error(`Error checking ${url} for ${userId}: ${e.message}`)
      }
    }
  }
}

// ── Main handlers ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("OK")

    const body = await request.text()
    const sig = request.headers.get("x-line-signature") || ""

    if (!(await verifySignature(body, sig, env.LINE_CHANNEL_SECRET))) {
      return new Response("Unauthorized", { status: 401 })
    }

    const { events } = JSON.parse(body)

    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue

      const text = event.message.text.trim()
      const token = env.LINE_CHANNEL_ACCESS_TOKEN
      const rt = event.replyToken
      const userId = event.source.userId

      // 自動註冊新用戶
      await registerUser(env, userId)

      if (text === "/list") {
        const { content } = await getFile(env, URLS_FILE)
        const entries = getUserEntries(content, userId)
        if (!entries.length) {
          await reply(rt, "你目前沒有監控任何網址", token)
        } else {
          const lines = entries.map((e, i) =>
            `${i + 1}. ${e.title || "（未知活動）"}\n   ${e.url}`
          )
          await reply(rt, `📋 你的監控清單（${entries.length} 個）：\n\n${lines.join("\n\n")}`, token)
        }
        continue
      }

      if (text === "/check") {
        await reply(rt, "⏳ 立即檢查中...", token)
        const checkUserId = userId
        ctx.waitUntil((async () => {
          const { content } = await getFile(env, URLS_FILE)
          const entries = getUserEntries(content, checkUserId)
          if (!entries.length) {
            await pushToUser(checkUserId, "你目前沒有監控任何網址", token)
            return
          }
          const results = await Promise.all(entries.map(async ({ url, title }) => {
            const displayTitle = title || url
            try {
              const { available, eventTitle } = await Promise.race([
                checkUrl(url),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000)),
              ])
              return { displayTitle: title || eventTitle || url, hasTicket: available.length > 0 }
            } catch (e) {
              return { displayTitle, hasTicket: null, reason: e.message === "timeout" ? "逾時" : "失敗" }
            }
          }))
          const lines = results.map((r, i) => {
            if (r.hasTicket === null) return `${i + 1}. ❓ ${r.displayTitle}（${r.reason}）`
            return r.hasTicket
              ? `${i + 1}. 🎟 ${r.displayTitle}【有票！】`
              : `${i + 1}. ❌ ${r.displayTitle}`
          })
          await pushToUser(checkUserId, `📊 檢查結果：\n\n${lines.join("\n")}`, token)
        })())
        continue
      }

      if (text.startsWith("/remove ")) {
        const target = text.slice(8).trim()
        const { content, sha } = await getFile(env, URLS_FILE)
        const lines = content.split("\n")
        const filtered = lines.filter(l => {
          const e = parseLine(l)
          if (!e) return true  // keep comments and blank lines
          return !(e.uid === userId && e.url === target)
        })
        if (filtered.length === lines.length) {
          await reply(rt, "找不到這個網址，請用 /list 確認", token)
        } else {
          await updateFile(env, URLS_FILE, filtered.join("\n"), sha)
          await reply(rt, `🗑 已移除監控：\n${target}`, token)
        }
        continue
      }

      if (text.startsWith("http://") || text.startsWith("https://")) {
        try {
          const { content, sha } = await getFile(env, URLS_FILE)
          const entries = getUserEntries(content, userId)
          if (entries.some(e => e.url === text)) {
            await reply(rt, "這個網址已經在監控中了！\n\n用 /list 查看監控清單", token)
            continue
          }
          const title = await fetchEventTitle(text)
          const newContent = content.trimEnd() + "\n" + userId + "|" + text + "|" + title + "\n"
          await updateFile(env, URLS_FILE, newContent, sha)
          await reply(rt,
            `✅ 已加入監控！\n\n` +
            (title ? `🎵 ${title}\n` : "") +
            `🔗 ${text}\n\n每 5 分鐘檢查一次，有票會通知你 🎟`,
            token
          )
        } catch (e) {
          await reply(rt, `❌ 加入失敗：${e.message}`, token)
        }
        continue
      }

      await reply(rt,
        "🤖 票務監控 Bot\n\n" +
        "📌 使用方式：\n" +
        "• 貼上票務網址 → 加入監控\n" +
        "• /list → 查看監控清單\n" +
        "• /check → 立即檢查一次\n" +
        "• /remove <網址> → 移除監控\n\n" +
        "✅ 支援平台：\n" +
        "• 拓元 tixcraft.com\n" +
        "• KKTIX kktix.com / kktix.cc\n" +
        "• 年代 ticket.com.tw\n" +
        "• 寬宏 kham.com.tw\n" +
        "• OPENTIX opentix.life",
        token
      )
    }

    return new Response("OK")
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env))
  },
}
