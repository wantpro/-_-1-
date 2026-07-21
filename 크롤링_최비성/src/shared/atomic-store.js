// 원자적 JSON 저장
// 임시 파일에 기록한 뒤 rename으로 교체하여, 중단 시 부분 파일이 최종 경로에 남지 않게 한다.

import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";

/**
 * 객체를 JSON으로 원자적으로 저장한다.
 * @param {string} filePath 최종 저장 경로
 * @param {unknown} obj 직렬화할 객체
 */
export async function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const json = JSON.stringify(obj, null, 2);
  await writeFile(tmp, json, "utf-8");
  await rename(tmp, filePath); // 동일 디렉터리 내 rename은 원자적
}
