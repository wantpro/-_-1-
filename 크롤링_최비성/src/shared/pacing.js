// 요청 페이싱 및 재시도 유틸
// 모든 네트워크 호출은 이 래퍼를 거쳐 차단 회피용 간격/백오프를 적용한다.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 일시적 오류(레이트리밋/네트워크)로 간주할 패턴
const TRANSIENT =
  /EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|429|408|5\d\d|rate.?limit|throttl/i;

export function isTransientError(err) {
  const msg = String(err?.message ?? err);
  const causeCode = err?.cause?.code ?? err?.code ?? "";
  if (err?.status && /^(408|429|5\d\d)$/.test(String(err.status))) return true;
  // node fetch는 message가 "fetch failed"이고 실제 코드는 cause.code에 있다.
  if (/EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|ECONNREFUSED|UND_ERR/i.test(String(causeCode))) return true;
  return TRANSIENT.test(msg);
}

/**
 * 지수 백오프 재시도 래퍼.
 * @param {() => Promise<T>} fn 실행할 비동기 함수
 * @param {{intervalMs:number,maxRetries:number,backoffFactor:number,backoffMaxMs:number}} profile
 * @param {{ onRetry?: (info:{attempt:number,waitMs:number,error:Error})=>void, isRetryable?: (e:Error)=>boolean }} [hooks]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, profile, hooks = {}) {
  const {
    maxRetries = 5,
    backoffFactor = 2,
    backoffMaxMs = 60_000,
    intervalMs = 2_000,
  } = profile ?? {};
  const isRetryable = hooks.isRetryable ?? isTransientError;

  let lastErr;
  // 시도 횟수 = 1(최초) + maxRetries(재시도)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries || !isRetryable(e)) throw e;
      // 백오프: intervalMs * factor^attempt, 상한 backoffMaxMs
      const wait = Math.min(intervalMs * backoffFactor ** attempt, backoffMaxMs);
      hooks.onRetry?.({ attempt: attempt + 1, waitMs: wait, error: e });
      await sleep(wait);
    }
  }
  throw lastErr;
}
