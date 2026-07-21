import json
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

from crawler_utils import clean_text, content_hash, fetch_soup, query_value
from quality_rules import analyze_post


KGWED_BASE_URL = "https://kgwed.com"
KGWED_REVIEW_URL = f"{KGWED_BASE_URL}/%ED%9B%84%EA%B8%B0/"
LIST_PAGE_LIMIT = 20
ARTICLE_LIMIT = 300


def get_kgwed_article_links(max_pages: int, stats: dict) -> list[str]:
    links = {}

    for page in range(1, max_pages + 1):
        url = f"{KGWED_REVIEW_URL}?mod=list&pageid={page}"
        stats["list_pages_attempted"] += 1
        soup = fetch_soup(url)

        if soup is None:
            stats["list_pages_failed"] += 1
            break

        stats["list_pages_loaded"] += 1
        links_before_page = len(links)

        for anchor in soup.select('a[href*="mod=document"][href*="uid="]'):
            href = urljoin(KGWED_REVIEW_URL, anchor.get("href", ""))
            uid = query_value(href, "uid")
            if uid:
                links[uid] = f"{KGWED_REVIEW_URL}?mod=document&uid={uid}"

        print(f"[결직 목록] {page}페이지: 누적 {len(links)}개 링크")

        if page > 1 and len(links) == links_before_page:
            break

    stats["discovered_links"] = len(links)
    return list(links.values())


def parse_kgwed_article(url: str) -> dict | None:
    soup = fetch_soup(url)
    if soup is None:
        return None

    document = soup.select_one(".kboard-document-wrap")
    if document is None:
        print(f"[본문 영역 없음] {url}")
        return None

    title_node = document.select_one(".kboard-title h1, .kboard-title")
    body_node = document.select_one(".kboard-content .content-view, .content-view")
    title = clean_text(title_node)
    body = clean_text(body_node)

    if not title or len(body) < 30:
        print(f"[제목 또는 본문 없음] {url}")
        return None

    analysis = analyze_post(title=title, body=body, source="kgwed")
    return {
        "record_type": "post",
        "source": "kgwed",
        "external_id": query_value(url, "uid"),
        "url": url,
        "content_hash": content_hash(analysis["title"] + analysis["body_clean"]),
        "source_note": "업체가 운영하는 후기 게시판",
        **analysis,
    }


def collect_kgwed_articles(
    max_pages: int = LIST_PAGE_LIMIT,
    max_articles: int = ARTICLE_LIMIT,
) -> tuple[list[dict], dict]:
    stats = {
        "record_type": "crawl_summary",
        "source": "kgwed",
        "collected_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "list_pages_planned": max_pages,
        "list_pages_attempted": 0,
        "list_pages_loaded": 0,
        "list_pages_failed": 0,
        "discovered_links": 0,
        "detail_page_limit": max_articles,
        "detail_pages_attempted": 0,
        "detail_pages_saved": 0,
        "detail_pages_failed": 0,
    }

    article_urls = get_kgwed_article_links(max_pages, stats)[:max_articles]
    print(f"[결직 상세] {len(article_urls)}개 페이지 확인 시작")
    articles = []
    for index, url in enumerate(article_urls, 1):
        stats["detail_pages_attempted"] += 1
        article = parse_kgwed_article(url)
        if article is None:
            stats["detail_pages_failed"] += 1
            continue
        articles.append(article)
        if index % 25 == 0 or index == len(article_urls):
            print(f"[결직 상세] {index}/{len(article_urls)} 확인, {len(articles)}건 저장")

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
        "결직 수집 완료 | "
        f"목록 {stats['list_pages_loaded']}/{stats['list_pages_attempted']}페이지 | "
        f"링크 {stats['discovered_links']}건 | "
        f"상세 {stats['detail_pages_saved']}/{stats['detail_pages_attempted']}건 저장"
    )


def main() -> None:
    rows, stats = collect_kgwed_articles()
    save_jsonl("kgwed_posts.jsonl", rows, stats)
    print_stats(stats)


if __name__ == "__main__":
    main()
