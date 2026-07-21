---
name: wedding-clean
description: 수집 원문 JSON을 분석용 CSV로 정제·통합하는 규칙. 중복 제거, 보일러플레이트 제거, 개인정보 마스킹 기준이 필요할 때 사용한다.
---

# Task 02 — 원문 정제·통합

## 목표

소스별 JSON을 한 분석용 표로 합치고, 중복·빈 글·페이지 보일러플레이트·개인 식별 가능 정보를 제거한다. 이 태스크의 결과가 이후 자동 분류의 유일한 입력이다.

## 입력

- `data/web/blind/결혼생활.json` 및 Task 01에서 새로 저장한 Blind 파일
- `data/web/threads/*.json` 중 `웨딩` 검색 결과

## 처리 규칙

1. `id` 또는 `url` 기준으로 중복을 제거한다. 검색어가 달라도 동일 URL이면 한 행만 남긴다.
2. `title + text`를 분석 텍스트로 만든다. 30자 미만, 본문 없음, 추출 오류 글은 제외한다.
3. 광고, 전역 메뉴, “댓글을 남겨주세요”, 더보기 표식 등 화면 보일러플레이트를 제거한다.
4. 본문에 포함된 회사명·닉네임·전화번호·이메일·정확한 주소는 분석에 불필요하므로 마스킹한다. 민감한 개인사 원문은 외부 보고서에 그대로 인용하지 않는다.
5. 소스, 원본 ID, URL, 수집일, 원 검색어, 댓글/조회 등 원본 메타데이터는 보존한다.
6. 특정 채널을 분석 대상으로 제한할 경우, Blind는 `board === "결혼생활"`만 남기고 제외 사유를 기록한다.

## 출력

- `data/analysis/wedding/intermediate/excluded-posts.csv`
- `data/analysis/wedding/meta/cleaning-summary.json`

`posts-topics.csv` 최소 컬럼(토픽 컬럼은 Task 03에서 추가):

```text
post_id,source,board,query,collected_at,published_at,url,title,text,
comment_count,view_count,like_count
```

## 검수·완료 기준

- [ ] 입력 파일별 행 수와 최종 행 수, 중복·빈 글·제외 사유별 건수를 요약함
- [ ] 랜덤 20개에서 제목·본문 연결과 보일러플레이트 제거를 확인함
- [ ] 분석 텍스트에 명백한 전화번호/이메일/회사·닉네임 조합이 남지 않음을 확인함
- [ ] 원본 JSON은 수정·덮어쓰기 하지 않음

## 다음 태스크 입력

`posts-topics.csv`의 `post_id`, `source`, `text`, 반응 수치.
