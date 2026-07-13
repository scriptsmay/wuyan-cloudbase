# Agent Guide — wuyan-cloudbase

Tencent CloudBase (TCB) project for esports fan support (player: 无言/Wuyan). Cloud functions + Vue 3 web frontend.

## Quick Commands

```bash
# Run all tests (Node.js built-in test runner)
node --test tests/*.test.js

# Run a single test file
node --test tests/ai-utils.test.js

# Web frontend dev server
cd web && npm run dev

# Web frontend build + deploy to TCB hosting
cd web && npm run deploy
```

## Architecture

- **`functions/`** — 16 cloud functions, each with its own `node_modules` (NOT hoisted)
- **`functions/lib/`** — shared utilities: `ai-utils.js` (content blocking, rate formatting), `schedule-merge.js` (schedule processing)
- **`functions/ask/`** — main AI Q&A endpoint; `runtime.js` has auth, CORS, JSON response helpers
- **`web/`** — Vue 3 + TypeScript + Vite frontend, deploys to TCB hosting
- **`cloudbaserc.json`** — TCB deployment config; defines all functions, triggers, and env vars

## Key Facts

- Cloud functions use **CommonJS** (`"type": "commonjs"` in root package.json)
- Tests use **Node.js built-in test runner** (no Jest/Mocha): `node --test tests/*.test.js`
- Each cloud function has **independent dependencies** (own node_modules folder)
- Shared code lives in `functions/lib/` — imported via relative paths like `../lib/ai-utils`
- Web frontend uses ESM (`"type": "module"` in web/package.json)

## Environment Variables

Functions use env vars defined in `cloudbaserc.json`:
- `AUTH_TOKEN` — legacy auth token for API endpoints
- `TCB_ENV` — CloudBase environment ID
- `ALLOWED_ORIGINS` — comma-separated CORS origins
- `ALLOW_LOCALHOST` — set to `"true"` for local dev
- `AI_MODEL` — AI model ID (e.g., `"hy3"`)
- `BLOCKED_TERMS` — comma-separated content filter terms

## Testing

- Tests import from `../functions/lib/` using relative paths
- Tests use `process.env` for configuration (set/cleanup in test body)
- No test framework config files — pure `node:test` + `node:assert/strict`

## Deployment

- Cloud functions deploy via TCB CLI: `tcb fn deploy`
- Web frontend: `cd web && npm run deploy` (builds, copies 404.html, deploys to TCB hosting)
- Timer triggers defined in `cloudbaserc.json` (cron format: `0 0 4 * * * *`)
