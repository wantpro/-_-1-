// 웨딩 콘텐츠 리서치 파이프라인
// 블라인드 결혼생활 공개글을 정제 → 토픽 분류 → 수요 점수 → 콘텐츠 백로그 → 리포트로 잇는다.
// 생성형 AI나 유료 API를 쓰지 않는 결정적 파이프라인이다.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("data");
const OUT = path.join(ROOT, "analysis", "wedding");
const INPUT = path.join(ROOT, "web", "blind", "결혼생활.json");

// 토픽 사전. 본문에 키워드가 몇 개 들어있는지 세어 최다 득점 토픽 하나에 배정한다.
// 비지도 군집화가 아니라 사람이 정한 규칙 기반 분류다. 동점이면 이 배열의 순서가 이긴다.
const TOPICS = [
  ["topic_01", "결혼 준비·일정", ["결혼준비", "결혼 준비", "상견례", "결혼식", "예식", "신랑", "신부"]],
  ["topic_02", "예산·비용", ["예산", "비용", "가격", "만원", "연봉", "돈", "가성비", "추가금"]],
  ["topic_03", "웨딩홀·스드메", ["웨딩홀", "식장", "스드메", "드레스", "메이크업", "촬영", "스튜디오"]],
  ["topic_04", "가족·상견례", ["시댁", "시어머니", "장모", "처가", "부모님", "상견례", "가족"]],
  ["topic_05", "관계·신뢰·파혼", ["파혼", "이혼", "바람", "외도", "전여친", "전남친", "신뢰", "판도라"]],
  ["topic_06", "가사·육아 분담", ["육아", "가사", "집안일", "밥", "남편", "아내", "분담", "육아휴직"]],
  ["topic_07", "임신·건강", ["임신", "난임", "임신초기", "입덧", "출산", "산후", "병원"]],
  ["topic_08", "대화·갈등", ["대화", "갈등", "싸움", "서운", "말다툼", "고민", "어떻게"]],
  ["topic_09", "결혼 후 생활", ["신혼", "부부", "생활", "용돈", "돈관리", "집", "동거"]],
  ["topic_10", "기타 결혼 경험", ["결혼", "배우자", "남친", "여친", "연애"]],
];

// 수요 점수 가중치. 합이 100이 되도록 맞춘다.
const WEIGHTS = { volume: 25, question: 30, concern: 25, reaction: 20 };

const TOP_PHRASES = 15;
const REPRESENTATIVE_POSTS = 5;
const TOP_TOPICS_FOR_BACKLOG = 10;
const MIN_TEXT_LENGTH = 30;

// 페이지 전역 메뉴·광고 등 본문이 아닌 줄
const UI_LINES = [
  /^블라인드( 기업서비스)?$/, /^Blind/, /^홈$/, /^채널$/, /^기업 리뷰$/, /^로그인$/, /^검색$/,
  /^추천순$/, /^북마크$/, /^댓글을 남겨주세요/, /^대댓글$/, /^댓글(?: \d+개)? 더보기$/,
  /^댓글 \d+$/, /^광고$/, /^작성자$/, /^작성일$/, /^조회수$/, /^댓글$/, /^팔로우$/,
];
const AD_LINES =
  /^(엄마들의|직장인 맞춤|직장인끼리|블라인드가 만든|가연 |햇반|스탠다드 트윈|사이오스|이사 무료|칠성사이다|뉴발란스|알텐바흐|크래프톤|쿠팡)/;

const CONCERN = /(불안|무섭|두렵|후회|괴롭|힘들|파혼|이혼|사기|배신|서운|걱정|문제|싫어|화나|갈등)/;
const QUESTION = /[?？]|어떻게|괜찮|추천|의견|부탁|알려|궁금/;

const csv = (rows) =>
  rows
    .map((r) => r.map((v) => `"${String(v ?? "").replaceAll('"', '""').replaceAll("\n", " ")}"`).join(","))
    .join("\n") + "\n";

const words = (text) => text.toLowerCase().match(/[가-힣]{2,}|[a-z]{3,}/g) ?? [];

/**
 * 본문에서 화면 보일러플레이트·광고·개인정보를 걷어낸다.
 * "닉네임 / · / 회사" 3줄 패턴은 작성자 식별 줄로 보고 제거한다.
 */
function cleanText(raw) {
  const lines = String(raw ?? "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const identityLines = new Set();
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i + 1] === "·") identityLines.add(i);
  }
  const kept = lines.filter(
    (line, i) =>
      !identityLines.has(i) &&
      !UI_LINES.some((r) => r.test(line)) &&
      !AD_LINES.test(line) &&
      !/^(어제|오늘|방금|\d+분|\d+시간|\d+일|\d+주)$/.test(line) &&
      line !== "·" &&
      !/^\d+$/.test(line) &&
      !/^[*!?·]+$/.test(line)
  );
  return kept
    .join(" ")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[이메일]")
    .replace(/(?:01[016789]|02|0[3-6][1-5]|070)[-. ]?\d{3,4}[-. ]?\d{4}/g, "[전화번호]")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 키워드 적중 수가 가장 많은 토픽. 하나도 없으면 기타. */
function topicFor(text) {
  const scores = TOPICS.map(([id, label, keys]) => ({
    id,
    label,
    score: keys.reduce((n, k) => n + (text.includes(k) ? 1 : 0), 0),
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores[0].score ? scores[0] : { id: "other", label: "기타", score: 0 };
}

const hasConcern = (text) => (CONCERN.test(text) ? 1 : 0);
const hasQuestion = (text) => (QUESTION.test(text) ? 1 : 0);

/** 원본 문서를 정제해 분석용 행과 제외 로그로 가른다. */
function cleanDocuments(input) {
  const seen = new Set();
  const clean = [];
  const excluded = [];
  for (const d of input.docs ?? []) {
    const reasons = [];
    if (seen.has(d.id || d.url)) reasons.push("duplicate");
    else seen.add(d.id || d.url);
    if (d.board !== "결혼생활") reasons.push("board-not-marriage-life");

    const text = cleanText(`${d.title ?? ""}\n${d.text ?? ""}`);
    if (text.length < MIN_TEXT_LENGTH) reasons.push("short-or-empty");

    if (reasons.length) {
      excluded.push({ post_id: d.id, url: d.url, reason: reasons.join(";") });
      continue;
    }
    clean.push({
      post_id: d.id,
      source: "blind",
      board: d.board,
      query: input.query,
      collected_at: input.collectedAt,
      published_at: d.date ?? "",
      url: d.url,
      title: cleanText(d.title),
      text,
      comment_count: d.commentCount ?? "",
      view_count: d.viewCount ?? "",
      like_count: "",
    });
  }
  return { clean, excluded };
}

/** 글마다 토픽을 붙이고, 토픽별 상위 단어·대표 글을 집계한다. */
function buildTopics(clean) {
  const rows = clean.map((d) => {
    const t = topicFor(d.text);
    return { ...d, topic_id: t.id, topic_weight: t.score };
  });

  const buckets = new Map(
    TOPICS.map(([id, label]) => [id, { label, n: 0, terms: new Map(), ids: [] }])
  );
  for (const d of rows) {
    const bucket = buckets.get(d.topic_id) ?? { label: "기타", n: 0, terms: new Map(), ids: [] };
    bucket.n++;
    bucket.ids.push(d.post_id);
    for (const w of words(d.text)) bucket.terms.set(w, (bucket.terms.get(w) ?? 0) + 1);
    buckets.set(d.topic_id, bucket);
  }

  const summary = [...buckets.entries()]
    .filter(([, b]) => b.n)
    .map(([id, b]) => ({
      topic_id: id,
      topic: b.label,
      document_count: b.n,
      // 단순 빈도이므로 TF-IDF와 달리 흔한 단어가 여러 토픽에 공통으로 올라온다.
      top_phrases: [...b.terms.entries()]
        .sort((a, b2) => b2[1] - a[1])
        .slice(0, TOP_PHRASES)
        .map(([w, n]) => `${w}:${n}`)
        .join(" | "),
      representative_post_ids: b.ids.slice(0, REPRESENTATIVE_POSTS).join(" | "),
    }));

  return { rows, summary };
}

/** 토픽별 수요 점수를 매겨 내림차순 정렬한다. */
function scoreDemand(summary, rows, clean) {
  const reactions = clean
    .map((d) => Number(d.comment_count) || 0)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const percentile = (n) =>
    reactions.length ? Math.round((reactions.filter((x) => x <= n).length / reactions.length) * 100) : 0;
  const mean = (docs, fn) => docs.reduce((n, d) => n + fn(d), 0) / docs.length;

  return summary
    .map((t) => {
      const docs = rows.filter((d) => d.topic_id === t.topic_id);
      const volume = docs.length / clean.length;
      const question = mean(docs, (d) => hasQuestion(d.text));
      const concern = mean(docs, (d) => hasConcern(d.text));
      const reaction = mean(docs, (d) => percentile(Number(d.comment_count) || 0)) / 100;
      const score = Math.round(
        WEIGHTS.volume * volume +
          WEIGHTS.question * question +
          WEIGHTS.concern * concern +
          WEIGHTS.reaction * reaction
      );
      return {
        ...t,
        volume: +volume.toFixed(3),
        question_rate: +question.toFixed(3),
        concern_rate: +concern.toFixed(3),
        reaction_normalized: +reaction.toFixed(3),
        demand_score: Math.min(100, score),
      };
    })
    .sort((a, b) => b.demand_score - a.demand_score);
}

/** 상위 토픽마다 콘텐츠 아이디어 3건씩 만든다. */
function buildBacklog(demand) {
  const promises = [
    "실행 가능한 체크리스트",
    "비슷한 상황을 안전하게 비교하는 공감형 사례",
    "결정 전 확인할 질문 템플릿",
  ];
  const formats = [
    ["저장형 캐러셀", "도달형 리일스", "체크리스트"],
    ["저장형 리일스", "공감형 캐러셀", "질문 템플릿"],
  ];
  const ideas = [];
  for (const [i, t] of demand.slice(0, TOP_TOPICS_FOR_BACKLOG).entries()) {
    for (let k = 0; k < 3; k++) {
      ideas.push({
        priority: i * 3 + k + 1,
        topic_id: t.topic_id,
        target_stage: "결혼 준비·결혼생활",
        audience: "결혼을 앞두었거나 결혼생활 중인 사람",
        pain_or_question: `${t.topic}에 대한 반복 질문과 고민`,
        content_promise: promises[k],
        format: formats[k % 2][k % 3] ?? "Q&A 카드",
        hook: `${t.topic}, 다른 사람들은 어떻게 했을까?`,
        outline: "문제 상황 → 선택 기준 3가지 → 실천 체크리스트 → 주의할 점",
        cta: "저장하고 배우자와 함께 확인해보세요",
        evidence_post_ids: t.representative_post_ids,
        demand_score: t.demand_score,
        status: "draft",
      });
    }
  }
  return ideas;
}

// 산출물은 용도로 가른다.
//   report/       사람이 열어보는 결과물
//   intermediate/ 다음 단계의 입력이 되는 중간물
//   meta/         재현·감사에 필요한 실행 기록
const DIRS = {
  report: path.join(OUT, "report"),
  intermediate: path.join(OUT, "intermediate"),
  meta: path.join(OUT, "meta"),
};

const OUTPUT_FILES = [
  "intermediate/excluded-posts.csv",
  "intermediate/posts-topics.csv",
  "intermediate/topic-summary.csv",
  "report/topic-demand.csv",
  "report/content-backlog.csv",
  "report/research-report.md",
  "meta/cleaning-summary.json",
  "meta/topic-model-config.json",
  "meta/demand-notes.md",
];

const LIMITATIONS = [
  "Blind 공개 채널의 현재 노출 표본만 사용",
  "작성일·좋아요 결측",
  "키워드 기반 토픽 분류",
  "Threads 제외",
];

const write = (dir, name, body) => writeFile(path.join(DIRS[dir], name), body);
const writeJson = (dir, name, obj) => write(dir, name, JSON.stringify(obj, null, 2));

// ── 실행 ──────────────────────────────────────────────────────────────────

const now = new Date().toISOString();
for (const dir of Object.values(DIRS)) await mkdir(dir, { recursive: true });
const input = JSON.parse(await readFile(INPUT, "utf8"));

const { clean, excluded } = cleanDocuments(input);
const exclusionReasons = [...new Set(excluded.flatMap((x) => x.reason.split(";")))];

// 정제 결과 본문은 posts-topics.csv가 토픽 컬럼까지 얹어 그대로 담으므로
// 별도 posts-clean.csv는 만들지 않는다(본문 전체가 두 벌 저장되는 것을 피한다).
await write("intermediate", "excluded-posts.csv", csv([["post_id", "url", "reason"], ...excluded.map(Object.values)]));
await writeJson("meta", "cleaning-summary.json", {
  generatedAt: now,
  input: input.count,
  clean: clean.length,
  excluded: excluded.length,
  exclusionReasons: Object.fromEntries(
    exclusionReasons.map((r) => [r, excluded.filter((x) => x.reason.includes(r)).length])
  ),
});

const { rows: topicRows, summary: topicSummary } = buildTopics(clean);

await write("intermediate", "posts-topics.csv", csv([Object.keys(topicRows[0] ?? {}), ...topicRows.map(Object.values)]));
await write(
  "intermediate",
  "topic-summary.csv",
  csv([
    ["topic_id", "topic", "document_count", "top_phrases", "representative_post_ids"],
    ...topicSummary.map(Object.values),
  ])
);
await writeJson("meta", "topic-model-config.json", {
  generatedAt: now,
  method: "deterministic Korean keyword scoring; no AI/API",
  topicCount: topicSummary.length,
  source: INPUT,
});

const demand = scoreDemand(topicSummary, topicRows, clean);

// 소스가 Blind 하나뿐인 동안 topic-demand-by-source.csv는 source 열이 상수인
// topic-demand.csv의 부분집합이라 만들지 않는다. 소스가 늘면 다시 살릴 것.
await write("report", "topic-demand.csv", csv([Object.keys(demand[0] ?? {}), ...demand.map(Object.values)]));
await write(
  "meta",
  "demand-notes.md",
  `# 수요 점수 산출\n\n- 기준일: ${now}\n- 소스: Blind 공개 결혼생활 채널만 (${clean.length}건)\n- 산식: 대화량 ${WEIGHTS.volume} + 질문 비율 ${WEIGHTS.question} + 고민 강도 ${WEIGHTS.concern} + 댓글 반응 백분위 ${WEIGHTS.reaction}\n- 날짜·좋아요 결측은 점수에서 제외했고, 플랫폼 간 비교는 하지 않는다.\n- 공개 채널 표본·현재 노출 글 편향이 있으므로 시장 규모가 아닌 콘텐츠 우선순위 지표로 해석한다.\n`
);

const ideas = buildBacklog(demand);
await write("report", "content-backlog.csv", csv([Object.keys(ideas[0]), ...ideas.map(Object.values)]));

await writeJson("meta", "run-manifest.json", {
  generatedAt: now,
  sourceFiles: [INPUT],
  counts: {
    input: input.count,
    clean: clean.length,
    excluded: excluded.length,
    topics: topicSummary.length,
    backlog: ideas.length,
  },
  outputs: OUTPUT_FILES,
  limitations: LIMITATIONS,
});

const topLines = demand
  .slice(0, TOP_TOPICS_FOR_BACKLOG)
  .map(
    (x, i) =>
      `${i + 1}. **${x.topic}** — ${x.document_count}건, 수요점수 ${x.demand_score} (질문 ${x.question_rate}, 고민 ${x.concern_rate})`
  )
  .join("\n");

await write(
  "report",
  "research-report.md",
  `# 웨딩 공개 대화 리포트\n\n기준일: ${now}\n\nBlind 공개 결혼생활 채널 ${input.count}건 중 결혼생활 게시판 ${clean.length}건을 정제했다. ${excluded.length}건은 중복·채널 불일치·짧은 본문으로 제외했다.\n\n## 상위 수요 토픽\n\n${topLines}\n\n## 해석 한계\n\n공개 채널의 현재 노출 글만 포함하며, Blind 내부 전체 아카이브나 비공개 글을 대표하지 않는다. 토픽은 키워드 기반 자동 분류이고, 원문과 개인정보는 외부 콘텐츠에 그대로 재사용하지 않는다.\n`
);

console.log(
  JSON.stringify(
    {
      input: input.count,
      clean: clean.length,
      excluded: excluded.length,
      topics: topicSummary.length,
      backlog: ideas.length,
      out: OUT,
    },
    null,
    2
  )
);
