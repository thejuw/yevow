"""
End-to-end Congressional Tracker runner.

This is intended to run outside the trading Worker, either on a local cron,
GitHub Actions, or a Cloudflare Container. The Cloudflare Worker stores runs,
normalized records, and PnL marks through /admin/congress/* endpoints.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .conflicts import fetch_committee_assignments
from .ocr_pipeline import extract_text_from_pdf
from .scraper import CongressionalPTRScraper, FilingArtifact
from .standardize import CleaningIssue, standardize_transaction_row

AMOUNT_BAND_RE = re.compile(
    r"\$?\s*[0-9][0-9,]*\s*(?:-|to|–|—)\s*\$?\s*[0-9][0-9,]*",
    re.IGNORECASE,
)
DATE_TOKEN_RE = re.compile(r"\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}")
TRANSACTION_TYPE_TOKEN_RE = re.compile(
    r"(?:^|\s|\])(?P<type>Purchase|Purchased|Sale|Sold|Exchange|P|S)(?:\s|\(|$)",
    re.IGNORECASE,
)


class CongressETLPipeline:
    def __init__(
        self,
        *,
        api_base: str | None = None,
        admin_token: str | None = None,
        run_id: str | None = None,
        download_dir: Path = Path("data/raw_disclosures"),
        source: str = "all",
        headless: bool = True,
    ) -> None:
        self.api_base = (api_base or os.getenv("SOVEREIGN_API_BASE") or "").rstrip("/")
        self.admin_token = admin_token or os.getenv("SOVEREIGN_ADMIN_TOKEN")
        self.admin_password = os.getenv("SOVEREIGN_ADMIN_PASSWORD")
        self.run_id = run_id or os.getenv("CONGRESS_RUN_ID")
        self.download_dir = download_dir
        self.source = source
        self.headless = headless
        self.logger = logging.getLogger(self.__class__.__name__)

    async def run(self) -> dict[str, Any]:
        artifacts = await self._scrape()
        payload = self._build_payload(artifacts)

        if not self.admin_token and self.api_base and self.admin_password:
            self.admin_token = self._login_for_token()

        if self.api_base and self.admin_token:
            self._post_payload(payload)
        else:
            self.logger.warning(
                "SOVEREIGN_API_BASE or SOVEREIGN_ADMIN_TOKEN not configured; payload not posted."
            )

        return payload

    async def _scrape(self) -> list[FilingArtifact]:
        scraper = CongressionalPTRScraper(
            download_dir=self.download_dir,
            headless=self.headless,
            max_downloads_per_source=int(os.getenv("CONGRESS_MAX_DAILY_DOWNLOADS", "100")),
        )
        return await scraper.run()

    def _build_payload(self, artifacts: list[FilingArtifact]) -> dict[str, Any]:
        filings: list[dict[str, Any]] = []
        transactions: list[dict[str, Any]] = []
        issues: list[dict[str, Any]] = []
        committee_assignments = fetch_committee_assignments(self.logger)

        for artifact in artifacts:
            filing_id = artifact.filing_id
            filings.append(
                {
                    "filingId": filing_id,
                    "chamber": artifact.chamber,
                    "source": artifact.source,
                    "sourceFilingId": artifact.filing_id,
                    "reportType": artifact.report_type,
                    "filerName": _title_to_member_name(artifact.title),
                    "filingDate": artifact.discovered_at,
                    "sourceUrl": artifact.url,
                    "rawSha256": artifact.sha256,
                    "parserStatus": "DOWNLOADED",
                    "metadata": asdict(artifact),
                }
            )

            if not artifact.local_path or not artifact.local_path.lower().endswith(".pdf"):
                issues.append(
                    CleaningIssue(
                        severity="INFO",
                        issue_type="NON_PDF_ARTIFACT",
                        message="Artifact was downloaded but is not a PDF; OCR skipped.",
                        raw_context=asdict(artifact),
                    ).to_payload(filing_id)
                )
                continue

            extraction = extract_text_from_pdf(Path(artifact.local_path))
            for warning in extraction.warnings:
                issues.append(
                    CleaningIssue(
                        severity="WARN",
                        issue_type="OCR_WARNING",
                        message=warning,
                        raw_context={"file": artifact.local_path},
                    ).to_payload(filing_id)
                )

            candidates = _extract_candidate_rows(extraction.full_text)

            if not candidates:
                issues.append(
                    CleaningIssue(
                        severity="WARN",
                        issue_type="NO_TRANSACTION_ROWS",
                        message="No conservative transaction row candidates found in extracted PDF text.",
                        raw_context={"file": artifact.local_path, "textLength": len(extraction.full_text)},
                    ).to_payload(filing_id)
                )
                continue

            for row in candidates:
                standardized, row_issues = standardize_transaction_row(
                    row,
                    chamber=artifact.chamber,
                    member_name=_title_to_member_name(artifact.title),
                    source_url=artifact.url,
                    filing_id=filing_id,
                )
                issues.extend(issue.to_payload(filing_id) for issue in row_issues)
                if standardized:
                    transactions.append(standardized.to_payload())

        return {
            "runId": self.run_id,
            "source": self.source,
            "filings": filings,
            "transactions": transactions,
            "cleaningIssues": issues,
            "committeeAssignments": committee_assignments,
            "completed": True,
            "stats": {
                "artifacts": len(artifacts),
                "filings": len(filings),
                "transactions": len(transactions),
                "issues": len(issues),
                "committeeAssignments": len(committee_assignments),
            },
        }

    def _login_for_token(self) -> str:
        request = Request(
            f"{self.api_base}/login",
            data=json.dumps(
                {
                    "password": self.admin_password,
                    "subject": "congress-runner",
                    "scopes": ["WRITE"],
                }
            ).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Sovereign-Sigma-Congress-Runner/1.0",
            },
        )

        try:
            with urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Worker login failed with HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"Worker login failed: {exc}") from exc

        token = payload.get("token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("Worker login response did not include a JWT token.")

        return token

    def _post_payload(self, payload: dict[str, Any]) -> None:
        request = Request(
            f"{self.api_base}/admin/congress/ingest",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.admin_token}",
                "Content-Type": "application/json",
                "User-Agent": "Sovereign-Sigma-Congress-Runner/1.0",
            },
        )

        try:
            with urlopen(request, timeout=60) as response:
                body = response.read().decode("utf-8")
                self.logger.info("Worker ingest response: %s", body)
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Worker ingest failed with HTTP {exc.code}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"Worker ingest failed: {exc}") from exc


def _extract_candidate_rows(text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    for line in text.splitlines():
        cleaned = " ".join(line.split())
        if not cleaned:
            continue

        row = _extract_candidate_row(cleaned)
        if not row:
            continue

        rows.append(row)

    return rows


def _extract_candidate_row(cleaned: str) -> dict[str, str] | None:
    amount_match = AMOUNT_BAND_RE.search(cleaned)
    if not amount_match:
        return None

    before_amount = cleaned[: amount_match.start()].strip()
    type_matches = list(TRANSACTION_TYPE_TOKEN_RE.finditer(before_amount))
    if not type_matches:
        return None

    type_match = type_matches[-1]
    type_value = type_match.group("type")
    after_type = before_amount[type_match.end() :].strip()
    date_matches = list(DATE_TOKEN_RE.finditer(after_type))

    if not date_matches:
        return None

    asset = before_amount[: type_match.start()].strip(" -|")
    transaction_date = date_matches[0].group(0)
    notification_date = date_matches[1].group(0) if len(date_matches) > 1 else ""

    return {
        "date": transaction_date,
        "notification_date": notification_date,
        "type": type_value,
        "amount": amount_match.group(0),
        "asset": asset,
        "description": cleaned,
    }


def _title_to_member_name(title: str) -> str | None:
    cleaned = title.strip()
    if not cleaned:
        return None
    return re.sub(r"\s+", " ", cleaned)[:160]


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Sovereign-Sigma Congressional Tracker.")
    parser.add_argument("--api-base", default=os.getenv("SOVEREIGN_API_BASE"))
    parser.add_argument("--admin-token", default=os.getenv("SOVEREIGN_ADMIN_TOKEN"))
    parser.add_argument("--run-id", default=os.getenv("CONGRESS_RUN_ID"))
    parser.add_argument("--source", choices=("all", "house", "senate"), default="all")
    parser.add_argument("--headed", action="store_true", help="Run browser with a visible window.")
    parser.add_argument("--download-dir", default="data/raw_disclosures")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    pipeline = CongressETLPipeline(
        api_base=args.api_base,
        admin_token=args.admin_token,
        run_id=args.run_id,
        source=args.source,
        headless=not args.headed,
        download_dir=Path(args.download_dir),
    )
    payload = asyncio.run(pipeline.run())
    print(json.dumps(payload["stats"], indent=2))


if __name__ == "__main__":
    main()
