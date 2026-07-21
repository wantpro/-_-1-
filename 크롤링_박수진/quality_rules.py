import html
import re


SERVICE_KEYWORDS = {
    "웨딩홀": [
        "웨딩홀", "예식장", "대관료", "식대", "보증인원", "꽃장식", "홀투어",
    ],
    "스튜디오·촬영": [
        "웨딩촬영", "스튜디오", "본식스냅", "원본사진", "앨범", "사진 셀렉",
    ],
    "드레스": [
        "드레스", "드레스샵", "드레스투어", "드투", "피팅", "가봉", "헬퍼비",
    ],
    "메이크업": [
        "메이크업", "메컵", "헤어메이크업", "얼리스타트", "출장비",
    ],
    "플래너": [
        "웨딩플래너", "동행플래너", "비동행플래너", "플래너 상담", "플래너 추천",
    ],
    "스드메·패키지": [
        "스드메", "드메", "웨딩패키지", "웨딩박람회", "제휴업체", "결직웨딩",
    ],
    "예물·혼수": [
        "예물", "예복", "혼주한복", "신랑신부 한복", "혼수", "웨딩밴드", "부케",
    ],
}


ISSUE_KEYWORDS = {
    "예상 밖 추가비용": [
        "추가금", "추가 비용", "별도 비용", "원본비", "헬퍼비", "피팅비",
        "업그레이드 비용", "부가세 별도", "비용이 추가", "추가로 내",
    ],
    "가격·견적 정보": [
        "견적", "가격 비교", "가격비교", "가격이 다르", "견적이 다르", "정찰제",
        "총액", "최종 비용", "가격 안내", "금액이 명시", "가격대", "가성비",
        "결혼식 비용", "웨딩 비용", "얼마정도", "얼마 정도", "저렴", "비싸",
    ],
    "계약·취소·환불": [
        "계약금", "예약금", "홀딩비", "환불", "취소", "위약금", "약관",
        "계약 취소", "예약 취소", "사기당", "계약 피해",
    ],
    "제휴·수수료 구조": [
        "제휴", "연계", "수수료", "고가라인", "강매", "당일 계약",
    ],
    "일정·예약 관리": [
        "일정 체크", "일정 관리", "일정 안내", "예약 변경", "카카오톡 안내",
        "준비물", "주차 안내", "스케쥴", "스케줄", "챙겨주", "몇시간",
        "몇 시간", "예약하기", "예식장 잡", "식장 잡",
    ],
    "서비스 불편·품질 문제": [
        "불친절", "지연", "누락", "실수", "재촬영", "보정 불만", "결과물 문제",
        "실망", "아쉬웠", "별로였", "문제가 있었", "연락이 안",
    ],
    "선택 피로·정보 부족": [
        "선택할 게", "알아보기 힘들", "비교하기 어렵", "정보가 없", "막막",
        "정신이 없", "시간이 부족", "번거롭", "지쳤", "어렵기도",
    ],
}


NOISE_TERMS = [
    "씨를", "번식성공", "번식", "수컷", "한남", "한녀", "노괴", "퐁퐁남",
    "설거지론", "도태남", "처녀", "가임력", "섹스 가능한", "결혼정책",
    "출산율", "전세계약", "부동산계약", "내집스캔", "신혼집 전세",
    "청소업체직원", "연애상담", "결정사", "전남친",
]


PREFERENCE_MARKERS = [
    "선택했", "골랐", "추천", "마음에 들", "스타일", "분위기", "친절",
    "만족", "잘 어울", "계약했", "상담받", "방문했", "촬영했", "투어했",
]


WEDDING_CONTEXT_TERMS = (
    "웨딩", "결혼", "예식", "예식장", "스드메", "플래너", "업체", "신혼",
    "혼수", "촬영", "드레스", "메이크업", "앨범", "본식", "신부", "신랑",
)


DC_PREPARATION_TERMS = (
    "결혼 준비", "결혼준비", "결혼식 비용", "결혼식 식장", "웨딩 비용",
    "웨딩홀", "예식장", "스드메", "웨딩촬영", "본식스냅", "드레스", "메이크업",
    "플래너", "웨딩밴드", "부케", "예물", "예복", "가봉", "식대", "축의금",
)


PRICE_PATTERN = re.compile(
    r"\d{1,3}(?:,\d{3})+\s*원|"
    r"\d+(?:\.\d+)?\s*만\s*원|"
    r"\d+\s*천\s*원"
)


def normalize_text(text: str) -> str:
    text = html.unescape(text or "")
    text = re.sub(r"https?://\S+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def match_groups(text: str, groups: dict[str, list[str]]) -> list[str]:
    return [
        label
        for label, keywords in groups.items()
        if any(keyword in text for keyword in keywords)
    ]


def contains_any(text: str, terms: tuple[str, ...] | list[str]) -> bool:
    return any(term in text for term in terms)


def extract_evidence_sentences(text: str) -> list[str]:
    issue_terms = [keyword for keywords in ISSUE_KEYWORDS.values() for keyword in keywords]
    evidence = []

    for sentence in re.split(r"(?<=[.!?。])\s+|\n+", text):
        sentence = sentence.strip()
        if len(sentence) < 12:
            continue
        if contains_any(sentence, issue_terms) or PRICE_PATTERN.search(sentence):
            evidence.append(sentence[:360])

    return evidence[:5]


def analyze_post(title: str, body: str, source: str) -> dict:
    title = normalize_text(title)
    body = normalize_text(body)
    text = f"{title} {body}"

    services = match_groups(text, SERVICE_KEYWORDS)
    issues = match_groups(text, ISSUE_KEYWORDS)
    has_wedding_context = contains_any(text, WEDDING_CONTEXT_TERMS)
    has_preference = contains_any(text, PREFERENCE_MARKERS)
    noise_hits = [term for term in NOISE_TERMS if term in text]

    if noise_hits:
        research_use = "제외"
        reject_reason = "웨딩 준비와 무관한 결혼 일반 담론"
    elif source == "dcinside":
        has_preparation_context = services or contains_any(text, DC_PREPARATION_TERMS)
        if issues and has_preparation_context:
            research_use = "핵심 이슈"
            reject_reason = None
        else:
            research_use = "제외"
            reject_reason = "구체적인 웨딩 준비 이슈를 확인하기 어려움"
    elif source == "kgwed" and has_wedding_context and issues:
        research_use = "핵심 이슈"
        reject_reason = None
    elif source == "kgwed" and has_wedding_context and (services or has_preference):
        research_use = "업체 선택 후기"
        reject_reason = None
    else:
        research_use = "제외"
        reject_reason = "웨딩 준비 서비스나 이슈를 확인하기 어려움"

    return {
        "title": title,
        "body_clean": body,
        "service_categories": services,
        "issue_labels": issues,
        "research_use": research_use,
        "price_mentions": sorted(set(PRICE_PATTERN.findall(text))),
        "evidence_sentences": extract_evidence_sentences(text),
        "keep": research_use != "제외",
        "reject_reason": reject_reason,
        "noise_hits": noise_hits,
    }
