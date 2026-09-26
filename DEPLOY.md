# Deploying ConnectX Control

Target: **GitHub repository → Cloudflare Pages** with a D1 database and an R2 bucket.
Total time: roughly 15 minutes. No server to maintain.

---

## 1. Push this project to GitHub

```bash
cd connectx-control
git init && git add -A && git commit -m "ConnectX Control 2.0.0 - independent gateway platform"
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
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `NODE_VERSION = 20` (environment variable) |

**Or by CLI:**

```bash
npx wrangler pages project create connectx-control --production-branch=main
npx wrangler pages deploy dist --project-name=connectx-control
```

### Bindings (Pages → Settings → Bindings)

| Type | Variable | Value |
|---|---|---|
| D1 database | `DB` | `connectx-control` |
| R2 bucket | `APP_STORAGE` | `connectx-releases` |
| Secret text | `SESSION_SECRET` | long random string (see below) |
| Plain text | `DEFAULT_DAILY_LIMIT` | `1000` (optional) |
| Secret text | `WEBHOOK_SIGNING_SECRET` | optional, signs client webhooks |

Generate a secret:

```bash
openssl rand -hex 32
npx wrangler pages secret put SESSION_SECRET --project-name=connectx-control
```

Bindings declared in `wrangler.toml` are applied automatically for `wrangler pages deploy`;
the dashboard needs them once for Git-integrated builds. **Redeploy after changing any
binding.**

---

## 5. First run

1. Open `https://connectx-control.pages.dev` (or your custom domain).
2. The login page reports the platform as uninitialized → **Initialize ConnectX Control**:
   create the owner account (password ≥ 10 characters).
3. Setup seeds the client products `EMS`, `CareOS`, `InfluenceOS`, `PlugX` and a `MAIN`
   workspace.
4. Go to **Workspaces** and create one per tenant (shop / branch / product environment).
5. Go to **Gateways → Pair new gateway**, choose the workspace, generate a pairing code.
6. On the phone: install the ConnectX APK, enter **this website's full URL**, then sign in
   with a ConnectX account or enter the pairing code. Grant SMS permissions, pick the
   sending SIM, run the test SMS.
7. **App Releases → Publish release**: upload the signed APK (R2) with package
   `com.connectx.gateway`, version `2.0.0`, build `18`, then publish. Phones now update
   from your own website.
8. **Apps & API Keys**: issue an API key for each product and hand it to that product's
   configuration (see `API.md`).

---

## 6. Custom domain (optional)

Pages → Custom domains → set up `connectx.yourdomain.com`. Android gateways must use the
final HTTPS origin; update the URL on each phone after switching (Settings → Log out keeps
the URL, so just correct it on the sign-in screen).

---

## 7. Verification checklist

```bash
BASE=https://connectx-control.pages.dev
curl -s $BASE/api/public/health
# {"ok":true,"service":"connectx-control",...}

curl -s "$BASE/api/public/releases/check?package=com.connectx.gateway&versionCode=1"
# 404 before the first published release; full release JSON afterwards

curl -s -X POST $BASE/api/client/v1/ping
# {"error":"Missing ConnectX API key..."} → routing + auth guard work
```

In the website: create a workspace → pair a gateway → send a test SMS from **Messages** →
watch it go `queued → sending → sent` and appear on the phone.

---

## 8. Operations

| Task | Command / place |
|---|---|
| Backup the database | `npx wrangler d1 export connectx-control --remote --output=backup.sql` |
| Restore | `npx wrangler d1 execute connectx-control --remote --file=backup.sql` |
| Logs | Pages → Deployments → Functions logs, or `npx wrangler pages deployment tail` |
| Rotate `SESSION_SECRET` | Pages → Settings → Secrets (invalidates web sessions; device tokens keep working because they are stored as independent hashes) |
| Local dry run | `npm run db:local && npm run pages:dev` |

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ConnectX database (D1 binding DB) is not configured` | Missing `DB` binding → add it and redeploy |
| `SESSION_SECRET is not configured` | Secret not set for the active environment (Production **and** Preview are separate) |
| Blank page after deploy | Build output must be `dist`; confirm `_redirects` shipped (SPA fallback) |
| Release upload 503 | `APP_STORAGE` R2 binding missing, or R2 not enabled on the account |
| `Cannot publish without a downloadable APK` | Upload the APK first, or supply a working external HTTPS `apk_url` |
| Phone says “Cannot find the ConnectX Control website” | Wrong/incomplete URL on the phone; use the full deployed origin |
| API key 401 | Key revoked, or the client product is set to `disabled` |
| Jobs stuck in `queued` | No online gateway in that workspace (Gateways page shows `online`) |
