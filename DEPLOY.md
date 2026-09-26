# Deploying ConnectX Control

Target: **GitHub repository → Cloudflare Pages** with a D1 database and an R2 bucket.
Total time: roughly 15 minutes. No server to maintain.

> **Project name:** the Android app ships with `https://connectxweb.pages.dev` built in.
> Create the Pages project as **`connectxweb`** so phones connect with zero configuration
> (or use any name/custom domain and set the address on each phone — Settings →
> *ConnectX Control Address*).

---

## 1. Push this project to GitHub

```bash
cd connectx-control
git init && git add -A && git commit -m "ConnectX Control 2.1.0 - systems + shops platform"
git branch -M main
git remote add origin https://github.com/sa8650/connectx-control.git   # create the empty repo first
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `dist`, `.wrangler` and `.dev.vars`, so only
source is published. `package-lock.json` **is** committed on purpose — Cloudflare Pages
runs `npm ci` when it exists.

---

## 2. Create the Cloudflare resources

```bash
npx wrangler login

# Database
npx wrangler d1 create connectx-control
# → copy the printed database_id into wrangler.toml ([[d1_databases]] database_id)

# Release storage (APK uploads)
npx wrangler r2 bucket create connectx-releases
```

Commit the updated `wrangler.toml` (with the real `database_id`) and push.

---

## 3. Apply the schema

```bash
npx wrangler d1 execute connectx-control --remote --file=./schema/connectx_schema.sql
```

All statements are `CREATE TABLE IF NOT EXISTS`, so re-running is safe.

---

## 4. Create the Pages project

**Dashboard route:** Cloudflare → Workers & Pages → **Create** → **Pages** → *Connect to
Git* → pick `connectx-control`.

| Setting | Value |
|---|---|
| Project name | `connectxweb` (→ `https://connectxweb.pages.dev`) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `NODE_VERSION = 20` (environment variable) |

**Or by CLI:**

```bash
npx wrangler pages project create connectxweb --production-branch=main
npm run pages:deploy     # = npm run build && wrangler pages deploy dist --project-name=connectxweb
```

### Bindings (Pages → Settings → Bindings)

| Type | Variable | Value |
|---|---|---|
| D1 database | `DB` | `connectx-control` |
| R2 bucket | `APP_STORAGE` | `connectx-releases` |
| Secret text | `SESSION_SECRET` | long random string (see below) |
| Plain text | `DEFAULT_DAILY_LIMIT` | `1000` (optional) |
| Secret text | `WEBHOOK_SIGNING_SECRET` | optional, signs system webhooks |
| Secret text | `BREVO_API_KEY` | optional — email provider key as an environment secret instead of storing it in Settings → Email (env wins over DB). Equivalent: `RESEND_API_KEY`, `SENDGRID_API_KEY`, `MAILGUN_API_KEY` (+ plain `MAILGUN_DOMAIN`), `POSTMARK_SERVER_TOKEN` |
| Plain text | `MOCK_EMAIL` | `1` = simulate email delivery without calling the provider (local demos/tests only — never set in production) |

Generate a secret:

```bash
openssl rand -hex 32
npx wrangler pages secret put SESSION_SECRET --project-name=connectxweb
```

Bindings declared in `wrangler.toml` are applied automatically for `wrangler pages deploy`;
the dashboard needs them once for Git-integrated builds. **Redeploy after changing any
binding.**

---

## 5. First run

1. Open `https://connectxweb.pages.dev` (or your custom domain).
2. The login page reports the platform as uninitialized → **Initialize ConnectX Control**:
   create the owner account (password ≥ 10 characters).
3. Setup seeds the systems `EMS`, `CareOS`, `InfluenceOS`, `PlugX` — all **unconfigured**.
4. **Systems & API Keys → Configure** each system you use: set its **API URL** (federated
   administrator sign-in + shop sync; for EMS the default login/shops paths already match)
   and its **webhook URL** for delivery results. Then **issue an API key** and put it into
   that system's ConnectX configuration (see `API.md`).
5. On the phone: install the ConnectX APK → it connects to this website automatically →
   pick the **system** → sign in with a **system administrator account** → choose a
   **shop** (synced from the system) → grant SMS permissions → pick the sending SIM → run
   the test SMS. Alternatively: **Gateways → Pair new gateway**, choose the shop, and
   enter the pairing code on the phone.
6. **App Releases → Publish release**: upload the signed APK (R2) with package
   `com.connectx.gateway`, version `2.1.0`, build `19`, then publish. Phones now update
   from your own website.
7. Shops you message from a system's backend **auto-register** on first use (pass
   `shop_name`), so nothing else is needed to start sending.

---

## 6. Custom domain (optional)

Pages → Custom domains → set up `connectx.yourdomain.com`. The Android app uses its
built-in `https://connectxweb.pages.dev` unless a phone is pointed elsewhere: sign-in
screen → **Can't connect?** (or Settings → **ConnectX Control Address**) accepts the full
HTTPS origin. Log out keeps the saved address.

---

## 7. Verification checklist

```bash
BASE=https://connectxweb.pages.dev
curl -s $BASE/api/public/health
# {"ok":true,"service":"connectx-control",...}

curl -s $BASE/api/device/systems
# {"systems":[{"id":...,"key":"ems","name":"EMS","available":false},...]}  (available once API URLs are set)

curl -s "$BASE/api/public/releases/check?package=com.connectx.gateway&versionCode=1"
# 404 before the first published release; full release JSON afterwards

curl -s -X POST $BASE/api/client/v1/ping
# {"error":"Missing ConnectX API key..."} → routing + auth guard work
```

In the website: configure a system → sign in on a phone (or pair a code) → send a test SMS
from **Messages** → watch it go `queued → sending → sent` and appear on the phone.

Local dry run with a demo system: `npm run db:local && npm run pages:dev`, then
`node scripts/mock-ems.mjs` and `node scripts/e2e.mjs` (walks the whole lifecycle).

---

## 8. Operations

| Task | Command / place |
|---|---|
| Backup the database | `npx wrangler d1 export connectx-control --remote --output=backup.sql` |
| Restore | `npx wrangler d1 execute connectx-control --remote --file=backup.sql` |
| Logs | Pages → Deployments → Functions logs, or `npx wrangler pages deployment tail` |
| Rotate `SESSION_SECRET` | Pages → Settings → Secrets (invalidates web/admin sessions; device tokens keep working because they are stored as independent hashes) |
| Local dry run | `npm run db:local && npm run pages:dev` |

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ConnectX database (D1 binding DB) is not configured` | Missing `DB` binding → add it and redeploy |
| `SESSION_SECRET is not configured` | Secret not set for the active environment (Production **and** Preview are separate) |
| Blank page after deploy | Build output must be `dist`; confirm `_redirects` shipped (SPA fallback) |
| Release upload 503 | `APP_STORAGE` R2 binding missing, or R2 not enabled on the account |
| `Cannot publish without a downloadable APK` | Upload the APK first, or supply a working external HTTPS `apk_url` |
| Phone shows “Could not reach …” | The built-in `https://connectxweb.pages.dev` is unreachable — check the Pages deployment, or set your custom address on the phone (Can't connect? / Settings → ConnectX Control Address) |
| Phone says “EMS is not connected on ConnectX yet” | The system has no **API URL** — set it under Systems & API Keys → Configure |
| Federated sign-in fails | Check the system's `login_path` / `shops_path` and that the system API accepts `{email,password}` → `{token,user}` and `Bearer` → `{shops:[…]}` |
| API key 401 | Key revoked, or the system is set to `disabled` |
| Jobs stuck in `queued` | No online gateway paired to that **shop** (Gateways page shows `online`) |
