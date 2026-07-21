// 규모 필터: 다운로드 규모로 중소형 앱 여부 판정 (경계값 포함)
// Google Play는 minInstalls, App Store는 평점 개수(ratings count) 프록시 사용.

function toIntOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/**
 * Google Play 중소형 판정.
 * @param {unknown} minInstalls
 * @param {{low:number, high:number}} range
 * @returns {{ keep: boolean, reason: string|null }}
 */
export function classifyGooglePlaySize(minInstalls, range) {
  const n = toIntOrNull(minInstalls);
  if (n === null) return { keep: false, reason: "unknown-installs" };
  if (n < range.low) return { keep: false, reason: "below-min" };
  if (n > range.high) return { keep: false, reason: "above-max" };
  return { keep: true, reason: null };
}

/**
 * App Store 중소형 판정.
 * @param {unknown} ratingsCount
 * @param {{floor:number, cap:number}} bounds
 * @returns {{ keep: boolean, reason: string|null }}
 */
export function classifyAppStoreSize(ratingsCount, bounds) {
  const n = toIntOrNull(ratingsCount);
  if (n === null) return { keep: false, reason: "unknown-ratings" };
  if (n < bounds.floor) return { keep: false, reason: "below-floor" };
  if (n > bounds.cap) return { keep: false, reason: "above-cap" };
  return { keep: true, reason: null };
}
