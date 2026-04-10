/**
 * Cloudflare Worker — LINE Bot webhook handler
 *
 * ENV vars needed (set in Cloudflare dashboard):
 *   LINE_CHANNEL_SECRET
 *   LINE_CHANNEL_ACCESS_TOKEN
 *   GITHUB_TOKEN
 *   GITHUB_REPO  (e.g. "yourname/ticketTracking")
 */

const URLS_FILE = "urls.txt"
const SUPPORTED_SITES = ["tixcraft.com", "kktix.com"]

// ── LINE helpers ────────────────────────────────────────────────────────────

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
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  })
}

// ── GitHub helpers ───────────────────────────────────────────────────────────

async function getFile(env) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${URLS_FILE}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ticket-monitor-bot",
      },
    }
  )
  const data = await resp.json()
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))))
  return { content, sha: data.sha }
}

async function updateFile(env, content, sha) {
  await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${URLS_FILE}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "ticket-monitor-bot",
      },
      body: JSON.stringify({
        message: "chore: update monitored URLs",
        content: btoa(unescape(encodeURIComponent(content))),
        sha,
      }),
    }
  )
}

// ── Main handler ─────────────────────────────────────────────────────────────

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

      // /list
      if (text === "/list") {
        const { content } = await getFile(env)
        const urls = content.split("\n").filter(l => l.trim() && !l.startsWith("#"))
        await reply(rt, urls.length
          ? `📋 監控中的網址（${urls.length} 個）：\n\n${urls.join("\n")}`
          : "目前沒有監控任何網址", token)
        continue
      }

      // /remove <url>
      if (text.startsWith("/remove ")) {
        const target = text.slice(8).trim()
        const { content, sha } = await getFile(env)
        const lines = content.split("\n")
        const filtered = lines.filter(l => l.trim() !== target)
        if (filtered.length === lines.length) {
          await reply(rt, "找不到這個網址，請用 /list 確認", token)
        } else {
          await updateFile(env, filtered.join("\n"), sha)
          await reply(rt, `🗑 已移除監控：\n${target}`, token)
        }
        continue
      }

      // URL input
      if (text.startsWith("http://") || text.startsWith("https://")) {
        const supported = SUPPORTED_SITES.some(s => text.includes(s))
        if (!supported) {
          await reply(rt, `⚠️ 目前不支援此網站\n\n支援的網站：\n${SUPPORTED_SITES.join("\n")}`, token)
          continue
        }

        const { content, sha } = await getFile(env)
        if (content.includes(text)) {
          await reply(rt, "這個網址已經在監控中了！\n\n用 /list 查看所有監控網址", token)
          continue
        }

        const newContent = content.trimEnd() + "\n" + text + "\n"
        await updateFile(env, newContent, sha)
        await reply(rt, `✅ 已加入監控！\n\n${text}\n\n每 5 分鐘檢查一次，有票會通知你 🎟`, token)
        continue
      }

      // Help
      await reply(rt,
        "🤖 票務監控 Bot\n\n" +
        "📌 使用方式：\n" +
        "• 貼上票務網址 → 加入監控\n" +
        "• /list → 查看監控中的網址\n" +
        "• /remove <網址> → 移除監控\n\n" +
        "🌐 支援網站：\n" +
        SUPPORTED_SITES.join("\n"),
        token
      )
    }

    return new Response("OK")
  },
}
