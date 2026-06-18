"""
Cleaning and standardization helpers for Congressional PTR records.

This module intentionally favors "unknown with a cleaning issue" over guessing.
PTR PDFs vary heavily by chamber, year, and filer; downstream records should
carry confidence scores and raw text so the UI can show provenance.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from datetime import date, datetime
from typing import Any, Literal

from dateutil import parser as date_parser

TransactionType = Literal["PURCHASE", "SALE", "EXCHANGE", "UNKNOWN"]

AMOUNT_BAND_RE = re.compile(
    r"\$?\s*(?P<low>[0-9][0-9,]*)\s*(?:-|to|–|—)\s*\$?\s*(?P<high>[0-9][0-9,]*)",
    re.IGNORECASE,
)
TICKER_RE = re.compile(
    r"(?:ticker|symbol)\s*[:\-]?\s*\$?(?P<ticker>[A-Z][A-Z0-9.\-]{0,7})",
    re.IGNORECASE,
)
PAREN_TICKER_RE = re.compile(r"\(\$?(?P<ticker>[A-Z][A-Z0-9.\-]{0,7})\)")
COMMON_FALSE_TICKERS = {
    "BOND",
    "CUSIP",
    "DUE",
    "FED",
    "FHLB",
    "FNMA",
    "GS",
    "IRA",
    "LLC",
    "ETF",
    "MAE",
    "NOTE",
    "PTR",
    "USD",
    "US",
    "N/A",
    "NA",
    "P",
    "S",
    "SP",
    "TSY",
}
NON_EQUITY_INSTRUMENT_RE = re.compile(
    r"\b("
    r"US\s+TSY|TREASUR(?:Y|IES)|T-?BILL|T-?NOTE|T-?BOND|"
    r"FANNIE\s+MAE|FREDDIE\s+MAC|GINNIE\s+MAE|MUNICIPAL|"
    r"CUSIP|NOTE\s+\d|DUE\s+\d|BOND"
    r")\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CleaningIssue:
    severity: Literal["INFO", "WARN", "ERROR", "CRITICAL"]
    issue_type: str
    message: str
    raw_context: dict[str, Any] | None = None

    def to_payload(self, filing_id: str | None = None, transaction_id: str | None = None) -> dict[str, Any]:
        payload = asdict(self)
        payload["filingId"] = filing_id
        payload["transactionId"] = transaction_id
        payload["rawContext"] = payload.pop("raw_context")
        return payload


@dataclass(frozen=True)
class StandardizedTransaction:
    chamber: str
    member_name: str | None
    owner: str | None
    symbol: str | None
    asset_name: str | None
    transaction_type: TransactionType
    transaction_date: str | None
    notification_date: str | None
    amount_min: float | None
    amount_max: float | None
    amount_mid: float | None
    raw_text: str
    confidence: float
    source_url: str | None = None
    filing_id: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "filingId": self.filing_id,
            "chamber": self.chamber,
            "memberName": self.member_name,
            "owner": self.owner,
            "symbol": self.symbol,
            "assetName": self.asset_name,
            "transactionType": self.transaction_type,
            "transactionDate": self.transaction_date,
            "notificationDate": self.notification_date,
            "amountMin": self.amount_min,
            "amountMax": self.amount_max,
            "amountMid": self.amount_mid,
            "rawText": self.raw_text,
            "confidence": self.confidence,
            "sourceUrl": self.source_url,
        }


def normalize_symbol(value: str | None) -> str | None:
    if not value:
        return None

    cleaned = value.strip().upper().replace("$", "")
    cleaned = re.sub(r"[^A-Z0-9.\-]", "", cleaned)

    if not cleaned or cleaned in COMMON_FALSE_TICKERS:
        return None

    if not re.fullmatch(r"[A-Z0-9.\-]{1,12}", cleaned):
        return None

    return cleaned


def parse_amount_band(value: str | None) -> tuple[float | None, float | None, float | None]:
    if not value:
        return None, None, None

    match = AMOUNT_BAND_RE.search(value.replace(",", ""))

    if not match:
        return None, None, None

    low = float(match.group("low").replace(",", ""))
    high = float(match.group("high").replace(",", ""))

    if low > high:
        low, high = high, low

    return low, high, (low + high) / 2.0


def normalize_transaction_type(value: str | None) -> TransactionType:
    if not value:
        return "UNKNOWN"

    normalized = value.strip().upper()

    if normalized in {"P", "BUY", "BOUGHT", "PURCHASE", "PURCHASED"}:
        return "PURCHASE"

    if normalized in {"S", "SELL", "SOLD", "SALE"}:
        return "SALE"

    if normalized in {"E", "EXCHANGE"}:
        return "EXCHANGE"

    if "PURCHASE" in normalized:
        return "PURCHASE"

    if "SALE" in normalized or "SOLD" in normalized:
        return "SALE"

    return "UNKNOWN"


def normalize_date(value: str | None) -> str | None:
    if not value:
        return None

    try:
        parsed = date_parser.parse(value, fuzzy=True)
    except (ValueError, OverflowError, TypeError):
        return None

    parsed_date = date(parsed.year, parsed.month, parsed.day)
    if parsed_date > date.today():
        return None

    return parsed_date.isoformat()


def extract_symbol_from_text(text: str) -> str | None:
    if NON_EQUITY_INSTRUMENT_RE.search(text):
        return None

    for match in [*TICKER_RE.finditer(text), *PAREN_TICKER_RE.finditer(text)]:
        symbol = normalize_symbol(match.group("ticker"))
        if symbol:
            return symbol
    return None


def standardize_transaction_row(
    row: dict[str, Any],
    *,
    chamber: str,
    member_name: str | None,
    source_url: str | None = None,
    filing_id: str | None = None,
) -> tuple[StandardizedTransaction | None, list[CleaningIssue]]:
    issues: list[CleaningIssue] = []
    raw_text = " | ".join(str(value) for value in row.values() if value is not None).strip()
    transaction_type = normalize_transaction_type(_first(row, "type", "transaction_type", "transaction"))
    transaction_date = normalize_date(_first(row, "date", "transaction_date", "transaction date"))
    notification_date = normalize_date(_first(row, "notification_date", "notification date", "filed"))
    symbol = normalize_symbol(_first(row, "ticker", "symbol")) or extract_symbol_from_text(raw_text)
    amount_min, amount_max, amount_mid = parse_amount_band(
        _first(row, "amount", "amount_range", "value", "transaction amount") or raw_text
    )

    if transaction_type == "UNKNOWN":
        issues.append(
            CleaningIssue(
                severity="WARN",
                issue_type="UNKNOWN_TRANSACTION_TYPE",
                message="Could not determine whether the transaction was a purchase or sale.",
                raw_context={"row": row},
            )
        )

    if not transaction_date:
        issues.append(
            CleaningIssue(
                severity="WARN",
                issue_type="MISSING_TRANSACTION_DATE",
                message="Could not parse a transaction date from the row.",
                raw_context={"row": row},
            )
        )

    if not symbol:
        issues.append(
            CleaningIssue(
                severity="WARN",
                issue_type="MISSING_TICKER",
                message="Could not identify a public ticker symbol.",
                raw_context={"row": row},
            )
        )

    if amount_mid is None:
        issues.append(
            CleaningIssue(
                severity="INFO",
                issue_type="MISSING_AMOUNT_BAND",
                message="Could not parse a disclosed amount band.",
                raw_context={"row": row},
            )
        )

    if transaction_type == "UNKNOWN" and not transaction_date and not symbol:
        return None, issues

    confidence = 0.35
    confidence += 0.2 if transaction_type != "UNKNOWN" else 0
    confidence += 0.2 if transaction_date else 0
    confidence += 0.15 if symbol else 0
    confidence += 0.1 if amount_mid is not None else 0

    return (
        StandardizedTransaction(
            chamber=chamber.lower(),
            member_name=member_name,
            owner=_first(row, "owner"),
            symbol=symbol,
            asset_name=_first(row, "asset", "asset_name", "description") or raw_text[:180],
            transaction_type=transaction_type,
            transaction_date=transaction_date,
            notification_date=notification_date,
            amount_min=amount_min,
            amount_max=amount_max,
            amount_mid=amount_mid,
            raw_text=raw_text,
            confidence=min(confidence, 1.0),
            source_url=source_url,
            filing_id=filing_id,
        ),
        issues,
    )


def _first(row: dict[str, Any], *keys: str) -> str | None:
    normalized = {str(key).strip().lower(): value for key, value in row.items()}

    for key in keys:
        value = normalized.get(key.strip().lower())
        if value is not None and str(value).strip():
            return str(value).strip()

    return None
