"""
Tixcraft / 拓元售票 monitor
"""
from bs4 import BeautifulSoup
from .base import fetch


def check(url: str) -> dict:
    resp = fetch(url)
    soup = BeautifulSoup(resp.text, "lxml")

    areas_available = []
    areas_soldout = []

    # Tixcraft renders ticket areas as <ul class="area-list"> with <li> items
    for li in soup.select("ul.area-list li"):
        text = li.get_text(strip=True)
        if not text:
            continue

        if "remaining" in text or "剩餘" in text:
            areas_available.append(text)
        elif "Sold out" in text or "售完" in text or "完售" in text:
            areas_soldout.append(text)

    if not areas_available and not areas_soldout:
        return {
            "available": False,
            "message": "無法解析票況，請確認網址是否正確",
            "areas": [],
        }

    if areas_available:
        return {
            "available": True,
            "message": f"有票！\n" + "\n".join(areas_available),
            "areas": areas_available,
        }

    return {
        "available": False,
        "message": f"全數售完（{len(areas_soldout)} 個區域）",
        "areas": [],
    }
