"""
Stage 1 scraper for the Sovereign-Sigma Congressional Stock Tracker.

This module downloads newly discovered raw Periodic Transaction Report (PTR)
artifacts from official public disclosure sources only:

  - House Office of the Clerk Financial Disclosure search
  - Senate eFD public search

Parsing, OCR, SQLite persistence, scheduling, and Streamlit UI are intentionally
out of scope for Step 1. A small JSON manifest is used only to avoid
re-downloading the same raw filing across daily runs.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal
from urllib.parse import urlparse

from playwright.async_api import (
    BrowserContext,
    Error as PlaywrightError,
    Page,
    TimeoutError as PlaywrightTimeoutError,
    async_playwright,
)

HOUSE_SEARCH_URL = "https://disclosures-clerk.house.gov/FinancialDisclosure/ViewSearch"
HOUSE_BASE_URL = "https://disclosures-clerk.house.gov"

SENATE_SEARCH_HOME_URL = "https://efdsearch.senate.gov/search/home/"
SENATE_BASE_URL = "https://efdsearch.senate.gov"

DEFAULT_DOWNLOAD_DIR = Path("data/raw_disclosures")
DEFAULT_MANIFEST_PATH = Path("data/raw_disclosures/download_manifest.json")
DEFAULT_TIMEOUT_MS = 45_000
DEFAULT_MAX_DOWNLOADS_PER_SOURCE = 100

PTR_LINK_PATTERNS = (
    re.compile(r"/ptr-pdfs/\d{4}/[^/?#]+\.pdf", re.IGNORECASE),
    re.compile(r"periodic[-_\s]?transaction", re.IGNORECASE),
    re.compile(r"\bptr\b", re.IGNORECASE),
)

BOT_BLOCK_PATTERNS = (
    "access denied",
    "automated access",
    "bot detection",
    "captcha",
    "cloudflare",
    "forbidden",
    "request blocked",
    "unusual traffic",
    "verify you are human",
)

REPORT_TYPE_PATTERNS = (
    "periodic transaction report",
    "periodic transaction",
    "ptr",
)


class ScraperBlockedError(RuntimeError):
    """Raised when a public site appears to block automated access."""


class ScraperTimeoutError(RuntimeError):
    """Raised when a public site does not respond within the configured timeout."""


@dataclass(frozen=True)
class FilingArtifact:
    source: Literal["house", "senate"]
    chamber: Literal["house", "senate"]
    filing_id: str
    report_type: str
    url: str
    title: str
    discovered_at: str
    local_path: str | None = None
    content_type: str | None = None
    sha256: str | None = None

    @property
    def manifest_key(self) -> str:
        return f"{self.source}:{self.filing_id}:{self.url}"


class CongressionalPTRScraper:
    def __init__(
        self,
        download_dir: Path = DEFAULT_DOWNLOAD_DIR,
        manifest_path: Path = DEFAULT_MANIFEST_PATH,
        *,
        headless: bool = True,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        max_downloads_per_source: int = DEFAULT_MAX_DOWNLOADS_PER_SOURCE,
        filing_year: int | None = None,
    ) -> None:
        self.download_dir = download_dir
        self.manifest_path = manifest_path
        self.headless = headless
        self.timeout_ms = timeout_ms
        self.max_downloads_per_source = max_downloads_per_source
        self.filing_year = filing_year or datetime.now(timezone.utc).year
        self.logger = logging.getLogger(self.__class__.__name__)
        self.manifest = self._load_manifest()

    async def run(self, source: Literal["all", "house", "senate"] = "all") -> list[FilingArtifact]:
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=self.headless)
            context = await browser.new_context(
                accept_downloads=True,
                locale="en-US",
                timezone_id="America/New_York",
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/125.0.0.0 Safari/537.36"
                ),
                extra_http_headers={
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            context.set_default_timeout(self.timeout_ms)

            try:
                downloaded: list[FilingArtifact] = []
                if source in {"all", "house"}:
                    downloaded.extend(await self.scrape_house(context))
                if source in {"all", "senate"}:
                    downloaded.extend(await self.scrape_senate(context))
                self._save_manifest()
                return downloaded
            finally:
                await context.close()
                await browser.close()

    async def scrape_house(self, context: BrowserContext) -> list[FilingArtifact]:
        page = await context.new_page()
        try:
            await self._safe_goto(page, HOUSE_SEARCH_URL, "house")
            await self._detect_block(page, "house")
            await self._search_house_ptrs(page)
            await self._detect_block(page, "house")

            artifacts = await self._discover_house_artifacts(page)
            self.logger.info("Discovered %s House PTR candidate links.", len(artifacts))
            return await self._download_new_artifacts(context, artifacts, "house")
        except (ScraperBlockedError, ScraperTimeoutError):
            raise
        except Exception as exc:
            self.logger.exception("House scrape failed safely: %s", exc)
            return []
        finally:
            await page.close()

    async def scrape_senate(self, context: BrowserContext) -> list[FilingArtifact]:
        page = await context.new_page()
        try:
            await self._safe_goto(page, SENATE_SEARCH_HOME_URL, "senate")
            await self._detect_block(page, "senate")
            await self._accept_senate_disclaimer(page)
            await self._search_senate_ptrs(page)
            await self._detect_block(page, "senate")

            artifacts = await self._discover_senate_artifacts(page)
            self.logger.info("Discovered %s Senate PTR candidate links.", len(artifacts))
            return await self._download_new_artifacts(context, artifacts, "senate")
        except (ScraperBlockedError, ScraperTimeoutError):
            raise
        except Exception as exc:
            self.logger.exception("Senate scrape failed safely: %s", exc)
            return []
        finally:
            await page.close()

    async def _safe_goto(self, page: Page, url: str, source: str) -> None:
        try:
            response = await page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)
            if response and response.status >= 400:
                raise ScraperBlockedError(f"{source} returned HTTP {response.status}")
            await page.wait_for_load_state("networkidle", timeout=min(self.timeout_ms, 15_000))
        except PlaywrightTimeoutError as exc:
            message = f"{source} navigation timed out for {self._redact_url(url)}"
            self.logger.error(message)
            raise ScraperTimeoutError(message) from exc
        except PlaywrightError as exc:
            message = f"{source} navigation failed for {self._redact_url(url)}: {exc}"
            self.logger.error(message)
            raise

    async def _detect_block(self, page: Page, source: str) -> None:
        title = ""
        body = ""
        try:
            title = (await page.title()).lower()
            body = (await page.locator("body").inner_text(timeout=5_000)).lower()
        except PlaywrightError:
            body = (await page.content()).lower()

        haystack = f"{title}\n{body}"
        matched = next((pattern for pattern in BOT_BLOCK_PATTERNS if pattern in haystack), None)
        if matched:
            message = (
                f"{source} appears to be blocking automated access "
                f"({matched}); no bypass attempted."
            )
            self.logger.error(message)
            raise ScraperBlockedError(message)

    async def _search_house_ptrs(self, page: Page) -> None:
        await self._select_option_containing(
            page,
            select_name_patterns=("filing year", "filingyear", "year"),
            option_text=str(self.filing_year),
        )
        await self._click_first_matching(
            page,
            selectors=(
                "button:has-text('Search')",
                "input[type='submit'][value*='Search']",
                "input[type='button'][value*='Search']",
                "text=Search",
            ),
        )
        await page.wait_for_load_state("networkidle", timeout=min(self.timeout_ms, 20_000))

    async def _accept_senate_disclaimer(self, page: Page) -> None:
        checkbox = page.get_by_label(re.compile(r"I understand", re.IGNORECASE))
        try:
            if await checkbox.count() > 0:
                await checkbox.first.check()
        except PlaywrightError:
            for selector in ("input[type='checkbox']", "#agree_statement"):
                locator = page.locator(selector)
                if await locator.count() > 0:
                    await locator.first.check()
                    break

        await self._click_first_matching(
            page,
            selectors=(
                "button:has-text('Submit')",
                "button:has-text('Continue')",
                "button:has-text('Agree')",
                "input[type='submit']",
                "text=Submit",
            ),
            required=False,
        )
        await page.wait_for_load_state("networkidle", timeout=min(self.timeout_ms, 20_000))

    async def _search_senate_ptrs(self, page: Page) -> None:
        await self._select_option_containing(
            page,
            select_name_patterns=("report", "report type", "filing type"),
            option_text="Periodic Transaction",
            required=False,
        )
        await self._select_option_containing(
            page,
            select_name_patterns=("year", "filing year"),
            option_text=str(self.filing_year),
            required=False,
        )
        await self._click_first_matching(
            page,
            selectors=(
                "button:has-text('Search')",
                "input[type='submit'][value*='Search']",
                "input[type='button'][value*='Search']",
                "text=Search",
            ),
            required=False,
        )
        await page.wait_for_load_state("networkidle", timeout=min(self.timeout_ms, 20_000))

    async def _discover_house_artifacts(self, page: Page) -> list[FilingArtifact]:
        links = await self._extract_links(page, HOUSE_BASE_URL)
        artifacts: list[FilingArtifact] = []
        seen_urls: set[str] = set()
        discovered_at = self._utc_now()

        for link in links:
            href = link["href"]
            text = link["text"]
            if href in seen_urls:
                continue
            if not self._looks_like_house_ptr(href, text):
                continue

            seen_urls.add(href)
            filing_id = self._filing_id_from_url(href)
            artifacts.append(
                FilingArtifact(
                    source="house",
                    chamber="house",
                    filing_id=filing_id,
                    report_type="PTR",
                    url=href,
                    title=text or f"House PTR {filing_id}",
                    discovered_at=discovered_at,
                )
            )

        return artifacts

    async def _discover_senate_artifacts(self, page: Page) -> list[FilingArtifact]:
        links = await self._extract_links(page, SENATE_BASE_URL)
        artifacts: list[FilingArtifact] = []
        seen_urls: set[str] = set()
        discovered_at = self._utc_now()

        for link in links:
            href = link["href"]
            text = link["text"]
            if href in seen_urls:
                continue
            if not self._looks_like_senate_ptr(href, text):
                continue

            seen_urls.add(href)
            filing_id = self._filing_id_from_url(href)
            artifacts.append(
                FilingArtifact(
                    source="senate",
                    chamber="senate",
                    filing_id=filing_id,
                    report_type="PTR",
                    url=href,
                    title=text or f"Senate PTR {filing_id}",
                    discovered_at=discovered_at,
                )
            )

        return artifacts

    async def _download_new_artifacts(
        self,
        context: BrowserContext,
        artifacts: Iterable[FilingArtifact],
        source: Literal["house", "senate"],
    ) -> list[FilingArtifact]:
        downloaded: list[FilingArtifact] = []
        source_dir = self.download_dir / source / str(self.filing_year)
        source_dir.mkdir(parents=True, exist_ok=True)

        for artifact in artifacts:
            if len(downloaded) >= self.max_downloads_per_source:
                self.logger.info("Reached %s max download cap.", source)
                break
            if artifact.manifest_key in self.manifest["downloaded"]:
                continue

            try:
                saved = await self._download_artifact(context, artifact, source_dir)
            except ScraperBlockedError:
                raise
            except Exception as exc:
                self.logger.warning(
                    "Failed to download %s artifact %s from %s: %s",
                    source,
                    artifact.filing_id,
                    self._redact_url(artifact.url),
                    exc,
                )
                continue

            self.manifest["downloaded"][saved.manifest_key] = asdict(saved)
            downloaded.append(saved)
            self.logger.info(
                "Downloaded %s PTR %s -> %s",
                source,
                saved.filing_id,
                saved.local_path,
            )

        return downloaded

    async def _download_artifact(
        self,
        context: BrowserContext,
        artifact: FilingArtifact,
        source_dir: Path,
    ) -> FilingArtifact:
        response = await context.request.get(artifact.url, timeout=self.timeout_ms)
        content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
        body = await response.body()

        if response.status >= 400:
            raise ScraperBlockedError(
                f"{artifact.source} download returned HTTP {response.status} for "
                f"{self._redact_url(artifact.url)}"
            )

        lower_body = body[:4096].decode("utf-8", errors="ignore").lower()
        if any(pattern in lower_body for pattern in BOT_BLOCK_PATTERNS):
            raise ScraperBlockedError(
                f"{artifact.source} download appears blocked for {self._redact_url(artifact.url)}"
            )

        extension = self._extension_for(artifact.url, content_type)
        file_name = f"{artifact.filing_id}{extension}"
        output_path = self._unique_path(source_dir / file_name)
        output_path.write_bytes(body)

        sha256 = hashlib.sha256(body).hexdigest()
        return FilingArtifact(
            **{
                **asdict(artifact),
                "local_path": str(output_path),
                "content_type": content_type or None,
                "sha256": sha256,
            }
        )

    async def _extract_links(self, page: Page, base_url: str) -> list[dict[str, str]]:
        return await page.eval_on_selector_all(
            "a[href]",
            """
            (anchors, baseUrl) => anchors.map((anchor) => ({
                href: new URL(anchor.getAttribute('href'), baseUrl).toString(),
                text: (anchor.innerText || anchor.textContent || '').trim()
            }))
            """,
            base_url,
        )

    async def _select_option_containing(
        self,
        page: Page,
        *,
        select_name_patterns: tuple[str, ...],
        option_text: str,
        required: bool = True,
    ) -> bool:
        selects = page.locator("select")
        count = await selects.count()

        for index in range(count):
            select = selects.nth(index)
            label_text = await self._nearby_label_text(select)
            html = (await select.evaluate("(node) => node.outerHTML")).lower()
            searchable = f"{label_text}\n{html}"
            if not any(pattern.lower() in searchable for pattern in select_name_patterns):
                continue

            option = await self._option_value_containing(select, option_text)
            if option is None:
                continue
            await select.select_option(option)
            return True

        if required:
            raise RuntimeError(f"Could not select option containing {option_text!r}")
        return False

    async def _option_value_containing(self, select: Any, option_text: str) -> str | None:
        option_text_lower = option_text.lower()
        options = await select.locator("option").evaluate_all(
            """
            (options) => options.map((option) => ({
                value: option.value,
                text: (option.innerText || option.textContent || '').trim()
            }))
            """
        )
        for option in options:
            if option_text_lower in option["text"].lower() or option_text_lower == option["value"]:
                return option["value"]
        return None

    async def _nearby_label_text(self, locator: Any) -> str:
        try:
            return await locator.evaluate(
                """
                (node) => {
                    const id = node.getAttribute('id');
                    const labels = [];
                    if (id) {
                      const explicit = document.querySelector(`label[for="${id}"]`);
                      if (explicit) labels.push(explicit.innerText || explicit.textContent || '');
                    }
                    const parent = node.closest('label, div, form, section');
                    if (parent) labels.push(parent.innerText || parent.textContent || '');
                    return labels.join(' ').trim();
                }
                """
            )
        except PlaywrightError:
            return ""

    async def _click_first_matching(
        self,
        page: Page,
        *,
        selectors: tuple[str, ...],
        required: bool = True,
    ) -> bool:
        for selector in selectors:
            locator = page.locator(selector)
            try:
                if await locator.count() == 0:
                    continue
                await locator.first.click(timeout=5_000)
                return True
            except PlaywrightError:
                continue

        if required:
            raise RuntimeError(f"Could not click any selector: {selectors}")
        return False

    def _looks_like_house_ptr(self, href: str, text: str) -> bool:
        haystack = f"{href}\n{text}"
        return any(pattern.search(haystack) for pattern in PTR_LINK_PATTERNS)

    def _looks_like_senate_ptr(self, href: str, text: str) -> bool:
        haystack = f"{href}\n{text}".lower()
        if any(pattern in haystack for pattern in REPORT_TYPE_PATTERNS):
            return True
        return "/search/view/" in haystack and "report" in haystack

    def _filing_id_from_url(self, url: str) -> str:
        parsed = urlparse(url)
        slug = Path(parsed.path).stem or hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
        return re.sub(r"[^a-zA-Z0-9_.-]+", "_", slug).strip("_")[:96]

    def _extension_for(self, url: str, content_type: str) -> str:
        parsed_suffix = Path(urlparse(url).path).suffix.lower()
        if parsed_suffix in {".pdf", ".html", ".htm", ".xml", ".zip"}:
            return parsed_suffix
        if "pdf" in content_type:
            return ".pdf"
        if "xml" in content_type:
            return ".xml"
        if "zip" in content_type:
            return ".zip"
        return ".html"

    def _unique_path(self, path: Path) -> Path:
        if not path.exists():
            return path

        stem = path.stem
        suffix = path.suffix
        for counter in range(2, 10_000):
            candidate = path.with_name(f"{stem}-{counter}{suffix}")
            if not candidate.exists():
                return candidate
        raise RuntimeError(f"Unable to allocate unique path for {path}")

    def _load_manifest(self) -> dict[str, Any]:
        if not self.manifest_path.exists():
            return {"schema_version": 1, "downloaded": {}}

        try:
            with self.manifest_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict) and isinstance(data.get("downloaded"), dict):
                return data
        except json.JSONDecodeError:
            self.logger.warning("Ignoring corrupt download manifest: %s", self.manifest_path)

        return {"schema_version": 1, "downloaded": {}}

    def _save_manifest(self) -> None:
        payload = {
            **self.manifest,
            "updated_at": self._utc_now(),
        }
        tmp_path = self.manifest_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        tmp_path.replace(self.manifest_path)

    def _redact_url(self, url: str) -> str:
        parsed = urlparse(url)
        return parsed._replace(query="", fragment="").geturl()

    def _utc_now(self) -> str:
        return datetime.now(timezone.utc).isoformat()


async def scrape_once(args: argparse.Namespace) -> list[FilingArtifact]:
    scraper = CongressionalPTRScraper(
        download_dir=Path(args.download_dir),
        manifest_path=Path(args.manifest_path),
        headless=not args.headful,
        timeout_ms=args.timeout_ms,
        max_downloads_per_source=args.max_downloads_per_source,
        filing_year=args.year,
    )
    return await scraper.run(source=args.source)


def configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download newly filed Congressional PTR artifacts.")
    parser.add_argument("--download-dir", default=str(DEFAULT_DOWNLOAD_DIR))
    parser.add_argument("--manifest-path", default=str(DEFAULT_MANIFEST_PATH))
    parser.add_argument("--year", type=int, default=datetime.now(timezone.utc).year)
    parser.add_argument("--source", choices=("all", "house", "senate"), default="all")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--max-downloads-per-source", type=int, default=DEFAULT_MAX_DOWNLOADS_PER_SOURCE)
    parser.add_argument("--headful", action="store_true", help="Run Chromium with a visible window.")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    configure_logging(args.verbose)
    downloaded = asyncio.run(scrape_once(args))
    logging.getLogger("congress_tracker.scraper").info(
        "Scrape completed; downloaded %s new PTR artifacts.", len(downloaded)
    )


if __name__ == "__main__":
    main()
