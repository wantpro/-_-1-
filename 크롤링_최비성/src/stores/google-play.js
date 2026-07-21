// Google Play 중소형 앱 저평점 리뷰 수집기
// 실행: npm run stores:google-play
//
// 흐름:
// 1) 카테고리 순회로 앱 목록 수집(또는 기존 apps.json 재사용)
// 2) 앱별 상세(minInstalls) 조회 → 중소형(Install_Range)만 선별
// 3) 선별 앱의 리뷰를 유용함 순으로 수집 → 1~3점만 저장
// 4) data/stores/google-play/reviews/<appId>.json 원자적 저장, resumable
//
// GP는 차단에 관대하므로 동시 처리(concurrency)와 짧은 간격으로 빠르게 수집한다.

import gplay from "google-play-scraper";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./lib/config.js";
import { withRetry, sleep } from "../shared/pacing.js";
import { writeJsonAtomic } from "../shared/atomic-store.js";
import { classifyGooglePlaySize } from "./lib/size-filter.js";
import { keepLowRating } from "./lib/rating-filter.js";
import { loadDoneSet, reuseAppsOrCollect } from "./lib/resume.js";
import { listGooglePlayApps } from "./lib/gp-lister.js";

const OUT_DIR = path.resolve("data", "stores", "google-play");
const REVIEW_DIR = path.join(OUT_DIR, "reviews");
const APPS_FILE = path.join(OUT_DIR, "apps.json");
const REVIEWS_PER_APP = 5000;

// GP 전용: App Store보다 공격적으로 가도 됨
const CONCURRENCY = 6; // 동시에 처리할 앱 수
const GP_INTERVAL_MS = 300; // 리뷰 페이지 간 간격
const GP_PACING = { intervalMs: GP_INTERVAL_MS, maxRetries: 4, backoffFactor: 2, backoffMaxMs: 20_000 };

const log = (m) => console.log(m);

async function getDetail(appId, config) {
  return withRetry(
    () => gplay.app({ appId, country: config.country, lang: config.lang }),
    { ...GP_PACING, maxRetries: 3 }
  );
}

async function collectReviews(appId, config) {
  const kept = [];
  let token;
  while (kept.length < REVIEWS_PER_APP) {
    const res = await withRetry(
      () =>
        gplay.reviews({
          appId,
          country: config.country,
          lang: config.lang,
          sort: gplay.sort.HELPFULNESS,
          num: 150,
          paginate: true,
          nextPaginationToken: token,
        }),
      GP_PACING
    );
    const batch = res.data ?? [];
    for (const r of batch) {
      if (!keepLowRating(r.score)) continue; // 1~3점만
      kept.push({
        appId,
        reviewId: r.id,
        userName: r.userName,
        reviewText: r.text,
        rating: r.score,
        helpfulCount: r.thumbsUp,
        reviewDate: r.date,
        replyText: r.replyText ?? null,
        version: r.version ?? null,
      });
    }
    token = res.nextPaginationToken;
    if (!token || batch.length === 0) break;
    await sleep(GP_INTERVAL_MS);
  }
  return kept;
}

// 한 앱을 끝까지 처리: 상세조회 → 중소형 필터 → 리뷰 수집 → 저장
async function processApp(app, config, stats) {
  let detail;
  try {
    detail = await getDetail(app.appId, config);
  } catch (e) {
    log(`[err] 상세 조회 실패 ${app.appId}: ${e?.message ?? e}`);
    return;
  }
  const verdict = classifyGooglePlaySize(detail?.minInstalls, config.installRange);
  if (!verdict.keep) {
    stats.dropped += 1;
    return;
  }
  stats.niche += 1;
  try {
    const reviews = await collectReviews(app.appId, config);
    await writeJsonAtomic(path.join(REVIEW_DIR, `${app.appId}.json`), {
      app: { ...app, minInstalls: detail.minInstalls },
      count: reviews.length,
      reviews,
      done: true,
    });
    stats.reviews += reviews.length;
    log(`[ok] ${app.appId} (installs=${detail.minInstalls}) - 저평점 ${reviews.length}건`);
  } catch (e) {
    log(`[err] 리뷰 수집 실패 ${app.appId}: ${e?.message ?? e}`);
  }
}

// 동시성 풀: 최대 limit개를 병렬로 처리
async function runPool(items, limit, worker) {
  let idx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const config = loadConfig();
  log(`[config] installRange=${config.installRange.low}~${config.installRange.high}, 동시 ${CONCURRENCY}`);

  const { apps, reused } = await reuseAppsOrCollect(APPS_FILE, async () => {
    const list = await listGooglePlayApps(config, { log });
    await writeJsonAtomic(APPS_FILE, list);
    return list;
  });
  log(`[apps] ${apps.length}개 ${reused ? "(재사용)" : "(신규 수집)"}`);

  const done = await loadDoneSet(REVIEW_DIR);
  const pending = apps.filter((a) => !done.has(a.appId));
  log(`[apps] 대기 ${pending.length}개 (완료 ${done.size}개 건너뜀)`);

  const stats = { niche: 0, dropped: 0, reviews: 0, processed: 0 };
  await runPool(pending, CONCURRENCY, async (app) => {
    await processApp(app, config, stats);
    stats.processed += 1;
    if (stats.processed % 100 === 0) {
      log(`[progress] ${stats.processed}/${pending.length} 처리 (중소형 ${stats.niche}, 제외 ${stats.dropped})`);
    }
  });

  log(`\n완료. 중소형 ${stats.niche}개, 제외 ${stats.dropped}개, 누적 저평점 리뷰 ${stats.reviews}건. 출력: ${OUT_DIR}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error("치명적 오류:", e);
    process.exit(1);
  });
}

export { main, processApp };
