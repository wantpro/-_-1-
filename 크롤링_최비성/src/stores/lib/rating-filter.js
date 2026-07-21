// 별점 필터: 저평점(1~3 정수)만 유지
// 4~5점, 비정수, 범위 이탈은 제외하며 사유를 함께 반환한다.

/**
 * @param {unknown} rating
 * @returns {{ keep: boolean, reason: string|null }}
 */
export function classifyRating(rating) {
  if (rating === null || rating === undefined || rating === "") {
    return { keep: false, reason: "missing" };
  }
  const n = Number(rating);
  if (!Number.isInteger(n)) {
    return { keep: false, reason: "non-integer" };
  }
  if (n < 1 || n > 5) {
    return { keep: false, reason: "out-of-range" };
  }
  if (n >= 4) {
    return { keep: false, reason: "high-rating" };
  }
  return { keep: true, reason: null };
}

/**
 * 저평점이면 true.
 * @param {unknown} rating
 * @returns {boolean}
 */
export function keepLowRating(rating) {
  return classifyRating(rating).keep;
}
