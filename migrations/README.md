# D1 Migration History

The migration sequence intentionally has gaps:

- `0001_schema.sql` is the squashed baseline schema from the early Sovereign-Sigma phases.
- `002` through `004` were design-time iterations that were folded into the baseline before the remote D1 database became the operational source of truth.
- `005_phase59_ghost_fill_status.sql` adds the Phase 59 shadow-mode execution status support.
- `006_phase60_candles.sql` adds cascade candle/replay storage.
- `007_cascade_replay_sources.sql` adds replay source metadata for cascade validation.

Do not renumber applied migrations. New migrations should continue from the highest applied number.
