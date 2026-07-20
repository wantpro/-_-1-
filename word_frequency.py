from collections import Counter
from pathlib import Path
import re

import pandas as pd
from kiwipiepy import Kiwi


# =========================================================
# 사용자 설정
# =========================================================

DOWNLOADS = Path.home() / "Downloads"

# 본문 수집 결과 파일
INPUT_FILE = DOWNLOADS / "naver_cafe_articles_with_body.csv"

# 출력 파일
ARTICLE_FREQUENCY_FILE = DOWNLOADS / "article_word_frequency.csv"
ARTICLE_SUMMARY_FILE = DOWNLOADS / "article_top_words.csv"
OVERALL_FREQUENCY_FILE = DOWNLOADS / "overall_word_frequency.csv"

# 게시글마다 보여줄 상위 단어 개수
TOP_N = 30

# 최소 단어 길이
MIN_WORD_LENGTH = 2


# 분석에서 제외할 단어
# 결과를 확인한 뒤 불필요한 단어를 계속 추가하면 됩니다.
STOPWORDS = {
    "이번",
    "오늘",
    "내일",
    "어제",
    "정도",
    "부분",
    "관련",
    "대한",
    "통해",
    "이후",
    "때문",
    "경우",
    "사람",
    "생각",
    "느낌",
    "질문",
    "내용",
    "진짜",
    "정말",
    "그냥",
    "조금",
    "뭔가",
    "저희",
    "제가",
    "자신",
    "여러분",
    "감사",
    "안녕",
    "사진",
    "댓글",
    "게시글",
    "멤버",
    "정보",
    "금지",
    "삭제",
    "요청",
    "고민",
    "작성",
    "기준",
    "이상",
    "공개",
    "성의",
    "준비",
    "고민",
    "추천",
    "설정",
    "최소",
    "pc",
    "글자",
    "결혼",
    "웨딩",
    "과정",
    "제이웨딩",
    "사용",
    "포인트",
    "게시",
    "주관",
    "제공",
    "공유",
}


# =========================================================
# 함수
# =========================================================

def read_csv_safely(file_path: Path) -> pd.DataFrame:
    """여러 인코딩을 순서대로 시도해 CSV를 읽습니다."""
    encodings = [
        "utf-8-sig",
        "utf-8",
        "cp949",
    ]

    for encoding in encodings:
        try:
            return pd.read_csv(
                file_path,
                encoding=encoding,
            )
        except UnicodeDecodeError:
            continue

    raise UnicodeDecodeError(
        "unknown",
        b"",
        0,
        1,
        "CSV 파일의 인코딩을 확인할 수 없습니다.",
    )


def clean_text(text: object) -> str:
    """본문 분석을 방해하는 URL과 불필요한 기호를 제거합니다."""
    if pd.isna(text):
        return ""

    text = str(text)

    # URL 제거
    text = re.sub(
        r"https?://\S+|www\.\S+",
        " ",
        text,
    )

    # 이메일 제거
    text = re.sub(
        r"\S+@\S+\.\S+",
        " ",
        text,
    )

    # 숫자 제거
    text = re.sub(
        r"\d+",
        " ",
        text,
    )

    # 한글, 영어, 공백 외 문자 제거
    text = re.sub(
        r"[^가-힣a-zA-Z\s]",
        " ",
        text,
    )

    # 연속 공백 정리
    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    return text.strip()


def extract_words(
    text: object,
    kiwi: Kiwi,
) -> list[str]:
    """
    본문에서 일반명사, 고유명사, 영어 단어를 추출합니다.

    NNG: 일반명사
    NNP: 고유명사
    SL: 영어 및 외국어
    """
    cleaned = clean_text(text)

    if not cleaned:
        return []

    words = []

    for token in kiwi.tokenize(cleaned):
        if token.tag not in {
            "NNG",
            "NNP",
            "SL",
        }:
            continue

        word = token.form.strip().lower()

        if len(word) < MIN_WORD_LENGTH:
            continue

        if word in STOPWORDS:
            continue

        # 자음이나 모음만 있는 토큰 제거
        if re.fullmatch(r"[ㄱ-ㅎㅏ-ㅣ]+", word):
            continue

        words.append(word)

    return words


def find_text_column(
    dataframe: pd.DataFrame,
) -> str:
    """본문이 들어 있는 열을 자동으로 찾습니다."""
    candidates = [
        "body",
        "content",
        "article_body",
        "description",
        "text",
    ]

    for candidate in candidates:
        if candidate in dataframe.columns:
            return candidate

    raise ValueError(
        "본문 열을 찾지 못했습니다.\n"
        f"현재 열 이름: {list(dataframe.columns)}\n"
        "코드의 본문 열 후보를 실제 CSV 열 이름에 맞게 수정하세요."
    )


def get_article_title(
    row: pd.Series,
    row_number: int,
) -> str:
    """page_title과 title 중 내용이 있는 제목을 사용합니다."""
    for column in [
        "page_title",
        "title",
    ]:
        if column not in row.index:
            continue

        value = row[column]

        if pd.notna(value) and str(value).strip():
            return str(value).strip()

    return f"게시글 {row_number}"


def get_article_link(row: pd.Series) -> str:
    """링크가 있는 경우 반환합니다."""
    for column in [
        "final_url",
        "link",
        "url",
    ]:
        if column not in row.index:
            continue

        value = row[column]

        if pd.notna(value) and str(value).strip():
            return str(value).strip()

    return ""


# =========================================================
# 분석 실행
# =========================================================

def main() -> None:
    if not INPUT_FILE.exists():
        raise FileNotFoundError(
            f"입력 파일을 찾지 못했습니다:\n{INPUT_FILE}\n\n"
            "파일 이름과 저장 위치를 확인하세요."
        )

    df = read_csv_safely(INPUT_FILE)

    print("CSV 열 이름:")
    print(list(df.columns))
    print()

    body_column = find_text_column(df)

    print(f"분석할 본문 열: {body_column}")
    print(f"전체 게시글 수: {len(df)}")
    print()

    kiwi = Kiwi()

    # 전체 단어 출현 횟수
    overall_counter = Counter()

    # 해당 단어가 등장한 게시글 개수
    document_counter = Counter()

    # 게시글별 단어 빈도표
    article_frequency_rows = []

    # 게시글별 요약표
    article_summary_rows = []

    analyzed_count = 0

    for row_number, (_, row) in enumerate(
        df.iterrows(),
        start=1,
    ):
        title = get_article_title(
            row,
            row_number,
        )
        link = get_article_link(row)
        body = row.get(body_column, "")

        words = extract_words(
            body,
            kiwi,
        )

        if not words:
            print(
                f"[건너뜀] {row_number}: "
                f"분석 가능한 본문이 없습니다."
            )
            continue

        counter = Counter(words)
        top_words = counter.most_common(TOP_N)

        analyzed_count += 1

        # 전체 빈도에 추가
        overall_counter.update(counter)

        # 한 게시글에서 여러 번 나와도 게시글 수는 1회만 증가
        document_counter.update(counter.keys())

        # 게시글별 세로형 빈도표
        for rank, (word, count) in enumerate(
            top_words,
            start=1,
        ):
            article_frequency_rows.append({
                "article_number": row_number,
                "title": title,
                "link": link,
                "rank": rank,
                "word": word,
                "count": count,
            })

        # 한 게시글을 한 행으로 요약
        article_summary_rows.append({
            "article_number": row_number,
            "title": title,
            "link": link,
            "total_words": len(words),
            "unique_words": len(counter),
            "top_words": " | ".join(
                f"{word}({count})"
                for word, count in top_words
            ),
        })

        print(
            f"[완료] {row_number}/{len(df)} "
            f"{title[:40]}"
        )

    # =====================================================
    # 결과 저장
    # =====================================================

    article_frequency_df = pd.DataFrame(
        article_frequency_rows
    )

    article_summary_df = pd.DataFrame(
        article_summary_rows
    )

    overall_rows = []

    for word, total_count in overall_counter.most_common():
        article_count = document_counter[word]

        overall_rows.append({
            "word": word,
            "total_count": total_count,
            "article_count": article_count,
            "article_ratio_percent": round(
                article_count
                / analyzed_count
                * 100,
                2,
            ) if analyzed_count else 0,
        })

    overall_df = pd.DataFrame(overall_rows)

    article_frequency_df.to_csv(
        ARTICLE_FREQUENCY_FILE,
        index=False,
        encoding="utf-8-sig",
    )

    article_summary_df.to_csv(
        ARTICLE_SUMMARY_FILE,
        index=False,
        encoding="utf-8-sig",
    )

    overall_df.to_csv(
        OVERALL_FREQUENCY_FILE,
        index=False,
        encoding="utf-8-sig",
    )

    print()
    print("=" * 60)
    print(f"분석 완료 게시글: {analyzed_count}개")
    print()
    print("저장된 파일:")
    print(ARTICLE_FREQUENCY_FILE)
    print(ARTICLE_SUMMARY_FILE)
    print(OVERALL_FREQUENCY_FILE)
    print("=" * 60)

    if not overall_df.empty:
        print()
        print("전체 게시글 상위 단어 30개:")
        print(
            overall_df.head(30).to_string(
                index=False
            )
        )


if __name__ == "__main__":
    main()