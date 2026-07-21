// App Store 중소형 앱 저평점 리뷰 수집기
// 실행: npm run stores:app-store
//
// 흐름:
// 1) 카테고리 순회로 앱 목록 + 평점 개수 수집(또는 기존 apps.json 재사용)
// 2) 평점 개수(Ratings_Floor~Cap)로 중소형만 선별
// 3) 리뷰 수집(helpfulRank 부여) → 1~3점만 저장
// 4) data/stores/app-store/reviews/<trackId>.json 원자적 저장, resumable
//
// 리뷰 수집 경로:
// - 기본: 공개 RSS(itunes.apple.com customerreviews). 토큰 불필요, 다른 호스트라 지속 부하에 강함.
//   앱당 최대 ~500건이지만 중소형 앱은 그 이하라 사실상 전량.
// - 선택: PM_AS_USE_PROXY=1 이면 same-origin 프록시(apps.apple.com/api, 전량 수집 가능하나
//   지속 부하 시 IP 레이트리밋에 걸리기 쉬움).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./lib/config.js";
import { sleep } from "../shared/pacing.js";
import { writeJsonAtomic } from "../shared/atomic-store.js";
import { classifyAppStoreSize } from "./lib/size-filter.js";
import { keepLowRating } from "./lib/rating-filter.js";
import { loadDoneSet, reuseAppsOrCollect } from "./lib/resume.js";
import { listAppStoreApps } from "./lib/as-lister.js";
import { createAmpClient } from "./lib/appstore-amp.js";
import { createRssClient } from "./lib/appstore-rss.js";

const OUT_DIR = path.resolve("data", "stores", "app-store");
const REVIEW_DIR = path.join(OUT_DIR, "reviews");
const APPS_FILE = path.join(OUT_DIR, "apps.json");
// 수집 가능한 만큼 모두 저장. RSS 경로는 페이지 한계상 앱당 최대 ~500건,
// amp-api(토큰) 경로는 사실상 전량. 저평점만 남기는 필터는 이후 단계에서 수행.
const REVIEWS_PER_APP = Infinity;
const REVIEW_CONCURRENCY = 2; // 동시에 수집할 앱 수(과하면 429 위험)

const log = (m) => console.log(m);

// amp-api 원시 리뷰를 저장 스키마로 정규화하고 저평점만 유지
function normalizeAndFilter(trackId, items) {
  const out = [];
  for (const { raw, helpfulRank } of items) {
    const attr = raw?.attributes ?? {};
    const rating = Number(attr.rating);
    if (!keepLowRating(rating)) continue; // 1~3점만
    out.push({
      trackId,
      reviewId: raw.id ?? null,
      userName: attr.userName ?? null,
      title: attr.title ?? null,
      reviewText: attr.review ?? null,
      rating,
      helpfulRank,
      // RSS는 실제 공감 수(voteCount)를 제공한다. 프록시(amp-api)는 없음 → null.
      helpfulCount: Number.isFinite(attr.voteCount) ? attr.voteCount : null,
      version: attr.versionNumberOriginalReviewWasWrittenFor ?? null,
      reviewDate: attr.date ?? null,
    });
  }
  return out;
}

async function main() {
  const config = loadConfig();
  // 무인(overnight) 실행: 429 회피를 위해 리뷰 간격 4초 + 재시도 끈질기게.
  const AS_REVIEW_INTERVAL_MS = 4_000;
  const LIST_INTERVAL_MS = 800;
  const listConfig = {
    ...config,
    pacing: { ...config.pacing, intervalMs: LIST_INTERVAL_MS },
  };
  const reviewConfig = {
    ...config,
    pacing: {
      ...config.pacing,
      intervalMs: Math.max(config.pacing.intervalMs, AS_REVIEW_INTERVAL_MS),
      maxRetries: Math.max(config.pacing.maxRetries, 7),
      backoffMaxMs: 90_000,
    },
  };
  log(`[config] ratings floor~cap=${config.ratings.floor}~${config.ratings.cap}, 목록 ${LIST_INTERVAL_MS}ms / 리뷰 ${reviewConfig.pacing.intervalMs}ms`);

  const { apps, reused } = await reuseAppsOrCollect(APPS_FILE, async () => {
    const list = await listAppStoreApps(listConfig, { log });
    if (list.length === 0) {
      throw new Error("App Store 앱 목록 수집 0개 - 중단(파일 미생성)");
    }
    await writeJsonAtomic(APPS_FILE, list);
    return list;
  });
  log(`[apps] ${apps.length}개 ${reused ? "(재사용)" : "(신규 수집)"}`);

  // 기본: 공개 RSS(itunes.apple.com, 토큰 불필요, 앱당 ~500건). 다른 호스트라 지속 부하에 강함.
  //   중소형 앱은 텍스트 리뷰가 500건을 넘는 경우가 드물어 사실상 전량 수집된다.
  // 선택: PM_AS_USE_PROXY=1 이면 same-origin 프록시(전량 수집 가능하나, 지속 부하 시
  //   apps.apple.com 쪽 IP 레이트리밋(429 연장 차단)에 걸리기 쉬움 → 소량/수동용).
  const useProxy = process.env.PM_AS_USE_PROXY === "1";
  const RSS_INTERVAL_MS = 700;
  let client;
  let appIntervalMs;
  if (useProxy) {
    client = createAmpClient(reviewConfig);
    appIntervalMs = reviewConfig.pacing.intervalMs;
  } else {
    const rssConfig = {
      ...config,
      pacing: {
        ...config.pacing,
        intervalMs: RSS_INTERVAL_MS,
        maxRetries: Math.max(config.pacing.maxRetries, 5),
        backoffMaxMs: 30_000,
      },
    };
    client = createRssClient(rssConfig);
    appIntervalMs = RSS_INTERVAL_MS;
  }
  log(`[client] 리뷰 수집 경로: ${useProxy ? "same-origin 프록시(전량)" : "RSS(앱당 ~500건)"}, 앱 간 ${appIntervalMs}ms`);
  const done = await loadDoneSet(REVIEW_DIR);

  // 미완료 + 중소형 통과 앱만 추려서 동시 풀로 수집
  const pending = apps.filter(
    (a) => !done.has(String(a.trackId)) && classifyAppStoreSize(a.ratingsCount, config.ratings).keep
  );
  log(`[apps] 중소형 대기 ${pending.length}개 (완료 ${done.size}개 건너뜀), 동시 ${REVIEW_CONCURRENCY}`);

  let totalReviews = 0;
  let processed = 0;
  let consecutiveErr = 0;

  async function worker(app) {
    const key = String(app.trackId);
    try {
      const items = await client.getAllReviews(app.trackId, { maxReviews: REVIEWS_PER_APP });
      const reviews = normalizeAndFilter(app.trackId, items);
      await writeJsonAtomic(path.join(REVIEW_DIR, `${key}.json`), {
        app,
        count: reviews.length,
        reviews,
        done: true,
      });
      totalReviews += reviews.length;
      consecutiveErr = 0;
      processed += 1;
      log(`[ok ${processed}/${pending.length}] ${app.title ?? key} (ratings=${app.ratingsCount}) - 저평점 ${reviews.length}건`);
    } catch (e) {
      consecutiveErr += 1;
      processed += 1;
      log(`[err ${processed}/${pending.length}] 리뷰 수집 실패 ${key}: ${e?.message ?? e}`);
      if (consecutiveErr >= 6) {
        const cooldown = 5 * 60_000;
        log(`[cooldown] 연속 실패 ${consecutiveErr}회 → ${cooldown / 60000}분 대기 후 재개`);
        await sleep(cooldown);
        consecutiveErr = 0;
      }
    }
    await sleep(appIntervalMs);
  }

  // 동시성 풀
  let idx = 0;
  const runners = Array.from({ length: REVIEW_CONCURRENCY }, async () => {
    while (idx < pending.length) {
      const i = idx++;
      await worker(pending[i]);
    }
  });
  await Promise.all(runners);

  const niche = pending.length;

  if (niche === 0) {
    log("[done] 중소형 통과 앱이 0개입니다. 임계값을 조정해 보세요.");
  }
  log(`\n완료. 중소형 ${niche}개, 누적 저평점 리뷰 ${totalReviews}건. 출력: ${OUT_DIR}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error("치명적 오류:", e);
    process.exit(1);
  });
}

export { main, normalizeAndFilter };
