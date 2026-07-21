// 블라인드(teamblind.com) 공개글 수집기 — 사이트맵 기반(robots 준수)
//
// 설계 근거:
//   - 회사메일 인증 게이트 "안쪽" 비공개 게시판은 대상이 아니다. 우회하지 않는다.
//   - 온사이트 검색 페이지는 클라이언트 렌더라 헤드리스로 비어서 오고, 신뢰성이 낮다.
//   - 대신 블라인드가 스스로 공개한 sitemap_list.xml(post-*.xml.gz)에서 "개별 공개글 URL"을
//     수집한다. robots.txt는 일반 UA(User-agent: *)에 대해 /user/history 외 크롤을 허용한다.
//   - 글 URL 슬러그에 제목이 들어 있어(.../kr/post/<제목슬러그>-<id>) URL 단계에서 키워드
//     필터링이 가능하다. 매칭된 글만 실제 페이지를 렌더링해 본문을 추출한다(요청 최소화).
//   - 로그인/회사인증 게이트로 막힌 글은 건너뛴다.
//
// 사용:
//   node src/web/blind.js --query="정산,노쇼,중개" --shards=2 --max=40
//   node src/web/blind.js --query="정산" --shards=1 --max=20 --with-body
//   node src/web/blind.js --query="정산" --list-only        # URL만 추려서 출력(렌더 안 함)
//   node src/web/blind.js --query="정산" --headful
//   node src/web/blind.js --topic-url="https://www.teamblind.com/kr/topics/결혼생활"
//        # 공개 채널을 끝까지 스크롤해 전체 글을 발견한 뒤 본문 수집
//
// 결과: data/web/blind/<query-slug>.json  (CommunityDoc 포맷)
//
// 옵션:
//   --query     쉼표구분 키워드(슬러그 매칭). 필수.
//   --shards    전개할 post 샤드 개수(기본 1, 각 샤드 ~40000 URL)
//   --max       키워드당 수집(렌더)할 최대 글 수(기본 30)
//   --with-body 본문까지 렌더링 추출(기본 true). --no-body로 끄려면 --body=0
//   --list-only URL 매칭 결과만 출력하고 종료
//   --headful   브라우저 화면 표시
//   --interval  글 렌더 간 대기 ms(기본 2500)

import { chromium } from "playwright";
import { saveQueryResult, dedupeById } from "./lib/community-doc.js";
import { loadSitemap, fetchSitemapUrls } from "./lib/sitemap.js";
import { sleep } from "../shared/pacing.js";

const SOURCE = "blind";
const SITEMAP_LIST = "https://www.teamblind.com/kr/sitemap_list.xml";

function parseArgs(argv) {
  const a = {
    queries: [], shards: 1, max: 30, withBody: true,
    listOnly: false, headful: false, intervalMs: 2500, topicUrl: null,
  };
  for (const arg of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "query") a.queries = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "shards") a.shards = Math.max(1, parseInt(v ?? "1", 10) || 1);
    else if (k === "max") a.max = (v ?? "") === "0" ? 0 : Math.max(1, parseInt(v ?? "30", 10) || 30);
    else if (k === "with-body") a.withBody = true;
    else if (k === "body") a.withBody = !(v === "0" || v === "false");
    else if (k === "no-body") a.withBody = false;
    else if (k === "list-only") a.listOnly = true;
    else if (k === "headful") a.headful = true;
    else if (k === "interval") a.intervalMs = Math.max(0, parseInt(v ?? "2500", 10) || 2500);
    else if (k === "topic-url") a.topicUrl = (v ?? "").trim() || null;
  }
  // 채널 수집은 기본적으로 목록 끝까지 탐색한다. --max를 준 경우에만 상한을 둔다.
  if (a.topicUrl && !argv.some((arg) => arg.startsWith("--max"))) a.max = 0;
  return a;
}

// 공개 채널의 목록을 끝까지 스크롤해 게시글 URL을 발견한다. 목록 카드가 중복 링크를
// 포함하므로 Set으로 정리하며, 세 번 연속 새 URL이 없을 때 끝에 도달한 것으로 본다.
async function collectTopicUrls(context, topicUrl, args) {
  const page = await context.newPage();
  const urls = new Set();
  let staleScrolls = 0;
  try {
    await page.goto(topicUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await settleSpa(page);
    for (;;) {
      const before = urls.size;
      const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'), (a) => a.href)
          .filter((href) => /\/kr\/post\//.test(href))
      );
      for (const href of found) urls.add(href.split("?")[0]);
      console.log(`  채널 목록: ${urls.size}건 발견${urls.size - before ? ` (+${urls.size - before})` : ""}`);
      if (args.max > 0 && urls.size >= args.max) break;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      // 목록은 스크롤 이벤트 뒤 비동기 API로 채워진다. 고정 1.2초 대기는
      // 응답이 늦을 때 조기 종료를 일으키므로, 충분히 기다린 뒤 다시 수집한다.
      await sleep(4000);
      const after = await page.evaluate(() => ({
        count: document.querySelectorAll('a[href*="/kr/post/"]').length,
        height: document.body.scrollHeight,
      }));
      const foundAfter = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'), (a) => a.href)
          .filter((href) => /\/kr\/post\//.test(href))
      );
      for (const href of foundAfter) urls.add(href.split("?")[0]);
      const added = urls.size - before;
      console.log(`  스크롤 후: ${urls.size}건${added ? ` (+${added})` : ""} (높이 ${after.height}px)`);
      staleScrolls = added === 0 ? staleScrolls + 1 : 0;
      // 네트워크 지연/재시도에 대비해 20회 연속 변화가 없을 때만 종료한다.
      // --max=1000 같은 대규모 시도에서는 일시적으로 빈 응답이 와도 계속한다.
      if (staleScrolls >= 20) break;
    }
  } finally {
    await page.close();
  }
  return Array.from(urls).slice(0, args.max || undefined);
}

async function collectAndSaveUrls(context, label, urls, args) {
  console.log(`\n[blind] "${label}" 공개 글 ${urls.length}건 렌더링`);
  const docs = [];
  let gated = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`  ${i + 1}/${urls.length}`);
    const r = args.withBody
      ? await renderPost(context, url, args.intervalMs)
      : { gated: false, title: titleFromUrl(url), text: "", board: null };
    if (r.gated) { gated++; continue; }
    docs.push({
      id: url,
      board: r.board ?? "블라인드(공개)",
      title: r.title ?? "",
      text: r.text ?? "",
      url,
      author: null,
      date: null,
      viewCount: r.viewCount ?? null,
      commentCount: r.commentCount ?? null,
    });
  }
  if (gated) console.log(`  게이트(비공개)로 스킵: ${gated}건`);
  const deduped = dedupeById(docs);
  if (deduped.length === 0) { console.log("  → 저장 생략(0건)"); return; }
  const out = await saveQueryResult(SOURCE, label, deduped);
  console.log(`  → 저장: ${out} (${deduped.length}건)`);
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

async function settleSpa(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch { /* 계속 진행 */ }
  await sleep(800);
}

// 개별 공개글 페이지의 메인 텍스트를 추출(브라우저 컨텍스트 내 실행).
// 클래스가 해시되어 있어 CSS 셀렉터는 불안정하므로, 가장 큰 텍스트 블록(main/article/body)을
// 통째로 가져오고 정제는 호출부에서 휴리스틱으로 수행한다. 게이트면 {gated:true}.
function extractPost() {
  const bodyText = document.body?.innerText ?? "";
  const gateHints = ["회사 이메일", "회사메일", "로그인하고", "가입하고", "로그인이 필요"];
  const looksEmpty = bodyText.replace(/\s+/g, "").length < 60;
  if (looksEmpty && gateHints.some((h) => bodyText.includes(h))) return { gated: true };

  let raw = "";
  for (const sel of ["main", "article", "body"]) {
    const t = document.querySelector(sel)?.innerText?.trim() ?? "";
    if (t.length > raw.length) raw = t;
  }
  // 채널/게시판 라벨: "채널 <이름> · 팔로우" 패턴
  const chMatch = raw.match(/채널\s+(.+?)\s*·\s*팔로우/);
  const board = chMatch ? chMatch[1].trim() : null;
  return { gated: false, raw, board };
}

// URL 슬러그에서 제목 도출: .../kr/post/<제목-슬러그>-<id> → "제목 슬러그"
function titleFromUrl(url) {
  try {
    const last = decodeURIComponent(url.split("/").pop() || "");
    return last.replace(/-[a-z0-9]{6,}$/i, "").replace(/-/g, " ").trim();
  } catch {
    return "";
  }
}

// 메인 텍스트에서 본문+댓글만 남기고 내비/추천글 보일러플레이트를 제거.
function cleanBody(raw, title) {
  if (!raw) return "";
  let s = raw;
  // 1) 제목 이후부터 시작(앞쪽 글로벌 내비 제거)
  if (title) {
    const idx = s.indexOf(title);
    if (idx >= 0) s = s.slice(idx + title.length);
  }
  // 2) 추천글/토픽베스트 등 보일러플레이트 직전에서 컷
  const cutMarkers = [/\n[^\n]{0,20}추천 글\n/, /\n토픽 베스트\n/, /\n님이 좋아할/];
  let cut = s.length;
  for (const re of cutMarkers) {
    const m = re.exec(s);
    if (m && m.index < cut) cut = m.index;
  }
  s = s.slice(0, cut);
  // 3) 광고/공유 위젯 라인 제거
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(좋아요|카카오톡|페이스북|트위터|링크복사|퍼가기|북마크|메뉴 더보기|AD|Coupang|공식 APPLE|매일 아침 7시|더 낸 세금)/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 메인 텍스트에서 조회수/댓글수 추출
function parseCounts(raw) {
  const view = /조회수\s*\n?\s*([\d,]+)/.exec(raw);
  const cmt = /댓글\s*\n?\s*([\d,]+)/.exec(raw);
  const toInt = (m) => (m ? parseInt(m[1].replace(/,/g, ""), 10) : null);
  return { viewCount: toInt(view), commentCount: toInt(cmt) };
}

async function renderPost(context, url, intervalMs) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await settleSpa(page);
    const r = await page.evaluate(extractPost);
    await sleep(intervalMs);
    if (r.gated) return r;
    const title = titleFromUrl(url);
    const { viewCount, commentCount } = parseCounts(r.raw);
    return {
      gated: false,
      title,
      text: cleanBody(r.raw, title),
      board: r.board,
      viewCount,
      commentCount,
    };
  } catch (e) {
    console.warn(`    렌더 실패(${url}): ${e.message}`);
    return { gated: false, title: titleFromUrl(url), text: "", board: null, error: true };
  } finally {
    await page.close();
  }
}

// ---- main -------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (args.queries.length === 0 && !args.topicUrl) {
  console.error('검색어 또는 --topic-url 이 필요합니다. 예: --query="정산,노쇼" 또는 --topic-url="https://www.teamblind.com/kr/topics/결혼생활"');
  process.exit(1);
}

const { browser, context } = await makeContext(args.headful);
try {
  if (args.topicUrl) {
    console.log(`[blind] 공개 채널 목록 수집 중: ${args.topicUrl}`);
    const urls = await collectTopicUrls(context, args.topicUrl, args);
    if (args.listOnly) {
      for (const url of urls) console.log(decodeURIComponent(url));
    } else {
      await collectAndSaveUrls(context, "결혼생활", urls, args);
    }
    process.exit(0);
  }

  console.log(`[blind] 사이트맵에서 공개글 URL 수집 중 (키워드: ${args.queries.join(", ")}, 샤드 한도 ${args.shards})`);
  const matched = await collectMatchedUrls(args);
  for (const [q, urls] of matched) console.log(`  "${q}": ${urls.length}건 매칭`);
  if (args.listOnly) {
    for (const [q, urls] of matched) {
      console.log(`\n=== ${q} ===`);
      for (const u of urls) console.log(decodeURIComponent(u));
    }
    process.exit(0);
  }
  for (const [q, urls] of matched) {
    if (urls.length === 0) { console.log(`\n[${q}] 매칭 0건 → 스킵`); continue; }
    await collectAndSaveUrls(context, q, urls, args);
  }
} finally {
  await browser.close();
}

// post 샤드를 순회하며 키워드별로 max건 채우고 조기 종료.
async function collectMatchedUrls(args) {
  const lower = args.queries.map((q) => q.toLowerCase());
  const matched = new Map(lower.map((q) => [q, []]));
  const isFull = () => lower.every((q) => matched.get(q).length >= args.max);

  // sitemap_list.xml은 인덱스 → 하위 샤드 loc 목록을 직접 받아 post 샤드만 처리
  const index = await loadSitemap(SITEMAP_LIST);
  const postShards = index.locs.filter((u) => /\/post-\d+/.test(u));
  const shards = postShards.slice(0, args.shards);

  for (let i = 0; i < shards.length && !isFull(); i++) {
    process.stdout.write(`  post 샤드 ${i + 1}/${shards.length} 처리…\r`);
    let urls;
    try { urls = await fetchSitemapUrls(shards[i]); }
    catch (e) { console.warn(`\n  샤드 실패: ${e.message}`); continue; }
    for (const url of urls) {
      let decoded;
      try { decoded = decodeURIComponent(url).toLowerCase(); } catch { decoded = url.toLowerCase(); }
      for (const q of lower) {
        const bucket = matched.get(q);
        if (bucket.length < args.max && decoded.includes(q)) bucket.push(url);
      }
      if (isFull()) break;
    }
    await sleep(400);
  }
  console.log("");
  return matched;
}
