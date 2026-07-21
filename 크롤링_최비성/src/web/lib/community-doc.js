// 커뮤니티 수집 공통 문서 스키마 (Community Document)
//
// 앱 리뷰가 아닌 커뮤니티(디시, 아카라이브, Reddit 등) 글을 수집할 때 쓰는 통일 포맷.
// 어떤 소스에서 수집하든 같은 형태로 저장해, 후속 정제·분석에서 재사용할 수 있게 한다.
//
// 저장 경로 규약:
//   data/web/<source>/<query-slug>.json
//
// 파일 구조:
//   {
//     "source": "dcinside",
//     "query": "캐시노트",
//     "collectedAt": "2026-...Z",
//     "count": 42,
//     "docs": [ CommunityDoc, ... ]
//   }
//
// CommunityDoc:
//   {
//     id        : 소스 내 고유 식별자(문자열)
//     source    : "dcinside" | "arcalive" | "reddit" | ...
//     board     : 게시판/갤러리/서브레딧 이름(사람이 읽는 라벨)
//     boardId   : 게시판 식별자(있으면)
//     title     : 글 제목
//     text      : 본문(또는 본문 요약). 없으면 ""
//     author    : 작성자(닉네임). 없으면 null
//     url        : 원문 URL
//     date      : 작성일 ISO 문자열. 없으면 null
//     commentCount : 댓글 수(정수). 없으면 null
//     viewCount    : 조회수(정수). 없으면 null
//   }

import { writeJsonAtomic } from "../../shared/atomic-store.js";
import path from "node:path";

/** 파일명으로 안전한 슬러그 생성(한글 보존, 경로 위험문자만 치환). */
export function slugify(query) {
  return String(query)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_") // 파일시스템 금지문자
    .replace(/\s+/g, "_")
    .slice(0, 80) || "query";
}

/** 한 건의 CommunityDoc을 표준 형태로 정규화(누락 필드 null/"" 보정). */
export function normalizeDoc(raw, source) {
  return {
    id: String(raw.id ?? ""),
    source,
    board: raw.board ?? null,
    boardId: raw.boardId ?? null,
    title: raw.title ?? "",
    text: raw.text ?? "",
    author: raw.author ?? null,
    url: raw.url ?? null,
    date: raw.date ?? null,
    commentCount: Number.isInteger(raw.commentCount) ? raw.commentCount : null,
    viewCount: Number.isInteger(raw.viewCount) ? raw.viewCount : null,
  };
}

/**
 * 한 검색어의 수집 결과를 data/web/<source>/<slug>.json 으로 원자적 저장.
 * @returns {string} 저장된 상대 경로
 */
export async function saveQueryResult(source, query, docs) {
  const normalized = docs.map((d) => normalizeDoc(d, source));
  const payload = {
    source,
    query,
    collectedAt: new Date().toISOString(),
    count: normalized.length,
    docs: normalized,
  };
  const outPath = path.resolve("data", "web", source, `${slugify(query)}.json`);
  await writeJsonAtomic(outPath, payload);
  return path.relative(process.cwd(), outPath);
}

/** 두 doc 목록을 id 기준으로 병합(중복 제거). 기존 결과에 누적할 때 사용. */
export function dedupeById(docs) {
  const seen = new Set();
  const out = [];
  for (const d of docs) {
    const key = d.id || d.url || d.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
