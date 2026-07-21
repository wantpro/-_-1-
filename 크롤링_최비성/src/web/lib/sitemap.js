// 사이트맵 하베스터 (robots 준수 공개 URL 수집)
//
// 검색 페이지 스크래핑 대신, 사이트가 스스로 공개한 sitemap.xml(또는 .xml.gz)에서
// 공개 URL만 수집한다. gzip 샤드는 node:zlib로 해제한다.
//
// 제공 함수:
//   fetchSitemapUrls(url)   : 단일 sitemap(.xml/.xml.gz)에서 <loc> URL 배열 추출
//   expandSitemapIndex(url) : sitemapindex면 하위 sitemap들의 loc 배열 반환, 아니면 []
//   harvest(url, {limit, filter, includeIndex}) : 인덱스를 재귀 전개해 URL 수집

import { gunzipSync } from "node:zlib";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchRaw(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" } });
  if (!res.ok) {
    const e = new Error(`sitemap fetch ${res.status}: ${url}`);
    e.status = res.status;
    throw e;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // fetch는 Content-Encoding: gzip을 자동 해제하므로, 실제 gzip 매직바이트(0x1f 0x8b)가
  // 남아 있을 때만 추가로 해제한다(.gz 확장자만으로 판단하면 이중 해제 오류 발생).
  const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return isGz ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8");
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeEntities(m[1]));
  return out;
}

// 사이트맵 <loc>에 들어오는 XML 엔티티(&amp; 등) 디코딩
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/.test(xml);
}

/** 단일 sitemap에서 URL(<loc>) 배열을 추출. 인덱스면 하위 sitemap loc들을 반환. */
export async function fetchSitemapUrls(url) {
  const xml = await fetchRaw(url);
  return extractLocs(xml);
}

/** sitemapindex 여부와 loc 목록을 함께 반환. */
export async function loadSitemap(url) {
  const xml = await fetchRaw(url);
  return { isIndex: isSitemapIndex(xml), locs: extractLocs(xml) };
}

/**
 * 사이트맵(인덱스 포함)을 재귀 전개해 최종 URL을 수집한다.
 * @param {string} url 시작 sitemap/sitemapindex URL
 * @param {object} opts
 *   - limit       : 수집 URL 상한(기본 1000)
 *   - filter      : (url)=>boolean, 통과한 URL만 수집
 *   - shardLimit  : 인덱스에서 전개할 하위 sitemap 최대 개수(기본 전체)
 *   - onShard     : (shardUrl, idx)=>void 진행 콜백
 *   - sleepMs     : 샤드 간 대기(기본 500ms)
 */
export async function harvest(url, opts = {}) {
  const { limit = 1000, filter, shardLimit = Infinity, onShard, sleepMs = 500 } = opts;
  const { isIndex, locs } = await loadSitemap(url);
  const collected = [];

  const pushUrls = (urls) => {
    for (const u of urls) {
      if (filter && !filter(u)) continue;
      collected.push(u);
      if (collected.length >= limit) return true;
    }
    return false;
  };

  if (!isIndex) {
    pushUrls(locs);
    return collected.slice(0, limit);
  }

  // 인덱스: 하위 sitemap들을 순회
  const shards = locs.slice(0, shardLimit);
  for (let i = 0; i < shards.length; i++) {
    onShard?.(shards[i], i);
    try {
      const sub = await loadSitemap(shards[i]);
      // 하위가 또 인덱스면 한 단계 더 전개
      if (sub.isIndex) {
        for (const s2 of sub.locs) {
          const urls = await fetchSitemapUrls(s2);
          if (pushUrls(urls)) return collected.slice(0, limit);
          if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
        }
      } else if (pushUrls(sub.locs)) {
        return collected.slice(0, limit);
      }
    } catch (e) {
      onShard?.(`  (샤드 실패: ${e.message})`, i);
    }
    if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
  }
  return collected.slice(0, limit);
}
