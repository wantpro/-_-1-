import csv
import json
import re
from collections import Counter
from datetime import datetime
from html import escape
from pathlib import Path

from quality_rules import analyze_post


ROOT = Path(__file__).resolve().parent
SOURCE_FILES = {
    "dcinside": ROOT / "dc_wedding_posts.jsonl",
    "kgwed": ROOT / "kgwed_posts.jsonl",
}
SOURCE_LABELS = {
    "dcinside": "DC인사이드",
    "kgwed": "결직웨딩",
}
SOURCE_NOTES = {
    "dcinside": "결혼 갤러리의 관련 키워드 검색 결과",
    "kgwed": "업체가 운영하는 후기 게시판",
}
LEGACY_SCOPE = {
    "dcinside": "최대 20개 목록 페이지, 최대 100개 후보 (실행 로그 없음)",
    "kgwed": "최대 5개 목록 페이지, 최대 50개 후보 (실행 로그 없음)",
}
ISSUE_DESCRIPTIONS = {
    "예상 밖 추가비용": "계약 이후 추가되는 옵션·원본·헬퍼·업그레이드 비용",
    "가격·견적 정보": "견적 비교, 가격 공개, 총액과 가성비에 관한 정보",
    "계약·취소·환불": "계약금, 예약 취소, 환불과 위약금 조건",
    "제휴·수수료 구조": "제휴 여부, 중개 수수료, 강매와 당일 계약",
    "일정·예약 관리": "준비물 안내, 예약 변경, 일정과 스케줄 관리",
    "서비스 불편·품질 문제": "응대, 누락, 지연, 결과물과 재촬영 문제",
    "선택 피로·정보 부족": "업체 비교의 어려움과 준비 과정의 정보 부족",
}
RESEARCH_USE_LABELS = {
    "core_problem": "핵심 불편·문제",
    "planner_workflow": "웨딩 플래너 진행 과정",
    "vendor_preference": "업체 선택 기준·후기",
    "핵심 이슈": "핵심 불편·문제",
    "웨딩 준비 사례": "웨딩 준비 과정",
    "업체 선택 후기": "업체 선택 기준·후기",
    "제외": "분석 제외",
}
RESEARCH_USE_DESCRIPTIONS = {
    "핵심 불편·문제": "추가비용·계약·환불·품질처럼 해결이 필요한 문제",
    "웨딩 플래너 진행 과정": "플래너 상담부터 일정 관리까지 실제로 진행한 과정",
    "웨딩 준비 과정": "예식과 촬영 등을 준비하며 겪은 과정과 경험",
    "업체 선택 기준·후기": "업체를 고른 이유와 이용 후 만족하거나 아쉬웠던 점",
    "분석 제외": "구체적인 웨딩 준비 정보가 부족해 분석에서 뺀 글",
}
STOPWORDS = {
    "그리고", "그런데", "그래서", "그냥", "정말", "진짜", "너무", "저는", "제가",
    "저희", "우리", "이번", "이제", "후기", "결혼", "결혼식", "웨딩", "신부", "신랑",
    "계약", "추천", "사진", "업체", "준비", "했어요", "있어요", "같아요", "합니다",
    "했습니다", "있는", "없는", "하고", "해서", "하는", "으로", "에서", "에게", "까지",
}


def load_data() -> tuple[list[dict], dict[str, dict]]:
    rows = []
    metadata = {}

    for source, path in SOURCE_FILES.items():
        if not path.exists():
            continue

        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    print(f"[JSON 오류] {path.name}:{line_number}")
                    continue

                if record.get("record_type") == "crawl_summary":
                    metadata[source] = record
                    continue

                record["source"] = record.get("source") or source
                rows.append(record)

    return rows, metadata


def reanalyze(row: dict) -> dict:
    body = row.get("body_clean") or row.get("body") or ""
    analysis = analyze_post(
        title=row.get("title", ""),
        body=body,
        source=row.get("source", ""),
    )
    return {
        "source": row.get("source", ""),
        "external_id": row.get("external_id", ""),
        "url": row.get("url", ""),
        **analysis,
    }


def normalize_signature(text: str) -> str:
    text = re.sub(r"https?://\S+", " ", text or "").lower()
    text = re.sub(r"[^0-9a-z가-힣]+", " ", text)
    return " ".join(text.split())


def deduplicate(rows: list[dict]) -> tuple[list[dict], Counter]:
    unique_rows = []
    duplicate_counts = Counter()
    seen = set()

    for row in rows:
        title = normalize_signature(row.get("title", ""))
        body = normalize_signature(row.get("body_clean", ""))
        signature_text = title if len(title) >= 12 else f"{title} {body[:240]}"
        signature = (row.get("source", ""), signature_text)

        if signature in seen:
            duplicate_counts[row.get("source", "")] += 1
            continue

        seen.add(signature)
        unique_rows.append(row)

    return unique_rows, duplicate_counts


def join_values(value) -> str:
    if isinstance(value, (list, tuple, set)):
        return ", ".join(str(item) for item in value if item)
    return str(value or "")


def research_use_label(value: str) -> str:
    value = str(value or "").strip()
    return RESEARCH_USE_LABELS.get(value, value or "분류 없음")


def preview(text: str, length: int = 190) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= length else text[:length].rstrip() + "…"


def evidence_for(row: dict) -> str:
    evidence = row.get("evidence_sentences", [])
    if evidence:
        return preview(" / ".join(evidence))
    if row.get("keep"):
        return preview(row.get("body_clean", ""))
    return row.get("reject_reason", "분석 대상에서 제외")


def write_csv(rows: list[dict], path: Path) -> None:
    fieldnames = [
        "출처", "포함여부", "분류", "서비스", "이슈", "가격언급", "제목", "근거", "URL",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "출처": SOURCE_LABELS.get(row.get("source", ""), row.get("source", "")),
                    "포함여부": "포함" if row.get("keep") else "제외",
                    "분류": research_use_label(row.get("research_use", "")),
                    "서비스": join_values(row.get("service_categories", [])),
                    "이슈": join_values(row.get("issue_labels", [])),
                    "가격언급": join_values(row.get("price_mentions", [])),
                    "제목": row.get("title", ""),
                    "근거": evidence_for(row),
                    "URL": row.get("url", ""),
                }
            )


def source_counts(rows: list[dict], source: str) -> tuple[int, int]:
    source_rows = [row for row in rows if row.get("source") == source]
    return len(source_rows), sum(1 for row in source_rows if row.get("keep"))


def render_top_cards(raw_count: int, rows: list[dict], duplicate_counts: Counter) -> str:
    included = sum(1 for row in rows if row.get("keep"))
    excluded = len(rows) - included
    cards = [
        ("상세 본문 저장", raw_count, "원본 JSONL 게시글"),
        ("중복 제외", sum(duplicate_counts.values()), "같은 출처·같은 제목"),
        ("분석 포함", included, "현재 한국어 규칙 통과"),
        ("분석 제외", excluded, "웨딩 준비 이슈 불충분"),
    ]
    return "".join(
        "<article class='metric'>"
        f"<span>{escape(label)}</span><strong>{value}</strong><small>{escape(note)}</small>"
        "</article>"
        for label, value, note in cards
    )


def audit_value(metadata: dict, key: str, fallback: str = "기록 없음") -> str:
    value = metadata.get(key)
    return str(value) if value is not None else fallback


def render_collection_audit(
    rows: list[dict],
    raw_counts: Counter,
    duplicate_counts: Counter,
    metadata: dict[str, dict],
) -> str:
    table_rows = []

    for source in SOURCE_FILES:
        source_meta = metadata.get(source, {})
        _, included = source_counts(rows, source)
        excluded = sum(
            1 for row in rows if row.get("source") == source and not row.get("keep")
        )

        if source_meta:
            list_pages = (
                f"{audit_value(source_meta, 'list_pages_loaded')} / "
                f"{audit_value(source_meta, 'list_pages_attempted')}"
            )
            links = audit_value(source_meta, "discovered_links")
            detail_attempts = audit_value(source_meta, "detail_pages_attempted")
            collected_at = audit_value(source_meta, "collected_at")
        else:
            list_pages = LEGACY_SCOPE[source]
            links = "기록 없음"
            detail_attempts = "기록 없음"
            collected_at = "2026-07-20 저장본"

        table_rows.append(
            "<tr>"
            f"<th><span class='source-dot {source}'></span>{SOURCE_LABELS[source]}</th>"
            f"<td>{escape(list_pages)}</td>"
            f"<td>{escape(links)}</td>"
            f"<td>{escape(detail_attempts)}</td>"
            f"<td><strong>{raw_counts[source]}</strong>건</td>"
            f"<td>{included}건</td>"
            f"<td>{duplicate_counts[source]}건 / {excluded}건</td>"
            f"<td>{escape(collected_at)}</td>"
            "</tr>"
        )

    return (
        "<div class='table-shell audit-table'><table>"
        "<thead><tr><th>출처</th><th>목록 성공 / 시도</th><th>발견 링크</th>"
        "<th>상세 진입</th><th>본문 저장</th><th>분석 포함</th>"
        "<th>중복 / 규칙 제외</th><th>수집 시각</th></tr></thead>"
        f"<tbody>{''.join(table_rows)}</tbody></table></div>"
    )


def render_scope_note(metadata: dict[str, dict]) -> str:
    search_terms = metadata.get("dcinside", {}).get("search_terms", [])
    terms = ", ".join(search_terms) if search_terms else "과거 실행 기록 없음"
    return (
        "<div class='scope-note'>"
        f"<strong>DC 검색어</strong><span>{escape(terms)}</span>"
        "<strong>결직 범위</strong><span>후기 게시판 목록에서 발견된 상세 URL 전체</span>"
        "</div>"
    )


def render_source_overview(rows: list[dict], raw_counts: Counter) -> str:
    cards = []
    for source in SOURCE_FILES:
        source_rows = [
            row for row in rows if row.get("source") == source and row.get("keep")
        ]
        issue_counts = Counter(
            issue for row in source_rows for issue in row.get("issue_labels", [])
        )
        top_issues = issue_counts.most_common(3)
        issue_html = "".join(
            f"<li><span>{escape(issue)}</span><strong>{count}</strong></li>"
            for issue, count in top_issues
        ) or "<li><span>분류된 이슈 없음</span><strong>0</strong></li>"
        cards.append(
            f"<article class='source-card {source}'>"
            f"<p class='eyebrow'>{escape(SOURCE_NOTES[source])}</p>"
            f"<h3>{SOURCE_LABELS[source]}</h3>"
            f"<p class='source-number'>{len(source_rows)}<span> / 원본 {raw_counts[source]}건</span></p>"
            f"<ul>{issue_html}</ul>"
            "</article>"
        )
    return "".join(cards)


def render_research_types(rows: list[dict]) -> str:
    counts = Counter(
        research_use_label(row.get("research_use", ""))
        for row in rows
        if row.get("keep")
    )
    if not counts:
        return "<p class='empty'>분석에 포함된 글이 없습니다.</p>"

    cards = []
    for label, count in counts.most_common():
        description = RESEARCH_USE_DESCRIPTIONS.get(
            label, "웨딩 준비 글을 내용에 따라 묶은 분석 유형"
        )
        cards.append(
            "<article class='type-card'>"
            f"<div><strong>{escape(label)}</strong><span>{count}건</span></div>"
            f"<p>{escape(description)}</p>"
            "</article>"
        )
    return "".join(cards)


def count_labels(rows: list[dict], field: str) -> dict[str, Counter]:
    counts: dict[str, Counter] = {}
    for row in rows:
        if not row.get("keep"):
            continue
        for label in row.get(field, []):
            counts.setdefault(label, Counter())[row.get("source", "")] += 1
    return counts


def render_distribution(rows: list[dict], field: str) -> str:
    counts = count_labels(rows, field)
    if not counts:
        return "<p class='empty'>분류된 항목이 없습니다.</p>"

    ordered = sorted(counts.items(), key=lambda item: (-sum(item[1].values()), item[0]))
    maximum = max(sum(count.values()) for _, count in ordered)
    bars = []

    for label, count in ordered:
        dc_count = count["dcinside"]
        kgwed_count = count["kgwed"]
        total = dc_count + kgwed_count
        bars.append(
            "<div class='distribution-row'>"
            f"<div class='distribution-label'><span>{escape(label)}</span><strong>{total}</strong></div>"
            "<div class='track'>"
            f"<span class='segment dcinside' style='width:{dc_count / maximum * 100:.1f}%'></span>"
            f"<span class='segment kgwed' style='width:{kgwed_count / maximum * 100:.1f}%'></span>"
            "</div>"
            f"<small>DC {dc_count} · 결직 {kgwed_count}</small>"
            "</div>"
        )
    return "".join(bars)


def render_issue_cards(rows: list[dict]) -> str:
    groups: dict[str, list[dict]] = {}
    for row in rows:
        if not row.get("keep"):
            continue
        for issue in row.get("issue_labels", []):
            groups.setdefault(issue, []).append(row)

    cards = []
    for issue, group in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])):
        counts = Counter(row.get("source", "") for row in group)
        examples = []
        for row in group[:3]:
            examples.append(
                "<li>"
                f"<a href='{escape(row.get('url', ''))}' target='_blank' rel='noreferrer'>"
                f"{escape(preview(row.get('title', ''), 62))}</a>"
                f"<p>{escape(evidence_for(row))}</p>"
                "</li>"
            )
        cards.append(
            "<article class='issue-card'>"
            f"<div class='issue-heading'><span>{len(group)}건</span><h3>{escape(issue)}</h3></div>"
            f"<p class='issue-description'>{escape(ISSUE_DESCRIPTIONS.get(issue, '반복해서 확인된 웨딩 준비 주제'))}</p>"
            f"<p class='split'>DC {counts['dcinside']} · 결직 {counts['kgwed']}</p>"
            f"<ul>{''.join(examples)}</ul>"
            "</article>"
        )
    return "".join(cards) or "<p class='empty'>분류된 이슈가 없습니다.</p>"


def tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[0-9A-Za-z가-힣]{2,}", text or "")
    return [token for token in tokens if token not in STOPWORDS and not token.isdigit()]


def render_keywords(rows: list[dict], limit: int = 18) -> str:
    counter = Counter()
    for row in rows:
        if not row.get("keep"):
            continue
        text = f"{row.get('title', '')} {' '.join(row.get('evidence_sentences', []))}"
        counter.update(tokenize(text))

    common = counter.most_common(limit)
    if not common:
        return "<p class='empty'>표시할 키워드가 없습니다.</p>"

    maximum = common[0][1]
    return "".join(
        "<div class='keyword'>"
        f"<span>{escape(word)}</span><div><i style='width:{count / maximum * 100:.1f}%'></i></div>"
        f"<strong>{count}</strong></div>"
        for word, count in common
    )


def render_posts_table(rows: list[dict]) -> str:
    body_rows = []
    for row in rows:
        source = row.get("source", "")
        state = "포함" if row.get("keep") else "제외"
        url = escape(row.get("url", ""))
        body_rows.append(
            f"<tr class='row-{source} {'included' if row.get('keep') else 'excluded'}'>"
            f"<td><span class='source-pill {source}'>{SOURCE_LABELS.get(source, source)}</span></td>"
            f"<td><span class='state {state}'>{state}</span><br><small>{escape(research_use_label(row.get('research_use', '')))}</small></td>"
            f"<td>{escape(join_values(row.get('service_categories', [])) or '—')}</td>"
            f"<td>{escape(join_values(row.get('issue_labels', [])) or '—')}</td>"
            f"<td class='post-title'><a href='{url}' target='_blank' rel='noreferrer'>{escape(row.get('title', ''))}</a></td>"
            f"<td>{escape(evidence_for(row))}</td>"
            "</tr>"
        )

    return (
        "<div class='table-shell posts-table'><table>"
        "<thead><tr><th>출처</th><th>판정</th><th>서비스</th><th>이슈</th><th>게시글</th><th>판정 근거</th></tr></thead>"
        f"<tbody>{''.join(body_rows)}</tbody></table></div>"
    )


def render_html(
    rows: list[dict],
    raw_count: int,
    raw_counts: Counter,
    duplicate_counts: Counter,
    metadata: dict[str, dict],
) -> str:
    generated_at = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    cards = render_top_cards(raw_count, rows, duplicate_counts)
    audit = render_collection_audit(rows, raw_counts, duplicate_counts, metadata)
    scope_note = render_scope_note(metadata)
    sources = render_source_overview(rows, raw_counts)
    research_types = render_research_types(rows)
    issue_distribution = render_distribution(rows, "issue_labels")
    service_distribution = render_distribution(rows, "service_categories")
    issue_cards = render_issue_cards(rows)
    keywords = render_keywords(rows)
    posts_table = render_posts_table(rows)

    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>웨딩 크롤링 통합 보고서</title>
  <style>
    :root {{
      --ink: #1f2926;
      --muted: #68736f;
      --paper: #f4f0e8;
      --surface: #fffdf8;
      --line: #dcd5c8;
      --dc: #e65f3f;
      --kg: #178b82;
      --gold: #b8892e;
    }}
    * {{ box-sizing: border-box; }}
    html {{ scroll-behavior: smooth; }}
    body {{
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 8% 4%, rgba(230,95,63,.12), transparent 24rem),
        radial-gradient(circle at 92% 16%, rgba(23,139,130,.12), transparent 28rem),
        var(--paper);
      font-family: "Pretendard", "Noto Sans KR", "Malgun Gothic", sans-serif;
    }}
    a {{ color: inherit; }}
    .page {{ width: min(1440px, calc(100% - 36px)); margin: 0 auto; padding: 54px 0 80px; }}
    .hero {{ max-width: 900px; margin-bottom: 34px; }}
    .eyebrow {{ margin: 0 0 10px; color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }}
    h1, h2, h3 {{ font-family: "Gowun Batang", "Nanum Myeongjo", serif; letter-spacing: -.035em; }}
    h1 {{ margin: 0; font-size: clamp(40px, 6vw, 76px); line-height: 1.02; font-weight: 700; }}
    .lead {{ max-width: 760px; margin: 20px 0 0; color: var(--muted); font-size: 17px; line-height: 1.75; }}
    .stamp {{ display: inline-block; margin-top: 18px; padding: 7px 11px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,253,248,.7); color: var(--muted); font-size: 12px; }}
    .metrics {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 34px 0; }}
    .metric, .panel, .source-card, .issue-card {{ background: rgba(255,253,248,.94); border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(55,46,36,.05); }}
    .metric {{ min-height: 150px; padding: 20px; border-radius: 18px; display: flex; flex-direction: column; }}
    .metric span {{ color: var(--muted); font-size: 13px; font-weight: 700; }}
    .metric strong {{ margin: auto 0 6px; font-family: "Gowun Batang", serif; font-size: 48px; line-height: 1; }}
    .metric small {{ color: var(--muted); }}
    nav {{ position: sticky; top: 12px; z-index: 5; display: flex; gap: 6px; width: fit-content; margin: 0 0 24px; padding: 7px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,253,248,.9); backdrop-filter: blur(12px); }}
    nav a {{ padding: 8px 12px; border-radius: 999px; color: var(--muted); font-size: 12px; font-weight: 800; text-decoration: none; }}
    nav a:hover {{ background: var(--ink); color: white; }}
    .panel {{ margin: 0 0 18px; padding: 26px; border-radius: 24px; }}
    .section-head {{ display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }}
    .section-head h2 {{ margin: 0; font-size: 30px; }}
    .section-head p {{ max-width: 680px; margin: 0; color: var(--muted); line-height: 1.6; }}
    .method {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }}
    .method article {{ padding: 18px; border-left: 3px solid var(--gold); background: #f8f3e9; }}
    .method strong {{ display: block; margin-bottom: 7px; }}
    .method p {{ margin: 0; color: var(--muted); font-size: 14px; line-height: 1.65; }}
    .source-grid, .chart-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }}
    .type-summary {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0 0 22px; }}
    .type-card {{ padding: 17px 18px; border: 1px solid var(--line); border-radius: 16px; background: #f8f3e9; }}
    .type-card > div {{ display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }}
    .type-card strong {{ font-size: 15px; }}
    .type-card span {{ color: var(--gold); font-size: 18px; font-weight: 900; white-space: nowrap; }}
    .type-card p {{ margin: 9px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }}
    .source-card {{ padding: 24px; border-radius: 20px; border-top: 5px solid; }}
    .source-card.dcinside {{ border-top-color: var(--dc); }}
    .source-card.kgwed {{ border-top-color: var(--kg); }}
    .source-card h3 {{ margin: 0; font-size: 28px; }}
    .source-number {{ margin: 18px 0; font: 700 46px/1 "Gowun Batang", serif; }}
    .source-number span {{ color: var(--muted); font: 500 13px/1.4 sans-serif; }}
    .source-card ul {{ margin: 0; padding: 0; list-style: none; }}
    .source-card li {{ display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); font-size: 14px; }}
    .chart {{ padding: 20px; border: 1px solid var(--line); border-radius: 18px; background: #faf7f0; }}
    .chart h3 {{ margin: 0 0 18px; font-size: 21px; }}
    .legend {{ display: flex; gap: 14px; margin: 8px 0 20px; color: var(--muted); font-size: 12px; }}
    .legend i, .source-dot {{ display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 50%; }}
    .dcinside {{ --source: var(--dc); }} .kgwed {{ --source: var(--kg); }}
    .legend .dcinside, .source-dot.dcinside {{ background: var(--dc); }}
    .legend .kgwed, .source-dot.kgwed {{ background: var(--kg); }}
    .distribution-row {{ display: grid; grid-template-columns: minmax(110px, 1fr) 2fr 92px; align-items: center; gap: 12px; margin: 13px 0; }}
    .distribution-label {{ display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }}
    .track {{ display: flex; height: 12px; overflow: hidden; border-radius: 999px; background: #e8e2d8; }}
    .segment {{ display: block; height: 100%; }}
    .segment.dcinside {{ background: var(--dc); }} .segment.kgwed {{ background: var(--kg); }}
    .distribution-row small {{ color: var(--muted); font-size: 11px; }}
    .issue-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }}
    .issue-card {{ padding: 22px; border-radius: 20px; }}
    .issue-heading {{ display: flex; align-items: baseline; gap: 10px; }}
    .issue-heading span {{ min-width: 46px; color: var(--gold); font-size: 13px; font-weight: 900; }}
    .issue-heading h3 {{ margin: 0; font-size: 23px; }}
    .issue-description, .split {{ color: var(--muted); font-size: 13px; line-height: 1.6; }}
    .issue-card ul {{ margin: 17px 0 0; padding: 0; list-style: none; }}
    .issue-card li {{ padding: 12px 0; border-top: 1px solid var(--line); }}
    .issue-card li a {{ font-weight: 800; text-decoration-color: #c9bfae; text-underline-offset: 3px; }}
    .issue-card li p {{ margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }}
    .keyword-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px 22px; }}
    .keyword {{ display: grid; grid-template-columns: 110px 1fr 28px; align-items: center; gap: 10px; font-size: 13px; }}
    .keyword > div {{ height: 8px; overflow: hidden; border-radius: 999px; background: #e8e2d8; }}
    .keyword i {{ display: block; height: 100%; background: linear-gradient(90deg, var(--gold), #d9ad59); }}
    .keyword strong {{ text-align: right; }}
    .table-shell {{ overflow: auto; border: 1px solid var(--line); border-radius: 16px; }}
    table {{ width: 100%; border-collapse: collapse; background: var(--surface); font-size: 13px; }}
    th, td {{ padding: 12px 13px; border-bottom: 1px solid #e8e2d8; text-align: left; vertical-align: top; line-height: 1.55; }}
    thead th {{ position: sticky; top: 0; z-index: 2; background: #eee8dc; white-space: nowrap; }}
    .audit-table table {{ min-width: 1050px; }}
    .audit-table tbody th {{ min-width: 130px; white-space: nowrap; }}
    .scope-note {{ display: grid; grid-template-columns: auto 1fr; gap: 7px 12px; margin-top: 14px; padding: 14px 16px; border-radius: 14px; background: #f8f3e9; color: var(--muted); font-size: 12px; line-height: 1.6; }}
    .scope-note strong {{ color: var(--ink); white-space: nowrap; }}
    .posts-table table {{ min-width: 1220px; }}
    .posts-table tbody tr:hover {{ background: #faf6ed; }}
    .posts-table tr.excluded {{ opacity: .55; }}
    .source-pill, .state {{ display: inline-block; padding: 4px 8px; border-radius: 999px; white-space: nowrap; font-size: 11px; font-weight: 900; }}
    .source-pill {{ color: white; background: var(--source); }}
    .state.포함 {{ background: #e2f1ed; color: #17665f; }} .state.제외 {{ background: #ece8e1; color: #776e62; }}
    .post-title {{ min-width: 260px; font-weight: 800; }}
    .post-title a {{ text-underline-offset: 3px; }}
    .empty {{ color: var(--muted); }}
    footer {{ padding: 20px 2px; color: var(--muted); font-size: 12px; line-height: 1.7; }}
    @media (max-width: 900px) {{
      .metrics, .method, .type-summary {{ grid-template-columns: repeat(2, 1fr); }}
      .source-grid, .chart-grid, .issue-grid {{ grid-template-columns: 1fr; }}
      .keyword-grid {{ grid-template-columns: 1fr; }}
      nav {{ max-width: 100%; overflow-x: auto; }}
    }}
    @media (max-width: 560px) {{
      .page {{ width: min(100% - 22px, 1440px); padding-top: 30px; }}
      .metrics, .method, .type-summary {{ grid-template-columns: 1fr; }}
      .metric {{ min-height: 128px; padding: 15px; }} .metric strong {{ font-size: 38px; }}
      .panel {{ padding: 17px; border-radius: 18px; }}
      .section-head {{ display: block; }} .section-head p {{ margin-top: 8px; }}
      .distribution-row {{ grid-template-columns: 105px 1fr; }} .distribution-row small {{ display: none; }}
      .keyword {{ grid-template-columns: 90px 1fr 24px; }}
    }}
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <p class="eyebrow">DC인사이드 + 결직웨딩 · 통합 분석 보고서</p>
      <h1>웨딩 준비 후기에서<br>무엇이 반복됐나</h1>
      <p class="lead">DC인사이드와 결직웨딩의 저장된 상세 본문을 명시적인 한국어 규칙으로 다시 분류했습니다. 어떤 표현 때문에 어떤 이슈로 묶였는지 원문 링크와 함께 확인할 수 있습니다.</p>
      <span class="stamp">보고서 생성 {generated_at}</span>
    </header>

    <section class="metrics">{cards}</section>
    <nav><a href="#audit">수집 검증</a><a href="#overview">출처 비교</a><a href="#issues">이슈</a><a href="#keywords">키워드</a><a href="#posts">전체 글</a></nav>

    <section class="panel" id="audit">
      <div class="section-head"><h2>수집 검증</h2><p>‘본문 저장’은 목록 제목만 본 것이 아니라 상세 URL을 요청해 제목과 본문을 파싱한 건수입니다. 과거 저장본은 후보 링크와 실패 수를 남기지 않아 해당 값은 복원할 수 없습니다.</p></div>
      <div class="method">
        <article><strong>상세 페이지 진입</strong><p>두 크롤러 모두 목록에서 URL을 모은 뒤 각 게시글의 상세 페이지를 별도로 열어 본문 영역을 저장합니다.</p></article>
        <article><strong>분석 포함 기준</strong><p>DC는 구체적인 웨딩 준비 맥락과 불편·문제가 함께 있어야 포함합니다. 결직은 불편·문제 글과 업체 선택 기준·후기를 구분해 포함합니다.</p></article>
        <article><strong>해석 시 주의</strong><p>결직은 업체 운영 후기 게시판이라 긍정 후기가 많습니다. 출처 성격을 일반 커뮤니티 의견과 동일하게 해석하면 안 됩니다.</p></article>
      </div>
      {audit}
      {scope_note}
    </section>

    <section class="panel" id="overview">
      <div class="section-head"><h2>출처 비교</h2><p>각 출처에서 현재 규칙으로 분석에 포함된 글과 반복 이슈를 나란히 봅니다.</p></div>
      <h3>분석 유형 한눈에 보기</h3>
      <div class="type-summary">{research_types}</div>
      <div class="source-grid">{sources}</div>
      <div class="chart-grid" style="margin-top:14px">
        <article class="chart"><h3>이슈 분포</h3><div class="legend"><span><i class="dcinside"></i>DC인사이드</span><span><i class="kgwed"></i>결직웨딩</span></div>{issue_distribution}</article>
        <article class="chart"><h3>서비스 분포</h3><div class="legend"><span><i class="dcinside"></i>DC인사이드</span><span><i class="kgwed"></i>결직웨딩</span></div>{service_distribution}</article>
      </div>
    </section>

    <section class="panel" id="issues">
      <div class="section-head"><h2>한국어 이슈 그룹</h2><p>각 그룹은 명시된 키워드 규칙으로 만들어졌습니다. 대표 글을 누르면 실제 상세 게시글로 이동합니다.</p></div>
      <div class="issue-grid">{issue_cards}</div>
    </section>

    <section class="panel" id="keywords">
      <div class="section-head"><h2>반복 키워드</h2><p>분석에 포함된 글의 제목과 이슈 근거 문장에서 조사·상투어를 제외하고 집계했습니다.</p></div>
      <div class="keyword-grid">{keywords}</div>
    </section>

    <section class="panel" id="posts">
      <div class="section-head"><h2>DC + 결직 전체 결과</h2><p>중복을 제외한 모든 상세 게시글입니다. 회색으로 흐린 행은 원문은 저장됐지만 현재 분석 기준에서는 제외된 글입니다.</p></div>
      {posts_table}
    </section>

    <footer>이 보고서는 저장된 본문을 재분석하므로 분류·시각화 변경만으로는 재크롤링이 필요하지 않습니다. 새 게시글을 추가하거나 정확한 수집 시도 통계를 남기려면 크롤러를 다시 실행해야 합니다.</footer>
  </main>
</body>
</html>
"""


def main() -> None:
    raw_rows, metadata = load_data()
    raw_counts = Counter(row.get("source", "") for row in raw_rows)
    analyzed_rows = [reanalyze(row) for row in raw_rows]
    rows, duplicate_counts = deduplicate(analyzed_rows)
    rows.sort(
        key=lambda row: (
            row.get("source", ""),
            not row.get("keep", False),
            row.get("title", ""),
        )
    )

    output_dir = ROOT / "reports"
    output_dir.mkdir(exist_ok=True)
    csv_path = output_dir / "wedding_crawling_summary.csv"
    html_path = output_dir / "wedding_crawling_summary.html"
    write_csv(rows, csv_path)
    html_path.write_text(
        render_html(rows, len(raw_rows), raw_counts, duplicate_counts, metadata),
        encoding="utf-8",
    )

    included = sum(1 for row in rows if row.get("keep"))
    print(f"통합 보고서 저장: 원본 {len(raw_rows)}건, 중복 제외 후 {len(rows)}건, 분석 포함 {included}건")
    print(csv_path)
    print(html_path)


if __name__ == "__main__":
    main()
