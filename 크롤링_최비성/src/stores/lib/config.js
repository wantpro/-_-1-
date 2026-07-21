// 공유 설정 로더 및 유효성 검증
// 환경변수와 CLI 인자(--key=value)에서 크롤러 설정을 읽어 검증한다.
// 미지정 시 기본값을 사용하고, 유효 범위를 벗어나면 명확한 오류를 던진다.

export const DEFAULTS = Object.freeze({
  country: "kr",
  lang: "ko",
  installMin: 10_000,
  installMax: 1_000_000,
  ratingsFloor: 100,
  ratingsCap: 50_000,
  pacing: Object.freeze({
    intervalMs: 2_000,
    maxRetries: 5,
    backoffFactor: 2,
    backoffMaxMs: 60_000,
  }),
});

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// "--key=value" 형태의 argv를 평탄한 맵으로 변환
function parseArgv(argv = []) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// 우선순위: CLI 인자 > 환경변수 > 기본값. 미지정이면 undefined 반환.
function pick(key, envKey, argvMap, env) {
  if (argvMap[key] !== undefined) return argvMap[key];
  if (env[envKey] !== undefined) return env[envKey];
  return undefined;
}

// 양의 정수(또는 0 이상) 파싱. 빈 값/비정수면 ConfigError.
function toInt(raw, label, { min = 0 } = {}) {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && raw.trim() === "") {
    throw new ConfigError(`${label}: 빈 값은 허용되지 않습니다`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${label}: 정수여야 합니다 (받은 값: ${raw})`);
  }
  if (n < min) {
    throw new ConfigError(`${label}: ${min} 이상이어야 합니다 (받은 값: ${n})`);
  }
  return n;
}

/**
 * 설정을 로딩하고 검증한다.
 * @param {{ env?: object, argv?: string[] }} opts
 * @returns {object} 검증된 설정
 * @throws {ConfigError} 유효 범위 위반 시
 */
export function loadConfig({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const a = parseArgv(argv);

  const country = pick("country", "PM_COUNTRY", a, env) ?? DEFAULTS.country;
  const lang = pick("lang", "PM_LANG", a, env) ?? DEFAULTS.lang;

  const installMin =
    toInt(pick("install-min", "PM_INSTALL_MIN", a, env), "install-min", { min: 0 }) ??
    DEFAULTS.installMin;
  const installMax =
    toInt(pick("install-max", "PM_INSTALL_MAX", a, env), "install-max", { min: 0 }) ??
    DEFAULTS.installMax;
  const ratingsFloor =
    toInt(pick("ratings-floor", "PM_RATINGS_FLOOR", a, env), "ratings-floor", { min: 0 }) ??
    DEFAULTS.ratingsFloor;
  const ratingsCap =
    toInt(pick("ratings-cap", "PM_RATINGS_CAP", a, env), "ratings-cap", { min: 0 }) ??
    DEFAULTS.ratingsCap;

  const intervalMs =
    toInt(pick("interval-ms", "PM_INTERVAL_MS", a, env), "interval-ms", { min: 0 }) ??
    DEFAULTS.pacing.intervalMs;
  const maxRetries =
    toInt(pick("max-retries", "PM_MAX_RETRIES", a, env), "max-retries", { min: 0 }) ??
    DEFAULTS.pacing.maxRetries;
  const backoffMaxMs =
    toInt(pick("backoff-max-ms", "PM_BACKOFF_MAX_MS", a, env), "backoff-max-ms", { min: 0 }) ??
    DEFAULTS.pacing.backoffMaxMs;

  // 관계 검증
  if (installMin > installMax) {
    throw new ConfigError(
      `install-min(${installMin})이 install-max(${installMax})보다 큽니다`
    );
  }
  if (ratingsFloor > ratingsCap) {
    throw new ConfigError(
      `ratings-floor(${ratingsFloor})가 ratings-cap(${ratingsCap})보다 큽니다`
    );
  }

  return {
    country,
    lang,
    installRange: { low: installMin, high: installMax },
    ratings: { floor: ratingsFloor, cap: ratingsCap },
    pacing: {
      intervalMs,
      maxRetries,
      backoffFactor: DEFAULTS.pacing.backoffFactor,
      backoffMaxMs,
    },
  };
}

export { ConfigError };
