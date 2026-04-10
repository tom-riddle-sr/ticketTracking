#!/usr/bin/env python3
"""
Ticket availability monitor
- Reads URLs from urls.txt (one per line)
- Detects which site each URL belongs to
- Sends LINE message when tickets become available
"""
import os
import sys
import requests


LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_USER_ID = os.environ.get("LINE_USER_ID", "")
URLS_FILE = os.path.join(os.path.dirname(__file__), "urls.txt")


def send_line_message(message: str):
    if not LINE_CHANNEL_ACCESS_TOKEN or not LINE_USER_ID:
        print("[WARN] LINE credentials not set, skipping notification")
        return
    resp = requests.post(
        "https://api.line.me/v2/bot/message/push",
        headers={
            "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
            "Content-Type": "application/json",
        },
        json={
            "to": LINE_USER_ID,
            "messages": [{"type": "text", "text": message}],
        },
        timeout=10,
    )
    if resp.status_code == 200:
        print(f"[LINE] Sent: {message[:60]}")
    else:
        print(f"[LINE] Failed ({resp.status_code}): {resp.text}")


def detect_site(url: str):
    if "tixcraft.com" in url:
        from monitors.tixcraft import check
        return check
    elif "kktix.com" in url:
        from monitors.kktix import check
        return check
    return None


def load_urls() -> list:
    if not os.path.exists(URLS_FILE):
        print(f"[ERROR] {URLS_FILE} not found")
        return []
    with open(URLS_FILE) as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def main():
    urls = load_urls()
    if not urls:
        print("No URLs to monitor.")
        sys.exit(0)

    found_any = False

    for url in urls:
        print(f"[CHECK] {url}")
        check_fn = detect_site(url)
        if not check_fn:
            print(f"  [SKIP] Unsupported site: {url}")
            continue

        try:
            result = check_fn(url)
            print(f"  → {result['message']}")

            if result["available"]:
                found_any = True
                send_line_message(
                    f"🎟 有票了！\n{result['message']}\n\n🔗 {url}"
                )
        except Exception as e:
            print(f"  [ERROR] {e}")

    if not found_any:
        print("\n[DONE] 目前沒有可購買的票")


if __name__ == "__main__":
    main()
