// App Store 리뷰 클라이언트 (토큰 불필요, same-origin 프록시 사용)
//
// apps.apple.com 의 same-origin 프록시 경로를 호출한다:
//   https://apps.apple.com/api/apps/v1/catalog/{country}/apps/{trackId}/reviews
// 이 프록시는 서버사이드에서 amp-api bearer 토큰을 주입하므로, 클라이언트는
// 토큰을 직접 구하지 않아도 된다(브라우저 유사 헤더 Origin/Referer/UA만 필요).
//
// 과거에는 amp-api-edge.apps.apple.com 을 직접 호출하며 JS 번들에서 JWT를 추출했지만,
// Apple이 토큰을 런타임 주입(MEDIA_API_TOKEN)으로 바꿔 번들 추출이 불가능해졌다.
// 반면 same-origin 프록시는 토큰을 서버가 붙여주므로 더 안정적이다.
// RSS(appstore-rss.js)와 달리 offset 페이지네이션으로 ~500건 이상도 수집 가능.

import { withRetry, sleep, isTransientError } from "../../shared/pacing.js";
import { setDefaultResultOrder } from "node:dns";

// 일부 환경에서 node fetch가 IPv6를 먼저 시도하다 ETIMEDOUT 나는 문제 회피(curl은 IPv4로 정상).
try {
  setDefaultResultOrder("ipv4first");
} catch {
  // 구버전 node 등에서 미지원 시 무시
}

const PROXY_BASE = "https://apps.apple.com/api/apps/v1/catalog";
const PAGE_LIMIT = 20; // 프록시 reviews 페이지 크기
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

class HttpError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * App Store 리뷰 클라이언트 생성(토큰 불필요).
 * @param {object} config loadConfig 결과 (country, lang, pacing 사용)
 * @param {{ fetchImpl?: typeof fetch }} [deps] 테스트용 fetch 주입
 */
export function createAmpClient(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const { country, pacing } = config;
  // 선택: 외부 토큰이 주입되면 Authorization도 같이 보냄(프록시는 없어도 동작).
  const injectedToken = config.asToken || process.env.PM_AS_TOKEN || null;

  function reviewsUrl(trackId, offset) {
    return (
      `${PROXY_BASE}/${country}/apps/${trackId}/reviews` +
      `?platform=web&l=${config.lang}&offset=${offset}&limit=${PAGE_LIMIT}&sort=mosthelpful`
    );
  }

  async function requestPage(trackId, offset) {
    const url = reviewsUrl(trackId, offset);
    const doFetch = async () => {
      const headers = {
        Accept: "application/json",
        Origin: "https://apps.apple.com",
        Referer: `https://apps.apple.com/${country}/app/id${trackId}`,
        "User-Agent": BROWSER_UA,
        "Accept-Language": country,
      };
      if (injectedToken) headers.Authorization = `Bearer ${injectedToken}`;
      const res = await fetchImpl(url, { headers });
      // 429(용량 초과)/5xx는 일시 오류로 보고 백오프 재시도
      if (!res.ok) throw new HttpError(res.status, `리뷰 요청 실패 ${res.status}`);
      return res.json();
    };
    return withRetry(doFetch, pacing, { isRetryable: isTransientError });
  }

  /**
   * 한 앱의 리뷰를 offset 페이지네이션으로 수집. helpfulRank를 1부터 부여.
   * @param {number|string} trackId
   * @param {{ maxReviews?: number, onPage?: (n:number)=>void }} [o]
   * @returns {Promise<Array<{raw:object, helpfulRank:number}>>}
   */
  async function getAllReviews(trackId, o = {}) {
    const maxReviews = o.maxReviews ?? Infinity;
    const out = [];
    let offset = 0;
    let rank = 0;
    while (out.length < maxReviews) {
      const body = await requestPage(trackId, offset);
      const data = body?.data ?? [];
      if (data.length === 0) break;
      for (const d of data) {
        rank += 1;
        out.push({ raw: d, helpfulRank: rank });
        if (out.length >= maxReviews) break;
      }
      o.onPage?.(data.length);
      // next 커서가 없으면 종료. next의 offset을 우선 사용하되, 없으면 받은 개수만큼 진행.
      const next = body?.next;
      if (!next) break;
      const m = /offset=(\d+)/.exec(next);
      const nextOffset = m ? Number(m[1]) : offset + data.length;
      if (nextOffset <= offset) break; // 진행 없음 → 종료
      offset = nextOffset;
      // 페이지 간 보수적 대기(429 회피)
      await sleep(pacing.intervalMs);
    }
    return out;
  }

  return { getAllReviews };
}

export { HttpError };
