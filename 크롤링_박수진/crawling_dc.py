import json
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode, urljoin

from crawler_utils import clean_text, content_hash, fetch_soup, query_value
from quality_rules import analyze_post


DC_LIST_URL = "https://gall.dcinside.com/board/lists/"
DC_GALLERY_ID = "wedding"
SEARCH_TERMS = (
    "웨딩홀",
    "예식장",
    "스드메",
    "웨딩촬영",
    "본식스냅",
    "드레스",
    "메이크업",
    "플래너",
    "추가금",
    "견적",
    "계약",
    "환불",
)
SEARCH_PAGES_PER_TERM = 3
ARTICLE_LIMIT = 300


def get_dc_article_links(search_pages: int, stats: dict) -> list[str]:
    links = {}

    for keyword in SEARCH_TERMS:
        for page in range(1, search_pages + 1):
            query = urlencode(
                {
                    "id": DC_GALLERY_ID,
                    "s_type": "search_subject_memo",
                    "s_keyword": keyword,
                    "page": page,
                }
            )
            url = f"{DC_LIST_URL}?{query}"
            stats["list_pages_attempted"] += 1
            soup = fetch_soup(url)

            if soup is None:
                stats["list_pages_failed"] += 1
                break

            stats["list_pages_loaded"] += 1
            links_before_page = len(links)

            for anchor in soup.select('a[href*="/board/view/"]'):
                href = urljoin(url, anchor.get("href", ""))
                post_no = query_value(href, "no")
                gallery_id = query_value(href, "id") or DC_GALLERY_ID

                if not post_no or gallery_id != DC_GALLERY_ID:
                    continue

                links[post_no] = (
                    "https://gall.dcinside.com/board/view/"
                    f"?id={DC_GALLERY_ID}&no={post_no}"
                )

            if page > 1 and len(links) == links_before_page:
                break

        print(f"[DC 목록] {keyword}: 누적 {len(links)}개 링크")

    stats["discovered_links"] = len(links)
    return list(links.values())


def parse_dc_article(url: str) -> dict | None:
    soup = fetch_soup(url)
    if soup is None:
        return None

    title_node = soup.select_one(
        "span.title_subject, h3.title_subject, .view_content_wrap .title_subject, "
        ".view_title, .title_area, .title_subject"
    )
    body_node = soup.select_one(
        ".writing_view_box .write_div, .writing_view_box, "
        ".view_content_wrap .view_content, .view_content_wrap, .write_div, "
        ".view_content, .con_box, .article_viewbox"
    )

    title = clean_text(title_node)
    body = clean_text(body_node)

    if not title:
        meta_title = soup.select_one('meta[property="og:title"]')
        title = (meta_title.get("content") or "").strip() if meta_title else ""

    if not body:
        meta_description = soup.select_one('meta[property="og:description"]')
        body = (meta_description.get("content") or "").strip() if meta_description else ""

    if not title or len(body) < 8:
        return None

    analysis = analyze_post(title=title, body=body, source="dcinside")
    return {
        "record_type": "post",
        "source": "dcinside",
        "external_id": query_value(url, "no"),
        "url": url,
        "content_hash": content_hash(analysis["title"] + analysis["body_clean"]),
        **analysis,
    }


def collect_dc_articles(
    search_pages: int = SEARCH_PAGES_PER_TERM,
    max_articles: int = ARTICLE_LIMIT,
) -> tuple[list[dict], dict]:
    stats = {
        "record_type": "crawl_summary",
        "source": "dcinside",
        "collected_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "search_terms": list(SEARCH_TERMS),
        "list_pages_planned": len(SEARCH_TERMS) * search_pages,
        "list_pages_attempted": 0,
        "list_pages_loaded": 0,
        "list_pages_failed": 0,
        "discovered_links": 0,
        "detail_page_limit": max_articles,
        "detail_pages_attempted": 0,
        "detail_pages_saved": 0,
        "detail_pages_failed": 0,
    }

    article_urls = get_dc_article_links(search_pages, stats)[:max_articles]
    print(f"[DC 상세] {len(article_urls)}개 페이지 확인 시작")
    articles = []
    for index, url in enumerate(article_urls, 1):
        stats["detail_pages_attempted"] += 1
        article = parse_dc_article(url)
        if article is None:
            stats["detail_pages_failed"] += 1
            continue
        articles.append(article)
        if index % 25 == 0 or index == len(article_urls):
            print(f"[DC 상세] {index}/{len(article_urls)} 확인, {len(articles)}건 저장")

    stats["detail_pages_saved"] = len(articles)
    return articles, stats


def save_jsonl(path: str, rows: list[dict], stats: dict) -> None:
    if not rows:
        raise RuntimeError("수집 결과가 0건이라 기존 파일을 덮어쓰지 않았습니다.")

    output_path = Path(path)
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(stats, ensure_ascii=False) + "\n")
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary_path.replace(output_path)


def print_stats(stats: dict) -> None:
    print(
        "DC 수집 완료 | "
        f"목록 {stats['list_pages_loaded']}/{stats['list_pages_attempted']}페이지 | "
        f"링크 {stats['discovered_links']}건 | "
        f"상세 {stats['detail_pages_saved']}/{stats['detail_pages_attempted']}건 저장"
    )


def main() -> None:
    rows, stats = collect_dc_articles()
    save_jsonl("dc_wedding_posts.jsonl", rows, stats)
    print_stats(stats)


if __name__ == "__main__":
    main()
