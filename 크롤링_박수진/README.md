# Wedding Crawling Report

DC인사이드 결혼 갤러리와 결직웨딩 후기 게시판의 글을 수집해 하나의 HTML 보고서로 정리합니다.

## 파일 구성

- `crawling_dc.py`: DC 관련 키워드 검색 결과에서 게시글을 수집합니다.
- `crawling_kgwed.py`: 결직웨딩 후기 목록에서 게시글을 수집합니다.
- `crawler_utils.py`: 요청, 재시도, robots.txt 확인 등 공통 기능입니다.
- `quality_rules.py`: 서비스와 이슈를 한국어 키워드로 분류합니다.
- `build_reports.py`: 저장된 본문을 다시 분석해 통합 CSV와 HTML을 만듭니다.
- `dc_wedding_posts.jsonl`: DC 상세 본문과 최근 수집 통계입니다.
- `kgwed_posts.jsonl`: 결직 상세 본문과 최근 수집 통계입니다.

## 실행 순서

새 게시글을 수집할 때만 아래 두 명령을 실행합니다.

```bash
python crawling_dc.py
python crawling_kgwed.py
```

보고서의 분류나 화면만 다시 만들 때는 크롤링할 필요가 없습니다.

```bash
python build_reports.py
```

최종 결과는 두 파일입니다.

- `reports/wedding_crawling_summary.html`: DC와 결직 결과를 합친 시각화 보고서
- `reports/wedding_crawling_summary.csv`: 같은 결과의 표 데이터

JSONL을 새로 수집하면 첫 줄에는 목록 페이지, 발견 링크, 상세 페이지 요청·저장 수가 기록되고 나머지 줄에는 게시글이 저장됩니다. 수집 결과가 0건이면 기존 파일을 덮어쓰지 않습니다.

## 설치

```bash
python -m pip install beautifulsoup4 requests urllib3
```
