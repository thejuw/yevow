# Sovereign-Sigma Command Center

Next.js 14 App Router command center for the Sovereign-Sigma Workers backend.

## Local

```bash
npm install
npm run dev
```

Open `http://localhost:3000` or pass a port:

```bash
npm run dev -- --port 3007
```

## Cloudflare Pages

- Project root: `web`
- Build command: `npm run pages:build`
- Output directory: `out`
- Environment variable:
  - `NEXT_PUBLIC_SOVEREIGN_API_BASE=https://<sovereign-sigma-core-worker>`
  - `NEXT_PUBLIC_LOTTO_API_BASE=https://lotto-api.yevow.co/api/lotto/v1`

The app is a static export and calls the Worker backend directly through JWT-protected `/login` and `/admin/*` routes.

## LOTTO / RabbitHoleTX

`/lotto/` is the public Yevow LOTTO forensic lab. It is intentionally separate
from the authenticated trading controls and runs its optimizer and EV model in
the browser. It includes:

- current rule matrices for eight Texas draw games;
- versioned Lotto Texas and Cash Five audit snapshots derived from verified
  official exports, with downloadable Markdown reports and source hashes;
- a seeded split-risk/pair-coverage ticket wheel with hard budget checks; and
- an integer-cent-input EV model for fixed, liability-capped, and pari-mutuel
  prizes.

The overview reads freshness from the isolated, read-only LOTTO status API. A
non-2xx response, timeout, or incompatible response schema automatically leaves
the bundled audits, optimizer, and EV model available in embedded snapshot mode.
`NEXT_PUBLIC_LOTTO_API_BASE` is compiled into the static export; changing it
requires a Pages rebuild and redeploy.

LOTTO cannot predict a random drawing. Historical frequency, gap, and
co-occurrence output is descriptive only, and a non-significant audit result is
not proof of randomness.

Validate the browser-safe engine and page before deployment:

```bash
npm run typecheck
npm run test:lotto
npm run build
npm run test:e2e -- --grep "LOTTO forensic dashboard"
```
