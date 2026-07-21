// App Store 앱 목록 수집기 + 평점 개수/장르 조회
// 1) app-store-scraper(list)로 카테고리별 인기 앱의 trackId를 발견(게임 카테고리 제외)
// 2) iTunes lookup API(토큰 불필요, 배치 조회)로 평점 개수(userRatingCount)와
//    장르(genreIds/genres)를 보강 → 안정적이고 빠름(429 거의 없음, null 최소화)
// 3) 주 장르가 게임(6014 또는 7001~7019)인 앱은 최종 제외
// 리뷰 수집은 appstore-amp.js(프록시)에서 별도로 처리한다.

import store from "app-store-scraper";
import { withRetry, sleep, isTransientError } from "../../shared/pacing.js";

const CATEGORY_CAP = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 20_000;
const LIST_RETRIES = 3;
const MIN_GAP_MS = 400;
const LOOKUP_BATCH = 100; // iTunes lookup 한 번에 조회할 id 수
const LOOKUP_GAP_MS = 500; // 배치 간 대기

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const COLLECTIONS = [store.collection.TOP_FREE_IOS, store.collection.TOP_PAID_IOS];

// 게임 장르: 6014(게임) + 7001~7019(게임 하위 장르)
function isGameGenre(id) {
  const n = Number(id);
  return n === 6014 || (n >= 7001 && n <= 7019);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`ETIMEDOUT: ${label}`)), ms)),
  ]);
}

// iTunes lookup 배치 조회: id별 평점수/장르 맵 반환.
async function lookupBatch(ids, config) {
  const { country, pacing } = config;
  const url = `https://itunes.apple.com/lookup?id=${ids.join(",")}&country=${country}`;
  const body = await withRetry(
    async () => {
      const res = await withTimeout(
        fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } }),
        LOOKUP_TIMEOUT_MS,
        "itunes.lookup"
      );
      if (!res.ok) {
        const err = new Error(`lookup ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { ...pacing, maxRetries: Math.max(pacing.maxRetries ?? 5, 4) },
    { isRetryable: isTransientError }
  );
  const map = new Map();
  for (const r of body?.results ?? []) {
    if (r.wrapperType && r.wrapperType !== "software") continue;
    const genreIds = (r.genreIds ?? []).map(Number);
    map.set(String(r.trackId), {
      ratingsCount: Number.isInteger(r.userRatingCount) ? r.userRatingCount : null,
      genreIds,
      developer: r.artistName ?? null,
      title: r.trackName ?? null,
      score: typeof r.averageUserRating === "number" ? r.averageUserRating : null,
    });
  }
  return map;
}

/**
 * App Store 카테고리 순회 앱 목록 수집(게임 제외, iTunes lookup으로 평점/장르 보강).
 * @returns {Promise<Array>} AppListItem[]
 */
export async function listAppStoreApps(config, opts = {}) {
  const log = opts.log ?? (() => {});
  const { country, pacing } = config;
  // 게임 카테고리는 발견 단계에서부터 제외
  const categories = Object.values(store.category).filter(
    (c) => typeof c === "number" && !isGameGenre(c)
  );
  const seen = new Map();
  const failures = [];

  for (const category of categories) {
    for (const collection of COLLECTIONS) {
      try {
        const list = await withRetry(
          () =>
            withTimeout(
              store.list({ collection, category, country, num: CATEGORY_CAP }),
              REQUEST_TIMEOUT_MS,
              "store.list"
            ),
          { ...pacing, maxRetries: LIST_RETRIES }
        );
        for (const a of list ?? []) {
          const existing = seen.get(a.id);
          if (existing) {
            if (!existing.categories.includes(category)) existing.categories.push(category);
          } else {
            seen.set(a.id, {
              trackId: a.id,
              bundleId: a.appId ?? null,
              title: a.title ?? null,
              developer: a.developer ?? null,
              score: a.score ?? null,
              ratingsCount: null,
              categories: [category],
            });
          }
        }
      } catch (e) {
        const msg = String(e?.message ?? e);
        // app-store-scraper는 폐지/미지원 장르에서 undefined.map 오류를 냄 → 정상 건너뛰기
        const unsupported = /reading 'map'/.test(msg);
        failures.push({ category, collection, error: msg, unsupported });
        if (!unsupported) log(`[skip] cat ${category}/${collection}: ${msg}`);
      }
      await sleep(Math.max(MIN_GAP_MS, pacing.intervalMs));
    }
  }

  log(`[as-lister] 목록 ${seen.size}개 발견, iTunes lookup으로 평점/장르 조회 시작`);

  // 배치 lookup으로 평점/장르 보강
  const items = [...seen.values()];
  const allIds = items.map((it) => it.trackId);
  let enriched = 0;
  for (let i = 0; i < allIds.length; i += LOOKUP_BATCH) {
    const batch = allIds.slice(i, i + LOOKUP_BATCH);
    try {
      const map = await lookupBatch(batch, config);
      for (const it of items) {
        const info = map.get(String(it.trackId));
        if (!info) continue;
        it.ratingsCount = info.ratingsCount;
        if (info.developer && !it.developer) it.developer = info.developer;
        if (info.title && !it.title) it.title = info.title;
        if (info.score != null && it.score == null) it.score = info.score;
        if (info.genreIds.length > 0) {
          it.categories = info.genreIds; // 실제 장르 ID로 분류 갱신
          if (isGameGenre(info.genreIds[0])) it._game = true;
        }
        enriched += 1;
      }
    } catch (e) {
      log(`[warn] lookup 배치 실패 (${i}~): ${e?.status ?? e?.message ?? e}`);
    }
    if (i + LOOKUP_BATCH < allIds.length) await sleep(LOOKUP_GAP_MS);
  }

  let gamesDropped = 0;
  const result = items.filter((it) => {
    if (it._game) {
      gamesDropped += 1;
      return false;
    }
    return true;
  });
  for (const it of result) delete it._game;

  log(
    `[as-lister] 완료: ${result.length}개 (보강 ${enriched}, 게임 제외 ${gamesDropped}, 목록 실패 ${failures.length})`
  );
  return result;
}
