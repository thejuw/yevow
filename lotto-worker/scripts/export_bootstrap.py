#!/usr/bin/env python3
"""Export a validated RabbitHoleTX snapshot for an offline Cloudflare bootstrap.

The exporter never contacts Texas Lottery or Cloudflare. It verifies that every
active SQLite draw is backed by one of the 17 immutable, digest-addressed cache
objects, then emits:

* D1-compatible, non-destructive SQL for ``migrations/0001_initial.sql``.
* A JSON manifest describing the exact local files and R2 object keys to upload.

The output is deterministic for the same database, cache, migration, and CLI
options. Populated D1 rows are never replaced by the generated SQL, which makes
an accidental re-application non-destructive. Empty Worker-registered source
stubs may be hydrated. Deployment tooling must still verify the counts and
dataset digest after importing it.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


INPUT_SCHEMA_VERSION = 3
OUTPUT_D1_SCHEMA_VERSION = 4
OUTPUT_MANIFEST_VERSION = 1
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_INSERT_ROWS = 50
MAX_INSERT_BYTES = 48 * 1024
SQL_FILENAME = "bootstrap.sql"
R2_MANIFEST_FILENAME = "r2-uploads.json"

OFFICIAL_ROOT = "https://www.texaslottery.com/export/sites/lottery/Games"
SESSION_ORDER = ("morning", "day", "evening", "night")


class ExportError(RuntimeError):
    """Raised when the local oracle cannot produce a trustworthy bootstrap."""


@dataclass(frozen=True)
class SourceSpec:
    """Cloudflare source identity mirrored from ``lotto-worker/src/manifest.ts``."""

    source_id: str
    game: str
    name: str
    url: str
    session: str
    expected_widths: tuple[int, ...]


@dataclass(frozen=True)
class SourceExport:
    """Validated source revision selected from the local RabbitHoleTX oracle."""

    spec: SourceSpec
    digest: str
    object_key: str
    cache_relative_path: str
    byte_count: int
    physical_row_count: int
    draw_count: int
    latest_draw_date: str
    started_at: str
    completed_at: str
    ingestion_id: str


@dataclass(frozen=True)
class DrawExport:
    """One normalized D1 draw row."""

    game: str
    draw_date: str
    session: str
    ordered_numbers: str
    canonical_numbers: str
    bonus_numbers: str
    metadata: str
    content_fingerprint: str
    source_id: str
    source_url: str
    source_sha256: str
    source_line: int
    raw_record: str
    seen_ingestion_id: str
    first_seen_at: str
    updated_at: str


@dataclass(frozen=True)
class BootstrapSnapshot:
    """Fully verified input state used to render both bootstrap artifacts."""

    sources: tuple[SourceExport, ...]
    draws: tuple[DrawExport, ...]
    dataset_digest: str
    validated_at: str


def _source(
    game: str,
    folder: str,
    name: str,
    filename: str,
    expected_widths: tuple[int, ...],
    session: str = "",
) -> SourceSpec:
    return SourceSpec(
        source_id=f"{game}:{name}",
        game=game,
        name=name,
        url=f"{OFFICIAL_ROOT}/{folder}/Winning_Numbers/{filename}",
        session=session,
        expected_widths=expected_widths,
    )


def _session_sources(
    game: str,
    folder: str,
    stem: str,
    expected_widths: tuple[int, ...],
) -> tuple[SourceSpec, ...]:
    return tuple(
        _source(
            game,
            folder,
            f"{stem}-{session}",
            f"{stem}{session}.csv",
            expected_widths,
            session,
        )
        for session in SESSION_ORDER
    )


SOURCES: tuple[SourceSpec, ...] = (
    _source("lotto", "Lotto_Texas", "lottotexas", "lottotexas.csv", (10,)),
    _source(
        "twostep",
        "Texas_Two_Step",
        "texastwostep",
        "texastwostep.csv",
        (9,),
    ),
    _source("cash5", "Cash_Five", "cashfive", "cashfive.csv", (9,)),
    _source("pb", "Powerball", "powerball", "powerball.csv", (10, 11)),
    _source("mm", "Mega_Millions", "megamillions", "megamillions.csv", (10, 11)),
    *_session_sources("p3", "Pick_3", "pick3", (7, 8, 9)),
    *_session_sources("d4", "Daily_4", "daily4", (9, 10)),
    *_session_sources("aon", "All_or_Nothing", "allornothing", (16,)),
)

SOURCE_BY_URL: Mapping[str, SourceSpec] = {source.url: source for source in SOURCES}


REQUIRED_INPUT_COLUMNS: Mapping[str, frozenset[str]] = {
    "ingestions": frozenset(
        {
            "id",
            "game",
            "source_url",
            "cache_path",
            "source_sha256",
            "from_cache",
            "started_at",
            "completed_at",
            "status",
            "parsed_count",
            "inserted_count",
            "updated_count",
            "unchanged_count",
            "quarantined_count",
            "retired_count",
            "error",
            "acquisition_kind",
        }
    ),
    "draws": frozenset(
        {
            "game",
            "draw_date",
            "session",
            "ordered_numbers",
            "canonical_numbers",
            "bonus_numbers",
            "metadata",
            "source_url",
            "source_sha256",
            "source_line",
            "raw_record",
            "created_at",
            "updated_at",
            "active",
            "retired_at",
            "acquisition_kind",
        }
    ),
    "quarantine": frozenset({"ingestion_id", "source_line", "raw_record", "reason"}),
    "schema_versions": frozenset({"version", "applied_at"}),
}


def sha256_file(path: Path) -> tuple[str, int]:
    """Return a file's SHA-256 and exact byte length without loading it at once."""

    digest = hashlib.sha256()
    byte_count = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            byte_count += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), byte_count


def canonical_json(value: Any) -> str:
    """Match compact ``JSON.stringify`` output while preserving mapping order."""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _parse_integer_array(raw: str, field: str) -> tuple[list[int], str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ExportError(f"{field} is not valid JSON: {exc}") from exc
    if not isinstance(value, list) or any(type(item) is not int for item in value):
        raise ExportError(f"{field} must be a JSON array containing only integers")
    return value, canonical_json(value)


def _parse_metadata(raw: str) -> tuple[dict[str, Any], str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ExportError(f"metadata is not valid JSON: {exc}") from exc
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ExportError("metadata must be a JSON object with string keys")
    return value, canonical_json(value)


def worker_content_fingerprint(
    game: str,
    draw_date: str,
    session: str,
    ordered_numbers: Sequence[int],
    bonus_numbers: Sequence[int],
    metadata_json: str,
) -> str:
    """Return the exact normalized fingerprint generated by the Worker."""

    ordered = ",".join(str(value) for value in ordered_numbers)
    bonus = ",".join(str(value) for value in bonus_numbers)
    return f"{game}|{draw_date}|{session}|{ordered}|{bonus}|{metadata_json}"


def _require_regular_file(path: Path, label: str) -> Path:
    try:
        file_stat = path.lstat()
    except FileNotFoundError as exc:
        raise ExportError(f"{label} does not exist: {path}") from exc
    if stat.S_ISLNK(file_stat.st_mode):
        raise ExportError(f"{label} must not be a symbolic link: {path}")
    if not stat.S_ISREG(file_stat.st_mode):
        raise ExportError(f"{label} is not a regular file: {path}")
    return path.resolve(strict=True)


def _open_oracle(db_path: Path) -> sqlite3.Connection:
    resolved = _require_regular_file(db_path, "RabbitHoleTX database")
    uri = f"{resolved.as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    return connection


def _validate_input_schema(connection: sqlite3.Connection) -> None:
    user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    if user_version != INPUT_SCHEMA_VERSION:
        raise ExportError(
            f"RabbitHoleTX schema mismatch: expected user_version "
            f"{INPUT_SCHEMA_VERSION}, observed {user_version}"
        )
    for table, required in REQUIRED_INPUT_COLUMNS.items():
        columns = {
            str(row["name"])
            for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }
        missing = sorted(required - columns)
        if missing:
            raise ExportError(f"RabbitHoleTX table {table!r} is missing columns: {missing}")

    recorded = connection.execute("SELECT MAX(version) FROM schema_versions").fetchone()[0]
    if recorded != INPUT_SCHEMA_VERSION:
        raise ExportError(
            f"RabbitHoleTX migration ledger mismatch: expected {INPUT_SCHEMA_VERSION}, "
            f"observed {recorded!r}"
        )


def _decode_export(raw_bytes: bytes, source_id: str) -> list[str]:
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = raw_bytes.decode("cp1252")
        except UnicodeDecodeError as exc:
            raise ExportError(f"cache object for {source_id} cannot be decoded") from exc
    if text.lstrip().lower().startswith(("<!doctype html", "<html")):
        raise ExportError(f"cache object for {source_id} contains HTML, not CSV")
    return text.splitlines()


def _latest_official_ingestion(
    connection: sqlite3.Connection, source: SourceSpec
) -> sqlite3.Row:
    row = connection.execute(
        """
        SELECT *
          FROM ingestions
         WHERE game = ?
           AND source_url = ?
           AND status = 'complete'
           AND acquisition_kind = 'official-export'
         ORDER BY completed_at DESC, id DESC
         LIMIT 1
        """,
        (source.game, source.url),
    ).fetchone()
    if row is None:
        raise ExportError(f"no completed official ingestion exists for {source.source_id}")
    if not row["completed_at"]:
        raise ExportError(f"official ingestion {row['id']} has no completion timestamp")
    if row["error"]:
        raise ExportError(f"official ingestion {row['id']} contains an error")
    if int(row["quarantined_count"]) != 0:
        raise ExportError(
            f"official ingestion {row['id']} for {source.source_id} quarantined rows; "
            "bootstrap requires a clean validated revision"
        )
    digest = str(row["source_sha256"])
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ExportError(f"official ingestion {row['id']} has an invalid SHA-256")
    return row


def _archive_path(cache_root: Path, source: SourceSpec, digest: str) -> tuple[Path, str]:
    relative = Path(source.game) / "archive" / f"{source.name}-{digest}.csv"
    candidate = cache_root / relative
    resolved = _require_regular_file(candidate, f"immutable cache object for {source.source_id}")
    try:
        resolved.relative_to(cache_root)
    except ValueError as exc:
        raise ExportError(f"cache object escaped --cache-root: {candidate}") from exc
    return resolved, relative.as_posix()


def _load_draws_for_source(
    connection: sqlite3.Connection,
    source: SourceSpec,
    digest: str,
    ingestion_id: str,
    physical_lines: Sequence[str],
) -> tuple[DrawExport, ...]:
    rows = connection.execute(
        """
        SELECT game, draw_date, session, ordered_numbers, canonical_numbers,
               bonus_numbers, metadata, source_url, source_sha256, source_line,
               raw_record, created_at, updated_at, acquisition_kind
          FROM draws
         WHERE active = 1 AND source_url = ?
         ORDER BY draw_date, session
        """,
        (source.url,),
    ).fetchall()
    if not rows:
        raise ExportError(f"no active draws exist for {source.source_id}")

    nonblank_lines = {
        line_number
        for line_number, raw_record in enumerate(physical_lines, start=1)
        if raw_record.strip()
    }
    seen_lines: set[int] = set()
    exported: list[DrawExport] = []
    for row in rows:
        context = f"{source.source_id} {row['draw_date']} {row['session']!r}"
        if row["game"] != source.game or row["session"] != source.session:
            raise ExportError(f"{context}: game/session does not match the source manifest")
        if row["source_sha256"] != digest:
            raise ExportError(f"{context}: active draw references a different source digest")
        if row["acquisition_kind"] != "official-export":
            raise ExportError(f"{context}: active draw is not official-export provenance")

        line_number = int(row["source_line"])
        if line_number < 1 or line_number > len(physical_lines):
            raise ExportError(f"{context}: source line {line_number} is outside the cache file")
        if line_number in seen_lines:
            raise ExportError(f"{context}: duplicate source line {line_number}")
        if physical_lines[line_number - 1] != row["raw_record"]:
            raise ExportError(f"{context}: raw record does not match the cache object")
        seen_lines.add(line_number)

        ordered, ordered_json = _parse_integer_array(row["ordered_numbers"], "ordered_numbers")
        canonical, canonical_numbers_json = _parse_integer_array(
            row["canonical_numbers"], "canonical_numbers"
        )
        bonus, bonus_json = _parse_integer_array(row["bonus_numbers"], "bonus_numbers")
        _, metadata_json = _parse_metadata(row["metadata"])
        if canonical != sorted(ordered):
            raise ExportError(f"{context}: canonical numbers are not the sorted ordered numbers")

        fingerprint = worker_content_fingerprint(
            source.game,
            str(row["draw_date"]),
            source.session,
            ordered,
            bonus,
            metadata_json,
        )
        exported.append(
            DrawExport(
                game=source.game,
                draw_date=str(row["draw_date"]),
                session=source.session,
                ordered_numbers=ordered_json,
                canonical_numbers=canonical_numbers_json,
                bonus_numbers=bonus_json,
                metadata=metadata_json,
                content_fingerprint=fingerprint,
                source_id=source.source_id,
                source_url=source.url,
                source_sha256=digest,
                source_line=line_number,
                raw_record=str(row["raw_record"]),
                seen_ingestion_id=ingestion_id,
                first_seen_at=str(row["created_at"]),
                updated_at=str(row["updated_at"]),
            )
        )

    if seen_lines != nonblank_lines:
        missing = sorted(nonblank_lines - seen_lines)
        extra = sorted(seen_lines - nonblank_lines)
        raise ExportError(
            f"{source.source_id}: active draw evidence does not cover every nonblank cache "
            f"record (missing={missing[:5]}, extra={extra[:5]})"
        )
    return tuple(exported)


def _dataset_digest(sources: Sequence[SourceExport], draws: Sequence[DrawExport]) -> str:
    digest = hashlib.sha256()
    digest.update(b"rabbitholetx-d1-bootstrap-v1\n")
    for source in sources:
        digest.update(
            (
                canonical_json(
                    [
                        source.spec.source_id,
                        source.digest,
                        source.object_key,
                        source.draw_count,
                        source.latest_draw_date,
                    ]
                )
                + "\n"
            ).encode("utf-8")
        )
    for draw in draws:
        digest.update(
            (
                canonical_json(
                    [
                        draw.game,
                        draw.draw_date,
                        draw.session,
                        draw.content_fingerprint,
                        draw.source_id,
                        draw.source_sha256,
                        draw.source_line,
                    ]
                )
                + "\n"
            ).encode("utf-8")
        )
    return digest.hexdigest()


def load_snapshot(db_path: Path, cache_root: Path, r2_prefix: str) -> BootstrapSnapshot:
    """Load and cross-check the complete local oracle without modifying it."""

    resolved_cache = cache_root.resolve(strict=True)
    if not resolved_cache.is_dir():
        raise ExportError(f"--cache-root is not a directory: {cache_root}")
    if len(SOURCES) != 17 or len(SOURCE_BY_URL) != 17:
        raise ExportError("internal source manifest must contain 17 unique official URLs")

    prefix = str(PurePosixPath(r2_prefix.strip("/")))
    if (
        not prefix
        or prefix in {".", ".."}
        or ".." in PurePosixPath(prefix).parts
        or re.fullmatch(r"[A-Za-z0-9._/-]+", prefix) is None
    ):
        raise ExportError("--r2-prefix must be a non-empty safe R2 key prefix")

    connection = _open_oracle(db_path)
    try:
        _validate_input_schema(connection)
        inactive_count = int(
            connection.execute("SELECT COUNT(*) FROM draws WHERE active = 0").fetchone()[0]
        )
        if inactive_count:
            raise ExportError(
                f"oracle contains {inactive_count} retired draws; this one-revision-per-source "
                "bootstrap cannot preserve their older raw evidence"
            )

        active_urls = {
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT source_url FROM draws WHERE active = 1"
            ).fetchall()
        }
        expected_urls = set(SOURCE_BY_URL)
        if active_urls != expected_urls:
            missing = sorted(expected_urls - active_urls)
            unexpected = sorted(active_urls - expected_urls)
            raise ExportError(
                f"active source set does not match the 17-source manifest "
                f"(missing={missing}, unexpected={unexpected})"
            )

        source_exports: list[SourceExport] = []
        draw_exports: list[DrawExport] = []
        source_order = {source.source_id: index for index, source in enumerate(SOURCES)}
        for source in SOURCES:
            ingestion = _latest_official_ingestion(connection, source)
            digest = str(ingestion["source_sha256"])
            cache_path, cache_relative_path = _archive_path(
                resolved_cache, source, digest
            )
            if Path(str(ingestion["cache_path"])).name != cache_path.name:
                raise ExportError(
                    f"{source.source_id}: ingestion cache path does not identify the "
                    "digest-addressed archive object"
                )
            raw_bytes = cache_path.read_bytes()
            byte_count = len(raw_bytes)
            observed_digest = hashlib.sha256(raw_bytes).hexdigest()
            if observed_digest != digest:
                raise ExportError(
                    f"cache digest mismatch for {source.source_id}: database={digest}, "
                    f"file={observed_digest}"
                )
            if byte_count == 0 or byte_count > MAX_SOURCE_BYTES:
                raise ExportError(
                    f"cache byte length for {source.source_id} is outside 1..{MAX_SOURCE_BYTES}: "
                    f"{byte_count}"
                )

            physical_lines = _decode_export(raw_bytes, source.source_id)
            nonblank_count = sum(bool(line.strip()) for line in physical_lines)
            if nonblank_count != int(ingestion["parsed_count"]):
                raise ExportError(
                    f"{source.source_id}: cache has {nonblank_count} nonblank records but "
                    f"ingestion {ingestion['id']} parsed {ingestion['parsed_count']}"
                )

            ingestion_id = f"bootstrap:{source.source_id}:{digest[:16]}"
            object_key = f"{prefix}/{source.game}/{source.name}/{digest}.csv"
            draws = _load_draws_for_source(
                connection,
                source,
                digest,
                ingestion_id,
                physical_lines,
            )
            if len(draws) != int(ingestion["parsed_count"]):
                raise ExportError(
                    f"{source.source_id}: active draw count {len(draws)} does not match "
                    f"parsed count {ingestion['parsed_count']}"
                )
            latest_draw_date = max(draw.draw_date for draw in draws)
            source_exports.append(
                SourceExport(
                    spec=source,
                    digest=digest,
                    object_key=object_key,
                    cache_relative_path=cache_relative_path,
                    byte_count=byte_count,
                    physical_row_count=nonblank_count,
                    draw_count=len(draws),
                    latest_draw_date=latest_draw_date,
                    started_at=str(ingestion["started_at"]),
                    completed_at=str(ingestion["completed_at"]),
                    ingestion_id=ingestion_id,
                )
            )
            draw_exports.extend(draws)

        draws_sorted = tuple(
            sorted(
                draw_exports,
                key=lambda draw: (
                    source_order[draw.source_id],
                    draw.draw_date,
                    draw.session,
                ),
            )
        )
        sources_tuple = tuple(source_exports)
        validated_at = max(source.completed_at for source in sources_tuple)
        return BootstrapSnapshot(
            sources=sources_tuple,
            draws=draws_sorted,
            dataset_digest=_dataset_digest(sources_tuple, draws_sorted),
            validated_at=validated_at,
        )
    finally:
        connection.rollback()
        connection.close()


def sql_literal(value: str | int | None) -> str:
    """Render one SQLite/D1 literal without interpolation ambiguity."""

    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    if "\x00" in value:
        raise ExportError("SQL text values must not contain NUL bytes")
    return "'" + value.replace("'", "''") + "'"


def _row_sql(values: Sequence[str | int | None]) -> str:
    return "(" + ",".join(sql_literal(value) for value in values) + ")"


def _emit_insert_chunks(
    output: io.StringIO,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[str | int | None]],
    conflict_columns: Sequence[str],
    conflict_action: str = "DO NOTHING",
) -> None:
    header = f"INSERT INTO {table} ({','.join(columns)}) VALUES\n"
    trailer = f"\nON CONFLICT({','.join(conflict_columns)}) {conflict_action};\n"
    chunk: list[str] = []
    chunk_bytes = len(header.encode("utf-8")) + len(trailer.encode("utf-8"))

    def flush() -> None:
        nonlocal chunk_bytes
        if not chunk:
            return
        output.write(header)
        output.write(",\n".join(chunk))
        output.write(trailer)
        chunk.clear()
        chunk_bytes = len(header.encode("utf-8")) + len(trailer.encode("utf-8"))

    for row in rows:
        rendered = _row_sql(row)
        rendered_bytes = len(rendered.encode("utf-8")) + 2
        if rendered_bytes + len(header.encode("utf-8")) + len(
            trailer.encode("utf-8")
        ) > MAX_INSERT_BYTES:
            raise ExportError(f"one {table} row exceeds the safe D1 statement byte budget")
        if chunk and (
            len(chunk) >= MAX_INSERT_ROWS or chunk_bytes + rendered_bytes > MAX_INSERT_BYTES
        ):
            flush()
        chunk.append(rendered)
        chunk_bytes += rendered_bytes
    flush()


def render_sql(snapshot: BootstrapSnapshot) -> bytes:
    """Render deterministic D1 data SQL without schema or destructive statements."""

    output = io.StringIO()
    output.write("-- RabbitHoleTX deterministic D1 bootstrap data\n")
    output.write(f"-- dataset_sha256={snapshot.dataset_digest}\n")
    output.write(f"-- source_count={len(snapshot.sources)} draw_count={len(snapshot.draws)}\n")
    output.write("PRAGMA foreign_keys = ON;\n")

    meta_rows: tuple[tuple[str | int | None, ...], ...] = (
        ("bootstrap_dataset_sha256", snapshot.dataset_digest, snapshot.validated_at),
        ("bootstrap_source_count", str(len(snapshot.sources)), snapshot.validated_at),
        ("bootstrap_draw_count", str(len(snapshot.draws)), snapshot.validated_at),
    )
    _emit_insert_chunks(
        output,
        "schema_meta",
        ("key", "value", "updated_at"),
        meta_rows,
        ("key",),
    )

    source_rows = (
        (
            source.spec.source_id,
            source.spec.game,
            source.spec.name,
            source.spec.url,
            source.spec.session,
            canonical_json(list(source.spec.expected_widths)),
            source.started_at,
            source.completed_at,
            source.digest,
            source.object_key,
            None,
            "complete",
            source.draw_count,
            source.draw_count,
            source.latest_draw_date,
            1,
            None,
            None,
            1,
            0,
            source.started_at,
            source.completed_at,
        )
        for source in snapshot.sources
    )
    _emit_insert_chunks(
        output,
        "lotto_sources",
        (
            "source_id",
            "game",
            "name",
            "url",
            "session",
            "expected_widths",
            "last_attempt_at",
            "last_success_at",
            "last_digest",
            "last_object_key",
            "last_error",
            "last_status",
            "row_count",
            "active_count",
            "latest_draw_date",
            "last_parser_version",
            "lease_token",
            "lease_expires_at",
            "enabled",
            "consecutive_failures",
            "created_at",
            "updated_at",
        ),
        source_rows,
        ("source_id",),
        """DO UPDATE SET
  game=excluded.game,
  name=excluded.name,
  url=excluded.url,
  session=excluded.session,
  expected_widths=excluded.expected_widths,
  last_attempt_at=excluded.last_attempt_at,
  last_success_at=excluded.last_success_at,
  last_digest=excluded.last_digest,
  last_object_key=excluded.last_object_key,
  last_error=excluded.last_error,
  last_status=excluded.last_status,
  row_count=excluded.row_count,
  active_count=excluded.active_count,
  latest_draw_date=excluded.latest_draw_date,
  last_parser_version=excluded.last_parser_version,
  enabled=excluded.enabled,
  consecutive_failures=excluded.consecutive_failures,
  updated_at=excluded.updated_at
WHERE lotto_sources.last_digest IS NULL
  AND lotto_sources.last_success_at IS NULL
  AND lotto_sources.row_count = 0
  AND lotto_sources.active_count = 0
  AND lotto_sources.lease_token IS NULL
  AND lotto_sources.lease_expires_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM lotto_draws WHERE source_id=excluded.source_id
  )""",
    )

    ingestion_rows = (
        (
            source.ingestion_id,
            source.spec.source_id,
            source.spec.game,
            "bootstrap",
            source.started_at,
            source.completed_at,
            "complete",
            source.digest,
            source.object_key,
            source.byte_count,
            source.physical_row_count,
            source.draw_count,
            source.draw_count,
            0,
            0,
            0,
            0,
            0,
            None,
        )
        for source in snapshot.sources
    )
    _emit_insert_chunks(
        output,
        "lotto_ingestions",
        (
            "ingestion_id",
            "source_id",
            "game",
            "trigger_kind",
            "started_at",
            "completed_at",
            "status",
            "digest",
            "object_key",
            "byte_count",
            "total_rows",
            "parsed",
            "inserted",
            "updated",
            "unchanged",
            "retired",
            "quarantined",
            "cache_fallback",
            "error",
        ),
        ingestion_rows,
        ("ingestion_id",),
    )

    draw_rows = (
        (
            draw.game,
            draw.draw_date,
            draw.session,
            draw.ordered_numbers,
            draw.canonical_numbers,
            draw.bonus_numbers,
            draw.metadata,
            draw.content_fingerprint,
            draw.source_id,
            draw.source_url,
            draw.source_sha256,
            draw.source_line,
            draw.raw_record,
            draw.seen_ingestion_id,
            1,
            draw.first_seen_at,
            draw.updated_at,
            None,
        )
        for draw in snapshot.draws
    )
    _emit_insert_chunks(
        output,
        "lotto_draws",
        (
            "game",
            "draw_date",
            "session",
            "ordered_numbers",
            "canonical_numbers",
            "bonus_numbers",
            "metadata",
            "content_fingerprint",
            "source_id",
            "source_url",
            "source_sha256",
            "source_line",
            "raw_record",
            "seen_ingestion_id",
            "active",
            "first_seen_at",
            "updated_at",
            "retired_at",
        ),
        draw_rows,
        ("game", "draw_date", "session"),
    )
    return output.getvalue().encode("utf-8")


def render_r2_manifest(
    snapshot: BootstrapSnapshot,
    migrations: Sequence[tuple[str, str]],
    migrations_sha256: str,
    sql_sha256: str,
    r2_bucket: str,
) -> bytes:
    """Render a portable, deterministic list of exact R2 upload objects."""

    first_source = snapshot.sources[0]
    first_suffix = (
        f"/{first_source.spec.game}/{first_source.spec.name}/{first_source.digest}.csv"
    )
    if not first_source.object_key.endswith(first_suffix):
        raise ExportError("first R2 object key does not follow the configured key contract")
    r2_prefix = first_source.object_key[: -len(first_suffix)]
    manifest = {
        "schemaVersion": OUTPUT_MANIFEST_VERSION,
        "kind": "rabbitholetx-r2-bootstrap",
        "target": {
            "binding": "LOTTO_RAW",
            "bucket": r2_bucket,
        },
        "dataset": {
            "sha256": snapshot.dataset_digest,
            "sourceCount": len(snapshot.sources),
            "drawCount": len(snapshot.draws),
            "validatedAt": snapshot.validated_at,
        },
        "contracts": {
            "inputSqliteSchemaVersion": INPUT_SCHEMA_VERSION,
            "d1SchemaVersion": OUTPUT_D1_SCHEMA_VERSION,
            "d1Migrations": [
                {"file": f"migrations/{name}", "sha256": digest}
                for name, digest in migrations
            ],
            "d1MigrationsSha256": migrations_sha256,
            "d1SqlFile": SQL_FILENAME,
            "d1SqlSha256": sql_sha256,
            "r2KeyTemplate": f"{r2_prefix}/{{game}}/{{source.name}}/{{sha256}}.csv",
            "fingerprint": (
                "${game}|${draw_date}|${session}|${orderedNumbers.join(',')}|"
                "${bonusNumbers.join(',')}|${JSON.stringify(metadata)}"
            ),
        },
        "uploads": [
            {
                "sourceId": source.spec.source_id,
                "game": source.spec.game,
                "name": source.spec.name,
                "session": source.spec.session,
                "sourceUrl": source.spec.url,
                "cacheRelativePath": source.cache_relative_path,
                "objectKey": source.object_key,
                "sha256": source.digest,
                "byteCount": source.byte_count,
                "rowCount": source.physical_row_count,
                "latestDrawDate": source.latest_draw_date,
                "httpMetadata": {"contentType": "text/csv; charset=utf-8"},
                "checksums": {"sha256": source.digest},
                "customMetadata": {
                    "game": source.spec.game,
                    "sourceId": source.spec.source_id,
                    "sourceUrl": source.spec.url,
                    "fetchedAt": source.started_at,
                    "sha256": source.digest,
                    "schemaVersion": "1",
                    "parserVersion": "1",
                },
            }
            for source in snapshot.sources
        ],
    }
    return (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def validate_generated_sql(
    migrations: Sequence[tuple[Path, bytes]],
    sql_bytes: bytes,
    snapshot: BootstrapSnapshot,
) -> None:
    """Apply migration and data to disposable SQLite and verify referential parity."""

    try:
        migration_sql = "\n".join(content.decode("utf-8") for _, content in migrations)
        bootstrap_sql = sql_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ExportError("one or more migration files are not UTF-8") from exc

    with tempfile.TemporaryDirectory(prefix="rabbitholetx-bootstrap-check-") as temp_dir:
        validation_path = Path(temp_dir) / "validation.sqlite3"
        connection = sqlite3.connect(validation_path)
        try:
            connection.executescript(migration_sql)
            # Exercise both deployment orders: half of the registry rows already
            # exist as empty stubs, as they would after Worker startup, and half
            # are created by the bootstrap itself.
            connection.executemany(
                """
                INSERT INTO lotto_sources(
                  source_id, game, name, url, session, expected_widths
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    (
                        source.spec.source_id,
                        source.spec.game,
                        source.spec.name,
                        source.spec.url,
                        source.spec.session,
                        canonical_json(list(source.spec.expected_widths)),
                    )
                    for source in snapshot.sources[::2]
                ),
            )
            connection.executescript(bootstrap_sql)
            connection.executescript(bootstrap_sql)
            counts = {
                "sources": int(
                    connection.execute("SELECT COUNT(*) FROM lotto_sources").fetchone()[0]
                ),
                "ingestions": int(
                    connection.execute("SELECT COUNT(*) FROM lotto_ingestions").fetchone()[0]
                ),
                "draws": int(connection.execute("SELECT COUNT(*) FROM lotto_draws").fetchone()[0]),
            }
            expected = {
                "sources": len(snapshot.sources),
                "ingestions": len(snapshot.sources),
                "draws": len(snapshot.draws),
            }
            if counts != expected:
                raise ExportError(
                    f"generated SQL count validation failed: observed={counts}, expected={expected}"
                )
            foreign_key_issues = connection.execute("PRAGMA foreign_key_check").fetchall()
            if foreign_key_issues:
                raise ExportError(
                    f"generated SQL failed foreign-key validation: {foreign_key_issues[:3]}"
                )
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise ExportError(f"generated SQL failed integrity validation: {integrity}")
            observed_digest = connection.execute(
                "SELECT value FROM schema_meta WHERE key = 'bootstrap_dataset_sha256'"
            ).fetchone()
            if observed_digest is None or observed_digest[0] != snapshot.dataset_digest:
                raise ExportError("generated SQL lost the bootstrap dataset digest")
            observed_schema_version = connection.execute(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'"
            ).fetchone()
            if (
                observed_schema_version is None
                or observed_schema_version[0] != str(OUTPUT_D1_SCHEMA_VERSION)
            ):
                raise ExportError(
                    "migration set does not produce expected D1 schema version "
                    f"{OUTPUT_D1_SCHEMA_VERSION}"
                )
            leased_sources = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM lotto_sources
                     WHERE lease_token IS NOT NULL OR lease_expires_at IS NOT NULL
                    """
                ).fetchone()[0]
            )
            if leased_sources:
                raise ExportError("bootstrap source rows must not carry ingestion leases")
            disabled_sources = int(
                connection.execute(
                    "SELECT COUNT(*) FROM lotto_sources WHERE enabled != 1"
                ).fetchone()[0]
            )
            if disabled_sources:
                raise ExportError("bootstrap must enable every configured source")
            source_revisions = {
                str(row[0]): (str(row[1]), int(row[2]))
                for row in connection.execute(
                    "SELECT source_id, last_digest, last_parser_version FROM lotto_sources"
                ).fetchall()
            }
            expected_revisions = {
                source.spec.source_id: (source.digest, 1) for source in snapshot.sources
            }
            if source_revisions != expected_revisions:
                raise ExportError("generated SQL did not hydrate every source revision")
        except sqlite3.Error as exc:
            raise ExportError(
                f"generated SQL is incompatible with the migration set: {exc}"
            ) from exc
        finally:
            connection.close()


def _stage_output(path: Path, content: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_path.chmod(0o644)
        return temporary_path
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _check_destination(path: Path, content: bytes, force: bool) -> bool:
    """Return True when an existing identical artifact needs no replacement."""

    if not path.exists() and not path.is_symlink():
        return False
    if path.is_symlink() or not path.is_file():
        raise ExportError(f"refusing to replace a non-regular output path: {path}")
    if path.read_bytes() == content:
        return True
    if not force:
        raise ExportError(f"output already exists with different content: {path}; use --force")
    return False


def write_artifacts(
    output_dir: Path,
    sql_bytes: bytes,
    manifest_bytes: bytes,
    force: bool,
) -> tuple[Path, Path]:
    """Atomically publish both locally generated artifacts."""

    output_dir.mkdir(parents=True, exist_ok=True)
    if output_dir.is_symlink() or not output_dir.is_dir():
        raise ExportError(f"--output-dir must be a real directory: {output_dir}")
    sql_path = output_dir / SQL_FILENAME
    manifest_path = output_dir / R2_MANIFEST_FILENAME
    sql_unchanged = _check_destination(sql_path, sql_bytes, force)
    manifest_unchanged = _check_destination(manifest_path, manifest_bytes, force)
    if sql_unchanged and manifest_unchanged:
        return sql_path.resolve(), manifest_path.resolve()

    staged_sql = _stage_output(sql_path, sql_bytes)
    staged_manifest = _stage_output(manifest_path, manifest_bytes)
    try:
        if not sql_unchanged:
            os.replace(staged_sql, sql_path)
        if not manifest_unchanged:
            os.replace(staged_manifest, manifest_path)
    finally:
        staged_sql.unlink(missing_ok=True)
        staged_manifest.unlink(missing_ok=True)
    return sql_path.resolve(), manifest_path.resolve()


def _default_paths() -> tuple[Path, Path, Path]:
    script_path = Path(__file__).resolve()
    dashboard_root = script_path.parents[2]
    oracle_root = dashboard_root.parent
    return (
        oracle_root / ".rabbitholetx" / "rabbitholetx.sqlite3",
        oracle_root / ".rabbitholetx" / "cache",
        dashboard_root / "lotto-worker" / "migrations",
    )


def load_migrations(path: Path) -> tuple[tuple[Path, bytes], ...]:
    """Load a single migration or an ordered directory of migration SQL files."""

    if path.is_symlink():
        raise ExportError(f"--migrations must not be a symbolic link: {path}")
    if path.is_file():
        candidates = (path,)
    elif path.is_dir():
        candidates = tuple(sorted(path.glob("*.sql"), key=lambda candidate: candidate.name))
    else:
        raise ExportError(f"--migrations is not a file or directory: {path}")
    if not candidates:
        raise ExportError(f"--migrations contains no .sql files: {path}")
    if len({candidate.name for candidate in candidates}) != len(candidates):
        raise ExportError("migration filenames must be unique")
    loaded: list[tuple[Path, bytes]] = []
    for candidate in candidates:
        resolved = _require_regular_file(candidate, f"D1 migration {candidate.name}")
        loaded.append((resolved, resolved.read_bytes()))
    return tuple(loaded)


def migration_set_sha256(migrations: Sequence[tuple[Path, bytes]]) -> str:
    """Hash ordered migration filenames and bytes without concatenation ambiguity."""

    digest = hashlib.sha256()
    digest.update(b"rabbitholetx-d1-migrations-v1\n")
    for path, content in migrations:
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(str(len(content)).encode("ascii"))
        digest.update(b"\x00")
        digest.update(content)
        digest.update(b"\n")
    return digest.hexdigest()


def build_parser() -> argparse.ArgumentParser:
    """Create the offline export command-line interface."""

    default_db, default_cache, default_migrations = _default_paths()
    parser = argparse.ArgumentParser(
        description=(
            "Verify the local RabbitHoleTX SQLite/cache oracle and create offline "
            "D1 SQL plus an exact R2 upload manifest. No network requests are made."
        )
    )
    parser.add_argument("--db", type=Path, default=default_db, help="RabbitHoleTX SQLite path")
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=default_cache,
        help="RabbitHoleTX validated cache directory",
    )
    parser.add_argument(
        "--migrations",
        type=Path,
        default=default_migrations,
        help="D1 migration file or directory used for compatibility validation",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Local destination for bootstrap.sql and r2-uploads.json",
    )
    parser.add_argument(
        "--r2-prefix",
        default="raw",
        help="R2 object-key prefix (default: raw)",
    )
    parser.add_argument(
        "--r2-bucket",
        default="yevow-rabbitholetx-raw",
        help="informational target bucket recorded in the manifest",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="atomically replace differing local artifacts",
    )
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    """Execute one validated offline export and return its public summary."""

    migrations = load_migrations(args.migrations)
    migrations_sha256 = migration_set_sha256(migrations)
    snapshot = load_snapshot(args.db, args.cache_root, args.r2_prefix)
    sql_bytes = render_sql(snapshot)
    sql_sha256 = hashlib.sha256(sql_bytes).hexdigest()
    manifest_bytes = render_r2_manifest(
        snapshot,
        tuple((path.name, hashlib.sha256(content).hexdigest()) for path, content in migrations),
        migrations_sha256,
        sql_sha256,
        args.r2_bucket,
    )
    validate_generated_sql(migrations, sql_bytes, snapshot)
    sql_path, manifest_path = write_artifacts(
        args.output_dir,
        sql_bytes,
        manifest_bytes,
        args.force,
    )
    return {
        "datasetSha256": snapshot.dataset_digest,
        "sourceCount": len(snapshot.sources),
        "drawCount": len(snapshot.draws),
        "sql": str(sql_path),
        "sqlSha256": sql_sha256,
        "r2Manifest": str(manifest_path),
        "r2ObjectCount": len(snapshot.sources),
    }


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point."""

    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        summary = run(args)
    except (ExportError, OSError, sqlite3.Error) as exc:
        print(f"bootstrap export failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
