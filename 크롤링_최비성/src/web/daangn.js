// 당근 동네생활 공개 수집기 — 사이트맵 기반(robots 준수)
//
// 설계 근거 & 한계(중요):
//   - 전화/위치 인증 게이트 "안쪽" 앱 전용 기능은 대상이 아니다. 우회하지 않는다.
//   - 임의 키워드 검색 경로(/kr/community/s/*)는 robots.txt에서 Disallow. 사용하지 않는다.
//   - 유일하게 robots가 허용하는 공개 루트는 사이트맵에 등재된
//     "지역 × 인기키워드" 랜딩 페이지(/kr/community/?in=<지역>&search=<키워드>)다.
//   - 따라서 수집 가능한 키워드는 당근이 정한 "인기 키워드"(약 74종: 맛집/집/헬스/고양이/
//     인테리어 등 일반어)로 제한된다. "정산/노쇼/사기" 같은 임의 페인 키워드는 불가하다.
//     (--list-keywords 로 사용 가능한 키워드 목록 확인)
//   - 랜딩 페이지에는 동네생활 글이 인라인으로 렌더된다. 개별 글 링크는 /s/(금지)뿐이라
//     따라가지 않고, 랜딩에 보이는 글 본문/스니펫만 추출한다.
//
// 사용:
//   node src/web/daangn.js --list-keywords
//   node src/web/daangn.js --query="맛집" --regions=5
//   node src/web/daangn.js --query="집,인테리어" --regions=3 --headful
//
// 결과: data/web/daangn/<query-slug>.json  (CommunityDoc 포맷)

import { chromium } from "playwright";
import { saveQueryResult, dedupeById } from "./lib/community-doc.js";
import { fetchSitemapUrls } from "./lib/sitemap.js";
import { sleep } from "../shared/pacing.js";

const SOURCE = "daangn";
const COMMUNITY_SITEMAP =
  "https://www.daangn.com/sitemap/kr/community/sitemap-popular-keywords.xml.gz";

function parseArgs(argv) {
  const a = { queries: [], regions: 3, listKeywords: false, all: false, headful: false, intervalMs: 3000 };
  for (const arg of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "query") a.queries = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "regions") a.regions = Math.max(1, parseInt(v ?? "3", 10) || 3);
    else if (k === "list-keywords") a.listKeywords = true;
    else if (k === "all") a.all = true;
    else if (k === "headful") a.headful = true;
    else if (k === "interval") a.intervalMs = Math.max(0, parseInt(v ?? "3000", 10) || 3000);
  }
  return a;
}

// 사이트맵을 읽어 키워드→랜딩URL[] 맵 구성(중복 q= 변형은 제외).
async function loadKeywordMap() {
  const urls = await fetchSitemapUrls(COMMUNITY_SITEMAP);
  const byKeyword = new Map();
  for (const u of urls) {
    let d;
    try { d = decodeURIComponent(u); } catch { d = u; }
    if (/[?&]q=/.test(d)) continue; // search=, q= 중복 변형 제외(목록형만)
    const km = /[?&]search=([^&]+)/.exec(d);
    if (!km) continue;
    const kw = km[1];
    if (!byKeyword.has(kw)) byKeyword.set(kw, []);
    const list = byKeyword.get(kw);
    if (!list.includes(u)) list.push(u); // URL 중복 제거(지역 다양성 확보)
  }
  return byKeyword;
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
    if (!headful) {
      console.warn("headless 실행 실패 → headful로 폴백합니다. (`npx playwright install chromium` 필요할 수 있음)");
      browser = await chromium.launch({ headless: false });
    } else {
      throw e;
    }
  }
  const context = await browser.newContext(uaOpts);
  return { browser, context };
}

// 랜딩 페이지에서 본문 영역 텍스트 + 지역(제목)을 가져온다.
function extractLanding() {
  const title = document.title; // "인천광역시 ... 송도동 이야기 | 당근 동네생활"
  const region = (title.split("|")[0] || "").replace(/이야기\s*$/, "").trim();
  const body = document.body?.innerText ?? "";
  return { region, body };
}

// 랜딩 innerText에서 개별 글 블록을 파싱.
// 각 글은 "...\n좋아요 수\n<N>\n댓글 수\n<M>" 트레일러로 끝난다.
function parsePosts(body, region) {
  // 글 목록 시작점: "관련 소식" 이후 + 필터 칩 목록(…임신/육아, 일반) 다음부터
  let s = body;
  const startMarker = s.indexOf("관련 소식");
  if (startMarker >= 0) s = s.slice(startMarker);
  const chipEnd = s.indexOf("\n일반\n");
  if (chipEnd >= 0) s = s.slice(chipEnd + "\n일반\n".length);
  const trailer = /좋아요 수\s*\n\s*([\d,]+)\s*\n\s*댓글 수\s*\n\s*([\d,]+)/g;
  const posts = [];
  let last = 0;
  let m;
  while ((m = trailer.exec(s)) !== null) {
    const block = s.slice(last, m.index);
    last = trailer.lastIndex;
    const likes = parseInt(m[1].replace(/,/g, ""), 10);
    const comments = parseInt(m[2].replace(/,/g, ""), 10);
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    // 뒤에서부터: date, "·", category, "·", region 패턴 분리
    // 형태: [title, snippet..., region, "·", category, "·", date]
    let date = null, category = null;
    const dots = [];
    for (let i = lines.length - 1; i >= 0 && dots.length < 2; i--) {
      if (lines[i] === "·") dots.push(i);
    }
    let titleEnd = lines.length;
    if (dots.length === 2) {
      date = lines[dots[0] + 1] ?? null;       // 마지막 · 다음 = 날짜
      category = lines[dots[1] + 1] ?? null;    // 첫 · 다음 = 카테고리
      titleEnd = dots[1] - 1;                    // region 라인 직전까지가 제목+스니펫
    }
    const title = lines[0] ?? "";
    const snippet = lines.slice(1, Math.max(1, titleEnd)).join(" ").trim();
    if (!title) continue;
    posts.push({ title, snippet, category, date, region, likes, comments });
  }
  return posts;
}

async function renderLanding(context, url, intervalMs) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch { /* 계속 */ }
    await page.evaluate(() => window.scrollBy(0, 4000));
    await sleep(1200);
    const { region, body } = await page.evaluate(extractLanding);
    await sleep(intervalMs);
    return parsePosts(body, region);
  } catch (e) {
    console.warn(`    랜딩 렌더 실패(${url}): ${e.message}`);
    return [];
  } finally {
    await page.close();
  }
}

// ---- main -------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));

console.log("[daangn] 사이트맵에서 인기 키워드 로딩…");
const kwMap = await loadKeywordMap();

if (args.listKeywords) {
  const list = [...kwMap.entries()]
    .map(([k, v]) => `${k} (${v.length}개 지역)`)
    .sort();
  console.log(`사용 가능한 인기 키워드 ${kwMap.size}종:\n` + list.join("\n"));
  process.exit(0);
}

if (args.queries.length === 0) {
  if (args.all) {
    args.queries = [...kwMap.keys()];
    console.log(`[daangn] --all: 인기 키워드 ${args.queries.length}종 전체 수집`);
  } else {
    console.error('검색어가 필요합니다. 사용 가능 키워드는 --list-keywords 로 확인. 예: --query="맛집" 또는 --all');
    process.exit(1);
  }
}

const { browser, context } = await makeContext(args.headful);
try {
  for (const q of args.queries) {
    const landings = kwMap.get(q);
    if (!landings || landings.length === 0) {
      console.log(`\n[${q}] 당근 인기 키워드에 없음 → 스킵 (--list-keywords 로 확인 가능)`);
      continue;
    }
    const targets = landings.slice(0, args.regions);
    console.log(`\n[daangn] "${q}" 랜딩 ${targets.length}개 지역 수집`);
    const all = [];
    for (const url of targets) {
      const posts = await renderLanding(context, url, args.intervalMs);
      console.log(`  ${decodeURIComponent(url).replace(/^https:\/\/www\.daangn\.com/, "")}: ${posts.length}건`);
      for (const p of posts) {
        all.push({
          id: `${url}#${p.title}_${p.region}`,
          board: `당근 동네생활 · ${p.region}${p.category ? " · " + p.category : ""}`,
          title: p.title,
          text: p.snippet,
          url,
          author: null,
          date: null,
          commentCount: Number.isInteger(p.comments) ? p.comments : null,
          viewCount: null,
        });
      }
    }
    const deduped = dedupeById(all);
    if (deduped.length === 0) { console.log("  → 저장 생략(0건)"); continue; }
    const out = await saveQueryResult(SOURCE, q, deduped);
    console.log(`  → 저장: ${out} (${deduped.length}건)`);
  }
} finally {
  await browser.close();
}
