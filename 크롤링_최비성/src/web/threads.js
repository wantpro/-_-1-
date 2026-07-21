// Threads 공식 API 수집기 (graph.threads.net)
//
// 우회가 아니라 Meta가 제공하는 "공식 Threads API"의 정식 경로를 사용한다.
// 로그인 게이트/스크래핑을 쓰지 않으며, 접근은 발급받은 액세스 토큰 권한 범위에 한정된다.
//
// 사전 준비:
//   1) Meta 개발자 콘솔에서 Threads 앱 생성 → 액세스 토큰 발급
//   2) 환경변수로 토큰 주입:
//        Windows(cmd):   set THREADS_ACCESS_TOKEN=토큰값
//        PowerShell:     $env:THREADS_ACCESS_TOKEN="토큰값"
//
// 사용:
//   node src/web/threads.js --mode=me --limit=50
//        → 내 계정의 Threads 글 수집 (THREADS_USER_ID 미지정 시 "me")
//   node src/web/threads.js --mode=keyword --query="캐시노트,정산" --limit=50
//        → 키워드 검색(앱에 keyword_search 권한이 승인된 경우에만 동작)
//
// 결과: data/web/threads/<query-slug>.json  (CommunityDoc 포맷)
//
// 주의: keyword_search는 Meta 승인 권한이 필요하다. 권한이 없으면 API가 오류를 반환하며,
//       그 경우 우회하지 않고 "me" 모드(본인 콘텐츠)만 사용한다.

import { saveQueryResult, dedupeById } from "./lib/community-doc.js";
import { withRetry, sleep } from "../shared/pacing.js";

const SOURCE = "threads";
const API_BASE = "https://graph.threads.net/v1.0";
const FIELDS = "id,text,timestamp,permalink,username,media_type,is_quote_post";
const PACING = { intervalMs: 2000, maxRetries: 4, backoffFactor: 2, backoffMaxMs: 30000 };

function parseArgs(argv) {
  const a = { mode: "me", queries: [], userId: "me", limit: 50, pages: 5, intervalMs: 1500 };
  for (const arg of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "mode") a.mode = (v ?? "me").trim();
    else if (k === "query") a.queries = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "user-id") a.userId = (v ?? "me").trim();
    else if (k === "limit") a.limit = Math.max(1, Math.min(100, parseInt(v ?? "50", 10) || 50));
    else if (k === "pages") a.pages = Math.max(1, parseInt(v ?? "5", 10) || 5);
    else if (k === "interval") a.intervalMs = Math.max(0, parseInt(v ?? "1500", 10) || 1500);
  }
  return a;
}

function getToken() {
  const t = process.env.THREADS_ACCESS_TOKEN;
  if (!t) {
    console.error("환경변수 THREADS_ACCESS_TOKEN 이 필요합니다. (Meta 개발자 콘솔에서 발급)");
    process.exit(1);
  }
  return t;
}

async function apiGet(url) {
  return withRetry(
    async () => {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`Threads API ${res.status}: ${body.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    PACING,
    {
      onRetry: ({ attempt, waitMs }) =>
        console.warn(`  재시도 ${attempt} (${waitMs}ms 대기)`),
    }
  );
}

// Threads 미디어 객체 → CommunityDoc
function toDoc(item) {
  return {
    id: String(item.id),
    board: item.username ? `@${item.username}` : "Threads",
    title: "", // Threads는 제목 개념이 없음
    text: item.text ?? "",
    author: item.username ?? null,
    url: item.permalink ?? null,
    date: item.timestamp ?? null,
  };
}

// 커서 기반 페이지네이션으로 목록 수집
async function collectPaged(firstUrl, args) {
  const all = [];
  let url = firstUrl;
  let page = 0;
  while (url && page < args.pages) {
    const data = await apiGet(url);
    const rows = Array.isArray(data.data) ? data.data : [];
    for (const r of rows) all.push(toDoc(r));
    console.log(`  page ${page + 1}: ${rows.length}건 (누적 ${all.length})`);
    url = data.paging?.next ?? null;
    page++;
    if (url) await sleep(args.intervalMs);
    if (all.length >= args.limit) break;
  }
  return dedupeById(all).slice(0, args.limit);
}

// 내 계정 글 수집
async function collectMe(token, args) {
  const u = new URL(`${API_BASE}/${encodeURIComponent(args.userId)}/threads`);
  u.searchParams.set("fields", FIELDS);
  u.searchParams.set("limit", String(Math.min(args.limit, 100)));
  u.searchParams.set("access_token", token);
  return collectPaged(u.toString(), args);
}

// 키워드 검색(앱에 승인된 경우에만 동작). 권한 없으면 오류 메시지 안내 후 스킵.
async function collectKeyword(token, query, args) {
  const u = new URL(`${API_BASE}/keyword_search`);
  u.searchParams.set("q", query);
  u.searchParams.set("search_type", "TOP");
  u.searchParams.set("fields", FIELDS);
  u.searchParams.set("limit", String(Math.min(args.limit, 100)));
  u.searchParams.set("access_token", token);
  try {
    return await collectPaged(u.toString(), args);
  } catch (e) {
    if (e.status === 400 || e.status === 403) {
      console.warn(
        `  [${query}] keyword_search 사용 불가(권한 미승인으로 추정): ${e.message}`
      );
      console.warn("  → 우회하지 않습니다. Meta에 keyword_search 권한 승인 후 재시도하세요.");
      return [];
    }
    throw e;
  }
}

// ---- main -------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const token = getToken();

if (args.mode === "me") {
  console.log(`[threads] mode=me user=${args.userId} limit=${args.limit}`);
  const docs = await collectMe(token, args);
  if (docs.length === 0) {
    console.log("  → 저장 생략(0건)");
  } else {
    const out = await saveQueryResult(SOURCE, `me_${args.userId}`, docs);
    console.log(`  → 저장: ${out} (${docs.length}건)`);
  }
} else if (args.mode === "keyword") {
  if (args.queries.length === 0) {
    console.error('keyword 모드는 --query 가 필요합니다. 예: --query="캐시노트,정산"');
    process.exit(1);
  }
  for (const q of args.queries) {
    console.log(`\n[threads] keyword: ${q}`);
    const docs = await collectKeyword(token, q, args);
    if (docs.length === 0) {
      console.log("  → 저장 생략(0건)");
      continue;
    }
    const out = await saveQueryResult(SOURCE, q, docs);
    console.log(`  → 저장: ${out} (${docs.length}건)`);
    await sleep(args.intervalMs);
  }
} else {
  console.error(`알 수 없는 mode: ${args.mode} (me | keyword)`);
  process.exit(1);
}
