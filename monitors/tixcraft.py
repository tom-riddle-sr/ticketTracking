"""
Tixcraft / 拓元售票 monitor
Detects ticket availability on tixcraft.com pages.
"""
from bs4 import BeautifulSoup
from .base import fetch


def check(url: str) -> dict:
    """
    Returns:
        {
            "available": bool,
            "message": str,   # human-readable status
            "areas": list     # available area names (if any)
        }
    """
    resp = fetch(url)
    soup = BeautifulSoup(resp.text, "lxml")

    # Each ticket area is a <tr> or a block containing area name + status
    # Sold out areas contain "Sold out" text; available ones show seat counts
    areas_available = []
    areas_soldout = []

    # Tixcraft area table rows
    rows = soup.select("table.table-hover tbody tr")
    if rows:
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            area_name = cells[0].get_text(strip=True)
            status_cell = cells[-1].get_text(strip=True)

            soldout_keywords = ["Sold out", "售完", "完售", "已售完", "0"]
            is_soldout = any(kw.lower() in status_cell.lower() for kw in soldout_keywords)

            if is_soldout:
                areas_soldout.append(area_name)
            else:
                areas_available.append(area_name)
    else:
        # Fallback: scan page for "Sold out" and count occurrences vs total areas
        all_areas = soup.select("[class*='area'], [class*='zone'], [class*='ticket']")
        page_text = soup.get_text()

        # If page has no recognizable structure, check raw text
        if "Sold out" not in page_text and "售完" not in page_text:
            # Might be fully available or page didn't load properly
            return {
                "available": False,
                "message": "無法解析頁面，請確認網址是否正確",
                "areas": [],
            }

        # Count sold out vs total
        soldout_count = page_text.count("Sold out") + page_text.count("售完")
        return {
            "available": False,
            "message": f"目前售完 (偵測到 {soldout_count} 個售完區域)",
            "areas": [],
        }

    if areas_available:
        return {
            "available": True,
            "message": f"有票！可購買區域：{', '.join(areas_available)}",
            "areas": areas_available,
        }
    else:
        return {
            "available": False,
            "message": f"全數售完（{len(areas_soldout)} 個區域）",
            "areas": [],
        }
