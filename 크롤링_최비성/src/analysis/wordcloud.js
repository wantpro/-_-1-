// 블라인드 결혼생활 공개글 워드클라우드 생성
// 제목의 단어 빈도를 세어 SVG와 HTML을 만든다. 외부 의존성 없음.
//
// 본문에는 사이트 UI/광고 문구가 반복되므로 제목만 집계 대상으로 삼는다.
// 배치는 단어마다 다른 각도에서 출발해 나선을 돌며 사각형 충돌을 검사하는 방식이다.

import fs from "node:fs/promises";
import path from "node:path";

const INPUT = path.join("data", "web", "blind", "결혼생활.json");
// 사람이 열어보는 결과물이므로 report/ 아래에 둔다. run-pipeline.js와 같은 규칙.
const OUT_DIR = path.join("data", "analysis", "wedding", "report");

const TOP_N = 55;
const CANVAS = { width: 1200, height: 860, cx: 600, cy: 430 };
const BOUNDS = { left: 20, right: 1180, top: 30, bottom: 830 };
const FONT = { min: 16, range: 44, boldAbove: 35, widthRatio: 0.92, lineHeight: 1.25 };
const SPIRAL = { golden: 2.39996, angleStep: 0.35, radiusStep: 2.2, maxTries: 500, yScale: 0.62 };
const COLORS = ["#be123c", "#db2777", "#7c3aed", "#2563eb", "#0f766e", "#b45309"];

// 조사·어미. 어간 끝이 우연히 일치하면 과절단되지만, 형태소 분석기 없이 쓰는 근사치다.
const PARTICLES =
  /(으로|에서|에게|부터|까지|처럼|보다|하고|하면|해서|하는|한테|입니다|습니다|어요|아요|네요|지만|는데|라고|다는|라는|같은|있는|없는|였던|이었다|이다|이랑|랑|은|는|이|가|을|를|도|에|의|로|와|과|고|며|만|서)$/;

// 사이트 보일러플레이트와 일반어에 더해, 전 문서에 깔려 결과를 덮어버리는
// 주제어(결혼·남편·아내 등)도 뺀다. 통계가 아니라 편집 판단이다.
const STOPWORDS = new Set(
  `내가 그냥 너무 진짜 근데 나도 나는 하고 있는 있는지 이런 그래서 그리고 하면 지금 많이 정말
   대댓글 더보기 작성자가 삭제한 댓글입니다 결혼 결혼생활 블라인드 채널 팔로우 조회수 댓글 좋아요
   사람 서로 우리 저는 제가 저도 있다 있는 하는 했다 했는데 되는데 것 같아 보면 요즘 왜 어떻게 뭐
   혹시 그리고 지금 남편 아내 와이프 teamblind https www com post kr 작성일 시간 새회사 작성자
   공무원 어제 남겨주세요 추천순 프로필 받기 가연 바로가기`.split(/\s+/)
);

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 제목에서 단어를 뽑아 조사를 떼고 불용어를 거른다. */
function extractTerms(title) {
  const matches = String(title ?? "").match(/[가-힣]{2,}|[A-Za-z]{3,}/g) ?? [];
  const kept = [];
  for (const term of matches) {
    const word = term.replace(PARTICLES, "");
    if (word.length < 2 || STOPWORDS.has(word) || STOPWORDS.has(term)) continue;
    kept.push(word);
  }
  return kept;
}

/** 문서 전체의 단어 빈도를 세어 상위 TOP_N개를 [단어, 횟수] 배열로 반환한다. */
function countTerms(docs) {
  const freq = new Map();
  for (const doc of docs) {
    for (const term of extractTerms(doc.title)) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  }
  return [...freq].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const inBounds = (b) =>
  b.x > BOUNDS.left && b.x + b.w < BOUNDS.right && b.y > BOUNDS.top && b.y + b.h < BOUNDS.bottom;

/**
 * 나선을 돌며 겹치지 않는 자리를 찾는다.
 * 단어마다 출발 각도를 달리해(index × 황금각) 방사형으로 흩어지게 한다.
 * maxTries 안에 자리를 못 찾으면 null.
 */
function findSlot({ index, width, size, placed }) {
  let angle = index * SPIRAL.golden;
  let radius = 0;
  for (let n = 0; n < SPIRAL.maxTries; n++) {
    const x = CANVAS.cx + Math.cos(angle) * radius;
    const y = CANVAS.cy + Math.sin(angle) * radius * SPIRAL.yScale;
    const box = { x: x - width / 2, y: y - size, w: width, h: size * FONT.lineHeight };
    if (inBounds(box) && !placed.some((p) => overlaps(box, p))) return box;
    angle += SPIRAL.angleStep;
    radius += SPIRAL.radiusStep;
  }
  return null;
}

/** 빈도 상위 단어를 캔버스에 배치한다. 자리를 못 찾은 단어는 빠진다. */
function layout(terms) {
  const max = terms[0]?.[1] ?? 1;
  const placed = [];
  for (const [index, [term, count]] of terms.entries()) {
    const size = Math.round(FONT.min + FONT.range * Math.sqrt(count / max));
    const width = term.length * size * FONT.widthRatio;
    const slot = findSlot({ index, width, size, placed });
    if (!slot) continue;
    placed.push({ ...slot, term, count, size, color: COLORS[index % COLORS.length] });
  }
  return placed;
}

function renderSvg(placed, subtitle) {
  const words = placed
    .map(
      (p) =>
        `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${p.size}" font-weight="${p.size > FONT.boldAbove ? 700 : 500}" fill="${p.color}">${escapeXml(p.term)}</text>`
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">` +
    `<rect width="${CANVAS.width}" height="${CANVAS.height}" rx="28" fill="#fff7ed"/>` +
    `<text x="60" y="70" font-family="sans-serif" font-size="28" font-weight="700" fill="#431407">Blind 결혼생활 공개글 워드클라우드</text>` +
    `<text x="60" y="102" font-family="sans-serif" font-size="15" fill="#9a3412">${subtitle}</text>` +
    `${words}</svg>`
  );
}

function renderHtml(svg, subtitle) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>결혼생활 워드클라우드</title>
<style>body{margin:0;background:#fff7ed;font-family:system-ui,-apple-system,sans-serif;color:#431407}main{max-width:1200px;margin:24px auto;padding:0 16px}h1{font-size:1.5rem;margin:0 0 12px}p{color:#9a3412;margin:0 0 18px}.cloud{background:white;border-radius:20px;box-shadow:0 8px 30px #7c2d121c;overflow:hidden}.cloud svg{display:block;width:100%;height:auto}</style></head>
<body><main><h1>Blind 결혼생활 공개글 워드클라우드</h1><p>${subtitle}</p><div class="cloud">${svg}</div></main></body></html>`;
}

const source = JSON.parse(await fs.readFile(INPUT, "utf8"));
const docs = source.docs ?? [];
const terms = countTerms(docs);
const placed = layout(terms);
const subtitle = `${docs.length}건 · 불용어 및 사이트 보일러플레이트 제외 · 단어 출현 빈도`;

const svg = renderSvg(placed, subtitle);
// run-pipeline.js보다 먼저 단독 실행될 수 있으므로 출력 폴더를 직접 보장한다.
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, "wordcloud.svg"), svg);
await fs.writeFile(path.join(OUT_DIR, "wordcloud.html"), renderHtml(svg, subtitle));
await fs.writeFile(
  path.join(OUT_DIR, "wordcloud-terms.json"),
  JSON.stringify(terms.map(([term, count]) => ({ term, count })), null, 2)
);

console.log(JSON.stringify({ docs: docs.length, terms: terms.length, placed: placed.length }));
