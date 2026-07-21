# Crawlers

공개 커뮤니티와 앱 스토어에서 원본 데이터를 수집하는 작은 보관소입니다.

수집 경로는 성격이 전혀 달라서 폴더로 갈라놨습니다. `web/`은 Playwright로 실제 페이지를 렌더링하고 `stores/`는 브라우저 없이 스토어 API만 호출합니다.

## Layout

- `src/web/` — Blind, DCInside, Daangn 수집기 (+ `lib/`: 문서 스키마·사이트맵)
- `src/stores/` — Google Play, App Store 리뷰 수집기 (+ `lib/`: 앱 목록·규모/별점 필터·재개)
- `src/analysis/` — 정제·토픽·수요점수·워드클라우드
- `src/shared/` — 양쪽이 함께 쓰는 페이싱·원자적 저장
- `data/web/`, `data/stores/` — 수집 원본 (`src/`와 같은 이름으로 짝지음)
- `data/analysis/` — 분석 산출물 (`report/` 결과물 · `intermediate/` 중간물 · `meta/` 실행 기록)
- `.claude/skills/` — 리서치 파이프라인 태스크 문서

## Commands

```bash
# 웹 크롤링 (Playwright)
npm run web:blind -- --query="결혼,웨딩" --shards=2 --max=30 --interval=2500
npm run web:dcinside -- --query="웨딩 견적" --pages=2
npm run web:daangn -- --query="맛집" --regions=5
npm run web:threads -- --mode=me --limit=50

# 스토어 리뷰 (API)
npm run stores:google-play
npm run stores:app-store

# 분석
npm run analysis:run
npm run analysis:wordcloud
```

수집 대상 앱은 설치수 1만~100만 사이 중소형("니치")으로 제한하고, 별점 1~3점 리뷰만 남깁니다. 기준값은 `src/stores/lib/config.js`에 있습니다.

Threads 전체 공개 검색은 공식 API의 별도 권한 승인이 필요하다. 자세한 범위와 실행 기준은 `.claude/skills/wedding-crawl/SKILL.md`를 따른다.
