# ConnectX Control

**The independent control platform for ConnectX: Central Communication Gateway — powered by Dexter Studio.**

ConnectX Control is a complete, self-contained product:

- 🖥️ **React control website** — manage **systems** (EMS, InfluenceOS, CareOS, PlugX…), their **shops**, Android gateway phones, message jobs, API keys, SIM carriers and app releases.
- ⚙️ **Gateway API** — the only backend the ConnectX Android app talks to: the system dropdown, **federated administrator sign-in** (proxied to each system's own API — the phone never contacts a system directly), shop sync/selection, pairing, job claim/report, stats, email history, OTA updates.
- 🔌 **Client API (v1)** — how systems send SMS/email with an API key and a `shop` reference, and get webhook callbacks with delivery results. EMS-compatible field names and response shapes.
- ✉️ **Email gateway** — configure Brevo (or Resend / SendGrid / Mailgun / Postmark) once in Settings; every connected system sends email through `POST /api/client/v1/email/send` and never needs its own SMTP setup. Sent mail is recorded for the website and the gateway phones.
- 🗄️ **Own database** — Cloudflare D1 (`schema/connectx_schema.sql`). No shared tables, no shared sessions with any other product.

> **Relationship to EMS:** none at the database. Connect EMS once from **Connect App**
> (paste this site’s Connect Endpoint into EMS, then approve the pairing code here).
> SMS travels EMS Connect Server → this Connect Server → the Android app → the selected SIM.
> The phone’s server address is compiled into the app and is not shown in the UI.
> See [CONNECT_APP.md](CONNECT_APP.md).

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript + Vite + react-router (plain CSS design system, no UI kit) |
| Backend | Cloudflare Pages Functions (edge, zero servers) |
| Database | Cloudflare D1 (SQLite) — binding `DB` |
| Release storage | Cloudflare R2 — binding `APP_STORAGE` (APK uploads) |
| Auth | HMAC-SHA256 signed bearer sessions · PBKDF2 (100k) passwords · hashed device tokens & API keys · federated system logins (server-side) |
| Tests | `node --test` over an in-memory SQLite D1 stub + a stubbed system API (48 tests) |

## Project layout

```
connectx-control/
├── src/                     # React control website (SPA)
│   ├── pages/               # Login/Setup, Dashboard, Devices, Jobs, Shops,
│   │                        # Systems (integrations & API keys), Releases,
│   │                        # Carriers, ApiDocs, Activity, Settings
│   ├── components/          # Layout, design-system UI kit
│   ├── api/client.ts        # typed fetch client for /api/control/*
│   └── auth/AuthContext.tsx
├── functions/               # Cloudflare Pages Functions (backend)
│   ├── api/[[path]].js      # router: control/ device/ client/ public/
│   └── _lib/                # core.js db.js control.js device.js client.js
│                            # releases.js webhook.js audit.js email.js
├── schema/connectx_schema.sql
├── scripts/                 # mock-ems.mjs (local demo system) + e2e.mjs smoke test
├── test/                    # node --test suites (core + email + full route lifecycle)
├── wrangler.toml            # Pages config: D1 + R2 bindings
├── vite.config.ts           # dev proxy /api → :8788 (wrangler pages dev)
└── index.html
```

## Quick start (local)

```bash
npm install
npm run db:local                      # create local D1 tables
# upgrading a local DB made with the old 2.0 (workspace) schema instead:
#   npm run db:migrate:local && npm run db:local
# upgrading a 2.1 database to 2.2 (system public-API mode):
#   npm run db:migrate22:local && npm run db:local
npm run pages:dev                     # backend + built SPA on http://localhost:8788
# optional, in other terminals:
node scripts/mock-ems.mjs             # demo "EMS-style" system API on :8799
npm run dev                           # vite dev server on :5173 proxying /api → :8788
npm test                              # 61 backend tests (in-memory SQLite)
node scripts/e2e.mjs                  # end-to-end smoke test (needs both servers above)
```

First run: the site shows **Initialize ConnectX Control** — create the owner account.
Setup seeds the `EMS`, `CareOS`, `InfluenceOS`, `PlugX` **systems** automatically (all
unconfigured until the owner sets their API URLs). Shops appear when administrators sign
in on phones or when a system's API sends messages for them.

Local dev secrets come from `.dev.vars` (`SESSION_SECRET=...`); the file is git-ignored.

## Production deploy

See **[DEPLOY.md](DEPLOY.md)** for the full GitHub → Cloudflare Pages walkthrough
(create D1 + R2, set `SESSION_SECRET`, apply the schema, configure systems, publish the
Android APK under App Releases). The Android app ships with `https://connectxweb.pages.dev`
built in — deploy the Pages project under that name (or set a custom address on phones).

## API surface (summary)

| Prefix | Auth | Consumers |
|---|---|---|
| `/api/control/*` | operator/owner bearer session | this website |
| `/api/device/*` | system dropdown (public) → admin session → device token (`cxd_…`) or pairing code | ConnectX Android gateway |
| `/api/client/v1/*` | `X-ConnectX-Key: cxk_live_…` + `shop` reference | EMS, CareOS, InfluenceOS, PlugX, … |
| `/api/public/*` | none | update checks, APK downloads, health |

Full reference: **[API.md](API.md)** (also rendered in-app under **API Docs**).

## Versioning

- `2.0.0` — independent platform: own accounts/devices/jobs/clients/releases;
  Android gateway re-pointed (`com.connectx.gateway`); EMS App Store dependency removed.
- `2.1.0` — **systems + shops replace workspaces**: federated administrator sign-in via
  owner-configured system API URLs, per-shop devices/jobs/pairing, shop auto-provisioning
  in the client API, system-scoped API keys and webhooks (`shop_external_id`).
- `2.2.0` — **system public-API mode (`auth_mode: api_key`)** for the EMS Public API v1:
  one-call sign-in (`/api/v1/auth/login` with the owner-stored `emsk_…` platform key →
  administrator + shops + entitlement), entitlement enforcement, and the SMS **dispatch
  loop** — ConnectX heartbeats, claims the system's queued SMS fleet-wide on every
  gateway poll (~20 s throttle) and reports delivery results back (`/api/v1/sms/report`).
  Keys are masked everywhere; optional Pages cron trigger for idle freshness.

Built and maintained by **Dexter Studio**.
