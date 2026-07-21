// App Store 리뷰 RSS 클라이언트 (토큰 불필요)
// itunes.apple.com 공개 customer reviews RSS를 사용한다.
//   https://itunes.apple.com/{country}/rss/customerreviews/page={n}/id={trackId}/sortby={sort}/json
// amp-api(JWT 추출/주입)가 깨지는 경우의 1차 경로. 토큰이 필요 없어 가장 안정적이다.
//
// 제약: 페이지는 1~10 (페이지당 50건), 즉 앱당 최대 약 500건.
// sortby=mosthelpful 정렬을 사용하므로 수집 순서에 helpfulRank(1부터)를 부여하면 공감 순위와 일치한다.
//
// createAmpClient와 동일한 인터페이스(getAllReviews)를 제공하고, amp-api 원시 형태와
// 호환되는 { raw, helpfulRank } 항목을 반환해 기존 정규화 로직을 그대로 쓸 수 있게 한다.

import { withRetry, sleep, isTransientError } from "../../shared/pacing.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAX_PAGE = 10; // RSS는 1~10페이지까지만 제공
const PER_PAGE = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

const lbl = (x) => (x && typeof x.label === "string" ? x.label : null);

// RSS entry → amp-api raw 호환 형태로 변환. 리뷰가 아닌 엔트리(앱 메타 등)는 null 반환.
function toRaw(entry) {
  const ratingLabel = lbl(entry?.["im:rating"]);
  if (ratingLabel == null) return null; // 평점 없는 엔트리(앱 메타)는 리뷰 아님
  const rating = Number(ratingLabel);
  if (!Number.isInteger(rating)) return null;
  return {
    id: lbl(entry?.id),
    attributes: {
      rating,
      userName: lbl(entry?.author?.name),
      title: lbl(entry?.title),
      review: lbl(entry?.content),
      versionNumberOriginalReviewWasWrittenFor: lbl(entry?.["im:version"]),
      date: lbl(entry?.updated),
      // RSS 고유 정보(공감수)도 보존
      voteCount: Number(lbl(entry?.["im:voteCount"])) || 0,
      voteSum: Number(lbl(entry?.["im:voteSum"])) || 0,
    },
  };
}

/**
 * RSS 기반 App Store 리뷰 클라이언트 생성.
 * createAmpClient와 동일한 인터페이스를 제공한다.
 * @param {object} config loadConfig 결과 (country, pacing 사용)
 * @param {{ fetchImpl?: typeof fetch }} [deps] 테스트용 fetch 주입
 */
export function createRssClient(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const { country, pacing } = config;
  const sort = config.asRssSort || "mosthelpful";

  async function requestPage(trackId, page) {
    const url =
      `https://itunes.apple.com/${country}/rss/customerreviews/` +
      `page=${page}/id=${trackId}/sortby=${sort}/json`;
    const doFetch = async () => {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      });
      // 400은 보통 "더 이상 페이지 없음" 신호 → 호출부에서 종료 처리
      if (res.status === 400) return { end: true };
      if (!res.ok) throw new HttpError(res.status, `RSS 요청 실패 ${res.status}`);
      const body = await res.json();
      const entries = body?.feed?.entry;
      return { entries: Array.isArray(entries) ? entries : [] };
    };
    return withRetry(doFetch, pacing, { isRetryable: isTransientError });
  }

  /**
   * 한 앱의 리뷰를 RSS 페이지네이션으로 수집. mosthelpful 순서대로 helpfulRank(1부터) 부여.
   * @param {number|string} trackId
   * @param {{ maxReviews?: number, onPage?: (n:number)=>void }} [o]
   * @returns {Promise<Array<{raw:object, helpfulRank:number}>>}
   */
  async function getAllReviews(trackId, o = {}) {
    const maxReviews = o.maxReviews ?? Infinity;
    const out = [];
    let rank = 0;
    for (let page = 1; page <= MAX_PAGE && out.length < maxReviews; page++) {
      const { entries, end } = await requestPage(trackId, page);
      if (end) break;
      if (!entries || entries.length === 0) break;
      let added = 0;
      for (const entry of entries) {
        const raw = toRaw(entry);
        if (!raw) continue; // 앱 메타 등 비리뷰 엔트리 제외
        rank += 1;
        out.push({ raw, helpfulRank: rank });
        added += 1;
        if (out.length >= maxReviews) break;
      }
      o.onPage?.(added);
      // 마지막 페이지로 추정되면(50건 미만) 종료
      if (entries.length < PER_PAGE) break;
      if (page < MAX_PAGE && out.length < maxReviews) {
        await sleep(pacing.intervalMs);
      }
    }
    return out;
  }

  return { getAllReviews };
}

export { HttpError };
