# Moltworker Supervisor

Sovereign-Sigma supports two supervisor heartbeat modes:

- Cloudflare cron supervisor: `sovereign-sigma-moltworker`
- Local OpenClaw-style supervisor: `npm run moltworker:local`

The local loop proves a machine-local supervisor process is alive by logging in
through the normal admin API and posting `/admin/moltworker/heartbeat`. The
gateway diagnostics should read this through `https://api.yevow.co/moltworker/health`.

## Local Run

```bash
export MOLTWORKER_GATEWAY_URL="https://api.yevow.co"
export MOLTWORKER_ADMIN_PASSWORD="<admin-password>"
export MOLTWORKER_LOCAL_DIRECTORY="/Users/livelovelonestar/Documents/Codex/2026-05-14/phase-1-core-architectural-setup-state"
export MOLTWORKER_MODE="AUTONOMOUS"
export MOLTWORKER_STRATEGIC_INTENT="Localized OpenClaw supervisor loop polling Sovereign-Sigma telemetry."
export MOLTWORKER_INTERVAL_MS="60000"

npm run moltworker:local
```

For one-shot validation:

```bash
MOLTWORKER_ONCE=true npm run moltworker:local
```

The script intentionally does not print the admin password or JWT. Heartbeat
metadata includes the runtime, local directory, hostname, process id, Node
version, and current git commit so diagnostics can distinguish a local supervisor
from the Cloudflare cron fallback.
