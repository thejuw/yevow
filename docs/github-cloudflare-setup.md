# GitHub and Cloudflare Deployment Setup

This repository is wired for GitHub CI plus manual production deployment to Cloudflare.

## Required GitHub Secrets

Add these in GitHub:

`Settings -> Secrets and variables -> Actions -> New repository secret`

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The API token should be scoped to this Cloudflare account and allow:

- Workers Scripts: Edit
- Workers Routes: Edit
- Workers KV Storage: Edit
- D1: Edit
- Cloudflare Pages: Edit

Do not add exchange, JWT, admin, Kaiko, Telegram, Discord, or vault secrets to GitHub unless a workflow explicitly needs them. Those runtime secrets should stay in Cloudflare Worker Secrets.

## Optional GitHub Environment

Create a GitHub Environment named `production`:

`Settings -> Environments -> New environment -> production`

Recommended protection:

- Required reviewers: enabled
- Deployment branches: `main` only

The deploy workflow is attached to this environment.

## Workflows

### CI

`.github/workflows/ci.yml`

Runs on every pull request and push to `main`:

- Worker dependency install
- Command Center dependency install
- Worker TypeScript typecheck
- Command Center TypeScript typecheck
- Command Center static export build
- Wrangler dry-run deploys for core, ingest, and executioner Workers

### Deploy Cloudflare

`.github/workflows/deploy-cloudflare.yml`

Runs manually from GitHub Actions:

`Actions -> Deploy Cloudflare -> Run workflow`

Targets:

- `all`: deploy all Workers and Pages
- `workers`: deploy core, ingest, and executioner Workers
- `pages`: build and deploy the Command Center to Cloudflare Pages

## Runtime Secrets Stay in Cloudflare

Provision Worker runtime secrets with Wrangler from a trusted local machine:

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put KAIKO_API_KEY
npx wrangler secret put EXCHANGE_API_KEY -c wrangler.executioner.toml
npx wrangler secret put EXCHANGE_API_SECRET -c wrangler.executioner.toml
```

The executioner is currently configured with `EXCHANGE_ORDER_TEST_MODE = "true"`. Keep it that way until live execution has been deliberately approved.
