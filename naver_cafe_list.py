import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import (
    parse_qs,
    parse_qsl,
    unquote,
    urlencode,
    urljoin,
    urlparse,
    urlunparse,
)

import pandas as pd

from selenium import webdriver
from selenium.common.exceptions import (
    NoSuchElementException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.by import By


# =========================================================
# 사용자 설정
# =========================================================

# 원하는 게시판을 직접 열었을 때 주소창에 표시되는 주소
BOARD_URL = "https://cafe.naver.com/f-e/cafes/24453752/menus/588"

# 최종적으로 수집하고 싶은 게시글 수
TARGET_ARTICLES = 300

# 확인할 최대 페이지 수
# 한 페이지당 15개라면 약 10페이지 필요
MAX_PAGES = 30

# 페이지당 접속 재시도 횟수
MAX_RETRIES = 3

# 글 목록이 나타날 때까지 기다릴 최대 시간
LIST_WAIT_SECONDS = 20

# 페이지를 수집한 뒤 다음 페이지로 넘어가기 전 대기
PAGE_INTERVAL_SECONDS = 1.5

# 공지글 포함 여부
INCLUDE_NOTICES = False

# 이미지 로딩 차단 여부
# 게시판이 이상하게 표시되면 False로 바꿔보세요.
BLOCK_IMAGES = True

# 저장 위치
DOWNLOADS = Path.home() / "Downloads"

OUTPUT_FILE = (
    DOWNLOADS / "naver_cafe_article_list.csv"
)

DEBUG_FOLDER = (
    DOWNLOADS / "naver_cafe_list_debug"
)


# =========================================================
# 네이버 카페 선택자
# =========================================================

# 게시글 목록이 나타났는지 판단하는 선택자
LIST_READY_SELECTORS = [
    "#main-area .article-board",
    "table.article-board",
    ".article-board",
    ".ArticleListArea",
    ".ArticleList",
    ".board-list",
    "td.td_article",
    "a.article[href*='ArticleRead']",
    "a[href*='/cafes/'][href*='/articles/']",
]

# 게시글 한 행 또는 한 항목을 찾는 선택자
ARTICLE_CONTAINER_SELECTORS = [
    "#main-area .article-board tbody tr",
    "table.article-board tbody tr",
    ".article-board tbody tr",
    ".ArticleListItem",
    "li.ArticleListItem",
    ".article-list-item",
    ".board-list li",
]

# 게시글 링크를 찾는 선택자
ARTICLE_LINK_SELECTORS = [
    "a.article",
    "a[href*='ArticleRead.nhn']",
    "a[href*='ArticleRead.naver']",
    "a[href*='articleid=']",
    "a[href*='/cafes/'][href*='/articles/']",
]


# =========================================================
# 기본 문자열 처리
# =========================================================

def clean_title(value):
    """게시글 제목의 줄바꿈과 불필요한 공백을 정리합니다."""
    if value is None:
        return ""

    text = str(value)

    text = re.sub(
        r"\s+",
        " ",
        text,
    ).strip()

    # 댓글 수가 제목 뒤에 붙은 경우 제거
    text = re.sub(
        r"\s*댓글수\s*\[\d+\]\s*$",
        "",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"\s*\(\d+\)\s*$",
        "",
        text,
    )

    return text.strip()


def is_invalid_title(title):
    """댓글 수, 좋아요, 숫자 등 제목이 아닌 텍스트를 제외합니다."""
    title = clean_title(title)

    if not title:
        return True

    patterns = [
        r"^댓글$",
        r"^댓글수.*$",
        r"^댓글\s*\d+$",
        r"^\[\d+\]$",
        r"^\(\d+\)$",
        r"^\d+$",
        r"^공감\s*\d*$",
        r"^좋아요\s*\d*$",
        r"^조회\s*\d*$",
        r"^새글$",
        r"^new$",
    ]

    for pattern in patterns:
        if re.fullmatch(
            pattern,
            title,
            flags=re.IGNORECASE,
        ):
            return True

    return False


# =========================================================
# 게시글 번호 추출
# =========================================================

def get_article_info(url):
    """
    게시글 URL에서 카페 번호와 게시글 번호를 추출합니다.

    반환 예:
    {
        "article_key": "123456:7890",
        "cafe_id": "123456",
        "article_id": "7890"
    }
    """
    if not url:
        return None

    url = str(url).strip()

    # 신형 URL
    # /cafes/카페번호/articles/게시글번호
    path_match = re.search(
        r"/cafes/(\d+)/articles/(\d+)",
        url,
        flags=re.IGNORECASE,
    )

    if path_match:
        cafe_id = path_match.group(1)
        article_id = path_match.group(2)

        return {
            "article_key": (
                f"{cafe_id}:{article_id}"
            ),
            "cafe_id": cafe_id,
            "article_id": article_id,
        }

    # 구형 URL
    # ArticleRead.nhn?clubid=...&articleid=...
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)

        article_values = (
            query.get("articleid")
            or query.get("articleId")
            or query.get("article_id")
        )

        cafe_values = (
            query.get("clubid")
            or query.get("clubId")
            or query.get("cafeid")
            or query.get("cafeId")
            or query.get("search.clubid")
        )

        if article_values:
            article_id = str(
                article_values[0]
            )

            cafe_id = (
                str(cafe_values[0])
                if cafe_values
                else ""
            )

            return {
                "article_key": (
                    f"{cafe_id}:{article_id}"
                ),
                "cafe_id": cafe_id,
                "article_id": article_id,
            }

    except Exception:
        pass

    return None


# =========================================================
# 브라우저 로딩 처리
# =========================================================

def stop_loading(driver):
    """광고·이미지 등 남아 있는 페이지 로딩을 중단합니다."""
    try:
        driver.execute_script(
            "window.stop();"
        )
    except WebDriverException:
        pass


def page_has_article_list(driver):
    """현재 문서 영역에 게시글 목록이 있는지 확인합니다."""
    for selector in LIST_READY_SELECTORS:
        try:
            elements = driver.find_elements(
                By.CSS_SELECTOR,
                selector,
            )

            if elements:
                return True

        except WebDriverException:
            continue

    return False


def switch_to_list_context(driver):
    """
    게시글 목록이 있는 문서 영역으로 전환합니다.

    신형 페이지는 기본 문서,
    구형 카페는 cafe_main iframe에 목록이 있습니다.
    """
    driver.switch_to.default_content()

    if page_has_article_list(driver):
        return "default"

    frame_selectors = [
        "iframe#cafe_main",
        "iframe[name='cafe_main']",
    ]

    for selector in frame_selectors:
        driver.switch_to.default_content()

        frames = driver.find_elements(
            By.CSS_SELECTOR,
            selector,
        )

        for frame in frames:
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(frame)

                if page_has_article_list(driver):
                    return "cafe_main"

            except WebDriverException:
                continue

    driver.switch_to.default_content()

    return None


def wait_for_article_list(
    driver,
    timeout=LIST_WAIT_SECONDS,
):
    """
    페이지 전체가 아니라 게시글 목록이 나타날 때까지만 기다립니다.
    """
    end_time = time.time() + timeout

    while time.time() < end_time:
        try:
            context = switch_to_list_context(
                driver
            )

            if context is not None:
                return context

        except WebDriverException:
            pass

        time.sleep(0.5)

    driver.switch_to.default_content()

    return None


def safe_get(
    driver,
    url,
    retries=MAX_RETRIES,
):
    """
    게시글 목록 페이지에 접속합니다.

    페이지 전체 로딩이 끝나지 않아도 목록이 나타나면
    남은 로딩을 중단하고 성공으로 처리합니다.
    """
    for attempt in range(
        1,
        retries + 1,
    ):
        print(
            f"접속 시도 {attempt}/{retries}"
        )

        driver.switch_to.default_content()

        try:
            driver.get(url)

        except TimeoutException:
            print(
                "페이지 전체 로딩은 시간 초과됐습니다."
            )
            print(
                "현재 표시된 글 목록을 확인합니다."
            )

            stop_loading(driver)

        except WebDriverException as error:
            print(
                "접속 오류:",
                type(error).__name__,
            )

            if attempt < retries:
                time.sleep(attempt * 2)
                continue

            return False

        time.sleep(0.8)

        try:
            current_url = driver.current_url
        except WebDriverException:
            current_url = ""

        if "nidlogin" in current_url:
            print(
                "로그인이 풀려 로그인 페이지로 이동했습니다."
            )
            return False

        context = wait_for_article_list(
            driver,
            timeout=LIST_WAIT_SECONDS,
        )

        if context is not None:
            print(
                "게시글 목록 확인:",
                context,
            )

            stop_loading(driver)

            return True

        print(
            "게시글 목록이 나타나지 않았습니다."
        )

        if attempt < retries:
            time.sleep(attempt * 2)

    return False


# =========================================================
# 실제 게시판 주소 확인
# =========================================================

def resolve_board_list_url(driver):
    """
    카페 외부 화면 안에 있는 cafe_main iframe의 실제 주소를 찾습니다.
    """
    driver.switch_to.default_content()

    end_time = time.time() + 10

    while time.time() < end_time:
        frames = driver.find_elements(
            By.CSS_SELECTOR,
            "iframe#cafe_main, "
            "iframe[name='cafe_main']",
        )

        for frame in frames:
            src = (
                frame.get_attribute("src")
                or ""
            ).strip()

            if src and src != "about:blank":
                return urljoin(
                    driver.current_url,
                    src,
                )

        time.sleep(0.5)

    # iframe_url 쿼리 파라미터 확인
    parsed = urlparse(
        driver.current_url
    )

    query = parse_qs(
        parsed.query
    )

    iframe_values = query.get(
        "iframe_url"
    )

    if iframe_values:
        iframe_url = unquote(
            iframe_values[0]
        )

        return urljoin(
            "https://cafe.naver.com",
            iframe_url,
        )

    return driver.current_url


# =========================================================
# 페이지 URL 생성
# =========================================================

def set_page_parameter(
    base_url,
    page_number,
    parameter_name,
):
    """주소의 페이지 번호를 지정한 값으로 변경합니다."""
    parsed = urlparse(base_url)

    query_items = parse_qsl(
        parsed.query,
        keep_blank_values=True,
    )

    # 기존 페이지 번호 제거
    query_items = [
        (key, value)
        for key, value in query_items
        if key not in {
            "page",
            "search.page",
        }
    ]

    query_items.append(
        (
            parameter_name,
            str(page_number),
        )
    )

    new_query = urlencode(
        query_items,
        doseq=True,
    )

    return urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            new_query,
            parsed.fragment,
        )
    )


def build_page_candidates(
    base_url,
    page_number,
):
    """
    네이버 카페 화면에 따라 page와 search.page를 모두 시험합니다.
    """
    parsed = urlparse(base_url)

    query_keys = {
        key
        for key, _ in parse_qsl(
            parsed.query,
            keep_blank_values=True,
        )
    }

    is_old_list = (
        "ArticleList" in parsed.path
        or "search.clubid" in query_keys
        or "search.menuid" in query_keys
    )

    if is_old_list:
        parameter_order = [
            "search.page",
            "page",
        ]
    else:
        parameter_order = [
            "page",
            "search.page",
        ]

    candidates = []

    # 1페이지는 원래 주소도 우선 시험
    if page_number == 1:
        candidates.append(base_url)

    for parameter_name in parameter_order:
        candidate = set_page_parameter(
            base_url,
            page_number,
            parameter_name,
        )

        if candidate not in candidates:
            candidates.append(candidate)

    return candidates


# =========================================================
# 게시글 항목 분석
# =========================================================

def extract_anchor_title(anchor):
    """링크 요소에서 가장 적절한 제목을 추출합니다."""
    candidates = [
        anchor.get_attribute("innerText"),
        anchor.get_attribute("title"),
        anchor.get_attribute("aria-label"),
        anchor.text,
    ]

    for candidate in candidates:
        title = clean_title(candidate)

        if title:
            return title

    return ""


def is_notice_container(container):
    """현재 게시글 행이 공지글인지 확인합니다."""
    try:
        class_name = (
            container.get_attribute("class")
            or ""
        ).lower()

        if "notice" in class_name:
            return True

        text = clean_title(
            container.get_attribute("innerText")
            or container.text
        )

        if re.match(
            r"^공지(?:\s|$)",
            text,
        ):
            return True

    except WebDriverException:
        pass

    return False


def get_best_article_from_container(
    container,
    page_number,
):
    """
    게시글 한 행 안에서 제목 링크를 찾아 반환합니다.

    같은 행에 제목·썸네일·댓글 링크가 있으면
    정상적인 제목 중 가장 긴 텍스트를 선택합니다.
    """
    best_candidate = None

    for selector in ARTICLE_LINK_SELECTORS:
        try:
            anchors = container.find_elements(
                By.CSS_SELECTOR,
                selector,
            )
        except WebDriverException:
            continue

        for anchor in anchors:
            try:
                href = anchor.get_attribute(
                    "href"
                )

                title = extract_anchor_title(
                    anchor
                )

                if not href:
                    continue

                href = urljoin(
                    "https://cafe.naver.com",
                    href,
                )

                article_info = get_article_info(
                    href
                )

                if article_info is None:
                    continue

                if is_invalid_title(title):
                    continue

                candidate = {
                    "page": page_number,
                    "title": title,
                    "link": href,
                    "cafe_id": (
                        article_info["cafe_id"]
                    ),
                    "article_id": (
                        article_info["article_id"]
                    ),
                    "article_key": (
                        article_info["article_key"]
                    ),
                }

                if (
                    best_candidate is None
                    or len(candidate["title"])
                    > len(best_candidate["title"])
                ):
                    best_candidate = candidate

            except WebDriverException:
                continue
            except Exception:
                continue

    return best_candidate


def collect_with_containers(
    driver,
    page_number,
):
    """
    게시글 행 단위로 수집합니다.
    가장 정확한 방식이므로 먼저 시도합니다.
    """
    for selector in ARTICLE_CONTAINER_SELECTORS:
        try:
            containers = driver.find_elements(
                By.CSS_SELECTOR,
                selector,
            )
        except WebDriverException:
            continue

        if not containers:
            continue

        records_by_key = {}

        for container in containers:
            try:
                if (
                    not INCLUDE_NOTICES
                    and is_notice_container(
                        container
                    )
                ):
                    continue

                candidate = (
                    get_best_article_from_container(
                        container,
                        page_number,
                    )
                )

                if candidate is None:
                    continue

                key = candidate["article_key"]

                previous = records_by_key.get(
                    key
                )

                if (
                    previous is None
                    or len(candidate["title"])
                    > len(previous["title"])
                ):
                    records_by_key[key] = candidate

            except WebDriverException:
                continue

        records = list(
            records_by_key.values()
        )

        if records:
            print(
                "사용한 게시글 행 선택자:",
                selector,
            )

            return records

    return []


def collect_with_fallback(
    driver,
    page_number,
):
    """
    행 단위 선택자를 찾지 못한 경우 목록 영역의 링크로 수집합니다.
    """
    root_selectors = [
        "#main-area .article-board",
        "table.article-board",
        ".article-board",
        ".ArticleListArea",
        ".ArticleList",
        ".board-list",
    ]

    for root_selector in root_selectors:
        try:
            roots = driver.find_elements(
                By.CSS_SELECTOR,
                root_selector,
            )
        except WebDriverException:
            continue

        if not roots:
            continue

        records_by_key = {}

        for root in roots:
            for link_selector in ARTICLE_LINK_SELECTORS:
                try:
                    anchors = root.find_elements(
                        By.CSS_SELECTOR,
                        link_selector,
                    )
                except WebDriverException:
                    continue

                for anchor in anchors:
                    try:
                        href = anchor.get_attribute(
                            "href"
                        )

                        title = extract_anchor_title(
                            anchor
                        )

                        if not href:
                            continue

                        href = urljoin(
                            "https://cafe.naver.com",
                            href,
                        )

                        article_info = (
                            get_article_info(href)
                        )

                        if article_info is None:
                            continue

                        if is_invalid_title(title):
                            continue

                        candidate = {
                            "page": page_number,
                            "title": title,
                            "link": href,
                            "cafe_id": (
                                article_info[
                                    "cafe_id"
                                ]
                            ),
                            "article_id": (
                                article_info[
                                    "article_id"
                                ]
                            ),
                            "article_key": (
                                article_info[
                                    "article_key"
                                ]
                            ),
                        }

                        key = candidate[
                            "article_key"
                        ]

                        previous = (
                            records_by_key.get(key)
                        )

                        if (
                            previous is None
                            or len(candidate["title"])
                            > len(previous["title"])
                        ):
                            records_by_key[
                                key
                            ] = candidate

                    except WebDriverException:
                        continue

        records = list(
            records_by_key.values()
        )

        if records:
            print(
                "대체 목록 선택자 사용:",
                root_selector,
            )

            return records

    return []


def collect_current_page(
    driver,
    page_number,
):
    """현재 페이지의 고유 게시글을 수집합니다."""
    context = wait_for_article_list(
        driver,
        timeout=10,
    )

    if context is None:
        return []

    records = collect_with_containers(
        driver,
        page_number,
    )

    if not records:
        records = collect_with_fallback(
            driver,
            page_number,
        )

    # 같은 글이 여러 번 들어온 경우 다시 제거
    unique_records = {}

    for record in records:
        key = record["article_key"]

        previous = unique_records.get(key)

        if (
            previous is None
            or len(record["title"])
            > len(previous["title"])
        ):
            unique_records[key] = record

    return list(
        unique_records.values()
    )


# =========================================================
# 파일 저장 및 디버그
# =========================================================

def save_records(
    records,
    output_file,
):
    """수집 결과를 CSV로 저장합니다."""
    columns = [
        "page",
        "title",
        "link",
        "cafe_id",
        "article_id",
    ]

    cleaned_records = []

    for record in records:
        cleaned_records.append({
            column: record.get(column, "")
            for column in columns
        })

    df = pd.DataFrame(
        cleaned_records,
        columns=columns,
    )

    try:
        df.to_csv(
            output_file,
            index=False,
            encoding="utf-8-sig",
        )

        return output_file

    except PermissionError:
        timestamp = datetime.now().strftime(
            "%Y%m%d_%H%M%S"
        )

        alternative = (
            DOWNLOADS
            / (
                "naver_cafe_article_list_"
                f"{timestamp}.csv"
            )
        )

        df.to_csv(
            alternative,
            index=False,
            encoding="utf-8-sig",
        )

        print()
        print(
            "기존 CSV가 엑셀에서 열려 있어 "
            "새 파일명으로 저장했습니다."
        )

        return alternative


def save_debug(
    driver,
    page_number,
    suffix="failed",
):
    """실패한 페이지의 화면과 HTML을 저장합니다."""
    DEBUG_FOLDER.mkdir(
        parents=True,
        exist_ok=True,
    )

    screenshot_path = (
        DEBUG_FOLDER
        / f"{suffix}_{page_number:03d}.png"
    )

    html_path = (
        DEBUG_FOLDER
        / f"{suffix}_{page_number:03d}.html"
    )

    try:
        driver.save_screenshot(
            str(screenshot_path)
        )
    except Exception:
        pass

    try:
        html_path.write_text(
            driver.page_source,
            encoding="utf-8",
        )
    except Exception:
        pass

    return screenshot_path, html_path


# =========================================================
# 실행
# =========================================================

def main():
    if (
        not BOARD_URL
        or BOARD_URL
        == "여기에_게시판_URL_붙여넣기"
    ):
        raise ValueError(
            "코드 상단 BOARD_URL에 "
            "실제 게시판 주소를 입력하세요."
        )

    options = webdriver.ChromeOptions()

    # 이미지 등 모든 파일의 로딩 완료를 기다리지 않음
    options.page_load_strategy = "eager"

    options.add_argument(
        "--start-maximized"
    )

    options.add_argument(
        "--disable-notifications"
    )

    options.add_argument(
        "--disable-popup-blocking"
    )

    if BLOCK_IMAGES:
        options.add_experimental_option(
            "prefs",
            {
                "profile.managed_default_content_settings.images": 2,
                "profile.default_content_setting_values.notifications": 2,
            },
        )

    driver = webdriver.Chrome(
        options=options
    )

    # driver.get이 무한정 멈추지 않도록 제한
    driver.set_page_load_timeout(20)

    all_records = {}
    previous_page_keys = None
    repeated_page_count = 0
    consecutive_failure_count = 0

    active_output_file = OUTPUT_FILE

    try:
        # -------------------------------------------------
        # 직접 로그인
        # -------------------------------------------------

        try:
            driver.get(
                "https://nid.naver.com/nidlogin.login"
            )
        except TimeoutException:
            stop_loading(driver)

        print()
        print(
            "열린 크롬 창에서 네이버에 직접 로그인하세요."
        )

        input(
            "로그인 완료 후 Enter를 누르세요: "
        )

        # -------------------------------------------------
        # 게시판 최초 접속
        # -------------------------------------------------

        driver.switch_to.default_content()

        try:
            driver.get(BOARD_URL)
        except TimeoutException:
            print(
                "게시판 전체 로딩은 시간 초과됐지만 "
                "현재 화면을 사용합니다."
            )
            stop_loading(driver)

        time.sleep(2)

        list_url = resolve_board_list_url(
            driver
        )

        print()
        print("실제 게시판 목록 주소:")
        print(list_url)
        print()

        # -------------------------------------------------
        # 여러 페이지 수집
        # -------------------------------------------------

        for page_number in range(
            1,
            MAX_PAGES + 1,
        ):
            if (
                len(all_records)
                >= TARGET_ARTICLES
            ):
                break

            print()
            print("=" * 65)
            print(
                f"{page_number}페이지 수집 시작"
            )
            print("=" * 65)

            page_records = None
            accepted_url = None

            page_candidates = (
                build_page_candidates(
                    list_url,
                    page_number,
                )
            )

            for candidate_number, page_url in enumerate(
                page_candidates,
                start=1,
            ):
                print()
                print(
                    "페이지 주소 후보 "
                    f"{candidate_number}/"
                    f"{len(page_candidates)}"
                )
                print(page_url)

                loaded = safe_get(
                    driver,
                    page_url,
                    retries=MAX_RETRIES,
                )

                if not loaded:
                    print(
                        "이 주소에서는 목록을 불러오지 못했습니다."
                    )
                    continue

                current_records = (
                    collect_current_page(
                        driver,
                        page_number,
                    )
                )

                current_keys = {
                    record["article_key"]
                    for record in current_records
                }

                print(
                    "현재 주소에서 찾은 고유 게시글:",
                    len(current_records),
                )

                if not current_records:
                    continue

                # 2페이지 이상인데 이전 페이지와 완전히 같으면
                # 페이지 파라미터가 적용되지 않은 것
                if (
                    page_number > 1
                    and previous_page_keys is not None
                    and current_keys
                    == previous_page_keys
                ):
                    print(
                        "이전 페이지와 같은 목록입니다."
                    )
                    print(
                        "다른 페이지 주소 방식을 시험합니다."
                    )
                    continue

                page_records = current_records
                accepted_url = page_url
                break

            # 모든 주소 후보 실패
            if page_records is None:
                consecutive_failure_count += 1

                print()
                print(
                    f"{page_number}페이지 수집 실패"
                )

                screenshot, html = save_debug(
                    driver,
                    page_number,
                    suffix="failed",
                )

                print("실패 화면:", screenshot)
                print("실패 HTML:", html)

                # 일시적인 한 페이지 실패는 넘김
                if consecutive_failure_count < 3:
                    print(
                        "다음 페이지를 계속 시도합니다."
                    )
                    continue

                print(
                    "3페이지 연속 실패하여 종료합니다."
                )
                break

            consecutive_failure_count = 0

            page_keys = {
                record["article_key"]
                for record in page_records
            }

            if (
                previous_page_keys is not None
                and page_keys == previous_page_keys
            ):
                repeated_page_count += 1
            else:
                repeated_page_count = 0

            previous_page_keys = page_keys

            new_count = 0

            for record in page_records:
                key = record["article_key"]

                if key in all_records:
                    continue

                all_records[key] = record
                new_count += 1

                if (
                    len(all_records)
                    >= TARGET_ARTICLES
                ):
                    break

            print()
            print("사용한 주소:")
            print(accepted_url)

            print(
                "현재 페이지 고유 게시글:",
                len(page_records),
            )

            print(
                "이번 페이지에서 새로 추가:",
                new_count,
            )

            print(
                "현재까지 누적:",
                len(all_records),
            )

            active_output_file = save_records(
                list(all_records.values()),
                active_output_file,
            )

            print(
                "중간 저장 완료:",
                active_output_file,
            )

            if repeated_page_count >= 1:
                print(
                    "같은 페이지가 반복되어 종료합니다."
                )
                break

            if new_count == 0:
                print(
                    "새로운 게시글이 없어 종료합니다."
                )
                break

            time.sleep(
                PAGE_INTERVAL_SECONDS
            )

        # -------------------------------------------------
        # 최종 저장
        # -------------------------------------------------

        final_records = list(
            all_records.values()
        )

        active_output_file = save_records(
            final_records,
            active_output_file,
        )

        print()
        print("=" * 65)
        print("게시글 목록 수집 완료")
        print(
            "수집한 고유 게시글:",
            len(final_records),
        )
        print("저장 위치:")
        print(active_output_file)
        print("=" * 65)

    finally:
        input(
            "\n크롬을 닫으려면 Enter를 누르세요: "
        )

        driver.quit()


if __name__ == "__main__":
    main()