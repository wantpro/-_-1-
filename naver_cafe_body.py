import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

import pandas as pd

from selenium import webdriver
from selenium.common.exceptions import (
    NoSuchElementException,
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


# =========================================================
# 설정
# =========================================================

DOWNLOADS = Path.home() / "Downloads"

INPUT_FILE = DOWNLOADS / "naver_cafe_article_list.csv"
OUTPUT_FILE = DOWNLOADS / "naver_cafe_articles_with_body.csv"
DEBUG_FOLDER = DOWNLOADS / "naver_cafe_debug"

# 전체 수집 시 None
MAX_ARTICLES = 300

# 로그인 유지용 전용 Chrome 프로필
CHROME_USER_DATA_DIR = DOWNLOADS / "naver_cafe_chrome_profile"
CHROME_PROFILE_DIR = "Default"

# 직접 띄운 Chrome에 붙고 싶으면 "127.0.0.1:9222"로 변경
# 예:
# chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\Downloads\naver_cafe_chrome_profile"
DEBUGGER_ADDRESS = None

PAGE_LOAD_TIMEOUT = 25
DOCUMENT_READY_TIMEOUT = 15
BODY_WAIT_TIMEOUT = 8
LOGIN_WAIT_TIMEOUT = 300

RETRY_PER_ARTICLE = 2
SAVE_EVERY = 10
BETWEEN_ARTICLE_DELAY = 0.25


# =========================================================
# 네이버 카페 선택자
# =========================================================

BODY_SELECTORS = [
    ".se-main-container",
    ".ArticleContentBox .article_viewer",
    ".article_viewer",
    ".ContentRenderer",
    "#postViewArea",
    "#tbody",
    ".se-viewer",
    ".se_component_wrap",
    "[class*='article_viewer']",
    "[class*='ContentRenderer']",
]

TITLE_SELECTORS = [
    ".ArticleTitle .title_text",
    ".ArticleTitle",
    ".title_text",
    ".article_title",
    "h3",
]

BLOCKED_TEXT_PATTERNS = [
    "권한이 없습니다",
    "가입한 멤버만",
    "멤버공개",
    "삭제되었거나",
    "존재하지 않는 게시글",
    "접근 제한",
]


# =========================================================
# CSV 처리
# =========================================================

def read_csv_safely(file_path):
    for encoding in ["utf-8-sig", "utf-8", "cp949"]:
        try:
            return pd.read_csv(file_path, encoding=encoding)
        except UnicodeDecodeError:
            continue

    raise ValueError("CSV 파일 인코딩을 읽을 수 없습니다.")


def is_invalid_title(title):
    title = str(title).strip()

    if not title:
        return True

    invalid_patterns = [
        r"^댓글수",
        r"^\[\d+\]$",
        r"^\d+$",
        r"^댓글$",
    ]

    return any(re.search(pattern, title) for pattern in invalid_patterns)


def normalize_article_url(raw_url):
    url = str(raw_url).strip()

    if not url:
        return ""

    if url.startswith("//"):
        url = "https:" + url
    elif url.startswith("/"):
        url = urljoin("https://cafe.naver.com", url)

    parsed = urlparse(url)

    if not parsed.scheme:
        parsed = urlparse("https://" + url)

    host = parsed.netloc.lower()
    query = parse_qs(parsed.query)

    article_id = query.get("articleid") or query.get("articleId")
    club_id = query.get("clubid") or query.get("clubId")
    menu_id = query.get("menuid") or query.get("menuId")

    path_match = re.search(r"/cafes/(\d+)/articles/(\d+)", parsed.path)
    if path_match:
        club_id = club_id or [path_match.group(1)]
        article_id = article_id or [path_match.group(2)]

    if article_id and club_id:
        normalized_query = {
            "clubid": club_id[0],
            "articleid": article_id[0],
        }

        if menu_id:
            normalized_query["menuid"] = menu_id[0]

        return urlunparse((
            "https",
            "cafe.naver.com",
            "/ArticleRead.nhn",
            "",
            urlencode(normalized_query),
            "",
        ))

    if host == "m.cafe.naver.com":
        host = "cafe.naver.com"

    return urlunparse((
        parsed.scheme or "https",
        host or "cafe.naver.com",
        parsed.path,
        "",
        parsed.query,
        "",
    ))


def get_article_key(url):
    url = str(url)

    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)

        article_id = query.get("articleid") or query.get("articleId")
        club_id = query.get("clubid") or query.get("clubId")

        if article_id:
            return (
                str(club_id[0]) if club_id else "",
                str(article_id[0]),
            )

        match = re.search(r"/cafes/(\d+)/articles/(\d+)", parsed.path)
        if match:
            return match.group(1), match.group(2)

    except Exception:
        pass

    return url.split("#")[0]


def clean_article_list(df):
    if "link" not in df.columns:
        raise ValueError(
            "CSV 파일에 link 열이 없습니다.\n"
            f"현재 열: {list(df.columns)}"
        )

    if "title" not in df.columns:
        df["title"] = ""

    df = df.copy()
    df["title"] = df["title"].fillna("").astype(str).str.strip()
    df["link"] = df["link"].fillna("").astype(str).str.strip()

    df = df[df["link"] != ""]
    df = df[~df["title"].apply(is_invalid_title)]

    df["link"] = df["link"].apply(normalize_article_url)
    df["article_key"] = df["link"].apply(get_article_key)
    df["title_length"] = df["title"].str.len()

    df = (
        df.sort_values("title_length", ascending=False)
        .drop_duplicates(subset=["article_key"], keep="first")
        .drop(columns=["article_key", "title_length"], errors="ignore")
        .reset_index(drop=True)
    )

    return df


# =========================================================
# 로그인 / 세션
# =========================================================

def is_login_page(driver):
    current_url = driver.current_url.lower()
    return "nidlogin" in current_url or "nid.naver.com" in current_url


def has_naver_login_cookie(driver):
    try:
        cookie_names = {cookie.get("name") for cookie in driver.get_cookies()}
    except WebDriverException:
        return False

    return bool({"NID_AUT", "NID_SES"} & cookie_names)


def wait_document_ready(driver, timeout=DOCUMENT_READY_TIMEOUT):
    WebDriverWait(driver, timeout).until(
        lambda d: d.execute_script("return document.readyState")
        in {"interactive", "complete"}
    )


def wait_for_manual_login(driver, reason):
    print()
    print(reason)
    print("열린 Chrome 창에서 네이버 로그인을 완료하세요.")
    print("로그인 후 창을 그대로 두면 자동으로 다음 단계로 넘어갑니다.")

    driver.switch_to.default_content()
    driver.get("https://nid.naver.com/nidlogin.login")

    WebDriverWait(driver, LOGIN_WAIT_TIMEOUT).until(
        lambda d: (not is_login_page(d)) or has_naver_login_cookie(d)
    )

    driver.get("https://cafe.naver.com")
    wait_document_ready(driver)


def ensure_logged_in(driver):
    driver.switch_to.default_content()
    driver.get("https://cafe.naver.com")
    wait_document_ready(driver)

    if is_login_page(driver) or not has_naver_login_cookie(driver):
        wait_for_manual_login(driver, "네이버 로그인 세션이 없습니다.")


# =========================================================
# 본문 추출
# =========================================================

def get_element_text(element):
    text = element.text.strip()

    if not text:
        text = (element.get_attribute("innerText") or "").strip()

    return text


def find_first_text(driver, selectors, min_length=1):
    for selector in selectors:
        try:
            elements = driver.find_elements(By.CSS_SELECTOR, selector)
        except WebDriverException:
            continue

        for element in elements:
            try:
                text = get_element_text(element)

                if len(text.strip()) >= min_length:
                    return text, selector

            except (StaleElementReferenceException, WebDriverException):
                continue

    return "", ""


def page_has_blocked_message(driver):
    try:
        text = driver.find_element(By.TAG_NAME, "body").get_attribute("innerText") or ""
    except (NoSuchElementException, WebDriverException):
        return False

    return any(pattern in text for pattern in BLOCKED_TEXT_PATTERNS)


def wait_for_body_in_current_context(driver, timeout=BODY_WAIT_TIMEOUT):
    end_time = time.time() + timeout

    while time.time() < end_time:
        body, selector = find_first_text(driver, BODY_SELECTORS, min_length=5)

        if body:
            return body, selector

        if page_has_blocked_message(driver):
            return "", "blocked_message"

        time.sleep(0.25)

    return "", ""


def extract_from_current_context(driver, frame_name):
    body, body_selector = wait_for_body_in_current_context(driver)

    if not body:
        return None

    title, title_selector = find_first_text(driver, TITLE_SELECTORS)

    return {
        "page_title": title,
        "body": body,
        "body_selector": body_selector,
        "title_selector": title_selector,
        "frame_name": frame_name,
    }


def extract_from_default_page(driver):
    driver.switch_to.default_content()
    return extract_from_current_context(driver, "default")


def extract_from_cafe_main(driver):
    driver.switch_to.default_content()

    try:
        WebDriverWait(driver, 5).until(
            EC.frame_to_be_available_and_switch_to_it((By.ID, "cafe_main"))
        )
    except TimeoutException:
        return None

    return extract_from_current_context(driver, "cafe_main")


def extract_from_other_iframes(driver):
    driver.switch_to.default_content()

    try:
        frame_count = len(driver.find_elements(By.TAG_NAME, "iframe"))
    except WebDriverException:
        return None

    for index in range(frame_count):
        driver.switch_to.default_content()

        try:
            frames = driver.find_elements(By.TAG_NAME, "iframe")

            if index >= len(frames):
                break

            frame_id = frames[index].get_attribute("id") or ""
            frame_name = frames[index].get_attribute("name") or ""

            if frame_id == "cafe_main" or frame_name == "cafe_main":
                continue

            driver.switch_to.frame(frames[index])

        except WebDriverException:
            continue

        result = extract_from_current_context(driver, f"iframe_{index}")

        if result is not None:
            return result

    return None


def save_debug_files(driver, number):
    DEBUG_FOLDER.mkdir(parents=True, exist_ok=True)
    driver.switch_to.default_content()

    screenshot_path = DEBUG_FOLDER / f"failed_{number:03d}.png"
    html_path = DEBUG_FOLDER / f"failed_{number:03d}.html"

    try:
        driver.save_screenshot(str(screenshot_path))
    except Exception:
        pass

    try:
        html_path.write_text(driver.page_source, encoding="utf-8")
    except Exception:
        pass

    return screenshot_path, html_path


def empty_article_result(status, url, driver=None):
    final_url = url
    browser_title = ""

    if driver is not None:
        try:
            final_url = driver.current_url
            browser_title = driver.title
        except WebDriverException:
            pass

    return {
        "page_title": "",
        "body": "",
        "body_selector": "",
        "title_selector": "",
        "frame_name": "",
        "final_url": final_url,
        "browser_title": browser_title,
        "status": status,
    }


def extract_article_once(driver, url):
    normalized_url = normalize_article_url(url)

    driver.switch_to.default_content()
    driver.get(normalized_url)
    wait_document_ready(driver)

    if is_login_page(driver):
        return empty_article_result("login_required", normalized_url, driver)

    result = extract_from_default_page(driver)

    if result is None:
        result = extract_from_cafe_main(driver)

    if result is None:
        result = extract_from_other_iframes(driver)

    driver.switch_to.default_content()

    if result is None:
        status = "access_blocked" if page_has_blocked_message(driver) else "empty_body"
        return empty_article_result(status, normalized_url, driver)

    return {
        **result,
        "final_url": driver.current_url,
        "browser_title": driver.title,
        "status": "success",
    }


def extract_article(driver, url):
    last_result = None

    for attempt in range(1, RETRY_PER_ARTICLE + 2):
        result = extract_article_once(driver, url)
        last_result = result

        if result["status"] == "success":
            return result

        if result["status"] == "login_required":
            wait_for_manual_login(
                driver,
                f"로그인이 풀렸습니다. 같은 글을 다시 시도합니다. 시도 {attempt}",
            )
            continue

        if result["status"] == "empty_body" and attempt <= RETRY_PER_ARTICLE:
            time.sleep(0.7)
            continue

        return result

    return last_result or empty_article_result("unknown_error", url, driver)


# =========================================================
# 브라우저 생성
# =========================================================

def create_driver():
    options = webdriver.ChromeOptions()
    options.page_load_strategy = "eager"

    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_argument("--disable-popup-blocking")
    options.add_argument("--lang=ko-KR")

    if DEBUGGER_ADDRESS:
        options.add_experimental_option("debuggerAddress", DEBUGGER_ADDRESS)
    else:
        CHROME_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
        options.add_argument(f"--user-data-dir={CHROME_USER_DATA_DIR}")
        options.add_argument(f"--profile-directory={CHROME_PROFILE_DIR}")

    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
    return driver


def save_results(results):
    pd.DataFrame(results).to_csv(
        OUTPUT_FILE,
        index=False,
        encoding="utf-8-sig",
    )


# =========================================================
# 실행
# =========================================================

def main():
    if not INPUT_FILE.exists():
        raise FileNotFoundError(
            "게시글 목록 CSV를 찾을 수 없습니다.\n"
            f"확인 위치: {INPUT_FILE}"
        )

    source_df = read_csv_safely(INPUT_FILE)
    print(f"정리 전 목록 수: {len(source_df)}개")

    source_df = clean_article_list(source_df)
    print(f"댓글/중복 제거 후: {len(source_df)}개")

    if MAX_ARTICLES is None:
        target_df = source_df.copy()
    else:
        target_df = source_df.head(MAX_ARTICLES).copy()

    driver = create_driver()
    results = []

    try:
        ensure_logged_in(driver)

        for number, (_, row) in enumerate(target_df.iterrows(), start=1):
            title = str(row.get("title", ""))
            url = str(row["link"])

            print()
            print(f"[{number}/{len(target_df)}] {title[:60]}")

            try:
                article = extract_article(driver, url)

                if article["status"] == "success":
                    print(f"본문 수집 성공: {len(article['body'])}자")
                    print("본문 선택자:", article["body_selector"])
                    print("페이지 위치:", article["frame_name"])
                else:
                    print("본문을 찾지 못했습니다.")
                    print("상태:", article["status"])
                    print("현재 주소:", article["final_url"])
                    print("브라우저 제목:", article["browser_title"])

                    screenshot, html = save_debug_files(driver, number)
                    print("디버그 화면:", screenshot)
                    print("디버그 HTML:", html)

                results.append({
                    **row.to_dict(),
                    **article,
                })

            except Exception as error:
                print("오류:", type(error).__name__, str(error))
                screenshot, html = save_debug_files(driver, number)

                results.append({
                    **row.to_dict(),
                    **empty_article_result(
                        f"error:{type(error).__name__}",
                        url,
                        driver,
                    ),
                })

                print("디버그 화면:", screenshot)
                print("디버그 HTML:", html)

            if number % SAVE_EVERY == 0:
                save_results(results)
                print(f"중간 저장 완료: {len(results)}개")

            if BETWEEN_ARTICLE_DELAY:
                time.sleep(BETWEEN_ARTICLE_DELAY)

        save_results(results)

        print()
        print("=" * 60)
        print("수집 작업 완료")
        print(f"결과 파일: {OUTPUT_FILE}")
        print("=" * 60)

    finally:
        input("\n크롬을 닫으려면 Enter를 누르세요: ")
        driver.quit()


if __name__ == "__main__":
    main()