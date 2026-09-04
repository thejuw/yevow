"""Unit tests for the offline RabbitHoleTX bootstrap exporter."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import export_bootstrap as exporter


INPUT_SCHEMA = """
PRAGMA user_version = 3;
CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO schema_versions VALUES (3, '2026-09-03T00:00:00.000Z');
CREATE TABLE ingestions (
  id INTEGER PRIMARY KEY,
  game TEXT NOT NULL,
  source_url TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  from_cache INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  parsed_count INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL,
  updated_count INTEGER NOT NULL,
  unchanged_count INTEGER NOT NULL,
  quarantined_count INTEGER NOT NULL,
  error TEXT NOT NULL,
  retired_count INTEGER NOT NULL,
  acquisition_kind TEXT NOT NULL
);
CREATE TABLE draws (
  id INTEGER PRIMARY KEY,
  game TEXT NOT NULL,
  draw_date TEXT NOT NULL,
  session TEXT NOT NULL,
  ordered_numbers TEXT NOT NULL,
  canonical_numbers TEXT NOT NULL,
  bonus_numbers TEXT NOT NULL,
  metadata TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  raw_record TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  active INTEGER NOT NULL,
  retired_at TEXT,
  acquisition_kind TEXT NOT NULL,
  UNIQUE(game, draw_date, session)
);
CREATE TABLE quarantine (
  ingestion_id INTEGER NOT NULL,
  source_line INTEGER NOT NULL,
  raw_record TEXT NOT NULL,
  reason TEXT NOT NULL
);
"""


class BootstrapExporterTests(unittest.TestCase):
    """Exercise deterministic output and fail-closed cache verification."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="bootstrap-export-test-")
        self.root = Path(self.temporary.name)
        self.db_path = self.root / "oracle.sqlite3"
        self.cache_root = self.root / "cache"
        self.migrations = Path(__file__).resolve().parents[1] / "migrations"
        connection = sqlite3.connect(self.db_path)
        try:
            connection.executescript(INPUT_SCHEMA)
            for index, source in enumerate(exporter.SOURCES, start=1):
                raw_record = f"validated row for {source.source_id}"
                raw_bytes = (raw_record + "\n").encode()
                digest = hashlib.sha256(raw_bytes).hexdigest()
                archive = (
                    self.cache_root
                    / source.game
                    / "archive"
                    / f"{source.name}-{digest}.csv"
                )
                archive.parent.mkdir(parents=True, exist_ok=True)
                archive.write_bytes(raw_bytes)
                timestamp = f"2026-09-03T00:00:{index:02d}.000Z"
                connection.execute(
                    """
                    INSERT INTO ingestions VALUES (
                      ?, ?, ?, ?, ?, 0, ?, ?, 'complete', 1, 1, 0, 0, 0, '', 0,
                      'official-export'
                    )
                    """,
                    (
                        index,
                        source.game,
                        source.url,
                        str(archive),
                        digest,
                        timestamp,
                        timestamp,
                    ),
                )
                ordered = [index, index + 1]
                bonus = [index + 2] if source.game in {"twostep", "pb", "mm"} else []
                metadata = {"rules_era": "test", "ordinal": index}
                connection.execute(
                    """
                    INSERT INTO draws (
                      game, draw_date, session, ordered_numbers, canonical_numbers,
                      bonus_numbers, metadata, source_url, source_sha256, source_line,
                      raw_record, created_at, updated_at, active, retired_at, acquisition_kind
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, NULL,
                              'official-export')
                    """,
                    (
                        source.game,
                        f"2026-08-{index:02d}",
                        source.session,
                        exporter.canonical_json(ordered),
                        exporter.canonical_json(sorted(ordered)),
                        exporter.canonical_json(bonus),
                        exporter.canonical_json(metadata),
                        source.url,
                        digest,
                        raw_record,
                        timestamp,
                        timestamp,
                    ),
                )
            connection.commit()
        finally:
            connection.close()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _args(self, output_dir: Path) -> argparse.Namespace:
        return argparse.Namespace(
            db=self.db_path,
            cache_root=self.cache_root,
            migrations=self.migrations,
            output_dir=output_dir,
            r2_prefix="raw",
            r2_bucket="yevow-rabbitholetx-raw",
            force=False,
        )

    def test_manifest_has_exact_source_and_digest_keys(self) -> None:
        output = self.root / "output"
        summary = exporter.run(self._args(output))
        manifest = json.loads((output / exporter.R2_MANIFEST_FILENAME).read_text())

        self.assertEqual(summary["sourceCount"], 17)
        self.assertEqual(summary["drawCount"], 17)
        self.assertEqual(len(manifest["uploads"]), 17)
        self.assertEqual(manifest["target"]["bucket"], "yevow-rabbitholetx-raw")
        self.assertEqual(manifest["contracts"]["d1SchemaVersion"], 4)
        self.assertEqual(len(manifest["contracts"]["d1Migrations"]), 4)
        for source, upload in zip(exporter.SOURCES, manifest["uploads"], strict=True):
            self.assertEqual(upload["sourceId"], source.source_id)
            self.assertEqual(
                upload["objectKey"],
                f"raw/{source.game}/{source.name}/{upload['sha256']}.csv",
            )
            cache_file = self.cache_root / upload["cacheRelativePath"]
            self.assertEqual(exporter.sha256_file(cache_file)[0], upload["sha256"])
            self.assertEqual(upload["customMetadata"]["sourceId"], source.source_id)

    def test_output_is_byte_deterministic_and_sql_is_idempotent(self) -> None:
        first = self.root / "first"
        second = self.root / "second"
        exporter.run(self._args(first))
        exporter.run(self._args(second))

        self.assertEqual(
            (first / exporter.SQL_FILENAME).read_bytes(),
            (second / exporter.SQL_FILENAME).read_bytes(),
        )
        self.assertEqual(
            (first / exporter.R2_MANIFEST_FILENAME).read_bytes(),
            (second / exporter.R2_MANIFEST_FILENAME).read_bytes(),
        )

    def test_cache_digest_mismatch_fails_closed(self) -> None:
        source = exporter.SOURCES[0]
        archive = next((self.cache_root / source.game / "archive").glob("*.csv"))
        archive.write_bytes(b"tampered\n")
        with self.assertRaisesRegex(exporter.ExportError, "cache digest mismatch"):
            exporter.run(self._args(self.root / "rejected"))
        self.assertFalse((self.root / "rejected").exists())

    def test_worker_fingerprint_contract(self) -> None:
        fingerprint = exporter.worker_content_fingerprint(
            "lotto",
            "2026-09-03",
            "",
            [1, 2, 54],
            [],
            '{"rules_era":"6/54"}',
        )
        self.assertEqual(
            fingerprint,
            'lotto|2026-09-03||1,2,54||{"rules_era":"6/54"}',
        )


if __name__ == "__main__":
    unittest.main()
