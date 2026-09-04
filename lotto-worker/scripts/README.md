# RabbitHoleTX Cloudflare bootstrap exporter

`export_bootstrap.py` is an offline bridge from the validated Python
RabbitHoleTX oracle to the dedicated Cloudflare D1/R2 data plane. It makes no
network requests and performs no Cloudflare writes.

Run it from any directory:

```sh
python lotto-worker/scripts/export_bootstrap.py \
  --db ../.rabbitholetx/rabbitholetx.sqlite3 \
  --cache-root ../.rabbitholetx/cache \
  --migrations lotto-worker/migrations \
  --output-dir /path/to/private/bootstrap-output
```

The defaults already point to those database, cache, and migration locations
when the dashboard is nested beside the Python project. `--output-dir` is
required so the large generated data export is never silently written into the
repository.

The command emits:

- `bootstrap.sql`: deterministic, non-destructive D1 data statements compatible
  with the complete ordered migration set. It does not create or drop schema and does
  not replace populated cloud rows. It can safely hydrate source registry rows
  that the Worker registered before any source revision or draws existed. Source
  rows seed parser version 1, enable all 17 configured sources, and leave
  ingestion lease fields `NULL`.
- `r2-uploads.json`: the exact 17 local cache-relative paths, SHA-256 values,
  byte counts, and immutable keys in the form
  `raw/{game}/{source.name}/{sha256}.csv`.
  The manifest also records the target bucket, HTTP content type, and exact custom
  metadata that the Worker writes during normal ingestion. `--r2-prefix` and
  `--r2-bucket` can describe another isolated deployment without changing code.

Before writing either file, the exporter checks the SQLite schema/migration
ledger, official provenance, all 17 source identities, clean latest ingestion
runs, archive paths, file hashes and sizes, raw-record line evidence, draw
counts, normalized JSON, and foreign-key/integrity behavior in a disposable
database. It applies the generated SQL twice during validation to prove that a
repeat import cannot replace rows.

Run its standard-library-only tests with:

```sh
python -m unittest discover -s lotto-worker/scripts -p 'test_*.py'
```
