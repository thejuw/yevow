"""
Free, no-key price marking for Congressional transaction estimates.

Yahoo's chart endpoint is used as the primary source and Stooq daily CSV is the
fallback. This is best-effort market-data for transparency, not an execution
feed.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from io import StringIO
from urllib.parse import quote
from urllib.request import Request, urlopen

YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
STOOQ_DAILY_BASE = "https://stooq.com/q/d/l/"


@dataclass(frozen=True)
class PriceMark:
    symbol: str
    provider: str
    current_price: float
    current_price_as_of: str
    transaction_price: float | None
    transaction_price_as_of: str | None

    def to_payload(self) -> dict[str, object]:
        return asdict(self)


class FreePriceProvider:
    def mark(self, symbol: str, transaction_date: str | None = None) -> PriceMark:
        normalized = _normalize_symbol(symbol)

        try:
            return self._mark_yahoo(normalized, transaction_date)
        except Exception:
            return self._mark_stooq(normalized, transaction_date)

    def _mark_yahoo(self, symbol: str, transaction_date: str | None) -> PriceMark:
        yahoo_symbol = symbol.replace(".", "-")
        latest = _fetch_json(f"{YAHOO_CHART_BASE}/{quote(yahoo_symbol)}?range=5d&interval=1d")
        result = _first_chart_result(latest)
        meta = result.get("meta", {})
        current_price = _finite_or_none(meta.get("regularMarketPrice")) or _last_close(result)

        if current_price is None:
            raise ValueError(f"Yahoo returned no current price for {symbol}")

        current_time = meta.get("regularMarketTime")
        current_as_of = (
            datetime.fromtimestamp(float(current_time), tz=timezone.utc).isoformat()
            if current_time
            else datetime.now(tz=timezone.utc).isoformat()
        )
        basis_price, basis_as_of = self._yahoo_historical(yahoo_symbol, transaction_date)

        return PriceMark(
            symbol=symbol,
            provider="YAHOO_CHART",
            current_price=current_price,
            current_price_as_of=current_as_of,
            transaction_price=basis_price,
            transaction_price_as_of=basis_as_of,
        )

    def _yahoo_historical(
        self, yahoo_symbol: str, transaction_date: str | None
    ) -> tuple[float | None, str | None]:
        if not transaction_date:
            return None, None

        try:
            target = datetime.fromisoformat(transaction_date[:10]).replace(tzinfo=timezone.utc)
        except ValueError:
            return None, None

        period1 = int((target - timedelta(days=4)).timestamp())
        period2 = int((target + timedelta(days=10)).timestamp())
        data = _fetch_json(
            f"{YAHOO_CHART_BASE}/{quote(yahoo_symbol)}?period1={period1}&period2={period2}&interval=1d"
        )
        result = _first_chart_result(data)
        timestamps = result.get("timestamp") or []
        closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []

        for timestamp, close in zip(timestamps, closes):
            price = _finite_or_none(close)
            if price is None:
                continue
            observed_at = datetime.fromtimestamp(float(timestamp), tz=timezone.utc)
            if observed_at.date() >= target.date():
                return price, observed_at.isoformat()

        return None, None

    def _mark_stooq(self, symbol: str, transaction_date: str | None) -> PriceMark:
        stooq_symbol = f"{symbol.lower().replace('.', '-')}.us"
        rows = _fetch_stooq_rows(stooq_symbol)

        if not rows:
            raise ValueError(f"Stooq returned no prices for {symbol}")

        latest = rows[-1]
        basis = _first_on_or_after(rows, transaction_date) if transaction_date else None

        return PriceMark(
            symbol=symbol,
            provider="STOOQ_DAILY",
            current_price=latest["close"],
            current_price_as_of=f"{latest['date']}T21:00:00+00:00",
            transaction_price=basis["close"] if basis else None,
            transaction_price_as_of=f"{basis['date']}T21:00:00+00:00" if basis else None,
        )


def _fetch_json(url: str) -> dict[str, object]:
    request = Request(url, headers={"User-Agent": "Sovereign-Sigma-Congress-Tracker/1.0"})
    with urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _fetch_stooq_rows(symbol: str) -> list[dict[str, object]]:
    request = Request(
        f"{STOOQ_DAILY_BASE}?s={quote(symbol)}&i=d",
        headers={"User-Agent": "Sovereign-Sigma-Congress-Tracker/1.0"},
    )
    with urlopen(request, timeout=20) as response:
        text = response.read().decode("utf-8")

    rows: list[dict[str, object]] = []
    for row in csv.DictReader(StringIO(text)):
        try:
            close = float(row["Close"])
        except (KeyError, TypeError, ValueError):
            continue
        rows.append({"date": row.get("Date", ""), "close": close})
    return rows


def _first_on_or_after(
    rows: list[dict[str, object]], transaction_date: str | None
) -> dict[str, object] | None:
    if not transaction_date:
        return None

    try:
        target = datetime.fromisoformat(transaction_date[:10]).date()
    except ValueError:
        return None

    for row in rows:
        try:
            observed = datetime.fromisoformat(str(row["date"])).date()
        except ValueError:
            continue
        if observed >= target:
            return row
    return None


def _first_chart_result(data: dict[str, object]) -> dict[str, object]:
    chart = data.get("chart")
    if not isinstance(chart, dict):
        raise ValueError("Yahoo response missing chart")
    if chart.get("error"):
        raise ValueError(f"Yahoo chart error: {chart['error']}")
    result = chart.get("result")
    if not isinstance(result, list) or not result:
        raise ValueError("Yahoo response missing result")
    return result[0]


def _last_close(result: dict[str, object]) -> float | None:
    indicators = result.get("indicators") or {}
    quote_rows = indicators.get("quote") if isinstance(indicators, dict) else None
    quote = quote_rows[0] if isinstance(quote_rows, list) and quote_rows else {}
    closes = quote.get("close") if isinstance(quote, dict) else []

    if not isinstance(closes, list):
        return None

    for close in reversed(closes):
        price = _finite_or_none(close)
        if price is not None:
            return price
    return None


def _finite_or_none(value: object) -> float | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def _normalize_symbol(value: str) -> str:
    symbol = value.strip().replace("$", "").upper()
    if not symbol or len(symbol) > 16:
        raise ValueError("Invalid ticker symbol")
    return symbol
