// 재개 관리자: 이미 수집 완료한 앱을 식별해 재실행 시 건너뛴다.
// 손상/0바이트/부분 저장 파일은 완료로 보지 않고 재수집 대상으로 둔다.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// 리뷰 파일이 "완료"로 인정되려면: JSON 파싱 가능 + reviews 배열 1건 이상(또는 done:true)
async function isCompleteReviewFile(filePath) {
  try {
    const st = await stat(filePath);
    if (st.size === 0) return false;
    const parsed = JSON.parse(await readFile(filePath, "utf-8"));
    if (parsed?.done === true) return true;
    return Array.isArray(parsed?.reviews) && parsed.reviews.length > 0;
  } catch {
    return false; // 파싱 불가/손상 → 미완료
  }
}

/**
 * 리뷰 출력 디렉터리를 스캔해 완료된 식별자 집합을 만든다.
 * 파일명(<id>.json)의 <id>가 식별자.
 * @param {string} reviewDir
 * @returns {Promise<Set<string>>}
 */
export async function loadDoneSet(reviewDir) {
  const done = new Set();
  if (!existsSync(reviewDir)) return done;
  const files = await readdir(reviewDir);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(reviewDir, f);
    if (await isCompleteReviewFile(full)) {
      done.add(f.replace(/\.json$/, ""));
    }
  }
  return done;
}

/**
 * apps.json이 유효하면 재사용, 아니면 collectFn으로 재수집.
 * 유효 = 파싱 가능 + 배열 항목 1건 이상.
 * @param {string} appsFile
 * @param {() => Promise<Array>} collectFn
 * @returns {Promise<{apps: Array, reused: boolean}>}
 */
export async function reuseAppsOrCollect(appsFile, collectFn) {
  if (existsSync(appsFile)) {
    try {
      const parsed = JSON.parse(await readFile(appsFile, "utf-8"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { apps: parsed, reused: true };
      }
    } catch {
      // 손상 → 재수집
    }
  }
  const apps = await collectFn();
  return { apps, reused: false };
}
