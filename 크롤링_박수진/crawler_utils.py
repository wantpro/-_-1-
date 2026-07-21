from __future__ import annotations

import hashlib
import random
import time
from urllib import robotparser
from urllib.parse import parse_qs, urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


USER_AGENT = "WeddingResearchCrawler/1.0"

REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "ko-KR,ko;q=0.9",
}

RETRY = Retry(
    total=2,
    backoff_factor=2,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["GET"],
)


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(REQUEST_HEADERS)
    session.mount("https://", HTTPAdapter(max_retries=RETRY))
    return session


SESSION = build_session()
_ROBOTS_CACHE: dict[str, robotparser.RobotFileParser | None] = {}


def robots_allowed(url: str) -> bool:
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    robots_url = f"{origin}/robots.txt"

    if origin in _ROBOTS_CACHE:
        cached = _ROBOTS_CACHE[origin]
        return True if cached is None else cached.can_fetch(USER_AGENT, url)

    rp = robotparser.RobotFileParser()
    rp.set_url(robots_url)

    try:
        rp.read()
        _ROBOTS_CACHE[origin] = rp
        return rp.can_fetch(USER_AGENT, url)
    except Exception as exc:
        print(f"[ROBOTS CHECK FAILED, CONTINUING] {robots_url} ({exc.__class__.__name__})")
        _ROBOTS_CACHE[origin] = None
        return True


def fetch_soup(
    url: str,
    *,
    session: requests.Session = SESSION,
    min_delay: float = 3,
    max_delay: float = 6,
) -> BeautifulSoup | None:
    if not robots_allowed(url):
        print(f"[ROBOTS BLOCKED OR UNAVAILABLE] {url}")
        return None

    time.sleep(random.uniform(min_delay, max_delay))

    try:
        response = session.get(url, timeout=20)
    except requests.RequestException as exc:
        print(f"[REQUEST FAILED] {exc.__class__.__name__}: {url}")
        return None

    if response.status_code in {403, 429}:
        print(f"[ACCESS BLOCKED] {response.status_code}: {url}")
        return None

    try:
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"[REQUEST FAILED] {exc.__class__.__name__}: {url}")
        return None

    return BeautifulSoup(response.text, "html.parser")


def clean_text(node) -> str:
    if node is None:
        return ""

    for removable in node.select("script, style, iframe, form, nav, footer, .advertisement"):
        removable.decompose()

    return " ".join(node.get_text(" ", strip=True).split())


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def query_value(url: str, key: str) -> str:
    return parse_qs(urlparse(url).query).get(key, [""])[0]
