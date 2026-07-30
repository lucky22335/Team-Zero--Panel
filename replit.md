# Team Zero Panel

A WhatsApp/SMS OTP virtual number management panel with real-time SMS forwarding to Telegram.

## Architecture

- **`artifacts/api-server`** — Express API server (Node 24, TypeScript, esbuild)
- **`artifacts/team-zero-panel`** — React + Vite frontend panel (TailwindCSS, Framer Motion, shadcn/ui)
- **`lib/db`** — Drizzle ORM PostgreSQL schema (currently unused; data persisted in `db.json` → GitHub)
- **`lib/api-client-react`** — Auto-generated OpenAPI client (orval)

## Running

- API server: `pnpm --filter @workspace/api-server run dev`  (PORT env var)
- Frontend: `pnpm --filter @workspace/team-zero-panel run dev`

## Key env vars / secrets

- `GITHUB_PERSONAL_ACCESS_TOKEN` — GitHub PAT for syncing db.json to `lucky22335/Team-Zero--Panel`
- `SESSION_SECRET` — Express session signing

## Data persistence

All runtime data (users, bots, SMS logs, claimed numbers) is stored in `db.json` at project root and automatically synced to GitHub on every write using `artifacts/api-server/src/lib/github-sync.ts`.

## SMS / Telegram forwarding

- **Fast poller** (`runFastUserApiPoller`): Fetches API 1–7 every 2 seconds → forwards OTPs to Telegram
- **Background worker** (`pollIncomingSms`): Fetches all 30+ background aggregator APIs → forwards to subscribers
- Double-delivery is prevented by `FAST_POLLER_SOURCES` set (API 1–7 are skipped by the worker)
- Dedup guard: `lastForwardedSmsIds` (in-memory + `forwarded_ids.json` for restart safety)

## Admin

- Admin password: `teamzerousman586` (hardcoded in sms-routes.ts)
- Admin panel accessible at `website.com/usman`

## User preferences

- Keep project structure as-is (do not migrate to Replit DB)
- Always push code changes to GitHub: `lucky22335/Team-Zero--Panel`
