// Google Play 앱 목록 수집기
// 54개 카테고리 × {TOP_FREE, TOP_PAID, GROSSING} 컬렉션을 순회하며 앱을 모은다.
// 중복 appId는 1회만 포함하되 발견된 카테고리/컬렉션을 누적한다.

import gplay from "google-play-scraper";
import { withRetry, sleep } from "../../shared/pacing.js";

const COLLECTION_CAP = 100; // 컬렉션당 최대 수집 개수
const REQUEST_TIMEOUT_MS = 30_000;
const LIST_RETRIES = 3;

const COLLECTIONS = [
  gplay.collection.TOP_FREE,
  gplay.collection.TOP_PAID,
  gplay.collection.GROSSING,
];

// 타임아웃을 건 list 호출
function listWithTimeout(params) {
  return Promise.race([
    gplay.list(params),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("ETIMEDOUT: gplay.list")), REQUEST_TIMEOUT_MS)
    ),
  ]);
}

/**
 * 카테고리/컬렉션을 순회하여 앱 목록을 수집한다.
 * @param {object} config loadConfig 결과
 * @param {{ log?: (msg:string)=>void }} [opts]
 * @returns {Promise<Array>} AppListItem[]
 */
export async function listGooglePlayApps(config, opts = {}) {
  const log = opts.log ?? (() => {});
  const { country, lang, pacing } = config;
  // GAME 및 게임 하위 카테고리는 제외(사용자 요청: 게임 미수집)
  const categories = Object.values(gplay.category).filter(
    (c) => !/^GAME/.test(String(c))
  );
  const seen = new Map(); // appId -> item
  const failures = [];

  for (const category of categories) {
    for (const collection of COLLECTIONS) {
      try {
        const list = await withRetry(
          () =>
            listWithTimeout({
              collection,
              category,
              country,
              lang,
              num: COLLECTION_CAP,
            }),
          { ...pacing, maxRetries: LIST_RETRIES }
        );
        for (const a of list ?? []) {
          const existing = seen.get(a.appId);
          if (existing) {
            if (!existing.categories.includes(category)) existing.categories.push(category);
            if (!existing.collections.includes(collection)) existing.collections.push(collection);
          } else {
            seen.set(a.appId, {
              appId: a.appId,
              title: a.title ?? null,
              developer: a.developer ?? null,
              score: a.score ?? null,
              categories: [category],
              collections: [collection],
            });
          }
        }
      } catch (e) {
        failures.push({ category, collection, error: String(e?.message ?? e) });
        log(`[skip] ${category}/${collection}: ${e?.message ?? e}`);
      }
      await sleep(pacing.intervalMs);
    }
  }

  log(`[gp-lister] 수집 ${seen.size}개 (실패 ${failures.length}건)`);
  return [...seen.values()];
}
