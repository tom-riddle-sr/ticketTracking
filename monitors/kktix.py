"""
KKTIX monitor
Detects ticket availability on kktix.com event pages.
"""
from bs4 import BeautifulSoup
from .base import fetch


def check(url: str) -> dict:
    resp = fetch(url)
    soup = BeautifulSoup(resp.text, "lxml")

    areas_available = []
    areas_soldout = []

    # KKTIX uses ticket type rows with "sold-out" class or button state
    ticket_rows = soup.select(".ticket-list-row, .ticket-item, [class*='ticket']")

    for row in ticket_rows:
        name_el = row.select_one(".ticket-name, .name, h3, h4")
        name = name_el.get_text(strip=True) if name_el else row.get_text(strip=True)[:30]

        is_soldout = (
            "sold-out" in row.get("class", [])
            or row.select_one("[class*='sold-out'], [class*='soldout']") is not None
            or "售完" in row.get_text()
            or "Sold Out" in row.get_text()
        )

        if name:
            if is_soldout:
                areas_soldout.append(name)
            else:
                areas_available.append(name)

    # Fallback: check if registration/buy button is disabled
    if not ticket_rows:
        buy_btn = soup.select_one("a.btn-register, button.btn-buy, [class*='register']")
        if buy_btn:
            disabled = (
                "disabled" in buy_btn.get("class", [])
                or buy_btn.get("disabled") is not None
            )
            if not disabled:
                return {"available": True, "message": "有票！購買按鈕可用", "areas": []}
        return {"available": False, "message": "售完或無法解析", "areas": []}

    if areas_available:
        return {
            "available": True,
            "message": f"有票！可購買：{', '.join(areas_available)}",
            "areas": areas_available,
        }
    return {
        "available": False,
        "message": f"全數售完（{len(areas_soldout)} 種票）",
        "areas": [],
    }
