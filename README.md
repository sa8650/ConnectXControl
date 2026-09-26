# ConnectX Control

**The independent control platform for ConnectX: Central Communication Gateway — powered by Dexter Studio.**

ConnectX Control is a complete, self-contained product:

- 🖥️ **React control website** — manage Android gateway phones, workspaces, message jobs, connected apps, API keys, SIM carriers and app releases.
- ⚙️ **Gateway API** — the only backend the ConnectX Android app talks to (pairing, job claim/report, stats, email history, OTA updates).
- 🔌 **Client API (v1)** — how other products (**EMS, CareOS, InfluenceOS, PlugX**, anything future) push SMS/email jobs with an API key and get webhook callbacks.
- 🗄️ **Own database** — Cloudflare D1 (`schema/connectx_schema.sql`). No shared tables, no shared sessions with any other product.

> **Relationship to EMS:** none at runtime. EMS is not modified and not required. When you
> are ready, EMS (or any product) simply becomes a *client*: issue it an API key here and
> call `POST /api/client/v1/sms`. The Android gateway no longer knows or cares where a job
> originated — every job is just workspace-scoped work with a `client_key` label.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript + Vite + react-router (plain CSS design system, no UI kit) |
| Backend | Cloudflare Pages Functions (edge, zero servers) |
| Database | Cloudflare D1 (SQLite) — binding `DB` |
| Release storage | Cloudflare R2 — binding `APP_STORAGE` (APK uploads) |
| Auth | HMAC-SHA256 signed bearer sessions · PBKDF2 (100k) passwords · hashed device tokens & API keys |
| Tests | `node --test` over an in-memory SQLite D1 stub (33 tests) |

## Project layout

```
connectx-control/
├── src/                     # React control website (SPA)
│   ├── pages/               # Login/Setup, Dashboard, Devices, Jobs, Workspaces,
│   │                        # Clients (apps & API keys), Releases, Carriers,
│   │                        # ApiDocs, Activity, Settings
│   ├── components/          # Layout, design-system UI kit
│   ├── api/client.ts        # typed fetch client for /api/control/*
│   └── auth/AuthContext.tsx
├── functions/               # Cloudflare Pages Functions (backend)
│   ├── api/[[path]].js      # router: control/ device/ client/ public/
│   └── _lib/                # core.js db.js control.js device.js client.js
│                            # releases.js webhook.js audit.js
├── schema/connectx_schema.sql
├── test/                    # node --test suites (core + full route lifecycle)
├── wrangler.toml            # Pages config: D1 + R2 bindings
├── vite.config.ts           # dev proxy /api → :8788 (wrangler pages dev)
└── index.html
```

## Quick start (local)

```bash
npm install
npm run db:local                      # create local D1 tables
npm run pages:dev                     # backend + built SPA on http://localhost:8788
# in another terminal (optional, hot-reload UI):
npm run dev                           # vite dev server on :5173 proxying /api → :8788
npm test                              # 33 backend tests (in-memory SQLite)
```

First run: the site shows **Initialize ConnectX Control** — create the owner account.
Setup seeds the `EMS`, `CareOS`, `InfluenceOS`, `PlugX` client entries and a `MAIN`
workspace automatically.

Local dev secrets come from `.dev.vars` (`SESSION_SECRET=...`); the file is git-ignored.

## Production deploy

See **[DEPLOY.md](DEPLOY.md)** for the full GitHub → Cloudflare Pages walkthrough
(create D1 + R2, set `SESSION_SECRET`, apply the schema, publish the Android APK under
App Releases).

## API surface (summary)

| Prefix | Auth | Consumers |
|---|---|---|
| `/api/control/*` | operator/owner bearer session | this website |
| `/api/device/*` | operator token → device token (`cxd_…`) or pairing code | ConnectX Android gateway |
| `/api/client/v1/*` | `X-ConnectX-Key: cxk_live_…` | EMS, CareOS, InfluenceOS, PlugX, … |
| `/api/public/*` | none | update checks, APK downloads, health |

Full reference: **[API.md](API.md)** (also rendered in-app under **API Docs**).

## Versioning

- `2.0.0` — independent platform: own accounts/workspaces/devices/jobs/clients/releases;
  Android gateway re-pointed (`com.connectx.gateway`); EMS App Store dependency removed.

Built and maintained by **Dexter Studio**.
