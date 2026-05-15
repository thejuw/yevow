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

The app is a static export and calls the Worker backend directly through JWT-protected `/login` and `/admin/*` routes.
