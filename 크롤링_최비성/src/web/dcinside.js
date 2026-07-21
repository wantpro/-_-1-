// 디시인사이드 통합검색 수집기 (Playwright)
//
// 통합검색(search.dcinside.com)은 JS 렌더링/일부 로그인 게이트가 있어 정적 fetch로는
// 비어 있다. 실제 브라우저(Playwright)로 렌더링한 뒤 결과 목록을 추출한다.
//
// 사용:
//   node src/web/dcinside.js --query="캐시노트" --pages=3
//   node src/web/dcinside.js --query="학원 정산,예약 노쇼,공동중개" --pages=2 --with-body
//   node src/web/dcinside.js --query="캐시노트" --probe          # DOM 구조 진단(개발용)
//   node src/web/dcinside.js --query="캐시노트" --headful        # 브라우저 화면 표시
//
// 결과: data/web/dcinside/<query-slug>.json  (CommunityDoc 포맷)
//
// 주의: 공개 게시물 대상이라도 ToS 회색지대이며, 과도한 요청은 IP 차단을 부른다.
// 기본 페이싱(요청 간 2.5s)을 보수적으로 유지한다.

import { chromium } from "playwright";
import { saveQueryResult, dedupeById } from "./lib/community-doc.js";
import { sleep } from "../shared/pacing.js";

const SOURCE = "dcinside";
const SEARCH_BASE = "https://search.dcinside.com/post";

function parseArgs(argv) {
  const a = { queries: [], pages: 3, withBody: false, probe: false, headful: false, intervalMs: 2500 };
  for (const arg of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "query") a.queries = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "pages") a.pages = Math.max(1, parseInt(v ?? "3", 10) || 3);
    else if (k === "with-body") a.withBody = true;
    else if (k === "probe") a.probe = true;
    else if (k === "headful") a.headful = true;
    else if (k === "interval") a.intervalMs = Math.max(0, parseInt(v ?? "2500", 10) || 2500);
  }
  return a;
}

function searchUrl(query, page) {
  // /post/p/{page}/sort/latest/q/{encoded}
  return `${SEARCH_BASE}/p/${page}/sort/latest/q/${encodeURIComponent(query)}`;
}

async function makeContext(headful) {
  const uaOpts = {
    locale: "ko-KR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: !headful });
  } catch (e) {
    // headless 셸 미설치 등으로 실패하면 설치된 full chromium(headful)로 폴백
    if (!headful) {
      console.warn("headless 실행 실패 → headful로 폴백합니다. (headless 사용하려면 `npx playwright install chromium` 완료 필요)");
      browser = await chromium.launch({ headless: false });
    } else {
      throw e;
    }
  }
  const context = await browser.newContext(uaOpts);
  return { browser, context };
}

// 검색 결과 한 페이지에서 글 목록 추출(브라우저 컨텍스트 내에서 실행)
function extractResults() {
  // 여러 후보 셀렉터를 시도해 가장 많이 잡히는 구조를 사용(레이아웃 변경 대비).
  const candidates = [
    "ul.sch_result_list > li",
    ".sch_result li",
    "li.sch_pop",
  ];
  let items = [];
  for (const sel of candidates) {
    const els = Array.from(document.querySelectorAll(sel));
    if (els.length > items.length) items = els;
  }
  const pick = (el, sels) => {
    for (const s of sels) {
      const n = el.querySelector(s);
      if (n) return n;
    }
    return null;
  };
  return items.map((li) => {
    const titleEl = pick(li, ["a.tit_txt", ".tit_txt", "a"]);
    // 본문 스니펫: dsc_sub(갤러리/날짜 줄)가 아닌 link_dsc_txt
    const snipEl = pick(li, ["p.link_dsc_txt:not(.dsc_sub)", ".dsc_txt"]);
    const galleryEl = pick(li, ["a.sub_txt", ".sub_name", "span.sub_txt"]);
    const dateEl = pick(li, ["span.date_time", ".date_time"]);
    const url = titleEl?.getAttribute("href") ?? null;
    return {
      title: titleEl?.textContent?.trim() ?? "",
      text: snipEl?.textContent?.trim() ?? "",
      board: galleryEl?.textContent?.trim() ?? null,
      dateRaw: dateEl?.textContent?.trim() ?? null,
      url: url && url.startsWith("http") ? url : url ? `https:${url}` : null,
    };
  });
}

async function probe(page, query) {
  await page.goto(searchUrl(query, 1), { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2000);
  const info = await page.evaluate(() => {
    const sels = ["ul.sch_result_list > li", ".sch_result li", "li.sch_pop", ".sch_result_list", ".integrate_sch"];
    const counts = {};
    for (const s of sels) counts[s] = document.querySelectorAll(s).length;
    const bodyLen = document.body?.innerText?.length ?? 0;
    const firstLi = document.querySelector("ul.sch_result_list > li, .sch_result li");
    return { counts, bodyLen, firstLiHtml: firstLi ? firstLi.outerHTML.slice(0, 1500) : null, title: document.title };
  });
  console.log("=== PROBE ===");
  console.log("page title:", info.title);
  console.log("body innerText length:", info.bodyLen);
  console.log("selector counts:", JSON.stringify(info.counts, null, 2));
  console.log("first item HTML:\n", info.firstLiHtml ?? "(없음)");
}

// "2026.06.27 00:57" → ISO 문자열(파싱 실패 시 원본 유지)
function parseDcDate(raw) {
  if (!raw) return null;
  const m = /(\d{4})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2}))?/.exec(raw);
  if (!m) return raw;
  const [, y, mo, d, h = "00", mi = "00"] = m;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00+09:00`);
  return Number.isNaN(dt.getTime()) ? raw : dt.toISOString();
}

async function collectQuery(context, query, args) {
  const page = await context.newPage();
  const all = [];
  try {
    for (let p = 1; p <= args.pages; p++) {
      await page.goto(searchUrl(query, p), { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(1500);
      const results = await page.evaluate(extractResults);
      if (results.length === 0) {
        console.log(`  [${query}] p${p}: 결과 0건 (마지막 페이지이거나 차단/구조변경)`);
        break;
      }
      for (const r of results) {
        all.push({
          id: r.url ?? `${query}_${p}_${all.length}`,
          board: r.board ?? "디시(통합검색)",
          title: r.title,
          text: r.text,
          url: r.url,
          author: null,
          date: parseDcDate(r.dateRaw),
        });
      }
      console.log(`  [${query}] p${p}: ${results.length}건 수집 (누적 ${all.length})`);
      await sleep(args.intervalMs);
    }
  } finally {
    await page.close();
  }
  return dedupeById(all);
}

// ---- main -------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (args.queries.length === 0) {
  console.error('검색어가 필요합니다. 예: node src/web/dcinside.js --query="캐시노트,학원 정산"');
  process.exit(1);
}

const { browser, context } = await makeContext(args.headful);
try {
  if (args.probe) {
    await probe(await context.newPage(), args.queries[0]);
  } else {
    for (const q of args.queries) {
      console.log(`\n검색어: ${q}`);
      const docs = await collectQuery(context, q, args);
      if (docs.length === 0) {
        console.log(`  → 저장 생략(0건)`);
        continue;
      }
      const out = await saveQueryResult(SOURCE, q, docs);
      console.log(`  → 저장: ${out} (${docs.length}건)`);
      await sleep(args.intervalMs);
    }
  }
} finally {
  await browser.close();
}
