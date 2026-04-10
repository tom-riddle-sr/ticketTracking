/**
 * Cloudflare Worker — LINE Bot webhook + Cron ticket monitor
 *
 * ENV vars:
 *   LINE_CHANNEL_SECRET
 *   LINE_CHANNEL_ACCESS_TOKEN
 *   GITHUB_TOKEN
 *   GITHUB_REPO  (e.g. "yourname/ticketTracking")
 *
 * urls.txt format: one "userId|url" per line (# = comment)
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

// ── urls.txt helpers (format: userId|url) ────────────────────────────────────

function parseUrlsByUser(content) {
  // Returns Map<userId, url[]>
  const map = new Map()
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("|")
    if (idx === -1) continue
    const uid = trimmed.slice(0, idx).trim()
    const url = trimmed.slice(idx + 1).trim()
    if (!uid || !url) continue
    if (!map.has(uid)) map.set(uid, [])
    map.get(uid).push(url)
  }
  return map
}

function getUserUrls(content, userId) {
  return parseUrlsByUser(content).get(userId) || []
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

async function checkKktix(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
  })
  const html = await resp.text()
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  const eventTitle = titleMatch ? titleMatch[1].replace(/\s*\|\s*KKTIX/i, "").trim() : ""

  // KKTIX JSON-LD uses full schema.org URL or short form
  const inStock =
    html.includes('"availability":"InStock"') ||
    html.includes('"availability": "InStock"') ||
    html.includes('"availability":"https://schema.org/InStock"') ||
    html.includes('"availability": "https://schema.org/InStock"')

  // Only use JSON-LD for soldOut — avoid false positives from partial sold-out text on page
  const soldOut =
    html.includes('"availability":"SoldOut"') ||
    html.includes('"availability":"OutOfStock"') ||
    html.includes('"availability":"https://schema.org/SoldOut"') ||
    html.includes('"availability":"https://schema.org/OutOfStock"')

  if (inStock && !soldOut) {
    return { available: ["有票可購買"], eventTitle, venue: "", eventDate: "" }
  }
  return { available: [], eventTitle, venue: "", eventDate: "" }
}

async function checkGeneric(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
  })
  const html = await resp.text()
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  const eventTitle = titleMatch ? titleMatch[1].trim() : ""

  const soldoutKeywords = ["sold out", "售完", "完售", "已售完", "缺貨", "暫停販售", "停止販售", "no tickets available"]
  const availableKeywords = ["remaining", "剩餘", "有票", "立即購票", "buy now", "add to cart", "加入購物車", "available"]

  const lowerText = text.toLowerCase()
  const hasSoldout = soldoutKeywords.some(k => lowerText.includes(k.toLowerCase()))
  const hasAvailable = availableKeywords.some(k => lowerText.includes(k.toLowerCase()))

  if (hasAvailable && !hasSoldout) {
    return { available: ["有票可購買"], eventTitle, venue: "", eventDate: "" }
  }
  return { available: [], eventTitle, venue: "", eventDate: "" }
}

async function checkUrl(url) {
  if (url.includes("tixcraft.com")) return checkTixcraft(url)
  if (url.includes("kktix.com") || url.includes("kktix.cc")) return checkKktix(url)
  return checkGeneric(url)
}

// ── Cron: monitor all URLs, notify each user their own results ────────────────

async function runMonitor(env) {
  const { content } = await getFile(env, URLS_FILE)
  const urlsByUser = parseUrlsByUser(content)

  for (const [userId, urls] of urlsByUser) {
    for (const url of urls) {
      try {
        const { available, eventTitle, venue, eventDate } = await checkUrl(url)
        if (available.length > 0) {
          const lines = ["🎟 有票了！"]
          if (eventTitle) lines.push(`🎵 ${eventTitle}`)
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
  async fetch(request, env) {
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
        const urls = getUserUrls(content, userId)
        await reply(rt, urls.length
          ? `📋 你的監控網址（${urls.length} 個）：\n\n${urls.join("\n")}`
          : "你目前沒有監控任何網址", token)
        continue
      }

      if (text === "/check") {
        await reply(rt, "⏳ 立即檢查中...", token)
        await runMonitor(env)
        continue
      }

      if (text.startsWith("/remove ")) {
        const target = text.slice(8).trim()
        const { content, sha } = await getFile(env, URLS_FILE)
        const entry = `${userId}|${target}`
        const lines = content.split("\n")
        const filtered = lines.filter(l => l.trim() !== entry)
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
          const userUrls = getUserUrls(content, userId)
          if (userUrls.includes(text)) {
            await reply(rt, "這個網址已經在監控中了！\n\n用 /list 查看所有監控網址", token)
            continue
          }
          const newContent = content.trimEnd() + "\n" + userId + "|" + text + "\n"
          await updateFile(env, URLS_FILE, newContent, sha)
          await reply(rt, `✅ 已加入監控！\n\n${text}\n\n每 5 分鐘檢查一次，有票會通知你 🎟`, token)
        } catch (e) {
          await reply(rt, `❌ 加入失敗：${e.message}`, token)
        }
        continue
      }

      await reply(rt,
        "🤖 票務監控 Bot\n\n" +
        "📌 使用方式：\n" +
        "• 貼上票務網址 → 加入監控\n" +
        "• /list → 查看你的監控網址\n" +
        "• /check → 立即檢查一次\n" +
        "• /remove <網址> → 移除監控\n\n" +
        "🌐 支援任何票務網站網址",
        token
      )
    }

    return new Response("OK")
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env))
  },
}
